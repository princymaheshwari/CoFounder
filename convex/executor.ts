import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction, internalMutation, query, type MutationCtx } from "./_generated/server";
import { appendMessage, audit, getConfig } from "./channels";
import { recordStoryExecution } from "./story";
import { RateLimitedError } from "./creao/http";
import { getRun, replyText, startRun, webhookUrl } from "./creao/runs";
import { rateLimiter } from "./dispatcher";
import { raiseIssue } from "./issues";
import { CATALOG } from "./lib/catalog";
import { CONNECTOR_OF, DEPARTMENT_MANAGER, executorInput, readExecutorReply, type Connector } from "./lib/executor";
import { executionBlock } from "./lib/nessie";
import type { RunStatus } from "./lib/types";
import { founderApproved } from "./nessie";

// Spec 10: connector actions run through the one Executor agent (Auto write autonomy), started only here
// (invariant 3: dispatcher.startRunForTask and executor.runExecutor are the only startRun callers).
// publish_post goes to the mock post queue; a connector that is not connected goes to the mock outbox.

const CONFIG_KEY = "executor";
type ExecutorConfig = { connectors: Connector[]; email_redirect_to?: string };
const DEFAULT_CONFIG: ExecutorConfig = { connectors: ["linear"] }; // Linear is required; Gmail and Calendar are optional

const vConnector = v.union(v.literal("linear"), v.literal("gmail"), v.literal("calendar"));

// Records which connectors the Executor has in Creao, and where customer emails really go (a test inbox).
//   npx convex run executor:configure '{"connectors":["linear","gmail","calendar"],"email_redirect_to":"me@example.com"}'
export const configure = internalMutation({
  args: { connectors: v.array(vConnector), email_redirect_to: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, a) => {
    const value: ExecutorConfig = { connectors: [...new Set(a.connectors)], ...(a.email_redirect_to ? { email_redirect_to: a.email_redirect_to } : {}) };
    const row = await ctx.db
      .query("config")
      .withIndex("by_key", (q) => q.eq("key", CONFIG_KEY))
      .unique();
    if (row) await ctx.db.patch(row._id, { value });
    else await ctx.db.insert("config", { key: CONFIG_KEY, value });
    await audit(ctx, { actor: "founder", kind: "executor_configured", ref: CONFIG_KEY, detail: { connectors: value.connectors, redirect: !!value.email_redirect_to } });
    return null;
  },
});

// ---------------------------------------------------------------- routing after a decision

// Starts the execution an allowed or approved action needs. Called by the gate (allow) and by the founder's
// approval, in their transaction, so only a committed decision executes anything.
export async function scheduleExecution(ctx: MutationCtx, action: Doc<"actions">, by: "gate" | "founder"): Promise<void> {
  // Story mode records the outcome instead of calling Nessie, the Executor or the post queue.
  if ((await ctx.db.get(action.task))?.mode === "replay") return await recordStoryExecution(ctx, action);
  const executor = CATALOG[action.type].executor;
  switch (executor) {
    case "nessie":
      await ctx.scheduler.runAfter(0, internal.nessie.executeMoneyAction, { actionId: action._id });
      return;
    case "executor":
      await ctx.scheduler.runAfter(0, internal.executor.runExecutor, { actionId: action._id });
      return;
    case "post_queue":
      await ctx.scheduler.runAfter(0, internal.executor.queuePost, { actionId: action._id });
      return;
    case "none":
      // switch_vendor, price_change, marketing_spend: the decision is the outcome; nothing to call.
      await audit(ctx, { actor: by, kind: "decision_only", ref: action.task, detail: { actionId: action._id, type: action.type } });
      return;
  }
}

async function authorized(ctx: MutationCtx, action: Doc<"actions">): Promise<string | null> {
  return executionBlock(action, { resume: false, founderApproved: await founderApproved(ctx, action) });
}

async function threadNote(ctx: MutationCtx, action: Doc<"actions">, text: string): Promise<void> {
  const task = await ctx.db.get(action.task);
  if (task) await appendMessage(ctx, { room: task.room, task: task._id, sender_kind: "system", sender_name: "Dispatcher", text: `[Dispatcher] ${text}` });
}

