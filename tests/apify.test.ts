import rateLimiterTest from "@convex-dev/rate-limiter/test";
import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import { diffSummary, hashText, normalizeMonitorItem, parseCallback, reviewStars, significance } from "../convex/lib/apify";

// Apify change monitors (spec 13): convex/lib/apify.ts + convex/apify.ts.

// Shape verified on monema/apify-change-monitor's dataset schema and README.
const monitorItem = (over: Record<string, unknown> = {}) => ({
  url: "https://vendor.example.com/pricing",
  final_url: "https://vendor.example.com/pricing",
  selector: "main",
  status: "changed",
  raw_changed: true,
  significant_change: true,
  change_ratio: 0.08,
  message: "Content changed",
  fetched_at: "2026-11-10T10:00:00Z",
  previous_hash: "aaa",
  current_hash: "bbb",
  previous_excerpt: "Team plan $20 per seat per month, billed annually. Contact sales for Enterprise.",
  current_excerpt: "Team plan $26 per seat per month, billed annually. Contact sales for Enterprise.",
  ...over,
});

describe("parseCallback", () => {
  test("reads Apify's default payload and our template", () => {
    expect(parseCallback({ eventType: "ACTOR.RUN.SUCCEEDED", resource: { id: "run1", defaultDatasetId: "ds1" } })).toEqual({ runId: "run1", datasetId: "ds1", items: null });
    expect(parseCallback({ runId: "run2", datasetId: "ds2" })).toEqual({ runId: "run2", datasetId: "ds2", items: null });
    expect(parseCallback({ runId: "inject-1", items: [{}] })).toEqual({ runId: "inject-1", datasetId: null, items: [{}] });
  });

  test("rejects a body without a run id or anything to read", () => {
    expect(parseCallback({ resource: { defaultDatasetId: "ds" } })).toBeNull();
    expect(parseCallback({ runId: "r" })).toBeNull();
    expect(parseCallback("nope")).toBeNull();
  });
});

describe("normalizeMonitorItem and significance", () => {
  test("a vendor price change is 0.9 with a before → after summary", () => {
    const s = normalizeMonitorItem("vendor-pricing", monitorItem())!;
    expect(s.significance).toBe(0.9);
    expect(s.change).toContain("$20");
    expect(s.change).toContain("→");
    expect(s.change).toContain("$26");
    expect(s.change_hash).toBe("bbb");
    expect(s.evidence_url).toBe("https://vendor.example.com/pricing");
  });

  test("first snapshots and unchanged pages produce no signal", () => {
    expect(normalizeMonitorItem("vendor-pricing", monitorItem({ status: "initial_snapshot" }))).toBeNull();
    expect(normalizeMonitorItem("vendor-pricing", monitorItem({ status: "unchanged" }))).toBeNull();
    expect(normalizeMonitorItem("vendor-pricing", { status: "changed" })).toBeNull();
  });

  test("a minor change still counts when it touches a price", () => {
    expect(normalizeMonitorItem("competitor-pricing", monitorItem({ status: "minor_change", significant_change: false }))!.significance).toBe(0.9);
  });

  test("a pricing page change away from prices is 0.2", () => {
    const s = normalizeMonitorItem("competitor-pricing", monitorItem({ previous_excerpt: "Trusted by 10,000 teams worldwide.", current_excerpt: "Trusted by 12,000 teams worldwide." }))!;
    expect(s.significance).toBe(0.2);
  });

  test("a low-star review about cancelling is 0.7, a happy one is 0.2", () => {
    expect(significance("reviews", "https://reviews.example.com/app", "1/5 stars. Cancelled after the sync bug ate my notes.")).toBe(0.7);
    expect(significance("reviews", "https://reviews.example.com/app", "5/5 love it")).toBe(0.2);
    expect(reviewStars("★★☆☆☆ too expensive")).toBe(2);
  });

  test("a new review is scored by its own stars, not an older review's", () => {
    const s = normalizeMonitorItem("reviews", monitorItem({
      url: "https://reviews.example.com/app",
      previous_excerpt: "Latest reviews: 5/5 stars. The summaries save me an hour a week.",
      current_excerpt: "Latest reviews: 1/5 stars. Charged twice this month, cancelling. 5/5 stars. The summaries save me an hour a week.",
    }))!;
    expect(s.significance).toBe(0.7);
  });

  test("careers and changelog entries are 0.5", () => {
    expect(significance("competitor-careers", "https://rival.example.com/careers", "Senior ML engineer, meetings")).toBe(0.5);
    expect(significance("community", "https://rival.example.com/changelog", "New: calendar sync")).toBe(0.5);
  });

  test("the change summary stays within 500 chars and the hash falls back to the text", () => {
    expect(diffSummary("a".repeat(2000), `${"a".repeat(1000)}b${"a".repeat(1000)}`).length).toBeLessThanOrEqual(500);
    const s = normalizeMonitorItem("community", monitorItem({ current_hash: undefined }))!;
    expect(s.change_hash).toBe(hashText(s.change));
  });
});

