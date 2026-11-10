import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { env, httpAction, internalAction, internalMutation } from "./_generated/server";
import { audit } from "./channels";
import {
  EVENT_THRESHOLD,
  MONITOR_TASKS,
  dataHints,
  isMonitorTask,
  normalizeMonitorItem,
  parseCallback,
  signalBrief,
  type MonitorSignal,
  type MonitorTask,
} from "./lib/apify";
import { roomByName, taskFromEvent } from "./tasks";

// Apify change monitors (spec 13, system-design §10). Each Apify Task (a scheduled monema/apify-change-monitor
// run) has a webhook on ACTOR.RUN.SUCCEEDED → POST /apify-callback?token=<APIFY_WEBHOOK_TOKEN>&task=<task name>.
// The callback answers at once and schedules ingestSignals, which pulls the run's dataset, normalizes and scores
// each item, and saveSignals stores new ones (deduped by url + change hash). Signals ≥ 0.6 become events and tasks
// in the task's channel; the rest stay in `signals` for standups (`co data signals`).

const APIFY_BASE = "https://api.apify.com/v2";
const FETCH_TIMEOUT_MS = 30_000;
const MAX_ITEMS = 100;

export const apifyCallback = httpAction(async (ctx, req) => {
  const params = new URL(req.url).searchParams;
  if (!env.APIFY_WEBHOOK_TOKEN || params.get("token") !== env.APIFY_WEBHOOK_TOKEN) {
    return new Response("unauthorized", { status: 401 });
  }
  const task = params.get("task") ?? "";
  if (!isMonitorTask(task)) return new Response("unknown task", { status: 400 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  const parsed = parseCallback(body);
  if (!parsed) return new Response("missing run id or dataset id", { status: 400 });
  await ctx.scheduler.runAfter(0, internal.apify.ingestSignals, {
    task,
    runId: parsed.runId,
    ...(parsed.datasetId ? { datasetId: parsed.datasetId } : {}),
    ...(parsed.items ? { items: parsed.items.slice(0, MAX_ITEMS) } : {}),
  });
  return new Response(null, { status: 200 });
});

const vTask = v.union(...(Object.keys(MONITOR_TASKS) as MonitorTask[]).map((k) => v.literal(k)));

// Pulls the run's dataset (unless the items came inline), normalizes and scores each item, then saves.
export const ingestSignals = internalAction({
  args: { task: vTask, runId: v.string(), datasetId: v.optional(v.string()), items: v.optional(v.array(v.any())) },
  returns: v.null(),
  handler: async (ctx, { task, runId, datasetId, items }) => {
    let raw: unknown[] = items ?? [];
    let error: string | undefined;
    if (!items) {
      try {
        if (!env.APIFY_TOKEN) throw new Error("APIFY_TOKEN is not set");
        if (!datasetId) throw new Error("no dataset id");
        const res = await fetch(`${APIFY_BASE}/datasets/${encodeURIComponent(datasetId)}/items?clean=true&format=json&limit=${MAX_ITEMS}`, {
          headers: { Authorization: `Bearer ${env.APIFY_TOKEN}` },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`Apify returned ${res.status}`);
        const json: unknown = await res.json();
        raw = Array.isArray(json) ? json : [];
      } catch (e) {
        error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      }
    }
    const signals = raw.map((it) => normalizeMonitorItem(task, it)).filter((s): s is MonitorSignal => s !== null);
    await ctx.runMutation(internal.apify.saveSignals, { task, runId, signals, items: raw.length, ...(error ? { error } : {}) });
    return null;
  },
});

const vSignal = v.object({ url: v.string(), change: v.string(), significance: v.number(), evidence_url: v.string(), change_hash: v.string() });

// Stores new signals (a repeated webhook or an unchanged page adds nothing) and turns significant ones into tasks.
export const saveSignals = internalMutation({
  args: { task: vTask, runId: v.string(), signals: v.array(vSignal), items: v.number(), error: v.optional(v.string()) },
  returns: v.object({ saved: v.number(), events: v.array(v.id("events")) }),
  handler: async (ctx, { task, runId, signals, items, error }) => {
    const cfg = MONITOR_TASKS[task];
    const room = await roomByName(ctx, cfg.room);
    const now = Date.now();
    const events: Id<"events">[] = [];
    let saved = 0;
    for (const s of signals) {
      const dup = await ctx.db
        .query("signals")
        .withIndex("by_url_and_change_hash", (q) => q.eq("url", s.url).eq("change_hash", s.change_hash))
        .first();
      if (dup) continue;
      const signalId = await ctx.db.insert("signals", { room, source: task, ...s, consumed: false, created_at: now });
      saved += 1;
      await audit(ctx, { actor: "apify", kind: "signal", ref: signalId, detail: { task, run: runId, url: s.url, significance: s.significance } });
      if (s.significance < EVENT_THRESHOLD) continue;
      const eventId = await ctx.db.insert("events", {
        type: cfg.event,
        payload: { signal: signalId, source: task, apify_run: runId, url: s.url, brief: signalBrief(task, s), refs: [s.evidence_url], data_hints: dataHints(task) },
        source: "apify",
        processed: false,
        created_at: now,
      });
      await ctx.db.patch(signalId, { consumed: true });
      events.push(eventId);
      await taskFromEvent(ctx, eventId);
    }
    await audit(ctx, { actor: "apify", kind: "apify_ingest", ref: runId, detail: { task, items, saved, events: events.length, error: error ?? null } });
    return { saved, events };
  },
});