async function markExecuted(ctx: MutationCtx, action: Doc<"actions">, refs: string[], how: string): Promise<void> {
  await ctx.db.patch(action._id, { status: "executed", executed_ref: refs });
  await audit(ctx, { actor: "executor", kind: "executed", ref: action.task, detail: { actionId: action._id, type: action.type, executed_ref: refs, how } });
  // A sent reply handles its ticket.
  if (action.type === "reply_customer" && how === "executor") {
    const p = (action.params ?? {}) as Record<string, unknown>;
    const ticketId = typeof p.ticket_id === "string" ? ctx.db.normalizeId("tickets", p.ticket_id) : null;
    if (ticketId) await ctx.db.patch(ticketId, { status: "handled" });
  }
  if (action.type === "publish_post" && how === "post queue") {
    // Read by the app as a "Posted on LinkedIn" card (feed.ts). The post queue is the demo stand-in for publishing.
    const p = (action.params ?? {}) as Record<string, unknown>;
    const channel = typeof p.channel === "string" ? p.channel : "unknown";
    await threadNote(ctx, action, `Posted on ${channel} (demo post queue, ${refs.join(", ")}): ${typeof p.text === "string" ? p.text : ""}`);
    return;
  }
  await threadNote(ctx, action, `${action.type} ${action._id} ${how === "executor" ? "executed by the Executor" : `sent to the ${how}`}: ${refs.join(", ")}.`);
}

// A failed connector action climbs to the manager of the proposing role's department (spec 10).
async function markConnectorFailed(ctx: MutationCtx, action: Doc<"actions">, reason: string): Promise<void> {
  await ctx.db.patch(action._id, { status: "failed" });
  await audit(ctx, { actor: "executor", kind: "execution_failed", ref: action.task, detail: { actionId: action._id, type: action.type, error: reason } });
  const task = await ctx.db.get(action.task);
  if (!task) return;
  const agent = await ctx.db
    .query("agents")
    .withIndex("by_role", (q) => q.eq("role", action.role))
    .unique();
  const manager = DEPARTMENT_MANAGER[agent?.department ?? "none"];
  await threadNote(ctx, action, `${action.type} ${action._id} failed in the Executor (${reason}). Raised to ${manager}.`);
  await raiseIssue(ctx, task, {
    kind: "capability",
    summary: `The Executor could not run ${action.type} ${action._id}: ${reason}`,
    attempts: [`executor run for ${action._id}`],
    evidence: [action._id],
    raisedBy: "executor",
    toRole: manager,
  });
}

// What the Executor (or the outbox) receives: reply_customer gets its recipient and subject from the ticket.
async function enrichParams(ctx: MutationCtx, action: Doc<"actions">, config: ExecutorConfig): Promise<Record<string, unknown>> {
  const p = { ...((action.params ?? {}) as Record<string, unknown>) };
  if (action.type !== "reply_customer") return p;
  const ticketId = typeof p.ticket_id === "string" ? ctx.db.normalizeId("tickets", p.ticket_id) : null;
  const ticket = ticketId ? await ctx.db.get(ticketId) : null;
  const original = typeof p.to === "string" ? p.to : ticket?.from_email;
  const subject = typeof p.subject === "string" ? p.subject : ticket ? `Re: ${ticket.subject}` : "Re: your message";
  if (config.email_redirect_to) {
    // Demo safety: every customer email goes to the founder's test inbox, naming the real recipient.
    return { ...p, to: config.email_redirect_to, subject: `${subject} [for ${original ?? "unknown"}]` };
  }
  if (!original) throw new Error("reply_customer has no recipient (no params.to and no ticket email)");
  return { ...p, to: original, subject };
}

async function toOutbox(ctx: MutationCtx, action: Doc<"actions">, connector: Connector, payload: unknown, reason: string): Promise<void> {
  const id = await ctx.db.insert("outbox", { action: action._id, connector, payload, reason, created_at: Date.now() });
  await markExecuted(ctx, action, [`outbox:${id}`], "mock outbox");
}

// ---------------------------------------------------------------- Executor runs

const vBegin = v.union(
  v.object({ kind: v.literal("refused"), reason: v.string() }),
  v.object({ kind: v.literal("done"), how: v.string() }),
  v.object({ kind: v.literal("run"), appId: v.string(), inputField: v.string(), input: v.string(), idempotencyKey: v.string() }),
);