function setup() {
  const t = convexTest(schema, import.meta.glob("../convex/**/*.ts"));
  for (const name of ["marketingPool", "customerPool", "financePool", "leadershipPool"]) workpoolTest.register(t, name);
  rateLimiterTest.register(t, "rateLimiter");
  return t;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-10T16:00:00Z"));
  vi.stubEnv("CO_TOKEN_SECRET", "test-secret");
  vi.stubEnv("CREAO_API_KEY", "capi_test");
  vi.stubEnv("CREAO_WEBHOOK_TOKEN", "hook_secret");
  vi.stubEnv("APIFY_WEBHOOK_TOKEN", "apify_hook");
  vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("/apify-callback → signals → tasks", () => {
  const post = (t: ReturnType<typeof setup>, query: string, body: unknown) =>
    t.fetch(`/apify-callback?${query}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  test("rejects a wrong token and an unknown task", async () => {
    const t = setup();
    expect((await post(t, "token=nope&task=vendor-pricing", { runId: "r", datasetId: "d" })).status).toBe(401);
    expect((await post(t, "token=apify_hook&task=weather", { runId: "r", datasetId: "d" })).status).toBe(400);
    expect((await post(t, "token=apify_hook&task=vendor-pricing", { hello: 1 })).status).toBe(400);
  });

  test("a run's dataset becomes signals; a vendor price rise opens a Spend task in #finance", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify_test");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        calls.push(String(url));
        if (String(url).includes("api.apify.com/v2/datasets/ds1/items")) return new Response(JSON.stringify([monitorItem(), monitorItem({ url: "https://other.example.com/", status: "unchanged" })]), { status: 200 });
        return new Response("{}", { status: 500 });
      }),
    );
    const t = setup();
    await t.mutation(internal.seed.config, {});
    await t.action(internal.apify.ingestSignals, { task: "vendor-pricing", runId: "run1", datasetId: "ds1" });
    expect(calls.some((u) => u.includes("/datasets/ds1/items"))).toBe(true);
    await t.run(async (ctx) => {
      const signals = await ctx.db.query("signals").collect();
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({ source: "vendor-pricing", significance: 0.9, consumed: true });
      const events = await ctx.db.query("events").collect();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "signal.vendor_price", source: "apify", processed: true });
      const tasks = await ctx.db.query("tasks").collect();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].role).toBe("spend");
      expect((await ctx.db.get(tasks[0].room))!.name).toBe("#finance");
      expect(tasks[0].brief).toContain("vendors changed its pricing page");
    });
  });

  test("the same run delivered twice adds no duplicate signals or tasks", async () => {
    const t = setup();
    await t.mutation(internal.seed.config, {});
    const body = { runId: "inject-1", items: [monitorItem()] };
    expect((await post(t, "token=apify_hook&task=vendor-pricing", body)).status).toBe(200);
    expect((await post(t, "token=apify_hook&task=vendor-pricing", body)).status).toBe(200);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("signals").collect()).toHaveLength(1);
      expect(await ctx.db.query("events").collect()).toHaveLength(1);
      expect((await ctx.db.query("tasks").collect()).filter((x) => x.role === "spend")).toHaveLength(1);
    });
  });

  test("while agent runs are paused a significant signal waits, and resuming opens its task", async () => {
    const t = setup();
    await t.mutation(internal.seed.config, {});
    await t.mutation(internal.onboarding.setRecurringPaused, { paused: true });
    const res = await t.mutation(internal.apify.saveSignals, {
      task: "vendor-pricing",
      runId: "r-held",
      items: 1,
      signals: [{ url: "https://vendor.example.com/pricing", change: "$20 → $26 per seat", significance: 0.9, evidence_url: "https://vendor.example.com/pricing", change_hash: "held1" }],
    });
    expect(res).toMatchObject({ saved: 1, held: 1 });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("tasks").collect()).toHaveLength(0);
      expect((await ctx.db.query("events").collect())[0]).toMatchObject({ type: "signal.vendor_price", processed: false });
      const notes = (await ctx.db.query("messages").collect()).filter((m) => m.text.includes("Agent runs are paused"));
      expect(notes).toHaveLength(1);
    });
    expect(await t.mutation(internal.onboarding.setRecurringPaused, { paused: false })).toMatchObject({ paused: false, released: 1 });
    await t.run(async (ctx) => {
      const tasks = await ctx.db.query("tasks").collect();
      expect(tasks.map((x) => x.role)).toEqual(["spend"]);
      expect((await ctx.db.query("events").collect())[0].processed).toBe(true);
    });
  });

  test("a low-significance change is kept for standups without a task", async () => {
    const t = setup();
    await t.mutation(internal.seed.config, {});
    const res = await t.mutation(internal.apify.saveSignals, {
      task: "community",
      runId: "r9",
      items: 1,
      signals: [{ url: "https://forum.example.com/t/1", change: "New reply", significance: 0.2, evidence_url: "https://forum.example.com/t/1", change_hash: "h1" }],
    });
    expect(res).toMatchObject({ saved: 1, events: [] });
    await t.run(async (ctx) => {
      expect((await ctx.db.query("signals").collect())[0]).toMatchObject({ source: "community", consumed: false });
      expect(await ctx.db.query("tasks").collect()).toHaveLength(0);
    });
  });

  test("a failed dataset fetch is audited and creates nothing", async () => {
    const t = setup();
    await t.mutation(internal.seed.config, {});
    await t.action(internal.apify.ingestSignals, { task: "reviews", runId: "r5", datasetId: "ds5" }); // APIFY_TOKEN unset
    await t.run(async (ctx) => {
      expect(await ctx.db.query("signals").collect()).toHaveLength(0);
      const row = (await ctx.db.query("audit_log").collect()).find((r) => r.kind === "apify_ingest")!;
      expect(row.detail).toMatchObject({ task: "reviews", saved: 0, error: "APIFY_TOKEN is not set" });
    });
  });
});
