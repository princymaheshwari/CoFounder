import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { env, internalAction, internalMutation, internalQuery, type ActionCtx, type MutationCtx } from "./_generated/server";
import { appendMessage, audit, getConfig } from "./channels";
import { DEFAULT_LEVEL_TIMEOUT_MS, assign, rerun, type HandoffSource } from "./dispatcher";
import { climbFromLadderTask, handOffIssues, isLadderTask, onPackage, packageFallback, raiseIssue, resolveIssues, settleHandledIssues } from "./issues";
import type { Envelope, ParseResult, ProposedAction } from "./lib/envelope";
import { AWAITING_REPLY, CLOSED_STATUSES, checkHandoff, deadlineAction, routeEvent, type HandoffRejection } from "./lib/routing";
import { hashToken, verifyTaskToken } from "./lib/tokens";
import { vRole, type Role, type RunStatus, type TaskKind, type TaskMode, type TaskStatus } from "./lib/types";

// Task state machine (spec 05). The task status is the state machine: every transition is a mutation
// with an audit row. Outbound work (runs) goes through the Dispatcher's department Workpools.

const NUDGE_NOTE = "No reply arrived before the deadline. Reply now with one cofounder envelope for this task.";
const MAX_BRIEF = 2_000;

export async function transition(
  ctx: MutationCtx,
  task: Doc<"tasks">,
  to: TaskStatus,
  trigger: string,
  detail: Record<string, unknown> = {},
): Promise<Doc<"tasks">> {
  const patch = { status: to, updated_at: Date.now() };
  await ctx.db.patch(task._id, patch);
  await audit(ctx, {
    actor: "dispatcher",
    kind: "task_status",
    ref: task._id,
    detail: { from: task.status, to, trigger, chain: task.chain_id, ...detail },
  });
  return { ...task, ...patch };
}

async function roomByName(ctx: MutationCtx, name: string): Promise<Id<"rooms">> {
  const room = await ctx.db
    .query("rooms")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
  if (!room) throw new Error(`channel ${name} not seeded (npx convex run seed:config)`);
  return room._id;
}

async function agentFor(ctx: MutationCtx, role: Role): Promise<Doc<"agents"> | null> {
  return await ctx.db
    .query("agents")
    .withIndex("by_role", (q) => q.eq("role", role))
    .unique();
}

export async function insertTask(
  ctx: MutationCtx,
  t: {
    role: Role;
    room: Id<"rooms">;
    kind: TaskKind;
    brief: string;
    chain_id: string;
    hop: number;
    origin_refs: string[];
    mode: TaskMode;
    event?: Id<"events">;
    parent_task?: Id<"tasks">;
    thread?: Id<"tasks">; // spec 09: a manager task writes into the employee's thread
    issue?: Id<"issues">;
  },
): Promise<Id<"tasks">> {
  const now = Date.now();
  const taskId = await ctx.db.insert("tasks", {
    ...t,
    attempt: 1,
    status: "queued",
    deadline: now + (await getConfig(ctx, "level_timeout_ms", DEFAULT_LEVEL_TIMEOUT_MS)),
    created_at: now,
    updated_at: now,
  });
  await audit(ctx, {
    actor: "dispatcher",
    kind: "task_status",
    ref: taskId,
    detail: { from: null, to: "queued", trigger: t.parent_task ? (t.kind === "handoff" ? "handoff" : t.kind) : "event", chain: t.chain_id, hop: t.hop, role: t.role, parent: t.parent_task ?? null },
  });
  return taskId;
}

// ---------------------------------------------------------------- event → task

function eventBrief(type: string, payload: unknown): string {
  if (payload && typeof payload === "object" && "brief" in payload && typeof payload.brief === "string") return payload.brief;
  const body = JSON.stringify(payload ?? null);
  return `Event ${type}: ${body.length > MAX_BRIEF ? `${body.slice(0, MAX_BRIEF - 1)}…` : body}`;
}

function eventRefs(payload: unknown): string[] {
  const refs: unknown = payload && typeof payload === "object" ? (payload as { refs?: unknown }).refs : undefined;
  return Array.isArray(refs) ? refs.filter((r): r is string => typeof r === "string") : [];
}