export const beginConnector = internalMutation({
  args: { actionId: v.id("actions") },
  returns: vBegin,
  handler: async (ctx, { actionId }): Promise<Infer<typeof vBegin>> => {
    const action = await ctx.db.get(actionId);
    if (!action) return { kind: "refused", reason: "not_found" };
    const connector = CONNECTOR_OF[action.type];
    const block = !connector ? `not a connector action (${action.type})` : await authorized(ctx, action);
    if (block || !connector) {
      await audit(ctx, { actor: "executor", kind: "execution_refused", ref: action.task, detail: { actionId, status: action.status, reason: block } });
      return { kind: "refused", reason: block ?? "no connector" };
    }
    const config = await getConfig<ExecutorConfig>(ctx, CONFIG_KEY, DEFAULT_CONFIG);
    let params: Record<string, unknown>;
    try {
      params = await enrichParams(ctx, action, config);
    } catch (err) {
      await markConnectorFailed(ctx, action, err instanceof Error ? err.message : String(err));
      return { kind: "done", how: "failed" };
    }
    if (!config.connectors.includes(connector)) {
      await toOutbox(ctx, action, connector, params, `${connector} is not connected to the Executor`);
      return { kind: "done", how: "outbox" };
    }
    const agent = await ctx.db
      .query("agents")
      .withIndex("by_role", (q) => q.eq("role", "executor"))
      .unique();
    if (!agent?.enabled || !agent.creao_app_id) {
      await markConnectorFailed(ctx, action, "no enabled Executor agent");
      return { kind: "done", how: "failed" };
    }
    // One Executor run per action: executing before the API call, and a fixed idempotency key.
    await ctx.db.patch(actionId, { status: "executing" });
    await audit(ctx, { actor: "executor", kind: "execution_started", ref: action.task, detail: { actionId, type: action.type, connector } });
    return {
      kind: "run",
      appId: agent.creao_app_id,
      inputField: agent.input_field,
      input: executorInput({ actionId, type: action.type, params }),
      idempotencyKey: `${actionId}:execute:1`,
    };
  },
});

export const markExecutorStarted = internalMutation({
  args: { actionId: v.id("actions"), runId: v.string(), idempotencyKey: v.string() },
  returns: v.null(),
  handler: async (ctx, a) => {
    const existing = await ctx.db
      .query("runs")
      .withIndex("by_creao_run_id", (q) => q.eq("creao_run_id", a.runId))
      .unique();
    if (!existing) {
      await ctx.db.insert("runs", {
        purpose: "execute",
        role: "executor",
        action: a.actionId,
        creao_run_id: a.runId,
        idempotency_key: a.idempotencyKey,
        status: "pending",
        delivery_ids: [],
        started_at: Date.now(),
      });
    }
    const action = await ctx.db.get(a.actionId);
    if (action) await audit(ctx, { actor: "executor", kind: "run_started", ref: action.task, detail: { actionId: a.actionId, runId: a.runId } });
    return null;
  },
});

export const startFailed = internalMutation({
  args: { actionId: v.id("actions"), error: v.string() },
  returns: v.null(),
  handler: async (ctx, { actionId, error }) => {
    const action = await ctx.db.get(actionId);
    if (action && action.status === "executing") await markConnectorFailed(ctx, action, error);
    return null;
  },
});

export const retryLater = internalMutation({
  args: { actionId: v.id("actions"), afterMs: v.number() },
  returns: v.null(),
  handler: async (ctx, { actionId, afterMs }) => {
    // Back to its decided status so the retry passes the same authorization check.
    const action = await ctx.db.get(actionId);
    if (!action || action.status !== "executing") return null;
    await ctx.db.patch(actionId, { status: action.gate?.effect === "allow" ? "allowed" : "approved" });
    await ctx.scheduler.runAfter(afterMs, internal.executor.runExecutor, { actionId });
    return null;
  },
});

export const consumeExecutorBudget = internalMutation({
  args: {},
  returns: v.object({ ok: v.boolean(), retryAfter: v.optional(v.number()) }),
  handler: async (ctx) => {
    const status = await rateLimiter.limit(ctx, "agentRuns", { key: "executor" });
    return status.ok ? { ok: true } : { ok: false, retryAfter: status.retryAfter };
  },
});

