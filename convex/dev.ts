import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { env, internalAction, internalMutation } from "./_generated/server";
import { TOKEN_TTL_MS, hashToken, signTaskToken } from "./lib/tokens";
import { gateAction } from "./gate";
import { jevDecide } from "./labels";
import { jevState, questionsFor } from "./lib/labelSpecs";
import { vActionType, vRole, vTaskStatus } from "./lib/types";
import { taskFromEvent } from "./tasks";

// Dev helper: a seeded support_ticket event, routed by spec 05 (→ Support task in #customer → ASSIGN).
export const seedSupportTicket = internalMutation({
  args: { subject: v.string(), body: v.string(), fromEmail: v.optional(v.string()) },
  returns: v.object({ taskId: v.id("tasks"), messageId: v.id("messages") }),
  handler: async (ctx, { subject, body, fromEmail }) => {
    const now = Date.now();
    const ticketId = await ctx.db.insert("tickets", {
      from_email: fromEmail ?? "customer@example.com",
      subject,
      body,
      status: "open",
      source: "seed",
      created_at: now,
    });
    const eventId = await ctx.db.insert("events", {
      type: "support_ticket",
      payload: {
        ticket: ticketId,
        brief: `Handle ticket ${ticketId}: "${subject}" ${body}`,
        data_hints: [`co data ticket --id ${ticketId}`],
      },
      source: "seed",
      processed: false,
      created_at: now,
    });
    const created = await taskFromEvent(ctx, eventId);
    if (!created) throw new Error(`event ${eventId} was already processed`);
    return created;
  },
});

// Dev helper (spec 09): a support_ticket event for an existing (e.g. Nessie-seeded) ticket, routed like a real one.
//   npx convex run dev:ticketEvent '{"ticketId":"…"}'
export const ticketEvent = internalMutation({
  args: { ticketId: v.id("tickets") },
  returns: v.object({ taskId: v.id("tasks"), messageId: v.id("messages") }),
  handler: async (ctx, { ticketId }) => {
    const ticket = await ctx.db.get(ticketId);
    if (!ticket) throw new Error(`ticket ${ticketId} not found`);
    const eventId = await ctx.db.insert("events", {
      type: "support_ticket",
      payload: {
        ticket: ticketId,
        brief: `Handle ticket ${ticketId}: "${ticket.subject}" ${ticket.body}`,
        data_hints: [`co data ticket --id ${ticketId}`, ...(ticket.customer ? [`co data customer --id ${ticket.customer}`] : []), "co data tickets"],
      },
      source: "seed",
      processed: false,
      created_at: Date.now(),
    });
    const created = await taskFromEvent(ctx, eventId);
    if (!created) throw new Error(`event ${eventId} was already processed`);
    return created;
  },
});

// Dev helper (spec 06): a throwaway task + signed token to call /co/* by hand, e.g.
//   npx convex run dev:coSmokeToken '{"role":"support"}'  →  python3 skills/co/co.py --token <token> data company
// No run is started. Remove the task with dev:dropCoSmokeTask.
const SMOKE_BRIEF = "[dev] co smoke test";

export const coSmokeTask = internalMutation({
  args: { role: vRole, status: vTaskStatus },
  returns: v.id("tasks"),
  handler: async (ctx, { role, status }) => {
    const agent = await ctx.db
      .query("agents")
      .withIndex("by_role", (q) => q.eq("role", role))
      .unique();
    const roomName = agent?.rooms[0] ?? "#customer";
    const room = await ctx.db
      .query("rooms")
      .withIndex("by_name", (q) => q.eq("name", roomName))
      .unique();
    if (!room) throw new Error(`room ${roomName} not seeded (npx convex run seed:config)`);
    const now = Date.now();
    return await ctx.db.insert("tasks", {
      role,
      room: room._id,
      kind: "work",
      brief: SMOKE_BRIEF,
      chain_id: `dev-co-${now}`,
      hop: 0,
      attempt: 1,
      status,
      origin_refs: [],
      deadline: now + TOKEN_TTL_MS,
      mode: "live",
      created_at: now,
      updated_at: now,
    });
  },
});

export const setCoSmokeTokenHash = internalMutation({
  args: { taskId: v.id("tasks"), tokenHash: v.string() },
  returns: v.null(),
  handler: async (ctx, { taskId, tokenHash }) => {
    await ctx.db.patch(taskId, { token_hash: tokenHash });
    return null;
  },
});

export const coSmokeToken = internalAction({
  args: { role: vRole, status: v.optional(vTaskStatus) },
  returns: v.object({ taskId: v.id("tasks"), token: v.string() }),
  handler: async (ctx, { role, status }): Promise<{ taskId: Id<"tasks">; token: string }> => {
    const secret = env.CO_TOKEN_SECRET;
    if (!secret) throw new Error("CO_TOKEN_SECRET is not set");
    const taskId: Id<"tasks"> = await ctx.runMutation(internal.dev.coSmokeTask, { role, status: status ?? "assigned" });
    const token = await signTaskToken(secret, { task: taskId, role, exp: Date.now() + TOKEN_TTL_MS });
    await ctx.runMutation(internal.dev.setCoSmokeTokenHash, { taskId, tokenHash: await hashToken(token) });
    return { taskId, token };
  },
});

