import { v } from "convex/values";
import { internal } from "./_generated/api";
import { env, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { appendMessage, audit } from "./channels";
import { assign } from "./dispatcher";
import { LINKEDIN_ACTOR, LINKEDIN_SOURCE, SAMPLE_POSTS, SAMPLE_SOURCE, SCAN_REUSE_MS, linkedinInput, linkedinQueries, normalizeLinkedInPost, type RadarSignal } from "./lib/radar";

// Company Radar for the weekly LinkedIn flow (spec 13). Before Market intel's run, Convex runs Apify's LinkedIn
// post search for this week's posts in the company's category and stores them as signals; Market intel reads
// them with `co data signals`. The Apify token stays in Convex env (invariant 6). A scan from the last six days
// is reused, so the weekly run never pays for the same week twice.

const APIFY_BASE = "https://api.apify.com/v2";
const SCAN_TIMEOUT_MS = 150_000;

export const scanContext = internalQuery({
  args: { taskId: v.id("tasks"), now: v.number() },
  returns: v.union(v.null(), v.object({ queries: v.array(v.string()), recent: v.number() })),
  handler: async (ctx, { taskId, now }) => {
    const task = await ctx.db.get("tasks", taskId);
    if (!task) return null;
    const company = await ctx.db.query("company").first();
    const rows = await ctx.db
      .query("signals")
      .withIndex("by_room", (q) => q.eq("room", task.room))
      .order("desc")
      .take(100);
    const recent = rows.filter((s) => s.source === LINKEDIN_SOURCE && s.created_at > now - SCAN_REUSE_MS).length;
    return { queries: linkedinQueries(company?.product ?? ""), recent };
  },
});

// Runs the scan (or reuses this week's), then lets the Dispatcher assign the task.
export const scanThenAssign = internalAction({
  args: { taskId: v.id("tasks") },
  returns: v.null(),
  handler: async (ctx, { taskId }) => {
    const c = await ctx.runQuery(internal.radar.scanContext, { taskId, now: Date.now() });
    if (!c) return null;
    if (c.recent > 0) {
      await ctx.runMutation(internal.radar.finishScan, { taskId, signals: [], reused: c.recent });
      return null;
    }
    let signals: RadarSignal[] = [];
    let error: string | undefined;
    try {
      if (!env.APIFY_TOKEN) throw new Error("APIFY_TOKEN is not set");
      await ctx.runMutation(internal.radar.scanStarted, { taskId });
      const res = await fetch(`${APIFY_BASE}/acts/${LINKEDIN_ACTOR}/run-sync-get-dataset-items?timeout=${SCAN_TIMEOUT_MS / 1000 - 10}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.APIFY_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(linkedinInput(c.queries)),
        signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Apify returned ${res.status}`);
      const items: unknown = await res.json();
      signals = (Array.isArray(items) ? items : []).map(normalizeLinkedInPost).filter((s): s is RadarSignal => s !== null);
    } catch (e) {
      error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    }
    await ctx.runMutation(internal.radar.finishScan, { taskId, signals, ...(error ? { error } : {}) });
    return null;
  },
});

// Visible while the Actor runs (usually under a minute).
export const scanStarted = internalMutation({
  args: { taskId: v.id("tasks") },
  returns: v.null(),
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get("tasks", taskId);
    if (!task) return null;
    await appendMessage(ctx, { room: task.room, sender_kind: "system", sender_name: "Dispatcher", text: "[Dispatcher] Company Radar (Apify) is reading this week's LinkedIn posts about AI meeting notes…" });
    return null;
  },
});

const vSignal = v.object({ url: v.string(), change: v.string(), significance: v.number(), evidence_url: v.string() });

// Saves new posts as signals (deduplicated by URL), says what Company Radar found, and assigns the task.
export const finishScan = internalMutation({
  args: { taskId: v.id("tasks"), signals: v.array(vSignal), reused: v.optional(v.number()), error: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { taskId, signals, reused, error }) => {
    const task = await ctx.db.get("tasks", taskId);
    if (!task || task.status !== "queued") return null;
    const known = new Set(
      (
        await ctx.db
          .query("signals")
          .withIndex("by_room", (q) => q.eq("room", task.room))
          .order("desc")
          .take(300)
      ).map((s) => s.url),
    );
    const now = Date.now();
    let saved = 0;
    for (const s of signals) {
      if (known.has(s.url)) continue;
      known.add(s.url);
      await ctx.db.insert("signals", { room: task.room, source: LINKEDIN_SOURCE, ...s, consumed: false, created_at: now });
      saved += 1;
    }
    // Apify failed: fall back to the labelled sample posts (once), so the week still has something to read.
    let samples = 0;
    if (error) {
      for (const s of SAMPLE_POSTS) {
        if (known.has(s.url)) continue;
        await ctx.db.insert("signals", { room: task.room, source: SAMPLE_SOURCE, ...s, consumed: false, created_at: now });
        samples += 1;
      }
    }
    const text = error
      ? `[Dispatcher] Company Radar (Apify) could not read LinkedIn this time (${error}). Market intel works from ${samples ? `${samples} saved sample posts` : "the sample posts already on file"}.`
      : reused
        ? `[Dispatcher] Company Radar (Apify) already read ${reused} LinkedIn posts from this week. Market intel works from that scan.`
        : `[Dispatcher] Company Radar (Apify) read ${saved} LinkedIn posts from this week about AI meeting notes.`;
    await appendMessage(ctx, { room: task.room, sender_kind: "system", sender_name: "Dispatcher", text });
    await audit(ctx, { actor: "radar", kind: "radar_scan", ref: taskId, detail: { source: LINKEDIN_SOURCE, saved, reused: reused ?? 0, error: error ?? null } });
    await assign(ctx, taskId);
    return null;
  },
});
