import { CATALOG } from "./catalog";
import type { ActionType, ConditionOp, Department, Effect, GateEffect, Role, RuleScopeLevel } from "./types";

// The authority gate (spec 07, invariant 2): a pure function from facts to a decision. No I/O, no LLM.
// First match decides: hard constraints → labels → novelty → most specific rule → default escalate.

export type FeatureValue = number | string | boolean;
export type ConditionValue = number | string | boolean | string[] | number[];
export type Condition = { field: string; op: ConditionOp; value: ConditionValue };
export type Label = { value: FeatureValue; confidence: number };

export type GateRule = {
  id: string;
  scope: { level: RuleScopeLevel; department?: Department; role?: Role };
  action_type: ActionType;
  conditions: Condition[];
  effect: Effect;
  status: string;
  expires_at?: number;
  support: number; // supporting founder decisions
};
export type GateBudget = { scope: string; limit_cents: number; spent_cents: number };
export type GateStats = { approvedCount: number; maxApprovedCents: number; counterparties: string[] };
export type GateConfig = {
  confidence_min: number;
  money_hard_cap_cents: number;
  novelty_multiplier: number;
  absence_min_support: number;
};
export type GateAction = {
  type: ActionType;
  role: Role;
  department: Department;
  params: Record<string, unknown>;
  amount_cents?: number;
  counterparty?: string;
  labels?: Record<string, Label>;
  label_error?: string;
};
export type GateInput = {
  action: GateAction;
  rules: GateRule[];
  budgets: GateBudget[];
  stats: GateStats;
  customer?: { tenure_days: number };
  founderStatus: "present" | "away";
  config: GateConfig;
  now: number;
};
export type GateResult = {
  effect: GateEffect;
  reason: string;
  rule_id?: string;
  debits: { scope: string; cents: number }[];
};

// One flat record for rule conditions: amount, tenure, role, channel, and every label's value.
export function features(action: GateAction, customer?: { tenure_days: number }): Record<string, FeatureValue> {
  const f: Record<string, FeatureValue> = { role: action.role };
  if (action.amount_cents !== undefined) f.amount_cents = action.amount_cents;
  if (customer) f.customer_tenure_days = customer.tenure_days;
  if (typeof action.params.channel === "string") f.channel = action.params.channel;
  for (const [name, label] of Object.entries(action.labels ?? {})) f[name] = label.value;
  return f;
}

// A missing feature or a type mismatch never satisfies a condition.
export function conditionHolds(c: Condition, f: Record<string, FeatureValue>): boolean {
  if (!(c.field in f)) return false;
  const x = f[c.field];
  const v = c.value;
  switch (c.op) {
    case "<":
      return typeof x === "number" && typeof v === "number" && x < v;
    case "<=":
      return typeof x === "number" && typeof v === "number" && x <= v;
    case ">":
      return typeof x === "number" && typeof v === "number" && x > v;
    case ">=":
      return typeof x === "number" && typeof v === "number" && x >= v;
    case "==":
      return !Array.isArray(v) && x === v;
    case "!=":
      return !Array.isArray(v) && x !== v;
    case "in":
      return Array.isArray(v) && (v as FeatureValue[]).includes(x);
    case "not_in":
      return Array.isArray(v) && !(v as FeatureValue[]).includes(x);
  }
}

const SPECIFICITY: Record<RuleScopeLevel, number> = { role: 3, department: 2, company: 1 };
const PRECEDENCE: Record<Effect, number> = { deny: 3, escalate: 2, allow: 1 };

function scopeMatches(rule: GateRule, action: GateAction): boolean {
  const s = rule.scope;
  return s.level === "company" || (s.level === "department" && s.department === action.department) || (s.level === "role" && s.role === action.role);
}

const escalate = (reason: string): GateResult => ({ effect: "escalate", reason, debits: [] });

export function evaluate(input: GateInput): GateResult {
  const { action, config, stats } = input;
  const entry = CATALOG[action.type];
  const amount = action.amount_cents;
  const budget = entry.budgetScope ? input.budgets.find((b) => b.scope === entry.budgetScope) : undefined;

  // 1. Hard constraints.
  if (entry.alwaysEscalate) return escalate("hard:always_escalate");
  if (entry.money && amount === undefined) return escalate("hard:no_amount");
  if (entry.money && amount !== undefined && amount > config.money_hard_cap_cents) return escalate("hard:cap");
  if (entry.money && budget && amount !== undefined && amount + budget.spent_cents > budget.limit_cents) return escalate("hard:budget");

  // 2. Labels (no labels at all passes until spec 11 labels every action).
  if (action.label_error || Object.values(action.labels ?? {}).some((l) => l.confidence < config.confidence_min)) {
    return escalate("labels:low_confidence");
  }

  // 3. Novelty, from the founder's own approvals of this action type.
  if (stats.approvedCount === 0) return escalate("novelty:new_type");
  if (entry.money && entry.trackCounterparty && action.counterparty && !stats.counterparties.includes(action.counterparty)) {
    return escalate("novelty:new_counterparty");
  }
  if (entry.money && amount !== undefined && stats.maxApprovedCents > 0 && amount > config.novelty_multiplier * stats.maxApprovedCents) {
    return escalate("novelty:amount");
  }

  // 4. Most specific active rule whose conditions all hold; ties: deny > escalate > allow.
  const f = features(action, input.customer);
  const candidates = input.rules.filter(
    (r) =>
      r.status === "active" &&
      r.action_type === action.type &&
      (r.expires_at === undefined || r.expires_at > input.now) &&
      scopeMatches(r, action) &&
      r.conditions.every((c) => conditionHolds(c, f)),
  );
  if (candidates.length) {
    const top = Math.max(...candidates.map((r) => SPECIFICITY[r.scope.level]));
    const rule = candidates
      .filter((r) => SPECIFICITY[r.scope.level] === top)
      .sort((a, b) => PRECEDENCE[b.effect] - PRECEDENCE[a.effect] || a.id.localeCompare(b.id))[0];
    if (rule.effect !== "allow") return { effect: rule.effect, reason: `rule:${rule.effect}`, rule_id: rule.id, debits: [] };

    // Absence mode: only well-supported rules may allow, and money waits for the founder.
    if (input.founderStatus === "away") {
      if (rule.support < config.absence_min_support) return { effect: "queue", reason: "absence:low_support", rule_id: rule.id, debits: [] };
      if (entry.money) return { effect: "queue", reason: "absence:money", rule_id: rule.id, debits: [] };
    }
    const debits = entry.money && budget && amount !== undefined ? [{ scope: budget.scope, cents: amount }] : [];
    return { effect: "allow", reason: "rule:allow", rule_id: rule.id, debits };
  }

  // 5. Default.
  return escalate("default:no_rule");
}
