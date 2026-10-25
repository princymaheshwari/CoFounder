import { getServiceToken } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { env, internalAction, internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { audit } from "./channels";
import { customerFor, gateAction } from "./gate";
import { gateLabeledForFounder } from "./issues";
import { DAY_MS } from "./lib/co";
import type { Label } from "./lib/gate";
import { JEV_MODEL, jevState, questionsFor, toLabels, type JevQuestions, type StateCustomer, type StateFinding, type StateTicket } from "./lib/labelSpecs";

// Spec 11: before the gate runs, Jev turns an action's fuzzy content into typed labels with confidence.
// labelActions (action) → Jev /alpha/decisions → saveLabels (mutation) → gate, in the same transaction.
// Jev only produces inputs; the decision stays in the gate (invariant 2). A Jev failure never blocks:
// it sets label_error and the gate escalates with labels:low_confidence.

const GATEWAY_URL = "https://ai-gateway.convex.dev";
const JEV_TIMEOUT_MS = 10_000;
const MAX_FINDINGS = 5;
const MAX_BATCH_ITEMS = 10;

const vQuestions = v.record(
  v.string(),
  v.object({ type: v.union(v.literal("choice"), v.literal("noul")), instructions: v.string(), criteria: v.optional(v.record(v.string(), v.string())) }),
);
const vLabels = v.record(v.string(), v.object({ value: v.union(v.string(), v.boolean(), v.number()), confidence: v.number() }));
// What runs once an action is labeled: the gate, or (spec 09) the manager-level authority step of an issue.
export const vAfterLabels = v.union(
  v.object({ kind: v.literal("gate") }),
  v.object({ kind: v.literal("founder"), issueId: v.id("issues"), taskId: v.id("tasks") }),
);

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------- state

function ticketOf(t: Doc<"tickets">): StateTicket {
  return { subject: t.subject, body: t.body, ...(t.amount_cents !== undefined ? { amount_cents: t.amount_cents } : {}) };
}

async function ticketFor(ctx: QueryCtx, p: Record<string, unknown>): Promise<Doc<"tickets"> | null> {
  const id = typeof p.ticket_id === "string" ? ctx.db.normalizeId("tickets", p.ticket_id) : null;
  return id ? await ctx.db.get(id) : null;
}

// Evidence is a URL, a record id, or a channel reference like "#finance/1043" (agents/roles.md). Only
// Convex records are read; a URL counts when it is a stored signal's evidence (nothing is fetched from the web).
async function evidenceText(ctx: QueryCtx, ref: string): Promise<string> {
  const channelRef = /^(#[\w-]+)\/(\d+)$/.exec(ref.trim());
  if (channelRef) {
    const room = await ctx.db
      .query("rooms")
      .withIndex("by_name", (q) => q.eq("name", channelRef[1]))
      .unique();
    const msg = room
      ? await ctx.db
          .query("messages")
          .withIndex("by_room_seq", (q) => q.eq("room", room._id).eq("seq", Number(channelRef[2])))
          .unique()
      : null;
    if (msg) return `${msg.sender_name}: ${msg.text}`;
  }
  if (/^https?:\/\//.test(ref)) {
    const signals = await ctx.db.query("signals").order("desc").take(200);
    const s = signals.find((x) => x.evidence_url === ref || x.url === ref);
    if (s) return `${s.source} signal: ${s.change}`;
  }
  const ticketId = ctx.db.normalizeId("tickets", ref);
  if (ticketId) {
    const t = await ctx.db.get(ticketId);
    if (t) return `Ticket "${t.subject}": ${t.body}`;
  }
  const signalId = ctx.db.normalizeId("signals", ref);
  if (signalId) {
    const s = await ctx.db.get(signalId);
    if (s) return `${s.source} signal: ${s.change}`;
  }
  const messageId = ctx.db.normalizeId("messages", ref);
  if (messageId) {
    const m = await ctx.db.get(messageId);
    if (m) return `${m.sender_name}: ${m.text}`;
  }
  const issueId = ctx.db.normalizeId("issues", ref);
  if (issueId) {
    const i = await ctx.db.get(issueId);
    if (i) return `Issue (${i.kind}): ${i.summary}`;
  }
  const ledger = await ctx.db
    .query("ledger_mirror")
    .withIndex("by_nessie_id", (q) => q.eq("nessie_id", ref))
    .unique();
  if (ledger) return `Ledger ${ledger.kind} of ${ledger.amount_cents} cents to ${ledger.counterparty} on ${ledger.date}`;
  return "(not found in company records)";
}

// The findings of the agent reply that carried the action (its task's latest agent envelope).
async function findingsFor(ctx: QueryCtx, taskId: Id<"tasks">): Promise<StateFinding[]> {
  const recent = await ctx.db
    .query("messages")
    .withIndex("by_task", (q) => q.eq("task", taskId))
    .order("desc")
    .take(20);
  const reply = recent.find((m) => m.sender_kind === "agent" && m.envelope && typeof m.envelope === "object");
  const raw = (reply?.envelope as { findings?: unknown } | undefined)?.findings;
  if (!Array.isArray(raw)) return [];
  const out: StateFinding[] = [];
  for (const f of raw.slice(0, MAX_FINDINGS) as unknown[]) {
    const { claim, evidence } = (f && typeof f === "object" ? f : {}) as { claim?: unknown; evidence?: unknown };
    if (typeof claim !== "string" || typeof evidence !== "string") continue;
    out.push({ claim, evidence, evidence_text: await evidenceText(ctx, evidence) });
  }
  return out;
}

// The Jev questions and state for an action still awaiting its labels; null when there is nothing to ask.
export const labelInput = internalQuery({
  args: { actionId: v.id("actions"), now: v.number() },
  returns: v.union(v.null(), v.object({ questions: vQuestions, state: v.any() })),
  handler: async (ctx, { actionId, now }) => {
    const action = await ctx.db.get(actionId);
    if (!action || action.status !== "proposed") return null;
    const findings = await findingsFor(ctx, action.task);
    const questions = questionsFor(action.type, findings.length > 0);
    if (!Object.keys(questions).length) return null;

    const params = action.params && typeof action.params === "object" ? (action.params as Record<string, unknown>) : {};
    const subjects = action.type === "refund_batch" && Array.isArray(params.items) ? (params.items as unknown[]).slice(0, MAX_BATCH_ITEMS) : [params];
    const tickets: StateTicket[] = [];
    const customers: StateCustomer[] = [];
    for (const s of subjects) {
      const p = s && typeof s === "object" ? (s as Record<string, unknown>) : {};
      const ticket = await ticketFor(ctx, p);
      if (ticket) tickets.push(ticketOf(ticket));
      const customer = await customerFor(ctx, p);
      if (customer) customers.push({ plan: customer.plan, tenure_days: Math.max(0, Math.floor((now - customer.signup_at) / DAY_MS)) });
    }
    return {
      questions,
      state: jevState({ action: { type: action.type, role: action.role, params: action.params, rationale: action.rationale }, tickets, customers, findings }),
    };
  },
});

// ---------------------------------------------------------------- Jev

export type JevOutcome = { labels: Record<string, Label>; error?: string; cost_usd?: number; answers?: unknown };

// One POST /alpha/decisions with a 10 s timeout and one retry (not on a 4xx other than 429). Never throws.
export async function jevDecide(questions: JevQuestions, state: Record<string, unknown>): Promise<JevOutcome> {
  const url = `${(env.AI_GATEWAY_URL ?? GATEWAY_URL).replace(/\/+$/, "")}/alpha/decisions`;
  let error = "jev: not attempted";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const token = await getServiceToken("ai-gateway");
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ model: JEV_MODEL, state, questions }),
        signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
      });
      const body = await res.text();
      if (!res.ok) {
        error = `jev: http ${res.status}: ${clip(body, 160)}`;
        if (res.status < 500 && res.status !== 429) break;
        continue;
      }
      const parsed = JSON.parse(body) as { answers?: unknown; usage?: { cost?: unknown } };
      const { labels, missing } = toLabels(questions, parsed.answers);
      const cost = typeof parsed.usage?.cost === "number" ? parsed.usage.cost : undefined;
      return {
        labels,
        answers: parsed.answers,
        ...(missing.length ? { error: `jev: no usable answer for ${missing.join(", ")}` } : {}),
        ...(cost !== undefined ? { cost_usd: cost } : {}),
      };
    } catch (e) {
      error = `jev: ${clip(errorText(e), 160)}`;
    }
  }
  return { labels: {}, error };
}

