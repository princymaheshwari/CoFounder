import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { env, internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { appendMessage, audit } from "./channels";
import { DAY_MS, findDuplicateCharges } from "./lib/co";
import { vRunPurpose, type ActionType } from "./lib/types";
import { seedRules } from "./seed";
import { assign } from "./dispatcher";
import { insertTask, taskFromEvent } from "./tasks";

// Story mode: a repeatable demo through the real pipeline. Tasks run with mode "replay": the Dispatcher
// still posts every ASSIGN, but instead of a Creao run, `reply` answers with a recorded envelope a few
// seconds later and hands it to dispatcher.recordReply, so the validator, gate, Jev labels, issue ladder,
// #founder-desk requests and rule learning all run for real. Execution is recorded, never sent.
// Everything here needs DEMO_TOOLS=on (npx convex env set DEMO_TOOLS on).

export const STORY_REPLY_MS = 2_500;
const STORY_EMAIL = "story-customer@example.com";

function requireDemo(): void {
  if (env.DEMO_TOOLS !== "on") throw new Error("Demo tools are off. Run: npx convex env set DEMO_TOOLS on");
}

// ---------------------------------------------------------------- recorded agents

const POSTS = [
  "Lumen Notes now writes your action items straight into your calendar, so nothing from Tuesday's meeting waits until Friday.",
  "Three ways product teams use AI meeting notes to cut follow-up time: shared decisions, owner tags, and a one-line recap.",
  "Our new summary view puts every decision from the week's meetings on one page. Open it before your Monday planning.",
  "You can now search across every meeting you have recorded. Type a customer's name and see each time they came up.",
];
const postIndex = (brief: string) => Number(/\[story post (\d+)\]/.exec(brief)?.[1] ?? 0);

type Env = Record<string, unknown>;

async function loyalCustomer(ctx: QueryCtx): Promise<Doc<"customers"> | null> {
  const now = Date.now();
  const all = await ctx.db.query("customers").take(200);
  return all.find((c) => (now - c.signup_at) / DAY_MS >= 120) ?? all[0] ?? null;
}

// The duplicate charges Ledger finds with `co data duplicates`, as one refund batch.
async function duplicateBatch(ctx: QueryCtx): Promise<{ items: { customer_id: string; amount_cents: number }[]; total: number }> {
  const customers = await ctx.db.query("customers").take(1000);
  const byAccount = new Map(customers.map((c) => [c.nessie_account_id, c]));
  const transfers = await ctx.db
    .query("ledger_mirror")
    .withIndex("by_kind", (q) => q.eq("kind", "transfer"))
    .take(5000);
  let items = findDuplicateCharges(transfers.filter((r) => byAccount.has(r.account_id))).map((g) => ({ customer_id: byAccount.get(g.account_id)!._id, amount_cents: g.extra_cents }));
  if (!items.length) items = customers.slice(0, 12).map((c) => ({ customer_id: c._id, amount_cents: 3500 }));
  return { items, total: items.reduce((n, i) => n + i.amount_cents, 0) };
}

async function latestOfType(ctx: QueryCtx, chainId: string, type: ActionType): Promise<Doc<"actions"> | null> {
  const rows = await ctx.db
    .query("actions")
    .withIndex("by_type", (q) => q.eq("type", type))
    .order("desc")
    .take(50);
  return rows.find((a) => a.chain_id === chainId) ?? null;
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

// What each agent says in the story, decided from the task in front of it (the ladder picks who is next).
async function scriptFor(ctx: QueryCtx, task: Doc<"tasks">): Promise<Env> {
  const base = { task: task._id, from: task.role };
  switch (task.role) {
    case "support": {
      const event = task.event ? await ctx.db.get(task.event) : null;
      const payload = (event?.payload ?? {}) as { ticket?: string; customer?: string };
      return {
        ...base,
        type: "REPORT",
        summary: "Refunded the duplicate $35 Pro charge under R7. Five more tickets this morning report the same double charge.",
        proposed_actions: [
          {
            type: "refund",
            params: { customer_id: payload.customer, ticket_id: payload.ticket, amount_cents: 3500, reason: "billing_error" },
            rationale: "Charged twice for the same Pro renewal; a long-standing customer, so R7 covers it.",
          },
        ],
        issue: { kind: "coordination", summary: "Six tickets report the same duplicate $35 Pro charge since yesterday. Looks like one billing bug, not six refunds.", attempts: ["Refunded my own ticket under R7", "Checked co data tickets"] },
      };
    }
    case "customer_manager":
      return {
        ...base,
        type: "HANDOFF",
        to_role: "ledger",
        brief: "Find every customer charged twice for the Pro renewal and propose one fix for all of them.",
        summary: "Grouped the six tickets: one billing bug. Ledger can see every affected account.",
      };
    case "ledger": {
      const batch = await duplicateBatch(ctx);
      return {
        ...base,
        type: "ESCALATE",
        need: "authority",
        summary: `${batch.items.length} customers were charged twice (${dollars(batch.total)} in total). That is over today's refund budget, so I can't approve it.`,
        attempts: ["co data duplicates", "co data budget"],
        proposed_actions: [{ type: "refund_batch", params: { items: batch.items, reason: "billing_error" }, rationale: `Refund all ${batch.items.length} duplicate charges in one batch.` }],
      };
    }
    case "finance_manager": {
      // Ledger's ESCALATE carried the batch as a proposal only; the manager re-proposes it (spec 09 gates it here).
      const batch = await latestOfType(ctx, task.chain_id, "refund_batch");
      const params = (batch?.params as Env | undefined) ?? { items: (await duplicateBatch(ctx)).items, reason: "billing_error" };
      return {
        ...base,
        type: "ESCALATE",
        need: "authority",
        summary: "No rule covers a batch refund this size. Recommending the refund plus a bug for the renewal job.",
        attempts: ["Checked active rules", "Checked today's budget"],
        proposed_actions: [
          { type: "refund_batch", params, rationale: batch?.rationale ?? "Refund every duplicate charge." },
          { type: "file_bug", params: { title: "Pro renewal charges some customers twice", body: "The renewal job ran twice for a set of accounts. Every affected customer is in the refund batch.", severity: "high" }, rationale: "Stop it from happening again." },
        ],
      };
    }
    case "cofounder": {
      const issue = task.issue ? await ctx.db.get(task.issue) : null;
      const batch = await latestOfType(ctx, task.chain_id, "refund_batch");
      const count = Array.isArray((batch?.params as Env | undefined)?.items) ? ((batch!.params as Env).items as unknown[]).length : 0;
      const total = batch?.amount_cents ?? 0;
      return {
        ...base,
        type: "REPORT",
        summary: "One decision for the founder.",
        package: {
          situation: `${count} customers were charged twice for Pro (${dollars(total)}). One renewal bug caused all of it.`,
          evidence: [`co data thread --id ${task.parent_task ?? task._id}`, ...(issue ? [issue._id] : [])],
          attempts: ["Support refunded one ticket under R7", "Ledger matched every duplicate charge", "Finance confirmed no rule covers a batch this size"],
          options: [{ label: "Refund everyone and file the bug" }, { label: "Refund only customers who wrote in" }],
          recommendation: "Refund everyone and file the bug. Waiting means more tickets for the same $35.",
        },
      };
    }
    case "content": {
      const text = POSTS[postIndex(task.brief) % POSTS.length];
      return {
        ...base,
        type: "REPORT",
        summary: "Drafted a LinkedIn post for the week.",
        proposed_actions: [{ type: "publish_post", params: { channel: "linkedin", text }, rationale: "Factual product update in our voice. No prices, no competitors." }],
      };
    }
    default:
      return { ...base, type: "REPORT", summary: "Done." };
  }
}

const wrap = (e: Env) => `Here is my reply.\n\n\`\`\`cofounder\n${JSON.stringify(e)}\n\`\`\``;

// Stands in for one Creao run: marks it started, then delivers the recorded reply through the real receiver.
export const reply = internalMutation({
  args: { taskId: v.id("tasks"), messageId: v.id("messages"), purpose: vRunPurpose, attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, a) => {
    const task = await ctx.db.get(a.taskId);
    if (!task || task.mode !== "replay") return null;
    const runId = `story-${a.taskId}-${a.purpose}-${a.attempt}`;
    await ctx.runMutation(internal.dispatcher.markRunStarted, { ...a, runId, idempotencyKey: runId, tokenHash: "story" });
    const text = wrap(await scriptFor(ctx, (await ctx.db.get(a.taskId))!));
    await ctx.runMutation(internal.dispatcher.recordReply, { runId, status: "completed", text });
    return null;
  },
});

// Story execution: what would be sent is recorded on the action and noted in its thread.
export async function recordStoryExecution(ctx: MutationCtx, action: Doc<"actions">): Promise<void> {
  const items = Array.isArray((action.params as Env | undefined)?.items) ? ((action.params as Env).items as unknown[]).length : 0;
  const what: Record<string, string> = {
    refund: "Refund recorded",
    refund_batch: `${items} refunds recorded`,
    publish_post: "Post queued for LinkedIn",
    file_bug: "Bug filed for engineering",
    reply_customer: "Reply queued for the customer",
  };
  await ctx.db.patch(action._id, { status: "executed", executed_ref: [`story:${action.type}`] });
  await audit(ctx, { actor: "executor", kind: "executed", ref: action.task, detail: { actionId: action._id, type: action.type, how: "story" } });
  const task = await ctx.db.get(action.task);
  if (task) {
    await appendMessage(ctx, {
      room: task.room,
      task: task._id,
      sender_kind: "system",
      sender_name: "Dispatcher",
      text: `[Dispatcher] ${what[action.type] ?? `${action.type} recorded`} (story mode: nothing was sent).`,
    });
  }
}

// ---------------------------------------------------------------- acts

const vAct = v.union(v.literal("double_charge"), v.literal("posts"), v.literal("after_rule"));

async function contentTask(ctx: MutationCtx, n: number): Promise<Id<"tasks">> {
  const room = await ctx.db
    .query("rooms")
    .withIndex("by_name", (q) => q.eq("name", "#marketing"))
    .unique();
  if (!room) throw new Error("#marketing is not seeded (npx convex run seed:config)");
  const taskId = await insertTask(ctx, {
    role: "content",
    room: room._id,
    kind: "work",
    brief: `Draft this week's LinkedIn post about a recent product improvement. [story post ${n}]`,
    chain_id: `story-post-${n}-${Date.now()}`,
    hop: 0,
    origin_refs: [],
    mode: "replay",
  });
  await assign(ctx, taskId);
  return taskId;
}

export const start = mutation({
  args: { act: vAct },
  returns: v.array(v.id("tasks")),
  handler: async (ctx, { act }) => {
    requireDemo();
    await audit(ctx, { actor: "founder", kind: "story_act", ref: act });
    if (act === "double_charge") {
      const customer = await loyalCustomer(ctx);
      const now = Date.now();
      const ticket = await ctx.db.insert("tickets", {
        ...(customer ? { customer: customer._id } : {}),
        from_email: STORY_EMAIL,
        subject: "Charged twice for Pro this month",
        body: "Hi, my card shows two $35 charges for the Pro plan this month. I only have one account. Can you refund the extra one?",
        amount_cents: 3500,
        status: "open",
        source: "seed",
        created_at: now,
      });
      const eventId = await ctx.db.insert("events", {
        type: "support_ticket",
        payload: {
          ticket,
          ...(customer ? { customer: customer._id } : {}),
          brief: `Handle ticket ${ticket}: "Charged twice for Pro this month". The customer sees two $35 Pro charges and asks for the extra one back.`,
          data_hints: [`co data ticket --id ${ticket}`],
        },
        source: "replay",
        processed: false,
        created_at: now,
      });
      const created = await taskFromEvent(ctx, eventId);
      return created ? [created.taskId] : [];
    }
    if (act === "posts") {
      const used = (await ctx.db.query("tasks").withIndex("by_role", (q) => q.eq("role", "content")).take(200)).length;
      return [await contentTask(ctx, used), await contentTask(ctx, used + 1), await contentTask(ctx, used + 2)];
    }
    const used = (await ctx.db.query("tasks").withIndex("by_role", (q) => q.eq("role", "content")).take(200)).length;
    return [await contentTask(ctx, used)];
  },
});

// What the presenter panel shows: how far the story is, and what to click next.
export const status = query({
  args: {},
  returns: v.object({
    enabled: v.boolean(),
    started: v.array(v.string()),
    openRequests: v.number(),
    activeRules: v.number(),
    proposedRules: v.number(),
  }),
  handler: async (ctx) => {
    const acts = (await ctx.db.query("audit_log").withIndex("by_at").order("desc").take(500)).filter((r) => r.kind === "story_act").map((r) => r.ref);
    const open = await ctx.db
      .query("founder_inbox")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .take(100);
    const rules = await ctx.db.query("rules").take(500);
    return {
      enabled: env.DEMO_TOOLS === "on",
      started: [...new Set(acts)],
      openRequests: open.length,
      activeRules: rules.filter((r) => r.status === "active").length,
      proposedRules: rules.filter((r) => r.status === "proposed").length,
    };
  },
});

// ---------------------------------------------------------------- reset

const WIPE = ["messages", "tasks", "actions", "issues", "decisions", "rules", "founder_inbox", "audit_log", "events", "runs", "post_queue", "outbox", "budgets"] as const;

// Clears every conversation, decision and rule (then re-seeds R7), keeping agents, channels, company,
// customers, Nessie mirror and seeded tickets. Run before a demo. Scheduled runs already in flight are not cancelled.
export async function resetDemo(ctx: MutationCtx): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of WIPE) {
    let n = 0;
    for (;;) {
      const rows = await ctx.db.query(table).take(500);
      if (!rows.length) break;
      for (const r of rows) await ctx.db.delete(r._id);
      n += rows.length;
      if (rows.length < 500) break;
    }
    counts[table] = n;
  }
  for (const t of await ctx.db.query("tickets").take(2000)) if (t.from_email === STORY_EMAIL) await ctx.db.delete(t._id);
  for (const c of await ctx.db.query("config").take(500)) if (c.key.startsWith("induction_pending")) await ctx.db.delete(c._id);
  for (const r of await ctx.db.query("rooms").take(50)) await ctx.db.patch(r._id, { next_seq: 1 });
  for (const f of await ctx.db.query("founder").take(10)) await ctx.db.patch(f._id, { status: "present", updated_at: Date.now() });
  await seedRules(ctx);
  return counts;
}

export const reset = mutation({
  args: {},
  returns: v.record(v.string(), v.number()),
  handler: async (ctx) => {
    requireDemo();
    return await resetDemo(ctx);
  },
});

export const resetInternal = internalMutation({
  args: {},
  returns: v.record(v.string(), v.number()),
  handler: (ctx) => resetDemo(ctx),
});