// Routes an unprocessed event to its role and channel, opens the task and assigns it. Null if already processed.
export async function taskFromEvent(
  ctx: MutationCtx,
  eventId: Id<"events">,
): Promise<{ taskId: Id<"tasks">; messageId: Id<"messages"> } | null> {
  const event = await ctx.db.get(eventId);
  if (!event) throw new Error(`event ${eventId} not found`);
  if (event.processed) return null;
  const route = routeEvent(event.type);
  const taskId = await insertTask(ctx, {
    role: route.role,
    room: await roomByName(ctx, route.room),
    kind: event.type === "weekly_review" ? "review" : "work",
    brief: eventBrief(event.type, event.payload),
    event: eventId,
    chain_id: `c_${eventId}`,
    hop: 0,
    origin_refs: eventRefs(event.payload),
    mode: event.source === "replay" ? "replay" : "live",
  });
  await ctx.db.patch(eventId, { processed: true });
  const messageId = await assign(ctx, taskId);
  return { taskId, messageId };
}

export const createTaskFromEvent = internalMutation({
  args: { eventId: v.id("events") },
  returns: v.union(v.object({ taskId: v.id("tasks"), messageId: v.id("messages") }), v.null()),
  handler: (ctx, { eventId }) => taskFromEvent(ctx, eventId),
});

// ---------------------------------------------------------------- child tasks (graph limits)

export type ChildResult = { ok: true; taskId: Id<"tasks"> } | { ok: false; reason: HandoffRejection | "no_agent" };

// Creates and assigns a child task for `role` in that role's home channel, if the graph limits allow it.
export async function createChildTask(
  ctx: MutationCtx,
  parent: Doc<"tasks">,
  child: { role: Role; brief: string; kind: TaskKind; refs: string[]; handoff?: HandoffSource },
): Promise<ChildResult> {
  // A chain is small (hop ≤ 3, ≤ 3 children each), so the chain index bounds this scan.
  const chain = await ctx.db
    .query("tasks")
    .withIndex("by_chain", (q) => q.eq("chain_id", parent.chain_id))
    .take(200);
  const check = checkHandoff(parent, child.role, chain.filter((t) => t.parent_task === parent._id).length);
  if (!check.ok) return check;
  const agent = await agentFor(ctx, child.role);
  if (!agent?.enabled || agent.kind !== "role" || !agent.rooms[0]) return { ok: false, reason: "no_agent" };

  const taskId = await insertTask(ctx, {
    role: child.role,
    room: await roomByName(ctx, agent.rooms[0]),
    kind: child.kind,
    brief: child.brief,
    parent_task: parent._id,
    event: parent.event,
    chain_id: parent.chain_id,
    hop: check.hop,
    origin_refs: [parent._id, ...child.refs.filter((r) => r !== parent._id)],
    mode: parent.mode,
  });
  await assign(ctx, taskId, child.handoff ? { handoff: child.handoff } : {});
  return { ok: true, taskId };
}

const REJECTION_TEXT: Record<HandoffRejection | "no_agent", string> = {
  hop_limit: "the chain already has 3 hops",
  self_role: "a role cannot hand off to itself",
  max_children: "the task already has 3 child tasks",
  executor_target: "only the gate dispatches the Executor",
  no_agent: "no enabled agent holds that role",
};

// ---------------------------------------------------------------- agent replies

// Persists proposed actions; labels.labelActions labels each one (spec 11) and the gate decides it (spec 07).
export async function proposeActions(ctx: MutationCtx, task: Doc<"tasks">, actions: ProposedAction[]): Promise<Id<"actions">[]> {
  const ids: Id<"actions">[] = [];
  for (const action of actions) {
    const actionId = await ctx.db.insert("actions", {
      task: task._id,
      chain_id: task.chain_id,
      role: task.role,
      type: action.type,
      params: action.params,
      rationale: action.rationale,
      status: "proposed",
      created_at: Date.now(),
    });
    await audit(ctx, { actor: task.role, kind: "action_proposed", ref: task._id, detail: { actionId, type: action.type } });
    ids.push(actionId);
  }
  return ids;
}

