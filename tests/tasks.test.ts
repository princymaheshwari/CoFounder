import rateLimiterTest from "@convex-dev/rate-limiter/test";
import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { extractEnvelopeBlock } from "../convex/lib/envelope";
import { TOKEN_TTL_MS, signTaskToken } from "../convex/lib/tokens";
import type { Role } from "../convex/lib/types";
import posted from "../convex/creao/__fixtures__/post-run-202.json";

const modules = import.meta.glob("../convex/**/*.ts");
const SECRET = "test-secret";

function setup() {
  const t = convexTest(schema, modules);
  for (const name of ["marketingPool", "customerPool", "financePool", "leadershipPool"]) workpoolTest.register(t, name);
  rateLimiterTest.register(t, "rateLimiter");
  return t;
}
type T = ReturnType<typeof setup>;

// A Creao stand-in: every POST /runs starts a new run (run-1, run-2, …).
let posts: { body: Record<string, unknown> }[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CREAO_API_KEY", "capi_test");
  vi.stubEnv("CREAO_WEBHOOK_TOKEN", "hook_secret");
  vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
  vi.stubEnv("CO_TOKEN_SECRET", SECRET);
  posts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      posts.push({ body: JSON.parse(init.body as string) as Record<string, unknown> });
      return new Response(JSON.stringify({ ...posted, id: `run-${posts.length}` }), { status: 202 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);
const getTask = async (t: T, id: Id<"tasks">): Promise<Doc<"tasks">> => (await t.run((ctx) => ctx.db.get(id)))!;
const thread = (t: T, taskId: Id<"tasks">) =>
  t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_task", (q) => q.eq("task", taskId))
      .collect(),
  );
const issuesOf = (t: T, taskId: Id<"tasks">) =>
  t.run((ctx) =>
    ctx.db
      .query("issues")
      .withIndex("by_task", (q) => q.eq("task", taskId))
      .collect(),
  );
const allTasks = (t: T) => t.run((ctx) => ctx.db.query("tasks").collect());

// [from, to] for every task_status audit row on the task, in order.
const transitions = (t: T, taskId: Id<"tasks">) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query("audit_log")
        .withIndex("by_ref", (q) => q.eq("ref", taskId))
        .collect()
    )
      .filter((r) => r.kind === "task_status")
      .map((r) => {
        const d = r.detail as { from: string | null; to: string };
        return [d.from, d.to];
      }),
  );

async function newEvent(t: T, type: string, payload: unknown = { brief: "Handle ticket 1: charged twice." }) {
  return await t.run((ctx) => ctx.db.insert("events", { type, payload, source: "seed", processed: false, created_at: Date.now() }));
}

// support_ticket event → Support task, assigned on run-N.
async function openTask(t: T, type = "support_ticket", payload?: unknown): Promise<Id<"tasks">> {
  await t.mutation(internal.seed.config, {});
  const created = await t.mutation(internal.tasks.createTaskFromEvent, { eventId: await newEvent(t, type, payload) });
  await drain(t);
  return created!.taskId;
}

// A manager working an employee's issue (spec 09 creates these; inserted here to drive DECISION / ESCALATE).
async function managerTask(t: T, parentId: Id<"tasks">, role: Role = "customer_manager"): Promise<Id<"tasks">> {
  const parent = await getTask(t, parentId);
  const taskId = await t.run((ctx) =>
    ctx.db.insert("tasks", {
      ...{ room: parent.room, chain_id: parent.chain_id, mode: parent.mode, origin_refs: [parentId] },
      role,
      kind: "issue",
      brief: "Support raised an issue.",
      parent_task: parentId,
      hop: parent.hop + 1,
      attempt: 1,
      status: "queued",
      deadline: Date.now() + 300_000,
      created_at: Date.now(),
      updated_at: Date.now(),
    }),
  );
  await t.mutation(internal.dispatcher.assignTask, { taskId });
  await drain(t);
  return taskId;
}

const wrap = (env: unknown) => `Here is my answer.\n\n\`\`\`cofounder\n${JSON.stringify(env)}\n\`\`\``;

// Delivers the agent's reply for the task's current run. `env` fields are merged over {task, from, summary}.
async function reply(t: T, taskId: Id<"tasks">, env: Record<string, unknown> | string) {
  const task = await getTask(t, taskId);
  const text = typeof env === "string" ? env : wrap({ task: taskId, from: task.role, summary: "Handled it.", ...env });
  await t.mutation(internal.dispatcher.recordReply, { runId: task.creao_run_id!, status: "completed", text });
}