export const dropCoSmokeTask = internalMutation({
  args: { taskId: v.id("tasks") },
  returns: v.null(),
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    if (task?.brief !== SMOKE_BRIEF) throw new Error(`${taskId} is not a co smoke-test task`);
    // Also drop what dev:proposeAction hung off it: actions, their inbox items, founder decisions, mock posts,
    // rules learned from those decisions (spec 12) and their inbox items, and thread messages.
    const inbox = await ctx.db.query("founder_inbox").take(1000);
    const posts = await ctx.db.query("post_queue").take(1000);
    const decisionIds = new Set<string>();
    for (const action of await ctx.db.query("actions").withIndex("by_task", (q) => q.eq("task", taskId)).take(100)) {
      for (const item of inbox) if (item.ref === action._id) await ctx.db.delete(item._id);
      for (const post of posts) if (post.action === action._id) await ctx.db.delete(post._id);
      for (const d of await ctx.db.query("decisions").withIndex("by_action_type", (q) => q.eq("action_type", action.type)).take(1000)) {
        if (d.action === action._id) {
          decisionIds.add(d._id);
          await ctx.db.delete(d._id);
        }
      }
      await ctx.db.delete(action._id);
    }
    for (const rule of await ctx.db.query("rules").take(1000)) {
      if (rule.status === "active" || !rule.supporting_decisions.some((d) => decisionIds.has(d))) continue;
      for (const item of inbox) if (item.ref === rule._id) await ctx.db.delete(item._id);
      await ctx.db.delete(rule._id);
    }
    for (const m of await ctx.db.query("messages").withIndex("by_task", (q) => q.eq("task", taskId)).take(500)) await ctx.db.delete(m._id);
    await ctx.db.delete(taskId);
    return null;
  },
});

// Dev helper (spec 08, 11): propose an action on a task and run it through labeling and the real gate, e.g.
//   npx convex run dev:proposeAction '{"taskId":"…","type":"refund","params":{"customer_id":"…","amount_cents":3500}}'
// Without `labels`, Jev labels it and the gate runs after (effect null here; read the action). With `labels`
// (e.g. {"refund_reason":{"value":"billing_error","confidence":0.95}}) Jev is skipped and the gate runs now.
// An allowed Nessie action is executed by the scheduled executeMoneyAction.
export const proposeAction = internalMutation({
  args: {
    taskId: v.id("tasks"),
    type: vActionType,
    params: v.any(),
    rationale: v.optional(v.string()),
    labels: v.optional(v.record(v.string(), v.object({ value: v.union(v.string(), v.boolean(), v.number()), confidence: v.number() }))),
  },
  returns: v.object({ actionId: v.id("actions"), effect: v.union(v.string(), v.null()), reason: v.union(v.string(), v.null()) }),
  handler: async (ctx, { taskId, type, params, rationale, labels }) => {
    const task = await ctx.db.get(taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    const actionId = await ctx.db.insert("actions", {
      task: taskId,
      chain_id: task.chain_id,
      role: task.role,
      type,
      params,
      rationale: rationale ?? "[dev] proposed by hand",
      ...(labels ? { labels } : {}),
      status: "proposed",
      created_at: Date.now(),
    });
    if (!labels) {
      await ctx.scheduler.runAfter(0, internal.labels.labelActions, { actionIds: [actionId], then: { kind: "gate" } });
      return { actionId, effect: null, reason: null };
    }
    const outcome = await gateAction(ctx, actionId);
    return { actionId, effect: outcome?.effect ?? null, reason: outcome?.reason ?? null };
  },
});

// Dev helper: remove a hand-proposed action and its founder inbox items (only "[dev]" rationales).
export const dropDevAction = internalMutation({
  args: { actionId: v.id("actions") },
  returns: v.number(),
  handler: async (ctx, { actionId }) => {
    const action = await ctx.db.get(actionId);
    if (!action || !action.rationale.startsWith("[dev")) throw new Error(`action ${actionId} is not a dev action`);
    let removed = 0;
    for (const item of await ctx.db.query("founder_inbox").withIndex("by_status", (q) => q.eq("status", "open")).take(500)) {
      if (item.ref === actionId) {
        await ctx.db.delete(item._id);
        removed++;
      }
    }
    await ctx.db.delete(actionId);
    return removed;
  },
});

// Dev helper (spec 11): ask Jev about an action without storing anything; returns the labels, Jev's raw
// answers and the cost. `ticket` stands in for the ticket a refund cites.
//   npx convex run dev:probeJev '{"type":"refund","params":{"amount_cents":3500},"rationale":"Charged twice",
//     "ticket":{"subject":"Charged twice","body":"I was billed $35 twice this month."}}'
export const probeJev = internalAction({
  args: {
    type: vActionType,
    params: v.any(),
    rationale: v.string(),
    ticket: v.optional(v.object({ subject: v.string(), body: v.string() })),
    findings: v.optional(v.array(v.object({ claim: v.string(), evidence: v.string(), evidence_text: v.string() }))),
  },
  returns: v.any(),
  handler: async (_ctx, { type, params, rationale, ticket, findings }) => {
    const questions = questionsFor(type, Boolean(findings?.length));
    const state = jevState({ action: { type, role: "dev", params, rationale }, tickets: ticket ? [ticket] : [], findings });
    return { questions: Object.keys(questions), ...(await jevDecide(questions, state)) };
  },
});
