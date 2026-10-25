import { z } from "zod";
import { conditionHolds, type Condition, type FeatureValue } from "./gate";
import { ACTION_TYPES, CONDITION_OPS, DEPARTMENTS, ROLES, type ActionType, type DecisionChoice, type Department, type Effect, type Role, type RuleScopeLevel, type RuleStatus } from "./types";

// Rule learning (spec 12, system-design §8). Pure: which decisions a rule covers, replaying a rule against
// the founder's decisions, when to induce, the candidate schema Claude must fill, and the text agents and
// the founder see. No I/O.

export type RuleScope = { level: RuleScopeLevel; department?: Department; role?: Role };
export type RuleLike = { scope: RuleScope; action_type: ActionType; conditions: Condition[]; effect: Effect };
export type DecisionRow = { id: string; action_type: ActionType; choice: DecisionChoice; features: Record<string, unknown>; reason?: string };
export type DeptOf = (role: Role) => Department | undefined;

type ScopedRule = { status: RuleStatus; scope: RuleScope; action_type?: ActionType; expires_at?: number };

// Active rules that apply to a role: company-wide, its department, or the role itself.
// Used for the ASSIGN's rules_in_scope (spec 04) and `co data rules` (spec 06).
export function ruleInScope(rule: ScopedRule, role: Role, department: Department): boolean {
  if (rule.status !== "active") return false;
  const s = rule.scope;
  return (
    s.level === "company" ||
    (s.level === "department" && s.department === department) ||
    (s.level === "role" && s.role === role)
  );
}

// The action types each role proposes or carries up the ladder (agents/creao/). A role not listed
// (the Cofounder) may see any type.
export const ROLE_ACTIONS: Partial<Record<Role, readonly ActionType[]>> = {
  support: ["refund", "reply_customer"],
  retention: ["reply_customer"],
  customer_manager: ["refund", "refund_batch", "reply_customer", "file_bug"],
  ledger: ["refund", "refund_batch"],
  spend: ["pay_bill", "switch_vendor"],
  finance_manager: ["refund", "refund_batch", "pay_bill", "switch_vendor", "file_bug"],
  market_intel: [],
  content: ["publish_post"],
  marketing_manager: ["publish_post", "marketing_spend"],
};

// Spec 12 mirror: the rules an ASSIGN lists, i.e. active, unexpired, in scope and of a type the role is likely to propose.
export function ruleForAssign(rule: ScopedRule & { action_type: ActionType }, role: Role, department: Department, now: number): boolean {
  if (!ruleInScope(rule, role, department)) return false;
  if (rule.expires_at !== undefined && rule.expires_at <= now) return false;
  const likely = ROLE_ACTIONS[role];
  return likely === undefined || likely.includes(rule.action_type);
}

// ---------------------------------------------------------------- coverage and replay

const isFeature = (x: unknown): x is FeatureValue => typeof x === "number" || typeof x === "string" || typeof x === "boolean";

// A decision's stored features as the flat record rule conditions read (non-scalar entries dropped).
export function featureRecord(features: Record<string, unknown>): Record<string, FeatureValue> {
  const out: Record<string, FeatureValue> = {};
  for (const [k, v] of Object.entries(features)) if (isFeature(v)) out[k] = v;
  return out;
}

export function matches(rule: Pick<RuleLike, "conditions">, features: Record<string, FeatureValue>): boolean {
  return rule.conditions.every((c) => conditionHolds(c, features));
}

function scopeCovers(scope: RuleScope, f: Record<string, FeatureValue>, deptOf: DeptOf): boolean {
  if (scope.level === "company") return true;
  const role = typeof f.role === "string" && (ROLES as readonly string[]).includes(f.role) ? (f.role as Role) : undefined;
  if (scope.level === "role") return role !== undefined && role === scope.role;
  const dept = typeof f.department === "string" ? f.department : role ? deptOf(role) : undefined;
  return dept !== undefined && dept === scope.department;
}

// Whether a rule would have decided this past decision: same type, scope holds, every condition holds.
export function covers(rule: RuleLike, d: DecisionRow, deptOf: DeptOf): boolean {
  if (rule.action_type !== d.action_type) return false;
  const f = featureRecord(d.features);
  return scopeCovers(rule.scope, f, deptOf) && matches(rule, f);
}

// allow ↔ approve, deny ↔ deny; an escalate rule hands the decision back, so it never contradicts one.
export function agrees(effect: Effect, choice: DecisionChoice): boolean {
  if (effect === "escalate") return true;
  return (effect === "allow") === (choice === "approve");
}