const refund = { type: "refund", params: { customer_id: "c_17", amount_cents: 3500, reason: "billing_error" }, rationale: "R7" };

describe("event → queued → assigned", () => {
  test("a support_ticket opens a Support task in #customer as a new chain at hop 0", async () => {
    const t = setup();
    const taskId = await openTask(t);
    const task = await getTask(t, taskId);
    const room = await t.run(async (ctx) => (await ctx.db.get(task.room))!);
    expect(room.name).toBe("#customer");
    expect(task).toMatchObject({ role: "support", kind: "work", hop: 0, status: "assigned", creao_run_id: "run-1" });
    expect(task.chain_id).toBe(`c_${task.event}`);
    expect(task.brief).toBe("Handle ticket 1: charged twice.");
    expect(await transitions(t, taskId)).toEqual([[null, "queued"]]);
    const kinds = await t.run(async (ctx) =>
      (await ctx.db.query("audit_log").withIndex("by_ref", (q) => q.eq("ref", taskId)).collect()).map((r) => r.kind),
    );
    expect(kinds).toEqual(expect.arrayContaining(["assign", "run_started"])); // queued → assigned is audited as run_started
    expect((await t.run((ctx) => ctx.db.get(task.event!)))!.processed).toBe(true);
  });

  test("an event is turned into a task once", async () => {
    const t = setup();
    await t.mutation(internal.seed.config, {});
    const eventId = await newEvent(t, "support_ticket");
    expect(await t.mutation(internal.tasks.createTaskFromEvent, { eventId })).not.toBeNull();
    expect(await t.mutation(internal.tasks.createTaskFromEvent, { eventId })).toBeNull();
    expect(await allTasks(t)).toHaveLength(1);
  });

  test("an unknown event type goes to the Cofounder in #leadership", async () => {
    const t = setup();
    const taskId = await openTask(t, "mystery", { url: "https://example.com" });
    const task = await getTask(t, taskId);
    expect(task.role).toBe("cofounder");
    expect((await t.run((ctx) => ctx.db.get(task.room)))!.name).toBe("#leadership");
    expect(task.brief).toBe('Event mystery: {"url":"https://example.com"}');
  });
});

