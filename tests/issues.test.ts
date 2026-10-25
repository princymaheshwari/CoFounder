import rateLimiterTest from "@convex-dev/rate-limiter/test";
import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { internal, api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { extractEnvelopeBlock } from "../convex/lib/envelope";
import { deadlineAction } from "../convex/lib/routing";
import type { Role } from "../convex/lib/types";
import posted from "../convex/creao/__fixtures__/post-run-202.json";
import { FakeNessie } from "./fakes/nessie";

const modules = import.meta.glob("../convex/**/*.ts");

function setup() {
  const t = convexTest(schema, modules);
  for (const name of ["marketingPool", "customerPool", "financePool", "leadershipPool"]) workpoolTest.register(t, name);
  rateLimiterTest.register(t, "rateLimiter");
  return t;
}
type T = ReturnType<typeof setup>;

// Creao stand-in (every POST /runs starts run-N) and the fake Nessie, routed by host.
let runs = 0;
let nessie: FakeNessie;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CREAO_API_KEY", "capi_test");
  vi.stubEnv("CREAO_WEBHOOK_TOKEN", "hook_secret");
  vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
  vi.stubEnv("CO_TOKEN_SECRET", "test-secret");
  vi.stubEnv("NESSIE_API_KEY", "nessie_test");
  runs = 0;
  nessie = new FakeNessie();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("nessieisreal")) return nessie.fetch(url, init);
      runs++;
      return new Response(JSON.stringify({ ...posted, id: `run-${runs}` }), { status: 202 });
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
const allTasks = (t: T) => t.run((ctx) => ctx.db.query("tasks").collect());
const allIssues = (t: T) => t.run((ctx) => ctx.db.query("issues").collect());
const roomName = async (t: T, id: Id<"rooms">) => (await t.run((ctx) => ctx.db.get(id)))!.name;
const threadMessages = (t: T, root: Id<"tasks">) =>
  t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_thread", (q) => q.eq("thread", root))
      .collect(),
  );
const taskOf = async (t: T, role: Role, kind?: Doc<"tasks">["kind"]) => (await allTasks(t)).filter((x) => x.role === role && (!kind || x.kind === kind)).at(-1)!;

async function ticketTask(t: T, brief = "Handle ticket 1: charged twice on Oct 22."): Promise<Id<"tasks">> {
  const eventId = await t.run((ctx) => ctx.db.insert("events", { type: "support_ticket", payload: { brief }, source: "seed", processed: false, created_at: Date.now() }));
  const created = await t.mutation(internal.tasks.createTaskFromEvent, { eventId });
  await drain(t);
  return created!.taskId;
}

const wrap = (env: unknown) => `Here is my answer.\n\n\`\`\`cofounder\n${JSON.stringify(env)}\n\`\`\``;

async function reply(t: T, taskId: Id<"tasks">, env: Record<string, unknown>) {
  await drain(t); // the task's run has started
  const task = await getTask(t, taskId);
  expect(task.creao_run_id).toBeDefined();
  await t.mutation(internal.dispatcher.recordReply, {
    runId: task.creao_run_id!,
    status: "completed",
    text: wrap({ task: taskId, from: task.role, summary: "Handled it.", ...env }),
  });
}

const coordination = { type: "ISSUE", kind: "coordination", summary: "Several tickets report a duplicate $35 charge on Oct 22.", attempts: ["Checked co data tickets"] };

describe("deadlineAction for ladder tasks", () => {
  test("issue and package tasks climb at the deadline without a nudge", () => {
    const due = { status: "assigned" as const, deadline: 0 };
    expect(deadlineAction({ ...due, kind: "work" }, 1)).toBe("nudge");
    expect(deadlineAction({ ...due, kind: "issue" }, 1)).toBe("escalate");
    expect(deadlineAction({ ...due, kind: "package" }, 1)).toBe("escalate");
    expect(deadlineAction({ ...due, kind: "issue", deadline: 5 }, 1)).toBeNull();
  });
});

