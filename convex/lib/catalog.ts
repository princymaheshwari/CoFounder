import type { ActionType } from "./types";

// Action catalog (spec 07, system-design §8): what each action type is, how much money it moves,
// who executes it once allowed, and which budget it draws on.

export type Tier = "low" | "medium" | "high" | "money";
export type ExecutorKind = "nessie" | "executor" | "post_queue" | "none";
export type BudgetScope = "company:refund" | "company:marketing";
type Params = Record<string, unknown>;

export type CatalogEntry = {
  tier: Tier;
  money: boolean;
  executor: ExecutorKind;
  alwaysEscalate: boolean;
  budgetScope?: BudgetScope;
  // Counterparty novelty applies to payees (merchants, vendors, channels), not to refunded customers.
  trackCounterparty: boolean;
  amount: (p: Params) => number | undefined;
  counterparty: (p: Params) => string | undefined;
};

const cents = (x: unknown): number | undefined => (typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : undefined);
const str = (x: unknown): string | undefined => (typeof x === "string" && x.length > 0 ? x : undefined);
const none = (): undefined => undefined;

function batchTotal(p: Params): number | undefined {
  if (!Array.isArray(p.items)) return undefined;
  let total = 0;
  for (const item of p.items as unknown[]) {
    const c = item && typeof item === "object" ? cents((item as Params).amount_cents) : undefined;
    if (c === undefined) return undefined;
    total += c;
  }
  return total;
}

export const CATALOG: Record<ActionType, CatalogEntry> = {
  reply_customer: { tier: "low", money: false, executor: "executor", alwaysEscalate: false, trackCounterparty: false, amount: none, counterparty: none },
  publish_post: { tier: "medium", money: false, executor: "post_queue", alwaysEscalate: false, trackCounterparty: false, amount: none, counterparty: (p) => str(p.channel) },
  file_bug: { tier: "low", money: false, executor: "executor", alwaysEscalate: false, trackCounterparty: false, amount: none, counterparty: none },
  schedule_digest: { tier: "low", money: false, executor: "executor", alwaysEscalate: false, trackCounterparty: false, amount: none, counterparty: none },
  refund: {
    tier: "money",
    money: true,
    executor: "nessie",
    alwaysEscalate: false,
    budgetScope: "company:refund",
    trackCounterparty: false,
    amount: (p) => cents(p.amount_cents),
    counterparty: (p) => str(p.customer_id),
  },
  refund_batch: {
    tier: "money",
    money: true,
    executor: "nessie",
    alwaysEscalate: false,
    budgetScope: "company:refund",
    trackCounterparty: false,
    amount: batchTotal,
    counterparty: none,
  },
  pay_bill: {
    tier: "money",
    money: true,
    executor: "nessie",
    alwaysEscalate: false,
    trackCounterparty: true,
    amount: (p) => cents(p.amount_cents),
    counterparty: (p) => str(p.merchant),
  },
  switch_vendor: {
    tier: "money",
    money: true,
    executor: "none",
    alwaysEscalate: true,
    trackCounterparty: true,
    amount: (p) => cents(p.monthly_impact_cents),
    counterparty: (p) => str(p.to_vendor),
  },
  price_change: { tier: "high", money: false, executor: "none", alwaysEscalate: true, trackCounterparty: false, amount: none, counterparty: (p) => str(p.plan) },
  marketing_spend: {
    tier: "money",
    money: true,
    executor: "none",
    alwaysEscalate: false,
    budgetScope: "company:marketing",
    trackCounterparty: true,
    amount: (p) => cents(p.amount_cents),
    counterparty: (p) => str(p.channel),
  },
};