describe("replies", () => {
  test("REPORT without actions → replied → done", async () => {
    const t = setup();
    const taskId = await openTask(t);
    await reply(t, taskId, { type: "REPORT" });
    expect((await getTask(t, taskId)).status).toBe("done");
    expect(await transitions(t, taskId)).toEqual([
      [null, "queued"],
      ["assigned", "replied"],
      ["replied", "done"],
    ]);
  });

  test("REPORT with proposed_actions → gated, each action stored as proposed", async () => {
    const t = setup();
    const taskId = await openTask(t);
    await reply(t, taskId, { type: "REPORT", proposed_actions: [refund] });
    const task = await getTask(t, taskId);
    expect(task.status).toBe("gated");
    const actions = await t.run((ctx) => ctx.db.query("actions").withIndex("by_task", (q) => q.eq("task", taskId)).collect());
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "refund", role: "support", status: "proposed", chain_id: task.chain_id, rationale: "R7" });
    expect((await transitions(t, taskId)).at(-1)).toEqual(["replied", "gated"]);
  });

  test("ISSUE → escalated with an issue for the employee's manager", async () => {
    const t = setup();
    const taskId = await openTask(t);
    await reply(t, taskId, {
      type: "ISSUE",
      kind: "coordination",
      summary: "Six duplicate-charge tickets look like one billing bug.",
      attempts: ["Refunded my own ticket under R7"],
      refs: ["ticket:1"],
    });
    expect((await getTask(t, taskId)).status).toBe("escalated");
    const [issue] = await issuesOf(t, taskId);
    const replyId = (await thread(t, taskId))[1]._id;
    expect(issue).toMatchObject({
      kind: "coordination",
      level: "employee",
      raised_by_role: "support",
      to_role: "customer_manager",
      status: "open",
      attempts: ["Refunded my own ticket under R7"],
      evidence: [replyId, "ticket:1"],
    });
    expect((await transitions(t, taskId)).at(-1)).toEqual(["replied", "escalated"]);
  });

  test("ESCALATE from a manager → escalated with a manager-level issue for the Cofounder", async () => {
    const t = setup();
    const supportTask = await openTask(t);
    const mgrTask = await managerTask(t, supportTask);
    await reply(t, mgrTask, { type: "ESCALATE", need: "authority", attempts: ["Grouped six tickets"] });
    expect((await getTask(t, mgrTask)).status).toBe("escalated");
    expect((await issuesOf(t, mgrTask))[0]).toMatchObject({ kind: "authority", level: "manager", to_role: "cofounder" });
  });

  test("OBJECT → done with the objection audited", async () => {
    const t = setup();
    const taskId = await openTask(t);
    await reply(t, taskId, { type: "OBJECT", findings: [{ claim: "Budget is wrong", evidence: "ledger:9" }], refs: ["msg:4"] });
    expect((await getTask(t, taskId)).status).toBe("done");
    const objection = await t.run(async (ctx) =>
      (await ctx.db.query("audit_log").withIndex("by_ref", (q) => q.eq("ref", taskId)).collect()).find((r) => r.kind === "objection"),
    );
    expect(objection?.detail).toMatchObject({ refs: ["msg:4"] });
  });

  test("DECISION resolves the issue it answers and ends done", async () => {
    const t = setup();
    const supportTask = await openTask(t);
    await reply(t, supportTask, { type: "ISSUE", kind: "coordination", attempts: ["Checked my ticket"] });
    const mgrTask = await managerTask(t, supportTask);
    await reply(t, mgrTask, { type: "DECISION", summary: "One billing bug; Finance will batch-refund." });
    expect((await getTask(t, mgrTask)).status).toBe("done");
    expect((await issuesOf(t, supportTask))[0]).toMatchObject({ status: "resolved", resolution: "One billing bug; Finance will batch-refund." });
  });

  test("DECISION with proposed_actions → gated", async () => {
    const t = setup();
    const supportTask = await openTask(t);
    const mgrTask = await managerTask(t, supportTask);
    await reply(t, mgrTask, { type: "DECISION", proposed_actions: [refund] });
    expect((await getTask(t, mgrTask)).status).toBe("gated");
  });

  test("a reply after the task is closed stays in the thread but changes nothing", async () => {
    const t = setup();
    const taskId = await openTask(t);
    await reply(t, taskId, { type: "REPORT" });
    await t.run((ctx) =>
      ctx.db.insert("runs", {
        purpose: "nudge",
        role: "support",
        task: taskId,
        creao_run_id: "late-run",
        idempotency_key: `${taskId}:nudge:2`,
        status: "running",
        delivery_ids: [],
        started_at: Date.now(),
      }),
    );
    await t.mutation(internal.dispatcher.recordReply, {
      runId: "late-run",
      status: "completed",
      text: wrap({ type: "ISSUE", task: taskId, from: "support", summary: "x", kind: "information", attempts: ["a"] }),
    });
    expect((await getTask(t, taskId)).status).toBe("done");
    expect(await thread(t, taskId)).toHaveLength(3);
    expect(await issuesOf(t, taskId)).toHaveLength(0);
  });
});

describe("invalid envelopes", () => {
  test("invalid → repairing with a REPAIR run on the same task; invalid again → escalated with both errors", async () => {
    const t = setup();
    const taskId = await openTask(t);
    await reply(t, taskId, "I looked into it but forgot the envelope.");
    expect((await getTask(t, taskId)).status).toBe("repairing");
    await drain(t);
    const repairing = await getTask(t, taskId);
    expect(repairing).toMatchObject({ status: "repairing", attempt: 2, creao_run_id: "run-2" });
    expect(posts[1].body).toMatchObject({ idempotencyKey: `${taskId}:repair:2` });
    const repairMsg = (await thread(t, taskId))[2];
    expect(repairMsg.text).toContain("Repair on task");

    await reply(t, taskId, { type: "ISSUE", kind: "information", attempts: "tried" }); // attempts must be an array
    expect((await getTask(t, taskId)).status).toBe("escalated");
    const [issue] = await issuesOf(t, taskId);
    expect(issue).toMatchObject({ kind: "capability", to_role: "customer_manager" });
    expect(issue.attempts).toHaveLength(2);
    expect(issue.attempts[0]).toMatch(/^No envelope found/);
    expect(await transitions(t, taskId)).toEqual([
      [null, "queued"],
      ["assigned", "repairing"],
      ["repairing", "escalated"],
    ]);
  });

  test("a valid envelope after a repair is routed normally", async () => {
    const t = setup();
    const taskId = await openTask(t);
    await reply(t, taskId, "no envelope");
    await drain(t);
    await reply(t, taskId, { type: "REPORT" });
    expect((await getTask(t, taskId)).status).toBe("done");
    expect((await transitions(t, taskId)).slice(-2)).toEqual([
      ["repairing", "replied"],
      ["replied", "done"],
    ]);
  });
});