export type Replay = { agree: number; total: number; covered: string[]; counterexamples: string[] };

// A candidate is valid only if it agrees with every past decision it covers.
export function replay(rule: RuleLike, decisions: DecisionRow[], deptOf: DeptOf): Replay {
  const out: Replay = { agree: 0, total: 0, covered: [], counterexamples: [] };
  for (const d of decisions) {
    if (!covers(rule, d, deptOf)) continue;
    out.total++;
    out.covered.push(d.id);
    if (agrees(rule.effect, d.choice)) out.agree++;
    else out.counterexamples.push(d.id);
  }
  return out;
}

// Whether `choice` contradicts what `effect` would have done (spec 12 override → suspend).
export function overrides(effect: Effect, choice: DecisionChoice): boolean {
  return effect !== "escalate" && !agrees(effect, choice);
}

// Induction trigger: ≥ min founder decisions in the newest decision's direction that no active rule covers.
export function inductionTarget(
  decisions: DecisionRow[], // newest first
  activeRules: RuleLike[],
  deptOf: DeptOf,
  min: number,
): { choice: DecisionChoice; decisions: DecisionRow[] } | null {
  const uncovered = decisions.filter((d) => !activeRules.some((r) => covers(r, d, deptOf)));
  if (!uncovered.length) return null;
  const choice = uncovered[0].choice;
  const same = uncovered.filter((d) => d.choice === choice);
  return same.length >= min ? { choice, decisions: same } : null;
}

// ---------------------------------------------------------------- candidate (Claude's structured output)

const conditionValue = z.union([z.number(), z.string(), z.boolean(), z.array(z.string()), z.array(z.number())]);
export const ruleCandidateSchema = z.object({
  scope: z.object({
    level: z.enum(["company", "department", "role"]),
    department: z.enum(DEPARTMENTS).optional(),
    role: z.enum(ROLES).optional(),
  }),
  action_type: z.enum(ACTION_TYPES),
  conditions: z.array(z.object({ field: z.string().min(1), op: z.enum(CONDITION_OPS), value: conditionValue })).max(8),
  effect: z.enum(["allow", "deny"]),
  rationale: z.string().max(600).optional(),
});
export type RuleCandidate = z.infer<typeof ruleCandidateSchema>;

// Fields a rule may test: anything the decisions recorded as a scalar, except bookkeeping.
const NOT_CONDITIONS = new Set(["role", "department", "gate_reason", "counterparty"]);

export const INDUCTION_SYSTEM = [
  "You turn a founder's past decisions into one authority rule for a deterministic gate.",
  "Propose the NARROWEST rule consistent with every decision given: it must cover all of them and decide them the way the founder did.",
  "Use only feature fields that appear in the decisions. Never use role, department, gate_reason or counterparty as conditions; express who the rule is for with scope instead.",
  "Prefer thresholds at observed values (e.g. amount_cents <= the largest approved amount). Boolean labels use op \"==\". Choice labels use \"in\" with the observed values.",
  "Scope: \"role\" with that role if every decision came from the same role, else \"department\" if they share one, else \"company\".",
  "effect is \"allow\" when the founder approved, \"deny\" when the founder denied.",
].join("\n");

