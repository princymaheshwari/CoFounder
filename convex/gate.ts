import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { appendMessage, audit, getConfig, notifyFounder } from "./channels";
import { scheduleExecution } from "./executor";
import { CATALOG } from "./lib/catalog";
import { DAY_MS } from "./lib/co";
import { evaluate, features, type FeatureValue, type GateConfig, type GateResult, type GateRule, type GateStats } from "./lib/gate";
import { budgetPeriod, type BudgetPeriodKind } from "./lib/time";
import { vGateEffect, type ActionStatus, type ActionType, type GateEffect } from "./lib/types";
import { CONFIG_DEFAULTS } from "./seed";

// Spec 07: evaluateGate is the only place an action is decided (invariant 2). One transaction loads the
// facts, calls the pure `evaluate`, records the decision, and debits the budget (invariant 5).

const STATUS_AFTER: Record<GateEffect, ActionStatus> = {
  allow: "allowed",
  escalate: "escalated",
  deny: "denied",
  queue: "queued",
};
const GATEABLE: readonly ActionStatus[] = ["proposed", "labeled"];

type BudgetLimits = Record<string, { limit_cents: number; period: BudgetPeriodKind }>;

const num = (x: unknown): number | undefined => (typeof x === "number" ? x : undefined);
const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

// The current period's row for a budget scope, created from config.budget_limits on first use.
// Reading and creating inside the gate's transaction keeps concurrent gates from double-spending.
export async function currentBudget(ctx: MutationCtx, scope: string, now: number): Promise<Doc<"budgets"> | null> {
  const limits = await getConfig<BudgetLimits>(ctx, "budget_limits", CONFIG_DEFAULTS.budget_limits);
  const def = limits[scope];
  if (!def) return null;
  const period = budgetPeriod(def.period, now);
  const row = await ctx.db
    .query("budgets")
    .withIndex("by_scope_period", (q) => q.eq("scope", scope).eq("period", period))
    .unique();
  if (row) return row;
  const id = await ctx.db.insert("budgets", { scope, period, limit_cents: def.limit_cents, spent_cents: 0 });
  return await ctx.db.get(id);
}

// What the founder has approved for this action type: count, largest amount, counterparties.
async function decisionStats(ctx: MutationCtx, type: ActionType): Promise<GateStats> {
  const rows = await ctx.db
    .query("decisions")
    .withIndex("by_action_type", (q) => q.eq("action_type", type))
    .order("desc")
    .take(1000);
  const stats: GateStats = { approvedCount: 0, maxApprovedCents: 0, counterparties: [] };
  const seen = new Set<string>();
  for (const d of rows) {
    if (d.decided_by !== "founder" || d.choice !== "approve" || d.subject_kind !== "action") continue;
    const f = d.features && typeof d.features === "object" ? (d.features as Record<string, unknown>) : {};
    const action = d.action && (num(f.amount_cents) === undefined || str(f.counterparty) === undefined) ? await ctx.db.get(d.action) : null;
    const amount = num(f.amount_cents) ?? action?.amount_cents;
    const counterparty = str(f.counterparty) ?? action?.counterparty;
    stats.approvedCount += 1;
    if (amount !== undefined) stats.maxApprovedCents = Math.max(stats.maxApprovedCents, amount);
    if (counterparty) seen.add(counterparty);
  }
  stats.counterparties = [...seen];
  return stats;
}

// The customer an action concerns: params.customer_id, else the ticket's customer.
export async function customerFor(ctx: QueryCtx, params: Record<string, unknown>): Promise<Doc<"customers"> | null> {
  const customerId = typeof params.customer_id === "string" ? ctx.db.normalizeId("customers", params.customer_id) : null;
  if (customerId) return await ctx.db.get(customerId);
  const ticketId = typeof params.ticket_id === "string" ? ctx.db.normalizeId("tickets", params.ticket_id) : null;
  const ticket = ticketId ? await ctx.db.get(ticketId) : null;
  return ticket?.customer ? await ctx.db.get(ticket.customer) : null;
}

// The features a founder decision records (spec 12): exactly what the gate's rule conditions read
// (`features`), plus the department and bookkeeping, so a rule induced from decisions replays the same way.
export async function decisionFeatures(ctx: QueryCtx, action: Doc<"actions">, now: number): Promise<Record<string, FeatureValue | null>> {
  const params = action.params && typeof action.params === "object" ? (action.params as Record<string, unknown>) : {};
  const agent = await ctx.db
    .query("agents")
    .withIndex("by_role", (q) => q.eq("role", action.role))
    .unique();
  const customer = await customerFor(ctx, params);
  const department = agent?.department ?? "none";
  const amount = action.amount_cents ?? CATALOG[action.type].amount(params);
  return {
    ...features(
      { type: action.type, role: action.role, department, params, amount_cents: amount, labels: action.labels },
      customer ? { tenure_days: Math.max(0, Math.floor((now - customer.signup_at) / DAY_MS)) } : undefined,
    ),
    department,
    counterparty: action.counterparty ?? null,
    gate_reason: action.gate?.reason ?? null,
  };
}

async function gateConfig(ctx: MutationCtx): Promise<GateConfig> {
  return {
    confidence_min: await getConfig(ctx, "confidence_min", CONFIG_DEFAULTS.confidence_min),
    money_hard_cap_cents: await getConfig(ctx, "money_hard_cap_cents", CONFIG_DEFAULTS.money_hard_cap_cents),
    novelty_multiplier: await getConfig(ctx, "novelty_multiplier", CONFIG_DEFAULTS.novelty_multiplier),
    absence_min_support: await getConfig(ctx, "absence_min_support", CONFIG_DEFAULTS.absence_min_support),
  };
}