// ---------------------------------------------------------------- persist

// Stores an action's labels (or the Jev error), audits them with the call's cost, and gates in the same transaction.
export const saveLabels = internalMutation({
  args: { actionId: v.id("actions"), labels: vLabels, error: v.optional(v.string()), cost_usd: v.optional(v.number()), gate: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { actionId, labels, error, cost_usd, gate }) => {
    const action = await ctx.db.get(actionId);
    if (!action || action.status !== "proposed") return null;
    await ctx.db.patch(actionId, { labels, status: "labeled", ...(error ? { label_error: error } : {}) });
    await audit(ctx, {
      actor: "jev",
      kind: "labels",
      ref: action.task,
      detail: { actionId, model: JEV_MODEL, labels, error: error ?? null, cost_usd: cost_usd ?? null },
    });
    if (gate) await gateAction(ctx, actionId);
    return null;
  },
});

// The manager-level authority step of an issue, once every action it carries is labeled (spec 09).
export const finishFounderGate = internalMutation({
  args: { issueId: v.id("issues"), taskId: v.id("tasks"), actionIds: v.array(v.id("actions")) },
  returns: v.null(),
  handler: async (ctx, { issueId, taskId, actionIds }) => {
    await gateLabeledForFounder(ctx, issueId, taskId, actionIds);
    return null;
  },
});

// Labels each action, then hands it on. A failure of any kind still records a label_error, so the gate escalates.
export const labelActions = internalAction({
  args: { actionIds: v.array(v.id("actions")), then: vAfterLabels },
  returns: v.null(),
  handler: async (ctx, { actionIds, then }) => {
    const gate = then.kind === "gate";
    for (const actionId of actionIds) {
      try {
        const input = await ctx.runQuery(internal.labels.labelInput, { actionId, now: Date.now() });
        if (!input) {
          if (gate) await ctx.runMutation(internal.gate.evaluateGate, { actionId });
          continue;
        }
        const { labels, error, cost_usd } = await jevDecide(input.questions, input.state as Record<string, unknown>);
        if (error) console.warn(`labels: action ${actionId}: ${error}`);
        await ctx.runMutation(internal.labels.saveLabels, { actionId, labels, gate, ...(error ? { error } : {}), ...(cost_usd !== undefined ? { cost_usd } : {}) });
      } catch (e) {
        console.error(`labels: action ${actionId}: ${errorText(e)}`);
        await ctx.runMutation(internal.labels.saveLabels, { actionId, labels: {}, gate, error: `labeler: ${clip(errorText(e), 160)}` });
      }
    }
    if (then.kind === "founder") await ctx.runMutation(internal.labels.finishFounderGate, { issueId: then.issueId, taskId: then.taskId, actionIds });
    return null;
  },
});
