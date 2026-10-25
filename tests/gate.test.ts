import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { CATALOG } from "../convex/lib/catalog";
import {
  conditionHolds,
  evaluate,
  features,
  type GateAction,
  type GateInput,
  type GateResult,
  type GateRule,
} from "../convex/lib/gate";
import { budgetPeriod, laDate, laWeekStart } from "../convex/lib/time";
import type { ActionType, Role } from "../convex/lib/types";
import { R7_TEXT } from "../convex/seed";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-24T18:00:00Z");

// ---------------------------------------------------------------- pure evaluate

const CONFIG = { confidence_min: 0.8, money_hard_cap_cents: 50_000, novelty_multiplier: 1.5, absence_min_support: 5 };
const R7: GateRule = {
  id: "r7",
  scope: { level: "company" },
  action_type: "refund",
  conditions: [
    { field: "amount_cents", op: "<=", value: 4000 },
    { field: "refund_reason", op: "in", value: ["billing_error", "defect"] },
    { field: "customer_tenure_days", op: ">=", value: 90 },
  ],
  effect: "allow",
  status: "active",
  support: 3,
};
const billing = { refund_reason: { value: "billing_error", confidence: 0.95 } };
const noCommitment = { makes_commitment: { value: false, confidence: 0.9 } };

function refund(amount: number, extra: Partial<GateAction> = {}): GateAction {
  return {
    type: "refund",
    role: "support",
    department: "customer",
    params: { customer_id: "c1", amount_cents: amount },
    amount_cents: amount,
    counterparty: "c1",
    labels: billing,
    ...extra,
  };
}

function action(type: ActionType, extra: Partial<GateAction> = {}): GateAction {
  return { type, role: "support", department: "customer", params: {}, ...extra };
}

function rule(id: string, extra: Partial<GateRule>): GateRule {
  return { id, scope: { level: "company" }, action_type: "refund", conditions: [], effect: "allow", status: "active", support: 5, ...extra };
}

// The weekly LinkedIn rule approved at onboarding (lib/recurring.ts FLOW_RULE).
const linkedinRule = rule("li", {
  scope: { level: "role", role: "content" },
  action_type: "publish_post",
  conditions: [
    { field: "channel", op: "in", value: ["linkedin"] },
    { field: "mentions_pricing", op: "==", value: false },
    { field: "mentions_competitor", op: "==", value: false },
  ],
});

function input(a: GateAction, over: Partial<GateInput> = {}): GateInput {
  return {
    action: a,
    rules: [R7],
    budgets: [{ scope: "company:refund", limit_cents: 30_000, spent_cents: 0 }],
    stats: { approvedCount: 3, maxApprovedCents: 4000, counterparties: ["CloudHost", "x-ads"] },
    customer: { tenure_days: 120 },
    founderStatus: "present",
    config: CONFIG,
    now: NOW,
    ...over,
  };
}

type Case = [name: string, input: GateInput, expected: Partial<GateResult>];