export type GateOutcome = { effect: GateEffect; reason: string; rule_id?: Id<"rules"> };

// Decides one action. Callable from any mutation (spec 09 gates ESCALATE actions); a no-op once gated.
// `inbox: false` skips the per-action founder inbox item: spec 09 packages escalated actions into one decision.
export async function gateAction(ctx: MutationCtx, actionId: Id<"actions">, opts: { inbox?: boolean } = {}): Promise<GateOutcome | null> {
  const action = await ctx.db.get(actionId);
  if (!action || !GATEABLE.includes(action.status)) return null;
  const task = await ctx.db.get(action.task);
  if (!task) throw new Error(`task ${action.task} not found for action ${actionId}`);
  const now = Date.now();
  const entry = CATALOG[action.type];
  const params = action.params && typeof action.params === "object" ? (action.params as Record<string, unknown>) : {};
  const amount = entry.amount(params);
  const counterparty = entry.counterparty(params);

  const agent = await ctx.db
    .query("agents")
    .withIndex("by_role", (q) => q.eq("role", action.role))
    .unique();
  const department = agent?.department ?? (await ctx.db.get(task.room))?.department ?? "none";
  const customer = await customerFor(ctx, params);
  const budget = entry.budgetScope ? await currentBudget(ctx, entry.budgetScope, now) : null;
  const ruleDocs = await ctx.db
    .query("rules")
    .withIndex("by_type_status", (q) => q.eq("action_type", action.type).eq("status", "active"))
    .take(200);
  const rules: GateRule[] = ruleDocs.map((r) => ({
    id: r._id,
    scope: r.scope,
    action_type: r.action_type,
    conditions: r.conditions,
    effect: r.effect,
    status: r.status,
    expires_at: r.expires_at,
    support: r.supporting_decisions.length,
  }));

  const result: GateResult = evaluate({
    action: {
      type: action.type,
      role: action.role,
      department,
      params,
      amount_cents: amount,
      counterparty,
      labels: action.labels,
      label_error: action.label_error,
    },
    rules,
    budgets: budget ? [budget] : [],
    stats: await decisionStats(ctx, action.type),
    customer: customer ? { tenure_days: Math.max(0, Math.floor((now - customer.signup_at) / DAY_MS)) } : undefined,
    founderStatus: (await ctx.db.query("founder").first())?.status ?? "present",
    config: await gateConfig(ctx),
    now,
  });

  const ruleId = ruleDocs.find((r) => r._id === result.rule_id)?._id;
  await ctx.db.patch(actionId, {
    amount_cents: amount,
    counterparty,
    status: STATUS_AFTER[result.effect],
    gate: {
      effect: result.effect,
      reason: result.reason,
      ...(ruleId ? { rule_id: ruleId } : { constraint: result.reason }),
    },
  });
  for (const debit of result.debits) {
    if (!budget || debit.scope !== budget.scope) throw new Error(`gate debit for unknown budget ${debit.scope}`);
    await ctx.db.patch(budget._id, { spent_cents: budget.spent_cents + debit.cents });
  }
  await audit(ctx, {
    actor: "gate",
    kind: "gate_decision",
    ref: task._id,
    detail: { actionId, type: action.type, effect: result.effect, reason: result.reason, rule_id: ruleId ?? null, amount_cents: amount ?? null, debits: result.debits },
  });

  switch (result.effect) {
    case "allow":
      // Nessie (spec 08), the Executor and the post queue (spec 10), scheduled here so only a committed allow runs.
      await audit(ctx, { actor: "gate", kind: "execution_pending", ref: task._id, detail: { actionId, executor: entry.executor } });
      await scheduleExecution(ctx, (await ctx.db.get(actionId))!, "gate");
      break;
    case "escalate": {
      if (opts.inbox === false) break;
      const lines = [
        `${action.role} proposes ${action.type}${amount !== undefined ? ` for ${dollars(amount)}` : ""}.`,
        `Why: ${action.rationale}`,
        `Gate: ${result.reason}`,
        ...(customer ? [`Customer: ${customer.name}, ${Math.floor((now - customer.signup_at) / DAY_MS)} days, ${customer.plan} plan`] : []),
        `Params: ${JSON.stringify(params)}`,
      ];
      await notifyFounder(ctx, {
        kind: "action",
        ref: actionId,
        title: `Approve ${action.type}${amount !== undefined ? ` ${dollars(amount)}` : ""}?`,
        body: lines.join("\n"),
        options: [{ label: "Approve" }, { label: "Deny" }],
      });
      break;
    }
    case "deny":
      await appendMessage(ctx, {
        room: task.room,
        task: task._id,
        sender_kind: "system",
        sender_name: "Dispatcher",
        text: `[Dispatcher] The gate denied ${action.type} on task ${task._id} (${result.reason}). Do not retry it.`,
      });
      break;
    case "queue":
      await audit(ctx, { actor: "gate", kind: "action_queued", ref: task._id, detail: { actionId, reason: result.reason } });
      break;
  }
  return { effect: result.effect, reason: result.reason, ...(ruleId ? { rule_id: ruleId } : {}) };
}

export const evaluateGate = internalMutation({
  args: { actionId: v.id("actions") },
  returns: v.union(v.null(), v.object({ effect: vGateEffect, reason: v.string(), rule_id: v.optional(v.id("rules")) })),
  handler: (ctx, { actionId }) => gateAction(ctx, actionId),
});