// Starts the Executor run for one allowed / approved connector action (or sends it to the outbox).
export const runExecutor = internalAction({
  args: { actionId: v.id("actions") },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { actionId }): Promise<string | null> => {
    const budget = await ctx.runMutation(internal.executor.consumeExecutorBudget, {});
    if (!budget.ok) {
      await ctx.scheduler.runAfter(budget.retryAfter ?? 60_000, internal.executor.runExecutor, { actionId });
      return null;
    }
    const begin = await ctx.runMutation(internal.executor.beginConnector, { actionId });
    if (begin.kind === "refused") throw new Error(`action ${actionId} cannot execute: ${begin.reason}`);
    if (begin.kind === "done") return null;
    try {
      const { runId } = await startRun({
        appId: begin.appId,
        inputs: { [begin.inputField]: begin.input },
        webhookUrl: webhookUrl(),
        idempotencyKey: begin.idempotencyKey,
      });
      await ctx.runMutation(internal.executor.markExecutorStarted, { actionId, runId, idempotencyKey: begin.idempotencyKey });
      return runId;
    } catch (err) {
      if (err instanceof RateLimitedError) {
        await ctx.runMutation(internal.executor.retryLater, { actionId, afterMs: err.retryAfterMs });
        return null;
      }
      await ctx.runMutation(internal.executor.startFailed, { actionId, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },
});

// Called by dispatcher.recordReply (same transaction) when an Executor run ends; the run was re-fetched from Creao.
export async function onExecutorResult(ctx: MutationCtx, run: Doc<"runs">, status: RunStatus, text: string, errorCode?: string): Promise<void> {
  const action = run.action ? await ctx.db.get(run.action) : null;
  if (!action || action.status !== "executing") {
    await audit(ctx, { actor: "executor", kind: "executor_result_ignored", ref: run.creao_run_id, detail: { action: run.action ?? null, status } });
    return;
  }
  if (status !== "completed") return await markConnectorFailed(ctx, action, `run ${status}${errorCode ? ` (${errorCode})` : ""}`);
  const outcome = readExecutorReply(text, action._id);
  if (outcome.kind === "executed") return await markExecuted(ctx, action, outcome.refs, "executor");
  if (outcome.kind === "not_connected") {
    const connector = CONNECTOR_OF[action.type]!;
    const config = await getConfig<ExecutorConfig>(ctx, CONFIG_KEY, DEFAULT_CONFIG);
    return await toOutbox(ctx, action, connector, await enrichParams(ctx, action, config), `the Executor reported ${outcome.connector} not connected`);
  }
  return await markConnectorFailed(ctx, action, outcome.reason);
}

// ---------------------------------------------------------------- post queue (mock publishing)

export const queuePost = internalMutation({
  args: { actionId: v.id("actions") },
  returns: v.union(v.null(), v.id("post_queue")),
  handler: async (ctx, { actionId }) => {
    const action = await ctx.db.get(actionId);
    if (!action || action.type !== "publish_post") return null;
    const block = await authorized(ctx, action);
    if (block) {
      await audit(ctx, { actor: "executor", kind: "execution_refused", ref: action.task, detail: { actionId, reason: block } });
      return null;
    }
    const p = (action.params ?? {}) as Record<string, unknown>;
    const id = await ctx.db.insert("post_queue", {
      action: actionId,
      channel: typeof p.channel === "string" ? p.channel : "unknown",
      text: typeof p.text === "string" ? p.text : "",
      status: "queued",
      created_at: Date.now(),
    });
    await markExecuted(ctx, action, [`post_queue:${id}`], "post queue");
    return id;
  },
});

// ---------------------------------------------------------------- founder app

const vActivity = v.object({
  actions: v.array(
    v.object({
      id: v.id("actions"),
      type: v.string(),
      status: v.string(),
      role: v.string(),
      refs: v.array(v.string()),
      created_at: v.number(),
    }),
  ),
  outbox: v.array(v.object({ id: v.id("outbox"), action: v.id("actions"), connector: vConnector, payload: v.any(), reason: v.string(), created_at: v.number() })),
  posts: v.array(v.object({ id: v.id("post_queue"), channel: v.string(), text: v.string(), status: v.string(), created_at: v.number() })),
});

// Recent connector actions with what they produced (Linear URL, Gmail id, event id), the outbox and the post queue.
export const activity = query({
  args: {},
  returns: vActivity,
  handler: async (ctx) => {
    const actions: Doc<"actions">[] = [];
    for (const type of ["file_bug", "reply_customer", "schedule_digest", "publish_post"] as const) {
      actions.push(...(await ctx.db.query("actions").withIndex("by_type", (q) => q.eq("type", type)).order("desc").take(20)));
    }
    const shown = actions
      .filter((a) => ["executing", "executed", "failed"].includes(a.status))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 20);
    const outbox = await ctx.db.query("outbox").order("desc").take(20);
    const posts = await ctx.db.query("post_queue").order("desc").take(20);
    return {
      actions: shown.map((a) => ({ id: a._id, type: a.type, status: a.status, role: a.role, refs: a.executed_ref ?? [], created_at: a.created_at })),
      outbox: outbox.map((o) => ({ id: o._id, action: o.action, connector: o.connector, payload: o.payload, reason: o.reason, created_at: o.created_at })),
      posts: posts.map((p) => ({ id: p._id, channel: p.channel, text: p.text, status: p.status, created_at: p.created_at })),
    };
  },
});


// Debug: the Executor's reply for a run, re-fetched from Creao. `npx convex run executor:runReply '{"runId":"…"}'`
export const runReply = internalAction({
  args: { runId: v.string() },
  returns: v.object({ status: v.string(), text: v.string() }),
  handler: async (_ctx, { runId }) => {
    const run = await getRun(runId);
    return { status: run.status, text: replyText(run) };
  },
});
