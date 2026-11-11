import { convexGateway } from "@convex-dev/ai-sdk-provider";
import { Output, generateText } from "ai";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { env, internalAction, internalMutation, internalQuery, query, type MutationCtx } from "./_generated/server";
import { audit } from "./channels";
import {
  DISCOVERY_RETRY_MS,
  DISCOVERY_SYSTEM,
  MONITOR_ACTOR,
  RUNS_PER_TICK,
  cleanUrl,
  desiredMonitors,
  discoveryPrompt,
  discoverySchema,
  intervalMs,
  monitorInput,
  pageConfirms,
  stateKey,
  webhookUrl,
  webhooksParam,
} from "./lib/monitors";

// Autonomous Apify monitors (spec 13). The company profile decides what is watched: sync keeps the `monitors`
// table matched to it, discover fills in pages the founder didn't give (Claude proposes, a fetch confirms), and the
// runDue cron starts each due check as a monema/apify-change-monitor run whose one-off webhook calls
// /apify-callback (apify.ts). Nothing is created in the Apify account. Keys stay in Convex env (invariant 6).

const APIFY_BASE = "https://api.apify.com/v2";
const MODEL = "anthropic/claude-sonnet-5.5"; // same model as onboarding and rule induction
const RUN_TIMEOUT_SECS = 120;
const RUN_MEMORY_MB = 256;
const PAUSE_KEY = "monitors_paused";
const INTERVAL_KEY = "monitor_interval_minutes";
const DISCOVERY_KEY = "monitor_discovery"; // {[name]: last attempt ms}

async function configValue(ctx: MutationCtx, key: string): Promise<unknown> {
  const row = await ctx.db.query("config").withIndex("by_key", (q) => q.eq("key", key)).unique();
  return row?.value;
}

async function setConfig(ctx: MutationCtx, key: string, value: unknown): Promise<void> {
  const row = await ctx.db.query("config").withIndex("by_key", (q) => q.eq("key", key)).unique();
  if (row) await ctx.db.patch("config", row._id, { value });
  else await ctx.db.insert("config", { key, value });
}

// ---------------------------------------------------------------- watch list

async function syncWatchList(ctx: MutationCtx): Promise<{ added: number; removed: number; active: number }> {
  const company = await ctx.db.query("company").first();
  const desired = company ? desiredMonitors(company) : [];
  const now = Date.now();
  const keep = new Set(desired.map((d) => `${d.watch} ${d.url}`));
  let added = 0;
  let removed = 0;
  for (const d of desired) {
    const row = await ctx.db
      .query("monitors")
      .withIndex("by_url_and_watch", (q) => q.eq("url", d.url).eq("watch", d.watch))
      .unique();
    if (!row) {
      await ctx.db.insert("monitors", { ...d, active: true, last_run_at: 0, created_at: now, updated_at: now });
      added += 1;
    } else if (!row.active || row.label !== d.label) {
      await ctx.db.patch("monitors", row._id, { active: true, label: d.label, updated_at: now });
      if (!row.active) added += 1;
    }
  }
  const active = await ctx.db
    .query("monitors")
    .withIndex("by_active_and_last_run_at", (q) => q.eq("active", true))
    .take(200);
  for (const m of active) {
    if (keep.has(`${m.watch} ${m.url}`)) continue;
    await ctx.db.patch("monitors", m._id, { active: false, updated_at: now });
    removed += 1;
  }
  if (added || removed) await audit(ctx, { actor: "apify", kind: "monitors_synced", ref: "monitors", detail: { added, removed, active: desired.length } });
  return { added, removed, active: desired.length };
}

// Matches the watch list to the company profile. Also runs at the start of every runDue tick.
export const sync = internalMutation({
  args: {},
  returns: v.object({ added: v.number(), removed: v.number(), active: v.number() }),
  handler: (ctx) => syncWatchList(ctx),
});

// ---------------------------------------------------------------- discovery

type Gap = { kind: "competitor" | "vendor"; name: string };

export const discoveryContext = internalQuery({
  args: { now: v.number() },
  returns: v.object({ context: v.string(), gaps: v.array(v.object({ kind: v.union(v.literal("competitor"), v.literal("vendor")), name: v.string() })) }),
  handler: async (ctx, { now }) => {
    const company = await ctx.db.query("company").first();
    if (!company) return { context: "", gaps: [] };
    const tried = ((await ctx.db.query("config").withIndex("by_key", (q) => q.eq("key", DISCOVERY_KEY)).unique())?.value ?? {}) as Record<string, number>;
    const fresh = (name: string) => !(tried[name] && now - tried[name] < DISCOVERY_RETRY_MS);
    const gaps: Gap[] = [
      ...company.competitors.filter((c) => !c.pricing_url || !c.changelog_url || !c.careers_url).map((c) => ({ kind: "competitor" as const, name: c.name })),
      ...company.vendors.filter((x) => !x.pricing_url).map((x) => ({ kind: "vendor" as const, name: x.name })),
    ].filter((g) => fresh(g.name));
    return { context: `${company.product} (${company.description})`.slice(0, 300), gaps: gaps.slice(0, 8) };
  },
});