describe("handoffs and graph limits", () => {
  test("HANDOFF → done, child task for to_role in its channel at hop + 1, assigned with a handoff ASSIGN", async () => {
    const t = setup();
    const taskId = await openTask(t);
    await reply(t, taskId, { type: "HANDOFF", to_role: "ledger", brief: "Check Oct 22 for duplicate charges.", summary: "Looks like a billing bug." });
    expect((await getTask(t, taskId)).status).toBe("done");

    const child = (await allTasks(t)).find((x) => x.parent_task === taskId)!;
    const parent = await getTask(t, taskId);
    expect(child).toMatchObject({ role: "ledger", kind: "handoff", hop: 1, chain_id: parent.chain_id, status: "queued" });
    expect(child.origin_refs[0]).toBe(taskId);
    expect((await t.run((ctx) => ctx.db.get(child.room)))!.name).toBe("#finance");
    const [assignMsg] = await thread(t, child._id);
    expect(assignMsg.text).toContain(`New task ${child._id} (handoff from Support)`);
    expect(JSON.parse(extractEnvelopeBlock(assignMsg.text)!)).toMatchObject({ to: "ledger", refs: [taskId] });
    expect(await transitions(t, child._id)).toEqual([[null, "queued"]]);

    await drain(t);
    expect((await getTask(t, child._id)).status).toBe("assigned");
  });

  test("a 4th-hop handoff becomes a coordination ISSUE for the Cofounder, not a task", async () => {
    const t = setup();
    const taskId = await openTask(t);
    await t.run((ctx) => ctx.db.patch(taskId, { hop: 3 }));
    await reply(t, taskId, { type: "HANDOFF", to_role: "ledger", brief: "Check duplicates." });
    expect((await getTask(t, taskId)).status).toBe("escalated");
    expect(await allTasks(t)).toHaveLength(1);
    const [issue] = await issuesOf(t, taskId);
    expect(issue).toMatchObject({ kind: "coordination", to_role: "cofounder" });
    expect(issue.summary).toMatch(/already has 3 hops/);
  });

  test.each([
    ["executor", "only the gate dispatches the Executor"],
    ["support", "a role cannot hand off to itself"],
  ])("a handoff to %s becomes a coordination ISSUE for the manager", async (toRole, why) => {
    const t = setup();
    const taskId = await openTask(t);
    await reply(t, taskId, { type: "HANDOFF", to_role: toRole, brief: "Do it." });
    expect(await allTasks(t)).toHaveLength(1);
    const [issue] = await issuesOf(t, taskId);
    expect(issue).toMatchObject({ kind: "coordination", to_role: "customer_manager" });
    expect(issue.summary).toContain(why);
  });

  test("a 4th child of the same task is refused", async () => {
    const t = setup();
    const supportTask = await openTask(t);
    const mgrTask = await managerTask(t, supportTask);
    const { _id, _creationTime, ...mgr } = await getTask(t, mgrTask);
    await t.run(async (ctx) => {
      for (const role of ["ledger", "spend", "retention"] as const) {
        await ctx.db.insert("tasks", { ...mgr, role, parent_task: _id, hop: mgr.hop + 1, status: "done" });
      }
    });
    await reply(t, mgrTask, { type: "HANDOFF", to_role: "finance_manager", brief: "Batch refund." });
    expect((await getTask(t, mgrTask)).status).toBe("escalated");
    expect((await issuesOf(t, mgrTask))[0].summary).toContain("already has 3 child tasks");
  });
});