const CASES: Case[] = [
  // 1. Hard constraints
  ["switch_vendor always escalates", input(action("switch_vendor", { amount_cents: 100, counterparty: "CloudHost" }), { rules: [rule("a", { action_type: "switch_vendor" })] }), { effect: "escalate", reason: "hard:always_escalate" }],
  ["price_change always escalates", input(action("price_change"), { rules: [rule("a", { action_type: "price_change" })] }), { effect: "escalate", reason: "hard:always_escalate" }],
  ["money without a computable amount escalates", input(refund(0, { amount_cents: undefined })), { effect: "escalate", reason: "hard:no_amount" }],
  ["money over the $500 cap escalates", input(refund(50_001, { labels: undefined }), { rules: [rule("a", {})] }), { effect: "escalate", reason: "hard:cap" }],
  ["money exactly at the cap passes the cap", input(refund(50_000), { budgets: [], stats: { approvedCount: 3, maxApprovedCents: 50_000, counterparties: [] }, rules: [rule("a", {})] }), { effect: "allow" }],
  ["refund over the remaining daily budget escalates", input(refund(3500), { budgets: [{ scope: "company:refund", limit_cents: 30_000, spent_cents: 27_000 }] }), { effect: "escalate", reason: "hard:budget" }],
  ["refund exactly using the remaining budget is allowed", input(refund(3000), { budgets: [{ scope: "company:refund", limit_cents: 30_000, spent_cents: 27_000 }] }), { effect: "allow", rule_id: "r7", debits: [{ scope: "company:refund", cents: 3000 }] }],
  ["refund_batch total counts against the budget", input(action("refund_batch", { params: { items: [{ amount_cents: 20_000 }, { amount_cents: 15_000 }] }, amount_cents: 35_000 })), { effect: "escalate", reason: "hard:budget" }],
  ["the cap is checked before the budget", input(refund(60_000)), { effect: "escalate", reason: "hard:cap" }],
  // 2. Labels
  ["label_error escalates", input(refund(3500, { label_error: "jev timeout" })), { effect: "escalate", reason: "labels:low_confidence" }],
  ["a label below 0.8 confidence escalates", input(refund(3500, { labels: { refund_reason: { value: "billing_error", confidence: 0.79 } } })), { effect: "escalate", reason: "labels:low_confidence" }],
  ["a label at exactly 0.8 passes", input(refund(3500, { labels: { refund_reason: { value: "billing_error", confidence: 0.8 } } })), { effect: "allow", rule_id: "r7" }],
  ["no labels pass for a type Jev asks nothing about", input(action("file_bug"), { rules: [rule("fb", { action_type: "file_bug" })] }), { effect: "allow", rule_id: "fb", debits: [] }],
  ["a required label that is missing escalates", input(action("reply_customer"), { rules: [rule("rc", { action_type: "reply_customer" })] }), { effect: "escalate", reason: "labels:low_confidence" }],
  ["a refund without refund_reason escalates", input(refund(3500, { labels: undefined })), { effect: "escalate", reason: "labels:low_confidence" }],
  ["reply_customer with its label passes", input(action("reply_customer", { labels: noCommitment }), { rules: [rule("rc", { action_type: "reply_customer" })] }), { effect: "allow", rule_id: "rc", debits: [] }],
  [
    "an unsure optional label no rule reads does not block (the weekly LinkedIn post)",
    input(
      action("publish_post", {
        role: "content",
        department: "marketing",
        params: { channel: "linkedin", text: "We shipped offline mode." },
        labels: { mentions_pricing: { value: false, confidence: 0.98 }, mentions_competitor: { value: false, confidence: 0.97 }, grounded: { value: true, confidence: 0.59 } },
      }),
      { rules: [linkedinRule] },
    ),
    { effect: "allow", rule_id: "li", debits: [] },
  ],
  [
    "an unsure label that an applicable rule reads still escalates",
    input(
      action("publish_post", {
        role: "content",
        department: "marketing",
        params: { channel: "linkedin", text: "We shipped offline mode." },
        labels: { mentions_pricing: { value: false, confidence: 0.98 }, mentions_competitor: { value: false, confidence: 0.97 }, grounded: { value: true, confidence: 0.59 } },
      }),
      { rules: [{ ...linkedinRule, conditions: [...linkedinRule.conditions, { field: "grounded", op: "==", value: true }] }] },
    ),
    { effect: "escalate", reason: "labels:low_confidence" },
  ],
  [
    "an unsure required label escalates even when no rule reads it",
    input(
      action("publish_post", {
        role: "content",
        department: "marketing",
        params: { channel: "linkedin", text: "We shipped offline mode." },
        labels: { mentions_pricing: { value: false, confidence: 0.6 }, mentions_competitor: { value: false, confidence: 0.97 } },
      }),
      { rules: [rule("any", { action_type: "publish_post", scope: { level: "role", role: "content" } })] },
    ),
    { effect: "escalate", reason: "labels:low_confidence" },
  ],
  // 3. Novelty
  ["an action type the founder never approved escalates", input(refund(3500), { stats: { approvedCount: 0, maxApprovedCents: 0, counterparties: [] } }), { effect: "escalate", reason: "novelty:new_type" }],
  ["a bill from an unseen merchant escalates", input(action("pay_bill", { amount_cents: 1000, counterparty: "NewVendor" }), { rules: [rule("pb", { action_type: "pay_bill" })] }), { effect: "escalate", reason: "novelty:new_counterparty" }],
  ["a bill from a known merchant passes novelty", input(action("pay_bill", { amount_cents: 1000, counterparty: "CloudHost" }), { rules: [rule("pb", { action_type: "pay_bill" })] }), { effect: "allow", rule_id: "pb" }],
  ["refunds never trigger counterparty novelty (the counterparty is a customer)", input(refund(3500, { counterparty: "brand-new-customer" })), { effect: "allow", rule_id: "r7" }],
  ["amount over 1.5× the largest approved escalates", input(refund(6001), { rules: [rule("a", {})] }), { effect: "escalate", reason: "novelty:amount" }],
  ["amount at exactly 1.5× passes", input(refund(6000), { rules: [rule("a", {})] }), { effect: "allow", rule_id: "a" }],
  // 4. Rules
  ["R7 allows a $35 billing-error refund for a 120-day customer", input(refund(3500)), { effect: "allow", reason: "rule:allow", rule_id: "r7", debits: [{ scope: "company:refund", cents: 3500 }] }],
  ["R7 does not cover a 30-day customer", input(refund(3500), { customer: { tenure_days: 30 } }), { effect: "escalate", reason: "default:no_rule" }],
  ["R7 does not cover an unknown customer", input(refund(3500), { customer: undefined }), { effect: "escalate", reason: "default:no_rule" }],
  ["R7 does not cover a changed-mind refund", input(refund(3500, { labels: { refund_reason: { value: "changed_mind", confidence: 0.99 } } })), { effect: "escalate", reason: "default:no_rule" }],
  ["R7 does not cover $45", input(refund(4500)), { effect: "escalate", reason: "default:no_rule" }],
  ["a role rule beats a company rule", input(refund(3500), { rules: [R7, rule("role-deny", { scope: { level: "role", role: "support" }, effect: "deny" })] }), { effect: "deny", reason: "rule:deny", rule_id: "role-deny" }],
  ["a department rule beats a company rule", input(refund(3500), { rules: [R7, rule("dept-esc", { scope: { level: "department", department: "customer" }, effect: "escalate" })] }), { effect: "escalate", reason: "rule:escalate", rule_id: "dept-esc" }],
  ["a specific rule whose conditions fail falls back to the company rule", input(refund(3500), { rules: [R7, rule("role-big", { scope: { level: "role", role: "support" }, effect: "deny", conditions: [{ field: "amount_cents", op: ">", value: 10_000 }] })] }), { effect: "allow", rule_id: "r7" }],
  ["tie at the same level: deny beats allow", input(refund(3500), { rules: [R7, rule("co-deny", { effect: "deny" })] }), { effect: "deny", rule_id: "co-deny" }],
  ["tie at the same level: escalate beats allow", input(refund(3500), { rules: [R7, rule("co-esc", { effect: "escalate" })] }), { effect: "escalate", reason: "rule:escalate", rule_id: "co-esc" }],
  ["another role's rule does not apply", input(refund(3500), { rules: [rule("ledger-only", { scope: { level: "role", role: "ledger" } })] }), { effect: "escalate", reason: "default:no_rule" }],
  ["another department's rule does not apply", input(refund(3500), { rules: [rule("fin", { scope: { level: "department", department: "finance" } })] }), { effect: "escalate", reason: "default:no_rule" }],
  ["an expired rule does not apply", input(refund(3500), { rules: [{ ...R7, expires_at: NOW - 1 }] }), { effect: "escalate", reason: "default:no_rule" }],
  ["a rule expiring later still applies", input(refund(3500), { rules: [{ ...R7, expires_at: NOW + DAY }] }), { effect: "allow", rule_id: "r7" }],
  ["a proposed (inactive) rule does not apply", input(refund(3500), { rules: [{ ...R7, status: "proposed" }] }), { effect: "escalate", reason: "default:no_rule" }],
  ["a rule for another action type does not apply", input(refund(3500), { rules: [{ ...R7, action_type: "pay_bill" }] }), { effect: "escalate", reason: "default:no_rule" }],
  // Absence mode
  ["away: an allow rule with < 5 supporting decisions queues", input(action("reply_customer", { labels: noCommitment }), { founderStatus: "away", rules: [rule("rc", { action_type: "reply_customer", support: 4 })] }), { effect: "queue", reason: "absence:low_support", rule_id: "rc" }],
  ["away: a well-supported money allow queues", input(refund(3500), { founderStatus: "away", rules: [{ ...R7, support: 6 }] }), { effect: "queue", reason: "absence:money", rule_id: "r7", debits: [] }],
  ["away: a well-supported non-money allow still allows", input(action("reply_customer", { labels: noCommitment }), { founderStatus: "away", rules: [rule("rc", { action_type: "reply_customer", support: 5 })] }), { effect: "allow", rule_id: "rc" }],
  ["away: escalations still escalate", input(refund(3500), { founderStatus: "away", customer: { tenure_days: 5 } }), { effect: "escalate", reason: "default:no_rule" }],
  // Cofounder authority (flow B): company rule for marketing_spend within $200 when the Cofounder decides.
  ["cofounder may approve marketing spend within $200", input(action("marketing_spend", { role: "cofounder", department: "leadership", params: { channel: "x-ads" }, amount_cents: 15_000, counterparty: "x-ads" }), { budgets: [{ scope: "company:marketing", limit_cents: 50_000, spent_cents: 0 }], stats: { approvedCount: 2, maxApprovedCents: 20_000, counterparties: ["x-ads"] }, rules: [rule("cf", { action_type: "marketing_spend", conditions: [{ field: "amount_cents", op: "<=", value: 20_000 }, { field: "role", op: "==", value: "cofounder" }] })] }), { effect: "allow", rule_id: "cf", debits: [{ scope: "company:marketing", cents: 15_000 }] }],
  ["marketing spend proposed by Content is not covered by the cofounder rule", input(action("marketing_spend", { role: "content", department: "marketing", params: { channel: "x-ads" }, amount_cents: 15_000, counterparty: "x-ads" }), { budgets: [], stats: { approvedCount: 2, maxApprovedCents: 20_000, counterparties: ["x-ads"] }, rules: [rule("cf", { action_type: "marketing_spend", conditions: [{ field: "role", op: "==", value: "cofounder" }] })] }), { effect: "escalate", reason: "default:no_rule" }],
  // 5. Default
  ["no rules at all escalates by default", input(refund(3500), { rules: [] }), { effect: "escalate", reason: "default:no_rule", debits: [] }],
];

