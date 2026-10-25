import rateLimiterTest from "@convex-dev/rate-limiter/test";
import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { FakeJev, isJev } from "./fakes/jev";

// Story mode (convex/story.ts) through the real pipeline, and the founder app's read models (convex/feed.ts).

function setup() {
  const t = convexTest(schema, import.meta.glob("../convex/**/*.ts"));
  for (const name of ["marketingPool", "customerPool", "financePool", "leadershipPool"]) workpoolTest.register(t, name);
  rateLimiterTest.register(t, "rateLimiter");
  return t;
}
type T = ReturnType<typeof setup>;

let jev: FakeJev;
let elsewhere: string[];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-24T19:00:00Z"));
  vi.stubEnv("DEMO_TOOLS", "on");
  vi.stubEnv("CO_TOKEN_SECRET", "test-secret");
  jev = new FakeJev();
  elsewhere = [];
  const rule = {
    scope: { level: "role", role: "content" },
    action_type: "publish_post",
    conditions: [
      { field: "channel", op: "in", value: ["linkedin"] },
      { field: "mentions_pricing", op: "==", value: false },
      { field: "mentions_competitor", op: "==", value: false },
    ],
    effect: "allow",
    rationale: "Plain product posts.",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/chat/completions")) {
        return new Response(
          JSON.stringify({ id: "c", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(rule) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (isJev(url)) return jev.fetch(url, init);
      elsewhere.push(String(url)); // Creao, Nessie: story mode must never call them
      return new Response("{}", { status: 500 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

async function seeded(t: T) {
  await t.mutation(internal.seed.config, {});
  await t.run(async (ctx) => {
    for (let i = 0; i < 3; i++) {
      await ctx.db.insert("customers", { name: `C${i}`, email: `c${i}@example.com`, nessie_customer_id: `n${i}`, nessie_account_id: `a${i}`, signup_at: Date.now() - (200 + i) * 86_400_000, plan: "Pro" });
    }
  });
}

const desk = async (t: T) => {
  const overview = await t.query(api.feed.overview, {});
  const room = overview.channels.find((c) => c.name === "#founder-desk")!;
  return { overview, data: await t.query(api.feed.channel, { roomId: room._id }) };
};
const openRequests = async (t: T) => (await t.query(api.inbox.listOpen, {})).sort((a, b) => a.created_at - b.created_at);

describe("story mode", () => {
  test("act 1: R7 handles one refund alone; the pattern reaches the founder once, in #founder-desk; nothing external is called", async () => {
    const t = setup();
    await seeded(t);
    await t.mutation(api.story.start, { act: "double_charge" });
    await drain(t);

    const actions = await t.run((ctx) => ctx.db.query("actions").collect());
    const refund = actions.find((a) => a.type === "refund")!;
    expect(refund).toMatchObject({ status: "executed", executed_ref: ["story:refund"], gate: { effect: "allow", reason: "rule:allow" } });
    expect(actions.filter((a) => a.status === "escalated").map((a) => a.type).sort()).toEqual(["file_bug", "refund_batch"]);

    const [request] = await openRequests(t);
    expect(request).toMatchObject({ kind: "package" });
    const { data } = await desk(t);
    const entry = data.entries.find((e) => e.thread?.request?._id === request._id)!;
    expect(entry.thread!.waiting).toBe(true);
    // Three test customers make a $105 batch: under budget, so it escalates as the first batch ever.
    expect(entry.thread!.request).toMatchObject({
      situation: expect.stringMatching(/charged twice/),
      actions: [
        { text: "Refund 3 customers, $105.00 total", gate: "First time this kind of action came up" },
        { text: expect.stringMatching(/^File a bug/), gate: "First time this kind of action came up" },
      ],
    });
    expect(elsewhere).toEqual([]);

    // The founder answers in the channel: the decision is stamped on the request and the batch is recorded.
    await t.mutation(api.inbox.decide, { inboxId: request._id, choice: "approve", reason: "Refund everyone." });
    await drain(t);
    expect((await t.run((ctx) => ctx.db.get(request._id)))!.decision).toMatchObject({ choice: "approve", reason: "Refund everyone." });
    const batch = (await t.run((ctx) => ctx.db.query("actions").collect())).find((a) => a.type === "refund_batch")!;
    expect(batch).toMatchObject({ status: "executed", executed_ref: ["story:refund_batch"] });
    expect(elsewhere).toEqual([]);
  });

  test("acts 2 and 3: three approvals → a rule request in #founder-desk → approved → the next post never reaches the founder", async () => {
    const t = setup();
    await seeded(t);
    await t.mutation(api.story.start, { act: "posts" });
    await drain(t);
    const posts = await openRequests(t);
    expect(posts.map((p) => p.kind)).toEqual(["action", "action", "action"]);
    for (const p of posts) await t.mutation(api.inbox.decide, { inboxId: p._id, choice: "approve" });
    await drain(t);

    const [ruleRequest] = await openRequests(t);
    expect(ruleRequest).toMatchObject({ kind: "rule", title: "Approve rule R8 for publish_post?" });
    const deskMsg = (await desk(t)).data.entries.find((e) => e.message.request?._id === ruleRequest._id)!;
    expect(deskMsg.message.request).toMatchObject({ diff: expect.arrayContaining([expect.stringMatching(/^\+ R8:/)]) });

    await t.mutation(api.inbox.decide, { inboxId: ruleRequest._id, choice: "approve" });
    await t.mutation(api.story.start, { act: "after_rule" });
    await drain(t);
    expect(await openRequests(t)).toEqual([]);
    const { overview } = await desk(t);
    expect(overview.tally).toMatchObject({ byRules: 1, byFounder: 3, waiting: 0 });
    expect(overview.tally.marks.at(-1)).toMatchObject({ who: "rule", rule: "R8" });

    const book = await t.query(api.feed.rulebook, {});
    expect(book.rules.find((r) => r.label === "R8")).toMatchObject({ status: "active", decided: 1, agree: 3, total: 3 });
    expect(book.timeline.map((x) => x.kind)).toEqual(["induction_started", "rule_proposed", "rule_approved"]);
  });

  test("a thread reads as plain view models: assignment, replies, and who decided", async () => {
    const t = setup();
    await seeded(t);
    const [taskId] = await t.mutation(api.story.start, { act: "after_rule" });
    await drain(t);
    const thread = await t.query(api.feed.thread, { taskId });
    // The founder's request lives in #founder-desk, not in the Content thread.
    expect(thread.messages.map((m) => m.kind)).toEqual(["assign", "reply"]);
    expect(thread.messages[0]).toMatchObject({ kind: "assign", to: "Content" });
    expect(thread.messages[0].headline).not.toMatch(/story post/);
    expect(thread.messages.find((m) => m.kind === "reply")!.envelope).toMatchObject({ type: "REPORT", actions: [{ type: "publish_post" }] });
    expect(thread.actions[0]).toMatchObject({ status: "escalated", reason: "First time this kind of action came up" });
  });

  test("demo tools are off unless DEMO_TOOLS=on", async () => {
    const t = setup();
    vi.stubEnv("DEMO_TOOLS", "");
    await expect(t.mutation(api.story.start, { act: "posts" })).rejects.toThrow(/Demo tools are off/);
    await expect(t.mutation(api.story.reset, {})).rejects.toThrow(/Demo tools are off/);
  });

  test("reset clears conversations and decisions, keeps the company, and re-seeds R7", async () => {
    const t = setup();
    await seeded(t);
    await t.mutation(api.story.start, { act: "double_charge" });
    await drain(t);
    await t.mutation(api.story.reset, {});
    const counts = await t.run(async (ctx) => ({
      messages: (await ctx.db.query("messages").collect()).length,
      tasks: (await ctx.db.query("tasks").collect()).length,
      inbox: (await ctx.db.query("founder_inbox").collect()).length,
      rules: (await ctx.db.query("rules").collect()).map((r) => r.text.slice(0, 3)),
      customers: (await ctx.db.query("customers").collect()).length,
      agents: (await ctx.db.query("agents").collect()).length > 0,
      seq: (await ctx.db.query("rooms").collect()).every((r) => r.next_seq === 1),
    }));
    expect(counts).toEqual({ messages: 0, tasks: 0, inbox: 0, rules: ["R7:"], customers: 3, agents: true, seq: true });
  });
});
