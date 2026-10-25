import rateLimiterTest from "@convex-dev/rate-limiter/test";
import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { normalizeLinkedInPost } from "../convex/lib/radar";
import { DEFAULT_PLAN, FLOW_SUFFIX, HOUR_MS, LINKEDIN_WEEKLY, MAX_RECURRING, REQUIRED_ROOMS, RECURRING_SUFFIX, nextRunAt, normalizePlan, planPrompt } from "../convex/lib/recurring";

// Onboarding → recurring threads (convex/onboarding.ts, convex/lib/recurring.ts).

describe("normalizePlan", () => {
  const task = (over: Record<string, unknown> = {}) => ({
    role: "spend",
    title: "Scan trends",
    brief: "Review new signals and report three findings.",
    trigger: "interval",
    every_hours: 48,
    cadence_label: "every 2 days",
    ...over,
  });

  test("places each task in its owner's channel and converts hours to ms", () => {
    const mine = normalizePlan({ tasks: [task()] }).find((t) => t.title === "Scan trends");
    expect(mine).toMatchObject({ room: "#finance", trigger: "interval", every_ms: 48 * HOUR_MS });
  });

  test("Claude's own Market intel and Content tasks give way to the LinkedIn flow", () => {
    const plan = normalizePlan({ tasks: [task({ role: "market_intel", title: "Competitor watch" }), task({ role: "content", title: "Draft posts" })] });
    expect(plan.filter((t) => t.room === "#marketing")).toEqual([LINKEDIN_WEEKLY]);
  });

  test("the weekly LinkedIn flow always leads #marketing", () => {
    const plan = normalizePlan({ tasks: [task()] });
    expect(plan.find((t) => t.room === "#marketing")).toEqual(LINKEDIN_WEEKLY);
    expect(normalizePlan(null).filter((t) => t.flow === "linkedin_weekly")).toHaveLength(1);
  });

  test("drops unknown roles, the Executor and malformed tasks", () => {
    const plan = normalizePlan({ tasks: [task({ role: "executor" }), task({ role: "ceo" }), task({ title: "" }), task()] });
    expect(plan.filter((t) => t.role === "spend" && t.title === "Scan trends")).toHaveLength(1);
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
  vi.unstubAllGlobals();
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
      for (const c of created.filter((x) => x.title !== LINKEDIN_WEEKLY.title)) {
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

describe("Company Radar: LinkedIn posts", () => {
  const item = {
    type: "post",
    linkedinUrl: "https://www.linkedin.com/posts/someone_activity-1",
    content: "AI   note takers are\nnow summarising action items live.",
    author: { name: "Dana Lee" },
    engagement: { likes: 120, comments: 14, shares: 6 },
  };

  test("normalizes a post into a signal with its URL as evidence", () => {
    const s = normalizeLinkedInPost(item)!;
    expect(s.url).toBe(item.linkedinUrl);
    expect(s.evidence_url).toBe(item.linkedinUrl);
    expect(s.change).toBe("Dana Lee on LinkedIn: AI note takers are now summarising action items live. (120 likes, 14 comments, 6 reposts)");
    expect(s.significance).toBeGreaterThan(0.2);
    expect(s.significance).toBeLessThanOrEqual(0.9);
  });

  test("drops items without a URL or text, and keeps change under 500 characters", () => {
    expect(normalizeLinkedInPost({ ...item, linkedinUrl: undefined })).toBeNull();
    expect(normalizeLinkedInPost({ ...item, content: "" })).toBeNull();
    expect(normalizeLinkedInPost({ ...item, type: "comment" })).toBeNull();
    expect(normalizeLinkedInPost({ ...item, content: "x".repeat(900) })!.change.length).toBeLessThanOrEqual(500);
  });
});

describe("the weekly LinkedIn flow", () => {
  const apifyItems = [
    { type: "post", linkedinUrl: "https://www.linkedin.com/posts/a_activity-1", content: "Meeting notes that write the follow-up for you.", author: { name: "A" }, engagement: { likes: 40, comments: 3, shares: 1 } },
    { type: "post", linkedinUrl: "https://www.linkedin.com/posts/b_activity-2", content: "Teams want notes synced to their calendar.", author: { name: "B" }, engagement: { likes: 9, comments: 0, shares: 0 } },
  ];

  test("confirm records the approval as a decision and a rule, scans LinkedIn, then assigns Market intel", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify_test");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        calls.push(String(url));
        if (String(url).includes("api.apify.com")) return new Response(JSON.stringify(apifyItems), { status: 201 });
        return new Response("{}", { status: 500 });
      }),
    );
    const t = setup();
    await t.mutation(internal.seed.config, {});
    const [flow] = await t.mutation(api.onboarding.confirm, { input: INPUT, tasks: [LINKEDIN_WEEKLY] });
    expect(flow.room).toBe("#marketing");

    // Until the scan finishes the task waits: no ASSIGN yet.
    const before = await t.run(async (ctx) => ({
      task: (await ctx.db.get(flow.taskId))!,
      rules: await ctx.db.query("rules").collect(),
      decisions: await ctx.db.query("decisions").collect(),
      opened: await ctx.db.query("messages").withIndex("by_task", (q) => q.eq("task", flow.taskId)).collect(),
    }));
    expect(before.task.status).toBe("queued");
    expect(before.opened).toHaveLength(0);
    expect(before.task.brief).toContain(FLOW_SUFFIX.linkedin_weekly);
    const rule = before.rules.find((r) => r.action_type === "publish_post")!;
    expect(rule).toMatchObject({ status: "active", effect: "allow", scope: { level: "role", role: "content" } });
    expect(rule.text).toMatch(/^R\d+: Content may publish the weekly LinkedIn post/);
    expect(before.decisions.filter((d) => d.action_type === "publish_post" && d.decided_by === "founder" && d.choice === "approve")).toHaveLength(1);

    await t.action(internal.radar.scanThenAssign, { taskId: flow.taskId });
    await t.run(async (ctx) => {
      const signals = await ctx.db.query("signals").collect();
      expect(signals.map((s) => s.evidence_url).sort()).toEqual(apifyItems.map((i) => i.linkedinUrl).sort());
      const msgs = await ctx.db.query("messages").collect();
      expect(msgs.some((m) => m.text.includes("Company Radar (Apify) read 2 LinkedIn posts"))).toBe(true);
      expect(msgs.some((m) => m.task === flow.taskId && m.text.startsWith("[Dispatcher]"))).toBe(true);
    });
    expect(calls.some((c) => c.includes("/acts/harvestapi~linkedin-post-search/run-sync-get-dataset-items"))).toBe(true);
  });

  test("a scan from this week is reused instead of calling Apify again", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        calls.push(String(url));
        return new Response("{}", { status: 500 });
      }),
    );
    const t = setup();
    await t.mutation(internal.seed.config, {});
    await t.run(async (ctx) => {
      const room = (await ctx.db.query("rooms").withIndex("by_name", (q) => q.eq("name", "#marketing")).unique())!;
      await ctx.db.insert("signals", { room: room._id, source: "linkedin-weekly", url: "u", change: "c", significance: 0.5, evidence_url: "u", consumed: false, created_at: Date.now() - HOUR_MS });
    });
    const [flow] = await t.mutation(api.onboarding.confirm, { input: INPUT, tasks: [LINKEDIN_WEEKLY] });
    await t.action(internal.radar.scanThenAssign, { taskId: flow.taskId });
    expect(calls.filter((c) => c.includes("api.apify.com"))).toHaveLength(0);
    const msgs = await t.run(async (ctx) => await ctx.db.query("messages").collect());
    expect(msgs.some((m) => m.text.includes("already read 1 LinkedIn posts"))).toBe(true);
  });

  test("when Apify fails, labelled sample posts keep the week running", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );
    const t = setup();
    await t.mutation(internal.seed.config, {});
    const [flow] = await t.mutation(api.onboarding.confirm, { input: INPUT, tasks: [LINKEDIN_WEEKLY] });
    await t.action(internal.radar.scanThenAssign, { taskId: flow.taskId }); // APIFY_TOKEN is not set here
    await t.run(async (ctx) => {
      const signals = await ctx.db.query("signals").collect();
      expect(signals.length).toBeGreaterThan(0);
      expect(signals.every((s) => s.source === "linkedin-sample" && s.change.startsWith("Sample post"))).toBe(true);
      const msgs = await ctx.db.query("messages").collect();
      expect(msgs.some((m) => m.text.includes("could not read LinkedIn") && m.text.includes("sample posts"))).toBe(true);
      expect(msgs.some((m) => m.task === flow.taskId && m.text.startsWith("[Dispatcher]"))).toBe(true); // assigned
    });
  });

  test("a second confirm keeps the one approval rule", async () => {
    const t = setup();
    await t.mutation(internal.seed.config, {});
    await t.mutation(api.onboarding.confirm, { input: INPUT, tasks: [LINKEDIN_WEEKLY] });
    await t.mutation(api.onboarding.confirm, { input: INPUT, tasks: [LINKEDIN_WEEKLY] });
    const rules = await t.run(async (ctx) => (await ctx.db.query("rules").collect()).filter((r) => r.action_type === "publish_post"));
    expect(rules).toHaveLength(1);
  });
});