describe("employee → manager", () => {
  test("an ISSUE wakes the manager with a new run; its ASSIGN and reply land in the employee's thread", async () => {
    const t = setup();
    await t.mutation(internal.seed.config, {});
    const support = await ticketTask(t);
    await reply(t, support, coordination);

    const mgr = await taskOf(t, "customer_manager", "issue");
    expect(mgr).toMatchObject({ thread: support, parent_task: support, room: (await getTask(t, support)).room, hop: 0 });
    const [issue] = await allIssues(t);
    expect(issue).toMatchObject({ level: "manager", status: "escalated", handler_task: mgr._id });

    const assign = (await threadMessages(t, support)).find((m) => m.task === mgr._id)!;
    expect(assign.text).toContain("Support raised an issue (coordination)");
    expect(assign.text).toContain("Several tickets report a duplicate $35 charge");
    expect(JSON.parse(extractEnvelopeBlock(assign.text)!).brief).toContain(`co data thread --id ${support}`);

    await reply(t, mgr._id, { type: "DECISION", summary: "One billing bug; refunds go through Finance." });
    const thread = await threadMessages(t, support);
    expect(thread.map((m) => m.sender_name)).toEqual(["Dispatcher", "Support", "Dispatcher", "Customer Manager"]);
    expect((await allIssues(t))[0]).toMatchObject({ status: "resolved", resolution: "One billing bug; refunds go through Finance." });
    expect((await getTask(t, mgr._id)).status).toBe("done");
  });

  test("a REPORT carrying an issue gates the employee's actions and also wakes the manager", async () => {
    const t = setup();
    await t.mutation(internal.seed.config, {});
    const support = await ticketTask(t);
    const refund = { type: "refund", params: { customer_id: "c_17", amount_cents: 3500, reason: "billing_error" }, rationale: "Duplicate." };
    await reply(t, support, {
      type: "REPORT",
      summary: "Refund proposed; same double charge in 6 tickets.",
      proposed_actions: [refund],
      issue: { kind: "coordination", summary: "Oct 22 double charge in 6 tickets.", attempts: ["co data tickets"] },
    });
    expect((await getTask(t, support)).status).toBe("gated");
    const [issue] = await allIssues(t);
    expect(issue).toMatchObject({ kind: "coordination", raised_by_role: "support", summary: "Oct 22 double charge in 6 tickets.", level: "manager" });
    expect(await taskOf(t, "customer_manager", "issue")).toMatchObject({ thread: support, issue: issue._id });
  });

  test("related issues in the channel within 2 hours are grouped onto the manager's open task", async () => {
    const t = setup();
    await t.mutation(internal.seed.config, {});
    const first = await ticketTask(t, "Handle ticket 1: charged twice.");
    await reply(t, first, coordination);
    const second = await ticketTask(t, "Handle ticket 2: double charge.");
    await reply(t, second, coordination);

    const managers = (await allTasks(t)).filter((x) => x.role === "customer_manager");
    expect(managers).toHaveLength(1);
    const issues = await allIssues(t);
    expect(issues.map((i) => i.handler_task)).toEqual([managers[0]._id, managers[0]._id]);
    expect((await threadMessages(t, second)).at(-1)!.text).toContain(`grouped with Customer Manager's open task ${managers[0]._id}`);

    // The manager's DECISION settles both, and the second ticket's thread gets the DECISION too.
    await reply(t, managers[0]._id, { type: "DECISION", summary: "Same bug for both." });
    expect((await allIssues(t)).every((i) => i.status === "resolved")).toBe(true);
    const decision = (await threadMessages(t, second)).at(-1)!;
    expect(decision.text).toMatch(/^\[Dispatcher\] Decision on .*approve by manager\. Same bug for both\./);
  });

  test("a first information issue goes back to the employee once; the second climbs", async () => {
    const t = setup();
    await t.mutation(internal.seed.config, {});
    const support = await ticketTask(t);
    await reply(t, support, { type: "ISSUE", kind: "information", summary: "I cannot find the customer.", attempts: ["co data ticket"] });
    expect(await getTask(t, support)).toMatchObject({ status: "assigned", attempt: 2 });
    expect((await allIssues(t))[0]).toMatchObject({ status: "resolved", resolution: "returned to the employee once with data hints" });
    expect((await threadMessages(t, support)).at(-1)!.text).toContain("co data customer");
    expect((await allTasks(t)).filter((x) => x.kind === "issue")).toHaveLength(0);

    await reply(t, support, { type: "ISSUE", kind: "information", summary: "Still no customer record.", attempts: ["co data ticket", "co data customer"] });
    expect((await allTasks(t)).filter((x) => x.kind === "issue").map((x) => x.role)).toEqual(["customer_manager"]);
  });

  test("a manager's cross-department HANDOFF goes to the target channel, is announced in #leadership and settles the issue", async () => {
    const t = setup();
    await t.mutation(internal.seed.config, {});
    const support = await ticketTask(t);
    await reply(t, support, coordination);
    const mgr = await taskOf(t, "customer_manager", "issue");
    await reply(t, mgr._id, { type: "HANDOFF", to_role: "ledger", brief: "Find the Oct 22 duplicate charges.", summary: "Grouped 6 tickets: likely a billing bug." });

    const ledger = await taskOf(t, "ledger");
    expect(ledger).toMatchObject({ kind: "handoff", parent_task: mgr._id, hop: 1 });
    expect(await roomName(t, ledger.room)).toBe("#finance");
    const leadership = await t.run(async (ctx) => {
      const room = (await ctx.db.query("rooms").withIndex("by_name", (q) => q.eq("name", "#leadership")).unique())!;
      return await ctx.db.query("messages").withIndex("by_room_seq", (q) => q.eq("room", room._id)).collect();
    });
    expect(leadership.map((m) => m.text)).toEqual([
      `[Dispatcher] Customer Manager handed task ${mgr._id} off to Ledger in #finance (task ${ledger._id}): Grouped 6 tickets: likely a billing bug.`,
    ]);
    expect((await allIssues(t))[0]).toMatchObject({ status: "resolved", resolution: `Handed off to ledger (task ${ledger._id}).` });
  });
});