describe("evaluate (pure, first match decides)", () => {
  test("covers at least 20 cases", () => expect(CASES.length).toBeGreaterThanOrEqual(20));
  test.each(CASES)("%s", (_name, gateInput, expected) => {
    const result = evaluate(gateInput);
    expect(result).toMatchObject(expected);
    if (result.effect === "allow") expect(result.rule_id).toBeTruthy();
    if (result.effect !== "allow") expect(result.debits).toEqual([]);
  });

  test("is pure: same input, same output, input untouched", () => {
    const i = input(refund(3500));
    const copy = structuredClone(i);
    expect(evaluate(i)).toEqual(evaluate(i));
    expect(i).toEqual(copy);
  });
});

describe("features and conditions", () => {
  test("features flatten amount, tenure, role, channel and label values", () => {
    const f = features(action("publish_post", { params: { channel: "linkedin" }, labels: { mentions_pricing: { value: true, confidence: 0.9 } } }), { tenure_days: 12 });
    expect(f).toEqual({ role: "support", channel: "linkedin", customer_tenure_days: 12, mentions_pricing: true });
  });

  test.each([
    [{ field: "a", op: "<", value: 5 }, { a: 4 }, true],
    [{ field: "a", op: "<", value: 5 }, { a: 5 }, false],
    [{ field: "a", op: ">=", value: 5 }, { a: 5 }, true],
    [{ field: "a", op: ">", value: 5 }, { a: "6" }, false], // type mismatch
    [{ field: "a", op: "==", value: "x" }, { a: "x" }, true],
    [{ field: "a", op: "!=", value: "x" }, { a: "y" }, true],
    [{ field: "a", op: "in", value: ["x", "y"] }, { a: "y" }, true],
    [{ field: "a", op: "not_in", value: ["x", "y"] }, { a: "z" }, true],
    [{ field: "a", op: "not_in", value: ["x"] }, {}, false], // missing feature never holds
    [{ field: "a", op: "!=", value: "x" }, {}, false],
  ] as const)("%o on %o → %s", (c, f, expected) => {
    expect(conditionHolds({ ...c, value: c.value as never }, f)).toBe(expected);
  });

  test("catalog amounts and counterparties", () => {
    expect(CATALOG.refund_batch.amount({ items: [{ amount_cents: 3500 }, { amount_cents: 3500 }] })).toBe(7000);
    expect(CATALOG.refund_batch.amount({ items: [{ amount_cents: "35" }] })).toBeUndefined();
    expect(CATALOG.pay_bill.counterparty({ merchant: "CloudHost" })).toBe("CloudHost");
    expect(CATALOG.switch_vendor.amount({ monthly_impact_cents: 900 })).toBe(900);
    expect(CATALOG.reply_customer.money).toBe(false);
  });

  test("budget periods: LA day and the LA week's Monday", () => {
    const sat = Date.parse("2026-10-24T18:00:00Z"); // Saturday in LA
    expect(budgetPeriod("day", sat)).toBe("2026-10-24");
    expect(budgetPeriod("week", sat)).toBe("2026-10-19");
    expect(laWeekStart(Date.parse("2026-10-19T08:00:00Z"))).toBe("2026-10-19"); // Monday 01:00 LA
    expect(laWeekStart(Date.parse("2026-10-19T06:00:00Z"))).toBe("2026-10-12"); // still Sunday in LA
  });
});