// The user message for induceRule: the decisions, the existing active rules, and the target.
export function inductionPrompt(a: { actionType: ActionType; choice: DecisionChoice; decisions: DecisionRow[]; activeRules: string[] }): string {
  return [
    `Action type: ${a.actionType}. The founder ${a.choice === "approve" ? "approved" : "denied"} each of these ${a.decisions.length} actions, and no active rule covers them:`,
    ...a.decisions.map((d) => `- decision ${d.id}: ${JSON.stringify(featureRecord(d.features))}${d.reason ? ` (founder's reason: ${d.reason})` : ""}`),
    a.activeRules.length ? `Active rules for ${a.actionType} (do not duplicate them):\n${a.activeRules.map((r) => `- ${r}`).join("\n")}` : `There are no active rules for ${a.actionType}.`,
    "Return one rule as JSON matching the schema, with a one-sentence rationale.",
  ].join("\n");
}

// Semantic checks beyond the schema: scope fields match the level, conditions use fields present in the data.
export function candidateProblem(c: RuleCandidate, actionType: ActionType, choice: DecisionChoice, decisions: DecisionRow[]): string | null {
  if (c.action_type !== actionType) return `action_type ${c.action_type} is not ${actionType}`;
  if ((c.effect === "allow") !== (choice === "approve")) return `effect ${c.effect} does not follow the founder's ${choice} decisions`;
  if (c.scope.level === "role" && !c.scope.role) return "a role scope needs a role";
  if (c.scope.level === "department" && !c.scope.department) return "a department scope needs a department";
  const present = new Set(decisions.flatMap((d) => Object.keys(featureRecord(d.features))));
  for (const cond of c.conditions) {
    if (NOT_CONDITIONS.has(cond.field)) return `field ${cond.field} is not a rule condition`;
    if (!present.has(cond.field)) return `field ${cond.field} is not in the decisions`;
    const numeric = ["<", "<=", ">", ">="].includes(cond.op);
    if (numeric !== (typeof cond.value === "number")) return `op ${cond.op} does not fit value ${JSON.stringify(cond.value)}`;
    if ((cond.op === "in" || cond.op === "not_in") !== Array.isArray(cond.value)) return `op ${cond.op} does not fit value ${JSON.stringify(cond.value)}`;
  }
  return null;
}

// The rule as stored: a role scope drops a stray department and vice versa.
export function normalizeCandidate(c: RuleCandidate): RuleLike {
  const scope: RuleScope =
    c.scope.level === "role" ? { level: "role", role: c.scope.role } : c.scope.level === "department" ? { level: "department", department: c.scope.department } : { level: "company" };
  return { scope, action_type: c.action_type, conditions: c.conditions, effect: c.effect };
}

// ---------------------------------------------------------------- text

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const fieldName = (f: string) => (f === "amount_cents" ? "amount" : f === "customer_tenure_days" ? "customer tenure (days)" : f.replace(/_/g, " "));
const valueText = (field: string, v: unknown): string =>
  Array.isArray(v) ? v.map((x) => valueText(field, x)).join(" or ") : typeof v === "number" && field.endsWith("_cents") ? money(v) : String(v);

const OP_TEXT: Record<Condition["op"], string> = {
  "<": "is under",
  "<=": "is at most",
  ">": "is over",
  ">=": "is at least",
  "==": "is",
  "!=": "is not",
  in: "is",
  not_in: "is not",
};

export function conditionText(c: Condition): string {
  return `${fieldName(c.field)} ${OP_TEXT[c.op]} ${valueText(c.field, c.value)}`;
}

function scopeText(s: RuleScope): string {
  return s.level === "role" ? `by ${s.role}` : s.level === "department" ? `in the ${s.department} department` : "company-wide";
}

const EFFECT_TEXT: Record<Effect, string> = { allow: "allowed", deny: "denied", escalate: "sent to the founder" };

// One sentence for agents (ASSIGN rules_in_scope, digests) and the founder.
export function ruleToSentence(rule: RuleLike, label?: string): string {
  const when = rule.conditions.length ? ` when ${rule.conditions.map(conditionText).join(" and ")}` : "";
  return `${label ? `${label}: ` : ""}${rule.action_type} ${scopeText(rule.scope)} is ${EFFECT_TEXT[rule.effect]}${when}.`;
}

// The founder's review: the rule as a diff against the version it replaces (if any), plus the agreement.
export function diffText(rule: RuleLike, opts: { label?: string; previous?: RuleLike & { label?: string }; agreement?: { agree: number; total: number } } = {}): string {
  const lines: string[] = [];
  const prev = opts.previous;
  if (prev) lines.push(`- ${ruleToSentence(prev, prev.label)}`);
  lines.push(`+ ${ruleToSentence(rule, opts.label)}`);
  const before = new Set((prev?.conditions ?? []).map(conditionText));
  const after = new Set(rule.conditions.map(conditionText));
  lines.push("", `  ${rule.action_type} · ${scopeText(rule.scope)} · effect ${rule.effect}`);
  for (const t of before) if (!after.has(t)) lines.push(`  - ${t}`);
  for (const t of after) lines.push(`  ${before.has(t) ? " " : "+"} ${t}`);
  if (opts.agreement) lines.push("", `Agrees with ${opts.agreement.agree}/${opts.agreement.total} past founder decisions it covers.`);
  return lines.join("\n");
}

// Rules are labelled R1, R2, …: the next number after the highest one in use.
export function nextRuleLabel(texts: string[]): string {
  let max = 0;
  for (const t of texts) {
    const m = /^R(\d+):/.exec(t);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `R${max + 1}`;
}

export const labelOf = (text: string): string | undefined => /^(R\d+):/.exec(text)?.[1];