describe("manager outcomes", () => {
  async function managerOnIssue(t: T) {
    await t.mutation(internal.seed.config, {});
    const support = await ticketTask(t);
    await reply(t, support, coordination);
    return { support, mgr: await taskOf(t, "customer_manager", "issue") };
  }

  test("ESCALATE capability files a bug through the gate and resolves the issue", async () => {
    const t = setup();
    const { mgr } = await managerOnIssue(t);
    await reply(t, mgr._id, { type: "ESCALATE", need: "capability", summary: "Checkout charges twice on retry.", attempts: ["Grouped tickets"] });
    const bug = (await t.run((ctx) => ctx.db.query("actions").collect())).find((a) => a.type === "file_bug")!;
    expect(bug).toMatchObject({ task: mgr._id, status: "escalated", gate: { reason: "novelty:new_type" } });
    expect(bug.params).toMatchObject({ severity: "high" });
    expect((await allIssues(t)).every((i) => i.status === "resolved")).toBe(true);
    expect((await getTask(t, mgr._id)).status).toBe("done");
  });

  test("ESCALATE authority whose actions a rule allows is settled by the gate, without the founder", async () => {
    const t = setup();
    const { mgr } = await managerOnIssue(t);
    await t.run(async (ctx) => {
      const d = await ctx.db.insert("decisions", { subject_kind: "action", action_type: "file_bug", choice: "approve", features: {}, decided_by: "founder", created_at: Date.now() });
      await ctx.db.insert("rules", {
        scope: { level: "company" },
        action_type: "file_bug",
        conditions: [],
        effect: "allow",
        status: "active",
        version: 1,
        supporting_decisions: [d],
        agreement: { agree: 1, total: 1 },
        text: "Bugs may always be filed.",
        created_at: Date.now(),
      });
    });
    const fileBug = { type: "file_bug", params: { title: "Double charge", body: "Oct 22", severity: "high" }, rationale: "Defect." };
    await reply(t, mgr._id, { type: "ESCALATE", need: "authority", attempts: ["Grouped tickets"], proposed_actions: [fileBug] });
    expect((await t.run((ctx) => ctx.db.query("actions").collect()))[0]).toMatchObject({ type: "file_bug", status: "allowed" });
    expect((await allIssues(t)).every((i) => i.status === "resolved")).toBe(true);
    expect((await allTasks(t)).some((x) => x.kind === "package")).toBe(false);
    expect((await getTask(t, mgr._id)).status).toBe("done");
  });

  test("timeouts climb one level at a time: manager → Cofounder → package → founder inbox", async () => {
    const t = setup();
    const { support, mgr } = await managerOnIssue(t);
    await drain(t);

    vi.setSystemTime((await getTask(t, mgr._id)).deadline + 1);
    expect(await t.mutation(internal.tasks.checkStuckTasks, {})).toEqual({ nudged: 0, escalated: 1 });
    const cofounder = await taskOf(t, "cofounder", "issue");
    expect(cofounder).toMatchObject({ thread: support, parent_task: mgr._id });
    expect((await allIssues(t)).at(-1)).toMatchObject({ raised_by_role: "customer_manager", attempts: ["timed out"], handler_task: cofounder._id });

    await drain(t);
    vi.setSystemTime((await getTask(t, cofounder._id)).deadline + 1);
    await t.mutation(internal.tasks.checkStuckTasks, {});
    const pkg = await taskOf(t, "cofounder", "package");
    expect(await roomName(t, pkg.room)).toBe("#founder-desk");

    await drain(t);
    vi.setSystemTime((await getTask(t, pkg._id)).deadline + 1);
    await t.mutation(internal.tasks.checkStuckTasks, {});
    const [item] = await t.query(api.inbox.listOpen, {});
    expect(item).toMatchObject({ kind: "package" });
    expect(item.body).toContain("No Cofounder package (the Cofounder timed out)");
  });

  test("a package task that does not send a package puts the issue in the inbox as is", async () => {
    const t = setup();
    const { mgr } = await managerOnIssue(t);
    await reply(t, mgr._id, { type: "ESCALATE", need: "authority", summary: "Needs the founder.", attempts: ["Grouped"] });
    const pkg = await taskOf(t, "cofounder", "package");
    await reply(t, pkg._id, { type: "ESCALATE", need: "authority", summary: "Founder must decide.", attempts: ["Read the chain"] });
    const [item] = await t.query(api.inbox.listOpen, {});
    expect(item.body).toContain("the Cofounder sent ESCALATE instead of a package");
  });
});