// ---------------------------------------------------------------- evaluateGate mutation

function setup() {
  return convexTest(schema, import.meta.glob("../convex/**/*.ts"));
}
type T = ReturnType<typeof setup>;

async function world(t: T) {
  await t.mutation(internal.seed.config, {});
  return await t.run(async (ctx) => {
    const room = (await ctx.db.query("rooms").withIndex("by_name", (q) => q.eq("name", "#customer")).unique())!;
    const now = Date.now();
    const taskId = await ctx.db.insert("tasks", {
      role: "support",
      room: room._id,
      kind: "work",
      brief: "Handle a refund ticket.",
      chain_id: "chain-1",
      hop: 0,
      attempt: 1,
      status: "gated",
      origin_refs: [],
      deadline: now + DAY,
      mode: "live",
      created_at: now,
      updated_at: now,
    });
    const customer = (days: number, name: string) =>
      ctx.db.insert("customers", { name, email: `${name}@example.com`, nessie_customer_id: `n-${name}`, nessie_account_id: `a-${name}`, signup_at: now - days * DAY, plan: "Pro" });
    return { taskId, room: room._id, loyal: await customer(120, "loyal"), fresh: await customer(3, "fresh") };
  });
}

async function propose(
  t: T,
  taskId: Id<"tasks">,
  type: ActionType,
  params: Record<string, unknown>,
  opts: { role?: Role; labels?: Doc<"actions">["labels"] } = {},
): Promise<Id<"actions">> {
  return t.run((ctx) =>
    ctx.db.insert("actions", {
      task: taskId,
      chain_id: "chain-1",
      role: opts.role ?? "support",
      type,
      params,
      rationale: "Customer was double charged.",
      ...(opts.labels ? { labels: opts.labels } : {}),
      status: "proposed",
      created_at: Date.now(),
    }),
  );
}