describe("deadlines", () => {
  test("an agent that never replies is nudged once, then escalated to its manager", async () => {
    const t = setup();
    const taskId = await openTask(t);
    expect(await t.mutation(internal.tasks.checkStuckTasks, {})).toEqual({ nudged: 0, escalated: 0 });

    vi.setSystemTime((await getTask(t, taskId)).deadline + 1);
    expect(await t.mutation(internal.tasks.checkStuckTasks, {})).toEqual({ nudged: 1, escalated: 0 });
    const nudged = await getTask(t, taskId);
    expect(nudged).toMatchObject({ status: "assigned", nudged: true, attempt: 2 });
    expect(nudged.deadline).toBeGreaterThan(Date.now());
    expect((await thread(t, taskId)).at(-1)!.text).toContain(`Reminder on task ${taskId} (attempt 2)`);
    // A second sweep before the nudge's deadline does nothing.
    expect(await t.mutation(internal.tasks.checkStuckTasks, {})).toEqual({ nudged: 0, escalated: 0 });

    await drain(t);
    expect(posts.at(-1)!.body).toMatchObject({ idempotencyKey: `${taskId}:nudge:2` });
    const runs = await t.run((ctx) => ctx.db.query("runs").collect());
    expect(runs.map((r) => r.purpose)).toEqual(["assign", "nudge"]);

    vi.setSystemTime((await getTask(t, taskId)).deadline + 1);
    expect(await t.mutation(internal.tasks.checkStuckTasks, {})).toEqual({ nudged: 0, escalated: 1 });
    expect((await getTask(t, taskId)).status).toBe("escalated");
    expect((await issuesOf(t, taskId))[0]).toMatchObject({ kind: "capability", to_role: "customer_manager", level: "employee" });
    expect(await transitions(t, taskId)).toEqual([
      [null, "queued"],
      ["assigned", "assigned"],
      ["assigned", "escalated"],
    ]);
  });

  test("an unanswered repair escalates at its deadline", async () => {
    const t = setup();
    const taskId = await openTask(t);
    await reply(t, taskId, "no envelope");
    await drain(t);
    vi.setSystemTime((await getTask(t, taskId)).deadline + 1);
    expect(await t.mutation(internal.tasks.checkStuckTasks, {})).toEqual({ nudged: 0, escalated: 1 });
    expect((await getTask(t, taskId)).status).toBe("escalated");
  });
});

describe("failed runs", () => {
  test("a failed current run fails the task and raises a capability issue", async () => {
    const t = setup();
    const taskId = await openTask(t);
    await t.mutation(internal.dispatcher.recordReply, { runId: "run-1", status: "failed", text: "", errorCode: "INSUFFICIENT_CREDITS" });
    expect((await getTask(t, taskId)).status).toBe("failed");
    const [issue] = await issuesOf(t, taskId);
    expect(issue).toMatchObject({ kind: "capability", to_role: "customer_manager" });
    expect(issue.summary).toContain("INSUFFICIENT_CREDITS");
    expect((await transitions(t, taskId)).at(-1)).toEqual(["assigned", "failed"]);
  });

  test("a failed older run (superseded by a nudge) is ignored", async () => {
    const t = setup();
    const taskId = await openTask(t);
    await t.run((ctx) => ctx.db.patch(taskId, { creao_run_id: "run-newer" }));
    await t.mutation(internal.dispatcher.recordReply, { runId: "run-1", status: "cancelled", text: "" });
    expect((await getTask(t, taskId)).status).toBe("assigned");
  });
});

describe("task tokens", () => {
  async function tokenFor(t: T) {
    const taskId = await openTask(t);
    const input = (posts[0].body.inputs as { message: string }).message;
    return { taskId, token: (JSON.parse(extractEnvelopeBlock(input)!) as { token: string }).token };
  }

  test("the token from the ASSIGN verifies for its open task", async () => {
    const t = setup();
    const { taskId, token } = await tokenFor(t);
    expect(await t.action(internal.tasks.verifyToken, { token })).toEqual({ ok: true, taskId, role: "support" });
  });

  test("rejects tampered tokens", async () => {
    const t = setup();
    const { taskId, token } = await tokenFor(t);
    const [, sig] = token.split(".");
    const forged = `${btoa(JSON.stringify({ task: taskId, role: "ledger", exp: Date.now() + 1_000_000 })).replace(/=+$/, "")}.${sig}`;
    expect(await t.action(internal.tasks.verifyToken, { token: forged })).toEqual({ ok: false, error: "bad_signature" });
  });

  test("rejects expired tokens", async () => {
    const t = setup();
    const { token } = await tokenFor(t);
    vi.setSystemTime(Date.now() + TOKEN_TTL_MS + 1);
    expect(await t.action(internal.tasks.verifyToken, { token })).toEqual({ ok: false, error: "expired" });
  });

  test("rejects tokens for closed tasks", async () => {
    const t = setup();
    const { taskId, token } = await tokenFor(t);
    await reply(t, taskId, { type: "REPORT" });
    expect(await t.action(internal.tasks.verifyToken, { token })).toEqual({ ok: false, error: "closed" });
  });

  test("rejects a validly signed token that was not the one issued for the task", async () => {
    const t = setup();
    const { taskId } = await tokenFor(t);
    const other = await signTaskToken(SECRET, { task: taskId, role: "support", exp: Date.now() + 60_000 });
    expect(await t.action(internal.tasks.verifyToken, { token: other })).toEqual({ ok: false, error: "revoked" });
  });
});