describe("flow A", () => {
  test("ticket → Customer manager → Ledger → Finance manager → package → founder approves → 12 refunds, DECISIONs, bug", async () => {
    const t = setup();
    await t.mutation(internal.seed.config, {});
    await t.action(internal.nessie.seedNessie, {});
    const op = (await t.query(internal.nessie.getState, {}))!.operating_account_id;

    // Support handles its ticket and raises the pattern as one coordination ISSUE.
    const support = await ticketTask(t);
    await reply(t, support, coordination);

    // The Customer manager, woken in Support's thread, hands off to Ledger in #finance.
    const cm = await taskOf(t, "customer_manager", "issue");
    await reply(t, cm._id, { type: "HANDOFF", to_role: "ledger", brief: "Find and fix the Oct 22 duplicate charges.", summary: "Grouped the tickets: one billing bug." });
    const ledger = await taskOf(t, "ledger");

    // Ledger finds the 12 duplicates with co and escalates the $420 batch (over the $300 daily budget).
    const view = await t.query(internal.co.readView, { taskId: ledger._id, role: "ledger", view: "duplicates" });
    const dups = (view as { ok: true; data: { duplicates: { customer_id: string; extra_cents: number }[] } }).data.duplicates;
    expect(dups).toHaveLength(12);
    const batch = {
      type: "refund_batch",
      params: { items: dups.map((d) => ({ customer_id: d.customer_id, amount_cents: d.extra_cents })), reason: "billing_error" },
      rationale: "Refund the 12 duplicate charges.",
    };
    await reply(t, ledger._id, { type: "ESCALATE", need: "authority", summary: "12 duplicates, $420: over today's refund budget.", attempts: ["co data duplicates", "co data budget"], proposed_actions: [batch] });

    // The Finance manager, woken in Ledger's thread, escalates the batch plus a bug for the defect.
    const fm = await taskOf(t, "finance_manager", "issue");
    expect(fm.thread).toBe(ledger._id);
    const bug = { type: "file_bug", params: { title: "Renewals charge twice", body: "12 customers on Oct 22", severity: "high" }, rationale: "Billing defect." };
    await reply(t, fm._id, { type: "ESCALATE", need: "authority", summary: "No rule covers a $420 batch refund.", attempts: ["Checked rules", "Checked budget"], proposed_actions: [batch, bug] });
    const actions = await t.run((ctx) => ctx.db.query("actions").withIndex("by_task", (q) => q.eq("task", fm._id)).collect());
    expect(actions.map((a) => [a.type, a.status, a.gate?.reason])).toEqual([
      ["refund_batch", "escalated", "hard:budget"],
      ["file_bug", "escalated", "novelty:new_type"],
    ]);
    // Packaged, so the gate added no per-action inbox items.
    expect(await t.query(api.inbox.listOpen, {})).toHaveLength(0);

    // The Cofounder writes one package in #founder-desk; it reaches the founder inbox.
    const pkg = await taskOf(t, "cofounder", "package");
    expect(await roomName(t, pkg.room)).toBe("#founder-desk");
    const pkgAssign = (await threadMessages(t, pkg._id))[0].text;
    expect(pkgAssign).toContain("refund_batch $420.00");
    await reply(t, pkg._id, {
      type: "REPORT",
      summary: "Package ready.",
      package: {
        situation: "12 customers were charged twice on Oct 22 ($420).",
        evidence: [`co data thread --id ${ledger._id}`],
        attempts: ["Support refunded one ticket", "Ledger matched charges"],
        options: [{ label: "Refund all 12 and file the bug" }, { label: "Refund only customers who wrote in" }],
        recommendation: "Refund all 12 and file the bug.",
      },
    });
    const [item] = await t.query(api.inbox.listOpen, {});
    expect(item).toMatchObject({ kind: "package", title: "Decide: 12 customers were charged twice on Oct 22 ($420)." });
    expect(item.body).toContain("Recommendation: Refund all 12 and file the bug.");
    const issue = (await allIssues(t)).find((i) => i.package_task === pkg._id)!;
    expect(issue.level).toBe("founder");

    // The founder approves: 12 transfers, budget debited, DECISION in #customer and #finance threads, bug approved.
    const before = nessie.transfersOf(op).length;
    expect(await t.mutation(api.inbox.decide, { inboxId: item._id, choice: "approve", reason: "Refund everyone." })).toMatchObject({ actions: 2 });
    await drain(t);
    expect(nessie.transfersOf(op).length - before).toBe(12);
    const [refundBatch, fileBug] = await t.run((ctx) => ctx.db.query("actions").withIndex("by_task", (q) => q.eq("task", fm._id)).collect());
    expect(refundBatch).toMatchObject({ status: "executed" });
    expect(refundBatch.executed_ref).toHaveLength(12);
    expect(fileBug).toMatchObject({ status: "approved" });
    const budget = await t.run((ctx) => ctx.db.query("budgets").collect());
    expect(budget[0]).toMatchObject({ scope: "company:refund", spent_cents: 42_000 });
    const decisions = await t.run((ctx) => ctx.db.query("decisions").collect());
    expect(decisions.filter((d) => d.action === refundBatch._id || d.action === fileBug._id).map((d) => d.choice)).toEqual(["approve", "approve"]);
    expect(decisions.find((d) => d.action === refundBatch._id)?.features).toMatchObject({ amount_cents: 42_000 });

    for (const root of [support, ledger._id]) {
      const last = (await threadMessages(t, root)).filter((m) => m.text.startsWith("[Dispatcher] Decision on"));
      expect(last.map((m) => m.text)).toContainEqual(expect.stringContaining("approve by founder. Founder approved: Refund everyone."));
    }
    expect(await roomName(t, (await getTask(t, support)).room)).toBe("#customer");
    expect(await roomName(t, ledger.room)).toBe("#finance");
    expect((await allIssues(t)).every((i) => i.status === "resolved")).toBe(true);
    expect((await allTasks(t)).filter((x) => x.status === "escalated")).toHaveLength(0);
    expect(await t.query(api.inbox.listOpen, {})).toHaveLength(0);
    await expect(t.mutation(api.inbox.decide, { inboxId: item._id, choice: "deny" })).rejects.toThrow(/already decided/);

    // The whole chain is in the audit log.
    const trail = await t.query(internal.audit.chainAudit, { chainId: (await getTask(t, support)).chain_id });
    const kinds = new Set(trail.map((r) => r.kind));
    for (const k of ["issue_raised", "issue_escalated", "package_requested", "package_ready", "gate_decision", "founder_decision", "execution_started", "executed"]) {
      expect(kinds.has(k)).toBe(true);
    }
  });

  test("the founder denies: actions denied, nothing executed, DECISION posted", async () => {
    const t = setup();
    await t.mutation(internal.seed.config, {});
    const support = await ticketTask(t);
    await reply(t, support, coordination);
    const cm = await taskOf(t, "customer_manager", "issue");
    const refund = { type: "refund", params: { customer_id: "nobody", amount_cents: 48_000, reason: "billing_error" }, rationale: "Big refund." };
    await reply(t, cm._id, { type: "ESCALATE", need: "authority", summary: "A $480 refund.", attempts: ["Checked rules"], proposed_actions: [refund] });
    const pkg = await taskOf(t, "cofounder", "package");
    await reply(t, pkg._id, {
      type: "REPORT",
      package: { situation: "One $480 refund.", evidence: [], attempts: ["Checked"], options: [{ label: "Deny" }], recommendation: "Deny." },
    });
    const [item] = await t.query(api.inbox.listOpen, {});
    await t.mutation(api.inbox.decide, { inboxId: item._id, choice: "deny", reason: "Too large." });
    await drain(t);
    expect((await t.run((ctx) => ctx.db.query("actions").collect()))[0]).toMatchObject({ type: "refund", status: "denied" });
    expect(nessie.posts).toBe(0);
    expect((await threadMessages(t, support)).at(-1)!.text).toContain("deny by founder. Founder denied: Too large.");
  });
});