async function confirmPage(name: string, raw: string | null): Promise<string | null> {
  const url = cleanUrl(raw ?? undefined);
  if (!url) return null;
  try {
    const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; CofounderMonitor/1.0)" }, signal: AbortSignal.timeout(10_000) });
    const body = (await res.text()).slice(0, 200_000);
    return pageConfirms(name, res.status, res.headers.get("content-type"), body) ? url : null;
  } catch {
    return null;
  }
}

// Fills in competitor and vendor pages the profile lacks, then syncs. A name is retried at most weekly; a page
// is saved only after it loads and names the company, so an invented URL is never watched.
export const discover = internalAction({
  args: {},
  returns: v.object({ checked: v.number(), found: v.number() }),
  handler: async (ctx): Promise<{ checked: number; found: number }> => {
    const { context, gaps }: { context: string; gaps: Gap[] } = await ctx.runQuery(internal.monitors.discoveryContext, { now: Date.now() });
    let found = 0;
    for (const g of gaps) {
      let pages = { pricing_url: null as string | null, changelog_url: null as string | null, careers_url: null as string | null };
      try {
        const result = await generateText({
          model: convexGateway(MODEL),
          system: DISCOVERY_SYSTEM,
          prompt: discoveryPrompt(g.kind, g.name, context),
          output: Output.object({ schema: discoverySchema, name: "pages" }),
          abortSignal: AbortSignal.timeout(20_000),
          maxRetries: 1,
        });
        pages = {
          pricing_url: await confirmPage(g.name, result.output.pricing_url),
          changelog_url: g.kind === "competitor" ? await confirmPage(g.name, result.output.changelog_url) : null,
          careers_url: g.kind === "competitor" ? await confirmPage(g.name, result.output.careers_url) : null,
        };
      } catch (e) {
        console.warn(`monitors.discover: ${g.name}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
      }
      found += Object.values(pages).filter(Boolean).length;
      await ctx.runMutation(internal.monitors.saveDiscovered, { kind: g.kind, name: g.name, ...pagesArgs(pages) });
    }
    await ctx.runMutation(internal.monitors.sync, {});
    return { checked: gaps.length, found };
  },
});

function pagesArgs(p: { pricing_url: string | null; changelog_url: string | null; careers_url: string | null }) {
  return {
    ...(p.pricing_url ? { pricing_url: p.pricing_url } : {}),
    ...(p.changelog_url ? { changelog_url: p.changelog_url } : {}),
    ...(p.careers_url ? { careers_url: p.careers_url } : {}),
  };
}

// Writes confirmed pages onto the profile (only fields still empty, so the founder's own URLs always win) and
// records the attempt.
export const saveDiscovered = internalMutation({
  args: {
    kind: v.union(v.literal("competitor"), v.literal("vendor")),
    name: v.string(),
    pricing_url: v.optional(v.string()),
    changelog_url: v.optional(v.string()),
    careers_url: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { kind, name, pricing_url, changelog_url, careers_url }) => {
    const tried = ((await configValue(ctx, DISCOVERY_KEY)) ?? {}) as Record<string, number>;
    await setConfig(ctx, DISCOVERY_KEY, { ...tried, [name]: Date.now() });
    const company = await ctx.db.query("company").first();
    if (!company) return null;
    const saved: Record<string, string> = {};
    if (kind === "competitor") {
      const competitors = company.competitors.map((c) => {
        if (c.name !== name) return c;
        const next = { ...c };
        if (!next.pricing_url && pricing_url) next.pricing_url = saved.pricing_url = pricing_url;
        if (!next.changelog_url && changelog_url) next.changelog_url = saved.changelog_url = changelog_url;
        if (!next.careers_url && careers_url) next.careers_url = saved.careers_url = careers_url;
        return next;
      });
      if (Object.keys(saved).length) await ctx.db.patch("company", company._id, { competitors, updated_at: Date.now() });
    } else {
      const vendors = company.vendors.map((x) => (x.name === name && !x.pricing_url && pricing_url ? { ...x, pricing_url: (saved.pricing_url = pricing_url) } : x));
      if (Object.keys(saved).length) await ctx.db.patch("company", company._id, { vendors, updated_at: Date.now() });
    }
    await audit(ctx, { actor: "apify", kind: "monitor_discovery", ref: name, detail: { kind, saved } });
    return null;
  },
});

// ---------------------------------------------------------------- runs

// Cron (every 5 min): syncs the watch list, then starts the checks that are due (never-checked pages first, so a
// new page gets its baseline right away). Skipped while paused or without Apify keys.
export const runDue = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    if ((await configValue(ctx, PAUSE_KEY)) === true) return 0;
    if (!env.APIFY_TOKEN || !env.APIFY_WEBHOOK_TOKEN) return 0;
    await syncWatchList(ctx);
    const now = Date.now();
    const cutoff = now - intervalMs(await configValue(ctx, INTERVAL_KEY));
    const due = await ctx.db
      .query("monitors")
      .withIndex("by_active_and_last_run_at", (q) => q.eq("active", true).lte("last_run_at", cutoff))
      .take(RUNS_PER_TICK);
    for (const m of due) {
      await ctx.db.patch("monitors", m._id, { last_run_at: now, updated_at: now });
      await ctx.scheduler.runAfter(0, internal.monitors.startRun, { monitorId: m._id, watch: m.watch, url: m.url });
    }
    return due.length;
  },
});

// One check: a monema/apify-change-monitor run with a one-off webhook back to /apify-callback.
export const startRun = internalAction({
  args: { monitorId: v.id("monitors"), watch: v.string(), url: v.string() },
  returns: v.null(),
  handler: async (ctx, { monitorId, watch, url }) => {
    let runId: string | undefined;
    let error: string | undefined;
    try {
      if (!env.APIFY_TOKEN || !env.APIFY_WEBHOOK_TOKEN) throw new Error("APIFY_TOKEN or APIFY_WEBHOOK_TOKEN is not set");
      const site = env.CONVEX_SITE_URL;
      const qs = new URLSearchParams({ timeout: String(RUN_TIMEOUT_SECS), memory: String(RUN_MEMORY_MB), webhooks: webhooksParam(webhookUrl(site, env.APIFY_WEBHOOK_TOKEN, watch)) });
      const res = await fetch(`${APIFY_BASE}/acts/${MONITOR_ACTOR}/runs?${qs.toString()}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.APIFY_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(monitorInput(url, stateKey(site, watch, url))),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`Apify returned ${res.status}`);
      const json: unknown = await res.json();
      const data = json && typeof json === "object" && "data" in json ? (json.data as Record<string, unknown>) : {};
      runId = typeof data.id === "string" ? data.id : undefined;
    } catch (e) {
      error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    }
    await ctx.runMutation(internal.monitors.recordRun, { monitorId, ...(runId ? { runId } : {}), ...(error ? { error } : {}) });
    return null;
  },
});

export const recordRun = internalMutation({
  args: { monitorId: v.id("monitors"), runId: v.optional(v.string()), error: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { monitorId, runId, error }) => {
    const m = await ctx.db.get("monitors", monitorId);
    if (!m) return null;
    await ctx.db.patch("monitors", monitorId, { ...(runId ? { apify_run_id: runId } : {}), last_error: error, updated_at: Date.now() });
    await audit(ctx, { actor: "apify", kind: error ? "monitor_run_failed" : "monitor_run_started", ref: runId ?? monitorId, detail: { watch: m.watch, url: m.url, error: error ?? null } });
    return null;
  },
});

// ---------------------------------------------------------------- controls

//   npx convex run monitors:setPaused '{"paused":true}'
export const setPaused = internalMutation({
  args: { paused: v.boolean() },
  returns: v.boolean(),
  handler: async (ctx, { paused }) => {
    await setConfig(ctx, PAUSE_KEY, paused);
    await audit(ctx, { actor: "founder", kind: paused ? "monitors_paused" : "monitors_resumed", ref: PAUSE_KEY });
    return paused;
  },
});

//   npx convex run monitors:setCheckInterval '{"minutes":15}'   (minimum 15)
export const setCheckInterval = internalMutation({
  args: { minutes: v.number() },
  returns: v.number(),
  handler: async (ctx, { minutes }) => {
    await setConfig(ctx, INTERVAL_KEY, minutes);
    return intervalMs(minutes) / 60_000;
  },
});

// What the company is watching, for the founder app and `npx convex run monitors:list`.
export const list = query({
  args: {},
  returns: v.array(v.object({ watch: v.string(), url: v.string(), label: v.string(), last_run_at: v.number(), last_error: v.optional(v.string()) })),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("monitors")
      .withIndex("by_active_and_last_run_at", (q) => q.eq("active", true))
      .take(50);
    return rows.map(({ watch, url, label, last_run_at, last_error }) => ({ watch, url, label, last_run_at, ...(last_error ? { last_error } : {}) }));
  },
});
