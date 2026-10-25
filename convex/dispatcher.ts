import { HOUR, RateLimiter } from "@convex-dev/rate-limiter";
import { Workpool } from "@convex-dev/workpool";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { env, internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { appendMessage, audit, getConfig } from "./channels";
import { RateLimitedError } from "./creao/http";
import { getRun, isTerminal, replyText, startRun, webhookUrl } from "./creao/runs";
import {
  companyBlock,
  formatAssign,
  formatHandoffAssign,
  formatNudge,
  formatRepair,
  parseEnvelope,
  type AssignArgs,
} from "./lib/envelope";
import { ruleForAssign } from "./lib/rules";
import { TOKEN_TTL_MS, hashToken, signTaskToken } from "./lib/tokens";
import { vRunPurpose, vRunStatus, type Department, type RunPurpose, type RunStatus } from "./lib/types";
import { onExecutorResult } from "./executor";
import { onAgentReply, onRunFailed } from "./tasks";

// Dispatcher (spec 04): starts agent runs through the Creao API Trigger and records each task's
// conversation as a channel thread. Only startRunForTask starts role-agent runs (invariant 3).

const POOL_OPTIONS = {
  maxParallelism: 3,
  retryActionsByDefault: true,
  defaultRetryBehavior: { maxAttempts: 3, initialBackoffMs: 2_000, base: 2 },
};
const pools: Record<Department, Workpool> = {
  marketing: new Workpool(components.marketingPool, POOL_OPTIONS),
  customer: new Workpool(components.customerPool, POOL_OPTIONS),
  finance: new Workpool(components.financePool, POOL_OPTIONS),
  leadership: new Workpool(components.leadershipPool, POOL_OPTIONS),
  none: new Workpool(components.leadershipPool, POOL_OPTIONS),
};

// Cost guard: every run spends Creao credits.
export const rateLimiter = new RateLimiter(components.rateLimiter, {
  agentRuns: { kind: "fixed window", rate: 60, period: HOUR },
});

// The real token is substituted only into the run input; channel messages keep this placeholder.
export const TOKEN_PLACEHOLDER = "[task-token]";
const STALE_RUN_MS = 3 * 60 * 1000;
export const DEFAULT_LEVEL_TIMEOUT_MS = 5 * 60 * 1000;

type StartArgs = { taskId: Id<"tasks">; messageId: Id<"messages">; purpose: RunPurpose; attempt: number };

async function assignArgs(ctx: MutationCtx, taskId: Id<"tasks">): Promise<{ args: AssignArgs; room: Id<"rooms"> }> {
  const task = await ctx.db.get(taskId);
  if (!task) throw new Error(`task ${taskId} not found`);
  const agent = await ctx.db
    .query("agents")
    .withIndex("by_role", (q) => q.eq("role", task.role))
    .unique();
  if (!agent || !agent.enabled || agent.kind !== "role" || !agent.creao_app_id) {
    throw new Error(`no enabled role agent with an App ID for role ${task.role}`);
  }
  const company = await ctx.db.query("company").first();
  if (!company) throw new Error("company profile not seeded (npx convex run seed:config)");

  // Spec 12 mirror: active, unexpired rules in scope for this role, of the action types it is likely to propose.
  const now = Date.now();
  const rules = (await ctx.db.query("rules").take(500)).filter((r) => ruleForAssign(r, task.role, agent.department, now));
  // Data hints travel with the event that created the task (spec 05 sets them).
  const event = task.event ? await ctx.db.get(task.event) : null;
  const hints: unknown = event?.payload && typeof event.payload === "object" ? (event.payload as { data_hints?: unknown }).data_hints : undefined;
  const dataHints = Array.isArray(hints) ? hints.filter((h): h is string => typeof h === "string") : [];

  return {
    room: task.room,
    args: {
      mention: agent.display_name,
      taskId: task._id,
      role: task.role,
      brief: task.brief,
      token: TOKEN_PLACEHOLDER,
      company: companyBlock(company),
      rules: rules.map((r) => r.text),
      dataHints,
      refs: task.origin_refs,
    },
  };
}

const STORY_REPLY_MS = 2_500;

async function enqueueStart(ctx: MutationCtx, room: Id<"rooms">, args: StartArgs): Promise<void> {
  // Story mode (convex/story.ts): a recorded reply stands in for the Creao run.
  if ((await ctx.db.get(args.taskId))?.mode === "replay") {
    await ctx.scheduler.runAfter(STORY_REPLY_MS, internal.story.reply, args);
    return;
  }
  const channel = await ctx.db.get(room);
  await pools[channel?.department ?? "none"].enqueueAction(ctx, internal.dispatcher.startRunForTask, args);
}

export type HandoffSource = { fromName: string; sourceRef: string; sourceSummary: string };

// Opens the task's thread with an ASSIGN and queues the agent run on the department Workpool.
// A handoff's first ASSIGN quotes the source thread (spec 05); repairs and nudges reuse the plain brief.
export async function assign(
  ctx: MutationCtx,
  taskId: Id<"tasks">,
  opts: { handoff?: HandoffSource } = {},
): Promise<Id<"messages">> {
  const task = await ctx.db.get(taskId);
  if (!task) throw new Error(`task ${taskId} not found`);
  if (task.status !== "queued") throw new Error(`task ${taskId} is ${task.status}, not queued`);
  // Status stays queued until the run starts, so an existing thread means it was already assigned.
  const opened = await ctx.db
    .query("messages")
    .withIndex("by_task", (q) => q.eq("task", taskId))
    .first();
  if (opened) throw new Error(`task ${taskId} is already assigned (thread open)`);
  const { args, room } = await assignArgs(ctx, taskId);
  const messageId = await appendMessage(ctx, {
    room,
    task: taskId,
    sender_kind: "system",
    sender_name: "Dispatcher",
    text: opts.handoff ? formatHandoffAssign({ ...args, ...opts.handoff }) : formatAssign(args),
  });
  await enqueueStart(ctx, room, { taskId, messageId, purpose: "assign", attempt: task.attempt });
  await audit(ctx, { actor: "dispatcher", kind: "assign", ref: taskId, detail: { messageId, role: task.role } });
  return messageId;
}

export const assignTask = internalMutation({
  args: { taskId: v.id("tasks") },
  returns: v.id("messages"),
  handler: (ctx, { taskId }) => assign(ctx, taskId),
});

// Repairs and nudges are new runs for the same agent on the task's Creao thread (spec 05 decides when).
// The deadline restarts here, so checkStuckTasks never acts again before the new run has had its time.
export async function rerun(
  ctx: MutationCtx,
  taskId: Id<"tasks">,
  purpose: "repair" | "nudge",
  note: string,
): Promise<Id<"messages">> {
  const task = await ctx.db.get(taskId);
  if (!task) throw new Error(`task ${taskId} not found`);
  const attempt = task.attempt + 1;
  const { args, room } = await assignArgs(ctx, taskId);
  const messageId = await appendMessage(ctx, {
    room,
    task: taskId,
    sender_kind: "system",
    sender_name: "Dispatcher",
    text: purpose === "repair" ? formatRepair({ ...args, attempt, error: note }) : formatNudge({ ...args, attempt, note }),
  });
  const timeout = await getConfig(ctx, "level_timeout_ms", DEFAULT_LEVEL_TIMEOUT_MS);
  await ctx.db.patch(taskId, { attempt, deadline: Date.now() + timeout, updated_at: Date.now() });
  await enqueueStart(ctx, room, { taskId, messageId, purpose, attempt });
  await audit(ctx, { actor: "dispatcher", kind: purpose, ref: taskId, detail: { messageId, attempt, note } });
  return messageId;
}

export const sendRepair = internalMutation({
  args: { taskId: v.id("tasks"), error: v.string() },
  returns: v.id("messages"),
  handler: (ctx, { taskId, error }) => rerun(ctx, taskId, "repair", error),
});

export const runInput = internalQuery({
  args: { taskId: v.id("tasks"), messageId: v.id("messages") },
  returns: v.object({
    appId: v.string(),
    inputField: v.string(),
    text: v.string(),
    role: v.string(),
    threadId: v.optional(v.string()),
    createdAt: v.number(),
    department: v.string(),
  }),
  handler: async (ctx, { taskId, messageId }) => {
    const task = await ctx.db.get(taskId);
    const message = await ctx.db.get(messageId);
    if (!task || !message) throw new Error("task or message not found");
    const agent = await ctx.db
      .query("agents")
      .withIndex("by_role", (q) => q.eq("role", task.role))
      .unique();
    if (!agent?.creao_app_id) throw new Error(`no App ID for role ${task.role}`);
    const room = await ctx.db.get(task.room);
    return {
      appId: agent.creao_app_id,
      inputField: agent.input_field,
      text: message.text,
      role: task.role,
      threadId: task.creao_thread_id,
      createdAt: task.created_at,
      department: room?.department ?? "none",
    };
  },
});

export const consumeRunBudget = internalMutation({
  args: { role: v.string() },
  returns: v.object({ ok: v.boolean(), retryAfter: v.optional(v.number()) }),
  handler: async (ctx, { role }) => {
    const status = await rateLimiter.limit(ctx, "agentRuns", { key: role });
    return status.ok ? { ok: true } : { ok: false, retryAfter: status.retryAfter };
  },
});

export const startRunForTask = internalAction({
  args: { taskId: v.id("tasks"), messageId: v.id("messages"), purpose: vRunPurpose, attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const input = await ctx.runQuery(internal.dispatcher.runInput, { taskId: args.taskId, messageId: args.messageId });
    const pool = pools[input.department as Department] ?? pools.none;

    const budget = await ctx.runMutation(internal.dispatcher.consumeRunBudget, { role: input.role });
    if (!budget.ok) {
      await pool.enqueueAction(ctx, internal.dispatcher.startRunForTask, args, { runAfter: budget.retryAfter ?? HOUR });
      return null;
    }

    const secret = env.CO_TOKEN_SECRET;
    if (!secret) throw new Error("CO_TOKEN_SECRET is not set");
    const token = await signTaskToken(secret, {
      task: args.taskId,
      role: input.role,
      exp: input.createdAt + TOKEN_TTL_MS,
    });
    const idempotencyKey = `${args.taskId}:${args.purpose}:${args.attempt}`;

    let runId: string;
    try {
      ({ runId } = await startRun({
        appId: input.appId,
        inputs: { [input.inputField]: input.text.split(TOKEN_PLACEHOLDER).join(token) },
        webhookUrl: webhookUrl(),
        idempotencyKey,
        threadId: input.threadId,
      }));
    } catch (err) {
      if (err instanceof RateLimitedError) {
        await pool.enqueueAction(ctx, internal.dispatcher.startRunForTask, args, { runAfter: err.retryAfterMs });
        return null;
      }
      throw err; // Workpool retries; the idempotencyKey makes a retried start return the same run
    }

    await ctx.runMutation(internal.dispatcher.markRunStarted, {
      ...args,
      runId,
      idempotencyKey,
      tokenHash: await hashToken(token),
    });
    return null;
  },
});

export const markRunStarted = internalMutation({
  args: {
    taskId: v.id("tasks"),
    messageId: v.id("messages"),
    purpose: vRunPurpose,
    attempt: v.number(),
    runId: v.string(),
    idempotencyKey: v.string(),
    tokenHash: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    const task = await ctx.db.get(a.taskId);
    if (!task) throw new Error(`task ${a.taskId} not found`);
    const existing = await ctx.db
      .query("runs")
      .withIndex("by_creao_run_id", (q) => q.eq("creao_run_id", a.runId))
      .unique();
    if (!existing) {
      await ctx.db.insert("runs", {
        purpose: a.purpose,
        role: task.role,
        task: a.taskId,
        creao_run_id: a.runId,
        idempotency_key: a.idempotencyKey,
        status: "pending",
        delivery_ids: [],
        started_at: Date.now(),
      });
    }
    const timeout = await getConfig(ctx, "level_timeout_ms", DEFAULT_LEVEL_TIMEOUT_MS);
    await ctx.db.patch(a.taskId, {
      creao_run_id: a.runId,
      token_hash: a.tokenHash,
      ...(task.status === "queued" ? { status: "assigned" as const } : {}),
      deadline: Date.now() + timeout,
      updated_at: Date.now(),
    });
    await ctx.db.patch(a.messageId, { creao_run_id: a.runId });
    await audit(ctx, { actor: "dispatcher", kind: "run_started", ref: a.taskId, detail: { runId: a.runId, purpose: a.purpose } });
    return null;
  },
});

// Re-fetches the run (webhooks are unsigned; trust only this) and records a terminal result.
export const ingestRun = internalAction({
  args: { runId: v.string() },
  returns: v.null(),
  handler: async (ctx, { runId }) => {
    const run = await getRun(runId);
    if (!isTerminal(run.status)) return null; // pollRuns tries again later
    await ctx.runMutation(internal.dispatcher.recordReply, {
      runId,
      status: run.status,
      text: replyText(run),
      threadId: run.threadId,
      errorCode: run.errorCode,
    });
    return null;
  },
});

const TERMINAL: readonly RunStatus[] = ["completed", "failed", "cancelled"];

export const recordReply = internalMutation({
  args: {
    runId: v.string(),
    status: vRunStatus,
    text: v.string(),
    threadId: v.optional(v.string()),
    errorCode: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    const run = await ctx.db
      .query("runs")
      .withIndex("by_creao_run_id", (q) => q.eq("creao_run_id", a.runId))
      .unique();
    if (!run) {
      await audit(ctx, { actor: "dispatcher", kind: "unknown_run", ref: a.runId });
      return null;
    }
    if (TERMINAL.includes(run.status)) return null; // already recorded (duplicate webhook or poll)
    await ctx.db.patch(run._id, { status: a.status, finished_at: Date.now(), error_code: a.errorCode });

    // Executor runs (spec 10): the action, not a task, owns the result.
    if (run.purpose === "execute") {
      await ctx.db.patch(run._id, { result_raw: { text: a.text.slice(0, 8000) } }); // the Executor's report, for the audit trail
      await audit(ctx, { actor: "dispatcher", kind: "run_finished", ref: a.runId, detail: { status: a.status, purpose: "execute" } });
      await onExecutorResult(ctx, run, a.status, a.text, a.errorCode);
      return null;
    }
    if (!run.task) {
      await audit(ctx, { actor: "dispatcher", kind: "run_finished", ref: a.runId, detail: { status: a.status } });
      return null;
    }
    const task = await ctx.db.get(run.task);
    if (!task) return null;

    if (a.status !== "completed") {
      await appendMessage(ctx, {
        room: task.room,
        task: task._id,
        sender_kind: "system",
        sender_name: "Dispatcher",
        text: `[Dispatcher] Run for task ${task._id} ended as ${a.status}${a.errorCode ? ` (${a.errorCode})` : ""}.`,
        creao_run_id: a.runId,
      });
      await audit(ctx, { actor: "dispatcher", kind: "run_failed", ref: task._id, detail: { runId: a.runId, status: a.status, errorCode: a.errorCode } });
      await onRunFailed(ctx, task._id, a.runId, a.status, a.errorCode);
      return null;
    }

    const agent = await ctx.db
      .query("agents")
      .withIndex("by_role", (q) => q.eq("role", task.role))
      .unique();
    const parsed = parseEnvelope(a.text, { taskId: task._id, role: task.role, kind: task.kind });
    const messageId = await appendMessage(ctx, {
      room: task.room,
      task: task._id,
      sender_kind: "agent",
      sender_name: agent?.display_name ?? task.role,
      sender_role: task.role,
      text: a.text,
      creao_run_id: a.runId,
      ...(parsed.ok ? { envelope: parsed.env } : { envelope_error: parsed.error }),
    });
    await ctx.db.patch(task._id, {
      ...(a.threadId ? { creao_thread_id: a.threadId } : {}),
      updated_at: Date.now(),
    });
    await audit(ctx, {
      actor: task.role,
      kind: "agent_reply",
      ref: task._id,
      detail: { runId: a.runId, messageId, valid: parsed.ok, ...(parsed.ok ? { type: parsed.env.type } : { error: parsed.error }) },
    });
    await onAgentReply(ctx, task._id, messageId, parsed);
    return null;
  },
});

// Completes runs whose webhook never arrived (fails before start, restarts, lost deliveries).
export const pollRuns = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const cutoff = Date.now() - STALE_RUN_MS;
    let scheduled = 0;
    for (const status of ["pending", "running"] as const) {
      const runs = await ctx.db
        .query("runs")
        .withIndex("by_status", (q) => q.eq("status", status))
        .take(100);
      for (const run of runs) {
        if (run.started_at > cutoff) continue;
        await ctx.scheduler.runAfter(0, internal.dispatcher.ingestRun, { runId: run.creao_run_id });
        scheduled++;
      }
    }
    return scheduled;
  },
});
