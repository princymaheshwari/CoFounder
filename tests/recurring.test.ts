import rateLimiterTest from "@convex-dev/rate-limiter/test";
import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { DEFAULT_PLAN, HOUR_MS, MAX_RECURRING, REQUIRED_ROOMS, RECURRING_SUFFIX, nextRunAt, normalizePlan, planPrompt } from "../convex/lib/recurring";

// Onboarding → recurring threads (convex/onboarding.ts, convex/lib/recurring.ts).

describe("normalizePlan", () => {
  const task = (over: Record<string, unknown> = {}) => ({
    role: "market_intel",
    title: "Scan trends",
    brief: "Review new signals and report three findings.",
    trigger: "interval",
    every_hours: 48,
    cadence_label: "every 2 days",
    ...over,
  });

  test("places each task in its owner's channel and converts hours to ms", () => {
    const [first] = normalizePlan({ tasks: [task()] }).filter((t) => t.role === "market_intel");
    expect(first).toMatchObject({ room: "#marketing", trigger: "interval", every_ms: 48 * HOUR_MS });
  });

  test("drops unknown roles, the Executor and malformed tasks", () => {
    const plan = normalizePlan({ tasks: [task({ role: "executor" }), task({ role: "ceo" }), task({ title: "" }), task()] });
    expect(plan.filter((t) => t.role === "market_intel")).toHaveLength(1);
    expect(plan.some((t) => (t.role as string) === "executor")).toBe(false);
  });

  test("fills every department channel Claude left out", () => {
    const plan = normalizePlan({ tasks: [task()] });
    for (const room of REQUIRED_ROOMS) expect(plan.some((t) => t.room === room)).toBe(true);
  });

  test("caps the list without losing a department", () => {
    const many = Array.from({ length: 12 }, (_, i) => task({ title: `Marketing task ${i}` }));
    const plan = normalizePlan({ tasks: many });
    expect(plan).toHaveLength(MAX_RECURRING);
    for (const room of REQUIRED_ROOMS) expect(plan.some((t) => t.room === room)).toBe(true);
  });

  test("keeps event triggers and dedupes by owner and title", () => {
    const plan = normalizePlan({ tasks: [task({ role: "support", trigger: "event", event_type: "support_ticket", every_hours: undefined }), task({ role: "support", trigger: "event", event_type: "support_ticket" })] });
    const support = plan.filter((t) => t.role === "support");
    expect(support).toHaveLength(1);
    expect(support[0]).toMatchObject({ trigger: "event", event_type: "support_ticket", room: "#customer" });
  });

  test("garbage falls back to one task per department", () => {
    expect(normalizePlan(null).map((t) => t.room)).toEqual([...REQUIRED_ROOMS]);
    expect(normalizePlan("nope")).toHaveLength(REQUIRED_ROOMS.length);
  });

  test("nextRunAt and the prompt", () => {
    expect(nextRunAt(HOUR_MS, 1_000)).toBe(1_000 + HOUR_MS);
    const prompt = planPrompt({ name: "Acme", what: "Notes", priorities: "Retention", goals: "10k MRR", links: ["https://a.example"], docs: [{ name: "plan.md", excerpt: "Q4 plan" }] });
    expect(prompt).toContain("Company: Acme");
    expect(prompt).toContain("--- plan.md");
  });
});

function setup() {
  const t = convexTest(schema, import.meta.glob("../convex/**/*.ts"));
  for (const name of ["marketingPool", "customerPool", "financePool", "leadershipPool"]) workpoolTest.register(t, name);
  rateLimiterTest.register(t, "rateLimiter");
  return t;
}