async function finishWithActions(ctx: MutationCtx, task: Doc<"tasks">, env: Envelope, messageId: Id<"messages">) {
  if (!env.proposed_actions?.length) {
    await transition(ctx, task, "done", env.type, { messageId });
    return;
  }
  const actionIds = await proposeActions(ctx, task, env.proposed_actions);
  await transition(ctx, task, "gated", env.type, { messageId, actionIds });
  // Jev labels each action, then the gate decides it in the same transaction as its labels (spec 11).
  await ctx.scheduler.runAfter(0, internal.labels.labelActions, { actionIds, then: { kind: "gate" } });
}

// A cross-department handoff is announced in #leadership (no run), so the conversation is visible there (spec 09).
async function leadershipNotice(ctx: MutationCtx, task: Doc<"tasks">, toRole: Role, childId: Id<"tasks">, summary: string): Promise<void> {
  const [from, to] = [await agentFor(ctx, task.role), await agentFor(ctx, toRole)];
  if (!from || !to || from.department === to.department) return;
  const leadership = await ctx.db
    .query("rooms")
    .withIndex("by_name", (q) => q.eq("name", "#leadership"))
    .unique();
  if (!leadership) return;
  const target = await ctx.db.get(childId);
  const targetRoom = target ? (await ctx.db.get(target.room))?.name : undefined;
  await appendMessage(ctx, {
    room: leadership._id,
    sender_kind: "system",
    sender_name: "Dispatcher",
    text: `[Dispatcher] ${from.display_name} handed task ${task._id} off to ${to.display_name}${targetRoom ? ` in ${targetRoom}` : ""} (task ${childId}): ${summary}`,
  });
}

// Acts on a valid envelope from a task in `replied` (spec 05 transitions).
export async function routeEnvelope(
  ctx: MutationCtx,
  task: Doc<"tasks">,
  env: Envelope,
  messageId: Id<"messages">,
): Promise<void> {
  // Spec 09: a package task answers with the founder package; anything else sends the issue to the inbox as is.
  if (task.kind === "package") {
    if (env.type === "REPORT") return await onPackage(ctx, task, env, messageId);
    await transition(ctx, task, "escalated", `PACKAGE_${env.type}`, { messageId });
    const issue = task.issue ? await ctx.db.get(task.issue) : null;
    if (issue) await packageFallback(ctx, issue, `the Cofounder sent ${env.type} instead of a package: ${env.summary}`);
    return;
  }
  switch (env.type) {
    case "REPORT": {
      await finishWithActions(ctx, task, env, messageId);
      // A manager's REPORT on an issue settles it (spec 09).
      if (task.kind === "issue") await settleHandledIssues(ctx, task, env.summary);
      // The task is done, but the agent saw a problem beyond its role: it climbs like an ISSUE. Not handed back
      // to the employee (fromEnvelope false), since the task itself is already finished.
      if (env.issue) {
        const after = (await ctx.db.get(task._id))!;
        await raiseIssue(ctx, after, {
          kind: env.issue.kind,
          summary: env.issue.summary,
          attempts: env.issue.attempts,
          evidence: [messageId, ...(env.refs ?? [])],
        });
      }
      return;
    }

    case "HANDOFF": {
      const toRole = env.to_role!; // the parser requires to_role and brief on HANDOFF
      const from = await agentFor(ctx, task.role);
      const child = await createChildTask(ctx, task, {
        role: toRole,
        brief: env.brief!,
        kind: "handoff",
        refs: env.refs ?? [],
        handoff: { fromName: from?.display_name ?? task.role, sourceRef: task._id, sourceSummary: env.summary },
      });
      if (child.ok) {
        await transition(ctx, task, "done", "HANDOFF", { messageId, child: child.taskId, toRole });
        if (task.kind === "issue") await handOffIssues(ctx, task, toRole, child.taskId);
        await leadershipNotice(ctx, task, toRole, child.taskId, env.summary);
        return;
      }
      // A handoff the graph limits refuse becomes a coordination ISSUE; past the hop limit it goes to the Cofounder.
      await transition(ctx, task, "escalated", "HANDOFF_REJECTED", { messageId, toRole, reason: child.reason });
      await raiseIssue(ctx, task, {
        kind: "coordination",
        summary: `Handoff to ${toRole} refused: ${REJECTION_TEXT[child.reason]}. ${env.summary}`,
        attempts: [`HANDOFF to ${toRole}: ${env.brief!}`],
        evidence: [messageId, ...(env.refs ?? [])],
        ...(child.reason === "hop_limit" ? { toRole: "cofounder" as const } : {}),
      });
      return;
    }

    case "ISSUE":
    case "ESCALATE":
      await transition(ctx, task, "escalated", env.type, { messageId });
      await raiseIssue(ctx, task, {
        kind: env.type === "ISSUE" ? env.kind! : env.need!, // the parser requires kind / need
        summary: env.summary,
        attempts: env.attempts ?? [],
        evidence: [messageId, ...(env.refs ?? [])],
        proposedActions: env.proposed_actions ?? [],
        fromEnvelope: true,
      });
      return;

    case "OBJECT":
      // Spec 15 attaches the objection to the referenced proposal and opens the Cofounder review.
      await audit(ctx, { actor: task.role, kind: "objection", ref: task._id, detail: { messageId, refs: env.refs, findings: env.findings } });
      await transition(ctx, task, "done", "OBJECT", { messageId });
      return;

    case "DECISION": {
      // A manager or Cofounder decision resolves the issue it answers: on this task or the task it was raised on.
      const resolved = await resolveIssues(ctx, task.parent_task ? [task._id, task.parent_task] : [task._id], env.summary, task.role);
      await audit(ctx, { actor: task.role, kind: "decision", ref: task._id, detail: { messageId, resolved } });
      await finishWithActions(ctx, task, env, messageId);
      if (task.kind === "issue") await settleHandledIssues(ctx, task, env.summary);
      return;
    }

    case "ASSIGN":
      throw new Error("parseEnvelope never accepts ASSIGN from an agent");
  }
}