const getAction = (t: T, id: Id<"actions">) => t.run(async (ctx) => (await ctx.db.get(id))!);
const refundBudget = (t: T) =>
  t.run((ctx) =>
    ctx.db
      .query("budgets")
      .withIndex("by_scope_period", (q) => q.eq("scope", "company:refund").eq("period", laDate(Date.now())))
      .unique(),
  );
const LABELS = { refund_reason: { value: "billing_error", confidence: 0.95 } };

describe("evaluateGate", () => {
  test("seeded R7 allows a $35 billing-error refund for a 120-day customer and debits the budget", async () => {
    const t = setup();
    const w = await world(t);
    const id = await propose(t, w.taskId, "refund", { customer_id: w.loyal, amount_cents: 3500, reason: "billing_error" }, { labels: LABELS });
    const r7 = await t.run(async (ctx) => (await ctx.db.query("rules").collect()).find((r) => r.text === R7_TEXT)!);

    expect(await t.mutation(internal.gate.evaluateGate, { actionId: id })).toEqual({ effect: "allow", reason: "rule:allow", rule_id: r7._id });
    expect(await getAction(t, id)).toMatchObject({
      status: "allowed",
      amount_cents: 3500,
      counterparty: w.loyal,
      gate: { effect: "allow", reason: "rule:allow", rule_id: r7._id },
    });
    expect(await refundBudget(t)).toMatchObject({ limit_cents: 30_000, spent_cents: 3500 });
    const kinds = await t.run(async (ctx) => (await ctx.db.query("audit_log").withIndex("by_ref", (q) => q.eq("ref", w.taskId)).collect()).map((a) => a.kind));
    expect(kinds).toEqual(["gate_decision", "execution_pending"]);
  });

  test("a $480 refund from a 3-day customer escalates with hard:budget; the inbox shows tenure", async () => {
    const t = setup();
    const w = await world(t);
    const id = await propose(t, w.taskId, "refund", { customer_id: w.fresh, amount_cents: 48_000, reason: "billing_error" }, { labels: LABELS });
    expect(await t.mutation(internal.gate.evaluateGate, { actionId: id })).toEqual({ effect: "escalate", reason: "hard:budget" });
    expect(await getAction(t, id)).toMatchObject({ status: "escalated", gate: { effect: "escalate", reason: "hard:budget", constraint: "hard:budget" } });
    expect((await getAction(t, id)).gate).not.toHaveProperty("rule_id");
    const [item] = await t.run((ctx) => ctx.db.query("founder_inbox").collect());
    expect(item).toMatchObject({ kind: "action", ref: id, status: "open", title: "Approve refund $480.00?" });
    expect(item.body).toContain("Gate: hard:budget");
    expect(item.body).toContain("fresh, 3 days, Pro plan");
    expect(await refundBudget(t)).toMatchObject({ spent_cents: 0 });
  });

  test("two concurrent $30 refunds against $40 remaining: exactly one is allowed", async () => {
    const t = setup();
    const w = await world(t);
    await t.run((ctx) => ctx.db.insert("budgets", { scope: "company:refund", period: laDate(Date.now()), limit_cents: 30_000, spent_cents: 26_000 }));
    const params = { customer_id: w.loyal, amount_cents: 3000, reason: "billing_error" };
    const a = await propose(t, w.taskId, "refund", params, { labels: LABELS });
    const b = await propose(t, w.taskId, "refund", params, { labels: LABELS });

    const results = await Promise.all([a, b].map((actionId) => t.mutation(internal.gate.evaluateGate, { actionId })));
    expect(results.map((r) => r!.reason).sort()).toEqual(["hard:budget", "rule:allow"]);
    expect(await refundBudget(t)).toMatchObject({ spent_cents: 29_000 });
    const budgets = await t.run((ctx) => ctx.db.query("budgets").collect());
    expect(budgets).toHaveLength(1);
  });

  test("concurrent gates on a fresh day create a single budget row", async () => {
    const t = setup();
    const w = await world(t);
    const params = { customer_id: w.loyal, amount_cents: 3500, reason: "billing_error" };
    const ids = await Promise.all([1, 2, 3].map(() => propose(t, w.taskId, "refund", params, { labels: LABELS })));
    await Promise.all(ids.map((actionId) => t.mutation(internal.gate.evaluateGate, { actionId })));
    const budgets = await t.run((ctx) => ctx.db.query("budgets").collect());
    expect(budgets).toHaveLength(1);
    expect(budgets[0].spent_cents).toBe(10_500);
  });

  test("gating is idempotent: a second call is a no-op and does not debit again", async () => {
    const t = setup();
    const w = await world(t);
    const id = await propose(t, w.taskId, "refund", { customer_id: w.loyal, amount_cents: 3500, reason: "billing_error" }, { labels: LABELS });
    await t.mutation(internal.gate.evaluateGate, { actionId: id });
    expect(await t.mutation(internal.gate.evaluateGate, { actionId: id })).toBeNull();
    expect(await refundBudget(t)).toMatchObject({ spent_cents: 3500 });
  });

  test("a denied action gets a Dispatcher note in its thread", async () => {
    const t = setup();
    const w = await world(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("decisions", {
        subject_kind: "action",
        action_type: "publish_post",
        choice: "approve",
        features: {},
        decided_by: "founder",
        created_at: Date.now(),
      });
      await ctx.db.insert("rules", {
        scope: { level: "role", role: "support" },
        action_type: "publish_post",
        conditions: [],
        effect: "deny",
        status: "active",
        version: 1,
        supporting_decisions: [],
        agreement: { agree: 1, total: 1 },
        text: "Support never posts.",
        created_at: Date.now(),
      });
    });
    const id = await propose(t, w.taskId, "publish_post", { channel: "linkedin", text: "hi" }, { labels: { mentions_pricing: { value: false, confidence: 0.95 }, mentions_competitor: { value: false, confidence: 0.95 } } });
    expect(await t.mutation(internal.gate.evaluateGate, { actionId: id })).toMatchObject({ effect: "deny", reason: "rule:deny" });
    expect(await getAction(t, id)).toMatchObject({ status: "denied" });
    const msgs = await t.run((ctx) => ctx.db.query("messages").withIndex("by_task", (q) => q.eq("task", w.taskId)).collect());
    expect(msgs.map((m) => m.text)).toEqual([`[Dispatcher] The gate denied publish_post on task ${w.taskId} (rule:deny). Do not retry it.`]);
  });

  test("an unknown action type for the founder escalates novelty:new_type", async () => {
    const t = setup();
    const w = await world(t);
    const id = await propose(t, w.taskId, "reply_customer", { ticket_id: "t1", body: "Sorry!" }, { labels: noCommitment });
    expect(await t.mutation(internal.gate.evaluateGate, { actionId: id })).toEqual({ effect: "escalate", reason: "novelty:new_type" });
  });

  test("founder away: an R7 refund queues instead of executing", async () => {
    const t = setup();
    const w = await world(t);
    await t.run((ctx) => ctx.db.insert("founder", { status: "away", updated_at: Date.now() }));
    const id = await propose(t, w.taskId, "refund", { customer_id: w.loyal, amount_cents: 3500, reason: "billing_error" }, { labels: LABELS });
    expect(await t.mutation(internal.gate.evaluateGate, { actionId: id })).toMatchObject({ effect: "queue", reason: "absence:low_support" });
    expect(await getAction(t, id)).toMatchObject({ status: "queued" });
    expect(await refundBudget(t)).toMatchObject({ spent_cents: 0 });
  });

  test("tenure comes from the ticket's customer when params carry only ticket_id", async () => {
    const t = setup();
    const w = await world(t);
    const ticket = await t.run((ctx) =>
      ctx.db.insert("tickets", { customer: w.loyal, from_email: "loyal@example.com", subject: "Charged twice", body: "b", status: "open", source: "seed", created_at: Date.now() }),
    );
    const id = await propose(t, w.taskId, "refund", { customer_id: "nessie-17", ticket_id: ticket, amount_cents: 3500, reason: "billing_error" }, { labels: LABELS });
    expect(await t.mutation(internal.gate.evaluateGate, { actionId: id })).toMatchObject({ effect: "allow" });
  });

  test("weekly marketing budget uses the LA week's Monday as its period", async () => {
    const t = setup();
    const w = await world(t);
    const id = await propose(t, w.taskId, "marketing_spend", { channel: "x-ads", amount_cents: 10_000, duration_days: 7 }, { role: "cofounder" });
    await t.mutation(internal.gate.evaluateGate, { actionId: id });
    const budget = await t.run((ctx) => ctx.db.query("budgets").withIndex("by_scope_period", (q) => q.eq("scope", "company:marketing")).unique());
    expect(budget).toMatchObject({ period: laWeekStart(Date.now()), limit_cents: 50_000, spent_cents: 0 });
  });
});