const INPUT = { name: "Lumen Notes", what: "AI meeting notes", priorities: "Fewer tickets", goals: "Grow Pro", links: [], docs: [] };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T16:00:00Z"));
  vi.stubEnv("CO_TOKEN_SECRET", "test-secret");
  vi.stubEnv("CREAO_API_KEY", "capi_test");
  vi.stubEnv("CREAO_WEBHOOK_TOKEN", "hook_secret");
  vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("confirm and runDue", () => {
  test("confirm opens one thread per task with a Dispatcher ASSIGN and a live first run", async () => {
    const t = setup();
    await t.mutation(internal.seed.config, {});
    const created = await t.mutation(api.onboarding.confirm, { input: INPUT, tasks: DEFAULT_PLAN });
    expect(created).toHaveLength(DEFAULT_PLAN.length);
    expect(new Set(created.map((c) => c.room))).toEqual(new Set(["#customer", "#finance", "#marketing", "#leadership"]));
    await t.run(async (ctx) => {
      for (const c of created) {
        const task = (await ctx.db.get(c.taskId))!;
        expect(task.mode).toBe("live");
        expect(task.brief).toContain(RECURRING_SUFFIX);
        const msgs = await ctx.db
          .query("messages")
          .withIndex("by_thread", (q) => q.eq("thread", c.taskId))
          .collect();
        expect(msgs[0].text.startsWith("[Dispatcher]")).toBe(true);
      }
      const rows = await ctx.db.query("recurring").collect();
      expect(rows.filter((r) => r.trigger === "event").map((r) => r.event_type)).toEqual(["support_ticket"]);
      expect(rows.filter((r) => r.trigger === "interval").every((r) => r.next_run_at! > Date.now())).toBe(true);
      expect((await ctx.db.query("company").first())?.onboarding?.what).toBe("AI meeting notes");
    });
  });

  test("a second confirm replaces the earlier plan", async () => {
    const t = setup();
    await t.mutation(internal.seed.config, {});
    await t.mutation(api.onboarding.confirm, { input: INPUT, tasks: DEFAULT_PLAN });
    await t.mutation(api.onboarding.confirm, { input: INPUT, tasks: DEFAULT_PLAN.slice(0, 3) });
    const active = await t.run(async (ctx) => (await ctx.db.query("recurring").collect()).filter((r) => r.active));
    expect(active).toHaveLength(3);
  });

  test("runDue starts the next run in the same thread and moves next_run_at", async () => {
    const t = setup();
    await t.mutation(internal.seed.config, {});
    const created = await t.mutation(api.onboarding.confirm, { input: INPUT, tasks: DEFAULT_PLAN });
    expect(await t.mutation(internal.onboarding.runDue, {})).toBe(0);
    const spend = created.find((c) => c.title === "Vendor and credit spend check")!;
    vi.setSystemTime(Date.now() + 25 * HOUR_MS);
    expect(await t.mutation(internal.onboarding.runDue, {})).toBeGreaterThanOrEqual(1);
    await t.run(async (ctx) => {
      const tasks = await ctx.db.query("tasks").collect();
      const next = tasks.find((x) => x.thread === spend.taskId)!;
      expect(next.role).toBe("spend");
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_thread", (q) => q.eq("thread", spend.taskId))
        .collect();
      expect(msgs.filter((m) => m.task === next._id)).toHaveLength(1);
      const row = (await ctx.db.get(spend.recurringId))!;
      expect(row.runs).toBe(2);
      expect(row.next_run_at).toBe(Date.now() + 24 * HOUR_MS);
    });
  });

  test("a new ticket leaves a note in the ticket-triage thread", async () => {
    const t = setup();
    await t.mutation(internal.seed.config, {});
    const created = await t.mutation(api.onboarding.confirm, { input: INPUT, tasks: DEFAULT_PLAN });
    const triage = created.find((c) => c.title === "Triage new support tickets")!;
    const { taskId } = await t.mutation(internal.dev.seedSupportTicket, { subject: "Charged twice", body: "Two $35 charges." });
    await t.run(async (ctx) => {
      const notes = await ctx.db
        .query("messages")
        .withIndex("by_thread", (q) => q.eq("thread", triage.taskId))
        .collect();
      expect(notes.some((m) => m.text.includes("support ticket"))).toBe(true);
      expect((await ctx.db.get(taskId))?.thread).toBeUndefined();
    });
  });
});

describe("parseRecurringBrief", () => {
  test("round-trips recurringBrief and strips the standing instruction", async () => {
    const { parseRecurringBrief, recurringBrief } = await import("../convex/lib/recurring");
    const t = DEFAULT_PLAN[3];
    expect(parseRecurringBrief(recurringBrief(t))).toEqual({ cadence: t.cadence_label, title: t.title, brief: t.brief });
    expect(parseRecurringBrief("Handle ticket 123: charged twice")).toBeNull();
  });
});