async function envelopeErrors(ctx: MutationCtx, taskId: Id<"tasks">): Promise<string[]> {
  const thread = await ctx.db
    .query("messages")
    .withIndex("by_task", (q) => q.eq("task", taskId))
    .take(200);
  return thread.flatMap((m) => (m.envelope_error ? [m.envelope_error] : []));
}

// Called by dispatcher.recordReply, in the same transaction, after the reply is stored in the thread.
export async function onAgentReply(
  ctx: MutationCtx,
  taskId: Id<"tasks">,
  messageId: Id<"messages">,
  parsed: ParseResult,
): Promise<void> {
  const task = await ctx.db.get(taskId);
  if (!task) return;
  // A late reply (e.g. the original run answering after a nudge already got one) stays in the thread only.
  if (!AWAITING_REPLY.includes(task.status)) {
    await audit(ctx, { actor: task.role, kind: "reply_ignored", ref: task._id, detail: { messageId, status: task.status } });
    return;
  }
  if (!parsed.ok) {
    if (task.status === "assigned") {
      await transition(ctx, task, "repairing", "invalid_envelope", { messageId, error: parsed.error });
      await rerun(ctx, task._id, "repair", parsed.error);
      return;
    }
    if (isLadderTask(task)) return await climbFromLadderTask(ctx, task, "invalid_after_repair", "sent an invalid envelope twice");
    const errors = await envelopeErrors(ctx, task._id);
    await transition(ctx, task, "escalated", "invalid_after_repair", { messageId, error: parsed.error });
    await raiseIssue(ctx, task, {
      kind: "capability",
      summary: `${task.role} sent an invalid envelope twice on task ${task._id}.`,
      attempts: errors,
      evidence: [messageId],
    });
    return;
  }
  const replied = await transition(ctx, task, "replied", parsed.env.type, { messageId });
  await routeEnvelope(ctx, replied, parsed.env, messageId);
}

// A run that ends failed or cancelled fails its task and puts it on the ladder. Older runs are ignored.
export async function onRunFailed(
  ctx: MutationCtx,
  taskId: Id<"tasks">,
  runId: string,
  status: RunStatus,
  errorCode: string | undefined,
): Promise<void> {
  const task = await ctx.db.get(taskId);
  if (!task || !AWAITING_REPLY.includes(task.status) || task.creao_run_id !== runId) return;
  if (isLadderTask(task)) return await climbFromLadderTask(ctx, task, `run_${status}`, `run ended as ${status}${errorCode ? ` (${errorCode})` : ""}`);
  const failed = await transition(ctx, task, "failed", `run_${status}`, { runId, errorCode });
  await raiseIssue(ctx, failed, {
    kind: "capability",
    summary: `The ${task.role} run for task ${task._id} ended as ${status}${errorCode ? ` (${errorCode})` : ""}.`,
    attempts: [`run ${runId}: ${status}${errorCode ? ` ${errorCode}` : ""}`],
    evidence: [runId],
  });
}

