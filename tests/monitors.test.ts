import rateLimiterTest from "@convex-dev/rate-limiter/test";
import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import { cleanUrl, desiredMonitors, intervalMs, pageConfirms, stateKey, webhookUrl, webhooksParam } from "../convex/lib/monitors";

// Autonomous Apify monitors: convex/lib/monitors.ts + convex/monitors.ts.

describe("desiredMonitors", () => {
  test("watches every page in the profile, once, on the right watch list", () => {
    const w = desiredMonitors({
      competitors: [
        { name: "Rival", pricing_url: "https://rival.example.com/pricing", careers_url: "https://rival.example.com/careers", changelog_url: "https://rival.example.com/changelog#top" },
        { name: "NoUrl" },
        { name: "Dup", pricing_url: "https://rival.example.com/pricing" },
      ],
      vendors: [{ name: "Host", pricing_url: "https://host.example.com/pricing" }, { name: "Fictional" }],
      review_urls: ["https://reviews.example.com/app"],
    });
    expect(w.map((x) => [x.watch, x.url])).toEqual([
      ["competitor-pricing", "https://rival.example.com/pricing"],
      ["competitor-changelog", "https://rival.example.com/changelog"],
      ["competitor-careers", "https://rival.example.com/careers"],
      ["vendor-pricing", "https://host.example.com/pricing"],
      ["reviews", "https://reviews.example.com/app"],
    ]);
  });

  test("ignores non-web and private URLs", () => {
    expect(cleanUrl("ftp://x.example.com")).toBeNull();
    expect(cleanUrl("http://localhost:3000/pricing")).toBeNull();
    expect(cleanUrl("not a url")).toBeNull();
  });
});

describe("run plumbing", () => {
  test("state keys separate deployments and pages", () => {
    const a = stateKey("https://outgoing-ocelot-470.convex.site", "competitor-pricing", "https://x.example.com/pricing");
    expect(a).toMatch(/^cofounder-outgoing-ocelot-470-competitor-pricing-[0-9a-f]{8}$/);
    expect(stateKey("https://exuberant-canary-565.convex.site", "competitor-pricing", "https://x.example.com/pricing")).not.toBe(a);
  });

  test("the one-off webhook is base64 JSON pointing at /apify-callback with the watch list", () => {
    const url = webhookUrl("https://d.convex.site/", "t&k", "vendor-pricing");
    expect(url).toBe("https://d.convex.site/apify-callback?token=t%26k&task=vendor-pricing");
    expect(JSON.parse(atob(webhooksParam(url)))).toEqual([{ eventTypes: ["ACTOR.RUN.SUCCEEDED"], requestUrl: url }]);
  });

  test("intervals default to an hour and never go below 15 minutes", () => {
    expect(intervalMs(undefined)).toBe(60 * 60_000);
    expect(intervalMs(1)).toBe(15 * 60_000);
  });

  test("a discovered page counts only if it loads as HTML and names the company", () => {
    expect(pageConfirms("Otter.ai", 200, "text/html; charset=utf-8", "<title>Otter Pricing</title>")).toBe(true);
    expect(pageConfirms("Otter.ai", 404, "text/html", "otter")).toBe(false);
    expect(pageConfirms("Otter.ai", 200, "text/html", "<title>Parked domain</title>")).toBe(false);
    expect(pageConfirms("Otter.ai", 200, "application/pdf", "otter")).toBe(false);
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
  vi.stubEnv("APIFY_TOKEN", "apify_test");
  vi.stubEnv("APIFY_WEBHOOK_TOKEN", "apify_hook");
  vi.stubEnv("CONVEX_SITE_URL", "https://outgoing-ocelot-470.convex.site");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("runDue and startRun", () => {
  test("syncs the seeded competitors, checks each once, and waits for the interval", async () => {
    const t = setup();
    await t.mutation(internal.seed.config, {});
    expect(await t.mutation(internal.monitors.runDue, {})).toBe(3); // Otter, Fireflies, Fathom pricing pages
    expect(await t.mutation(internal.monitors.runDue, {})).toBe(0);
    vi.setSystemTime(Date.now() + 61 * 60_000);
    expect(await t.mutation(internal.monitors.runDue, {})).toBe(3);
  });

  test("a removed competitor stops being watched", async () => {
    const t = setup();
    await t.mutation(internal.seed.config, {});
    await t.mutation(internal.monitors.sync, {});
    await t.run(async (ctx) => {
      const c = (await ctx.db.query("company").first())!;
      await ctx.db.patch(c._id, { competitors: c.competitors.slice(0, 1) });
    });
    expect(await t.mutation(internal.monitors.sync, {})).toMatchObject({ removed: 2, active: 1 });
  });

  test("pausing stops all checks", async () => {
    const t = setup();
    await t.mutation(internal.seed.config, {});
    await t.mutation(internal.monitors.setPaused, { paused: true });
    expect(await t.mutation(internal.monitors.runDue, {})).toBe(0);
  });

  test("startRun starts the change monitor with the page, its state key and the one-off webhook", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "null")) });
        return new Response(JSON.stringify({ data: { id: "run42", status: "READY", defaultDatasetId: "ds42" } }), { status: 201 });
      }),
    );
    const t = setup();
    await t.mutation(internal.seed.config, {});
    await t.mutation(internal.monitors.sync, {});
    const m = await t.run(async (ctx) => (await ctx.db.query("monitors").first())!);
    await t.action(internal.monitors.startRun, { monitorId: m._id, watch: m.watch, url: m.url });
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe("/v2/acts/monema~apify-change-monitor/runs");
    expect(JSON.parse(atob(u.searchParams.get("webhooks")!))[0].requestUrl).toBe(
      "https://outgoing-ocelot-470.convex.site/apify-callback?token=apify_hook&task=competitor-pricing",
    );
    expect(calls[0].body).toMatchObject({ url: m.url, min_change_ratio: 0.01 });
    expect((calls[0].body as { state_key: string }).state_key).toMatch(/^cofounder-outgoing-ocelot-470-/);
    expect((await t.run(async (ctx) => ctx.db.get(m._id)))!.apify_run_id).toBe("run42");
  });

  test("a failed start is recorded on the monitor", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 402 })));
    const t = setup();
    await t.mutation(internal.seed.config, {});
    await t.mutation(internal.monitors.sync, {});
    const m = await t.run(async (ctx) => (await ctx.db.query("monitors").first())!);
    await t.action(internal.monitors.startRun, { monitorId: m._id, watch: m.watch, url: m.url });
    expect((await t.run(async (ctx) => ctx.db.get(m._id)))!.last_error).toBe("Apify returned 402");
  });

  test("discovery saves only confirmed pages, and never overwrites the founder's URLs", async () => {
    const t = setup();
    await t.mutation(internal.seed.config, {});
    await t.mutation(internal.monitors.saveDiscovered, { kind: "competitor", name: "Otter.ai", pricing_url: "https://elsewhere.example.com/p", careers_url: "https://otter.ai/careers" });
    const otter = await t.run(async (ctx) => (await ctx.db.query("company").first())!.competitors.find((c) => c.name === "Otter.ai")!);
    expect(otter.pricing_url).toBe("https://otter.ai/pricing");
    expect(otter.careers_url).toBe("https://otter.ai/careers");
  });
});