// ---------------------------------------------------------------- deadlines (cron, 1 min)

export const checkStuckTasks = internalMutation({
  args: {},
  returns: v.object({ nudged: v.number(), escalated: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    let nudged = 0;
    let escalated = 0;
    for (const status of AWAITING_REPLY) {
      const tasks = await ctx.db
        .query("tasks")
        .withIndex("by_status", (q) => q.eq("status", status))
        .take(200);
      for (const task of tasks) {
        const next = deadlineAction(task, now);
        if (next === "nudge") {
          await ctx.db.patch(task._id, { nudged: true });
          await transition(ctx, task, "assigned", "deadline_nudge");
          await rerun(ctx, task._id, "nudge", NUDGE_NOTE);
          nudged++;
        } else if (next === "escalate" && isLadderTask(task)) {
          // Spec 09: each ladder level gets one attempt within its time budget, then climbs.
          await climbFromLadderTask(ctx, task, "deadline", "timed out");
          escalated++;
        } else if (next === "escalate") {
          const out = await transition(ctx, task, "escalated", "deadline");
          await raiseIssue(ctx, out, {
            kind: "capability",
            summary: `${task.role} did not reply to task ${task._id} before the deadline.`,
            attempts: status === "assigned" ? ["assigned: no reply", "nudged once: no reply"] : ["repair requested: no reply"],
            evidence: task.creao_run_id ? [task.creao_run_id] : [],
          });
          escalated++;
        }
      }
    }
    return { nudged, escalated };
  },
});

// ---------------------------------------------------------------- task tokens

const vTokenError = v.union(
  v.literal("malformed"),
  v.literal("bad_signature"),
  v.literal("expired"),
  v.literal("unknown_task"),
  v.literal("revoked"),
  v.literal("closed"),
);
const vTokenResult = v.union(
  v.object({ ok: v.literal(true), taskId: v.id("tasks"), role: vRole }),
  v.object({ ok: v.literal(false), error: vTokenError }),
);
type TokenResult =
  | { ok: true; taskId: Id<"tasks">; role: Role }
  | { ok: false; error: "malformed" | "bad_signature" | "expired" | "unknown_task" | "revoked" | "closed" };

export const tokenTask = internalQuery({
  args: { task: v.string(), role: v.string(), tokenHash: v.string() },
  returns: vTokenResult,
  handler: async (ctx, a): Promise<TokenResult> => {
    const taskId = ctx.db.normalizeId("tasks", a.task);
    const task = taskId ? await ctx.db.get(taskId) : null;
    if (!task) return { ok: false, error: "unknown_task" };
    if (task.token_hash !== a.tokenHash || task.role !== a.role) return { ok: false, error: "revoked" };
    if (CLOSED_STATUSES.includes(task.status)) return { ok: false, error: "closed" };
    return { ok: true, taskId: task._id, role: task.role };
  },
});

// Signature, expiry, then the task: the token must be the one issued for it and the task still open.
// Spec 06's /co/* routes call this from their httpAction.
export async function verifyTaskAccess(ctx: ActionCtx, token: string): Promise<TokenResult> {
  const secret = env.CO_TOKEN_SECRET;
  if (!secret) throw new Error("CO_TOKEN_SECRET is not set");
  const verified = await verifyTaskToken(secret, token, Date.now());
  if (!verified.ok) return verified;
  return await ctx.runQuery(internal.tasks.tokenTask, {
    task: verified.claims.task,
    role: verified.claims.role,
    tokenHash: await hashToken(token),
  });
}

export const verifyToken = internalAction({
  args: { token: v.string() },
  returns: vTokenResult,
  handler: (ctx, { token }): Promise<TokenResult> => verifyTaskAccess(ctx, token),
});
