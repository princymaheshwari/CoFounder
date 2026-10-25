import type { ActionStatus, GateEffect, LedgerKind } from "./types";

// Pure Nessie helpers (spec 08). Verified live on 2026-10-24 against https://api.nessieisreal.com:
// - amounts are whole dollars (the API truncates 35.5 to 35), so we only send whole-dollar cents;
// - transfers have no payee field (body is {transaction_date, status, amount, description}) and move no
//   balance, so the receiving account is kept in a `[to:<account>]` tag in the description;
// - nothing is idempotent, so every object we create carries a `[cf:<key>]` tag and resumes look it up.

export const NESSIE_BASE_URL = "https://api.nessieisreal.com";

export type NessieObject = Record<string, unknown>;

export type MirrorRow = {
  nessie_id: string;
  kind: LedgerKind;
  account_id: string; // the paying account
  amount_cents: number;
  counterparty?: string; // receiving account id (transfers) or merchant / payee name; absent = keep what we have
  date: string; // ISO
  raw: NessieObject;
};

export class FractionalAmountError extends Error {
  constructor(readonly cents: number) {
    super(`Nessie stores whole dollars only; ${cents} cents is not a whole-dollar amount`);
    this.name = "FractionalAmountError";
  }
}

export function toNessieAmount(cents: number): number {
  if (!Number.isInteger(cents) || cents <= 0 || cents % 100 !== 0) throw new FractionalAmountError(cents);
  return cents / 100;
}

export function centsFromNessie(amount: unknown): number {
  const n = typeof amount === "number" ? amount : Number(amount);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

// GET /accounts/{id}/transfers returns `id`; everything else (and every POST) returns `_id`.
export function nessieId(o: NessieObject): string {
  const id = o._id ?? o.id;
  if (typeof id !== "string" || !id) throw new Error("Nessie object has no id");
  return id;
}

// Convex rejects object keys starting with "_" or "$" in stored values: `_id` is kept as `id`.
export function cleanRaw(o: NessieObject): NessieObject {
  const out: NessieObject = {};
  for (const [k, val] of Object.entries(o)) out[k.replace(/^[_$]+/, "") || "field"] = val;
  return out;
}

export const tag = (key: "cf" | "to", value: string) => `[${key}:${value}]`;

export function readTags(text: unknown): { cf?: string; to?: string } {
  if (typeof text !== "string") return {};
  const out: { cf?: string; to?: string } = {};
  for (const m of text.matchAll(/\[(cf|to):([^\]\s]+)\]/g)) out[m[1] as "cf" | "to"] = m[2];
  return out;
}

// The `cf` tag of an object we created: transfers and purchases carry it in description, bills in nickname.
export const markerOf = (o: NessieObject): string | undefined => readTags(o.description).cf ?? readTags(o.nickname).cf;

// Dates are stored as given; we send full ISO. Date-only values become UTC midnight so rows sort together.
export function isoDate(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "1970-01-01T00:00:00.000Z";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T00:00:00.000Z`;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : raw;
}

export function mirrorFromTransfer(o: NessieObject, payingAccount: string): MirrorRow {
  return {
    nessie_id: nessieId(o),
    kind: "transfer",
    account_id: payingAccount,
    amount_cents: centsFromNessie(o.amount),
    counterparty: readTags(o.description).to,
    date: isoDate(o.transaction_date),
    raw: cleanRaw(o),
  };
}

export function mirrorFromPurchase(o: NessieObject, payingAccount: string, merchantNames: Record<string, string>): MirrorRow {
  const merchantId = typeof o.merchant_id === "string" ? o.merchant_id : "";
  return {
    nessie_id: nessieId(o),
    kind: "purchase",
    account_id: typeof o.payer_id === "string" ? o.payer_id : payingAccount,
    amount_cents: centsFromNessie(o.amount),
    counterparty: merchantNames[merchantId] ?? (merchantId || undefined),
    date: isoDate(o.purchase_date),
    raw: cleanRaw(o),
  };
}

export function mirrorFromBill(o: NessieObject, payingAccount: string): MirrorRow {
  return {
    nessie_id: nessieId(o),
    kind: "bill",
    account_id: typeof o.account_id === "string" ? o.account_id : payingAccount,
    amount_cents: centsFromNessie(o.payment_amount),
    counterparty: typeof o.payee === "string" ? o.payee : undefined,
    date: isoDate(o.payment_date ?? o.creation_date),
    raw: cleanRaw(o),
  };
}

// Money flowing in from outside; the deposit's account is the receiving side.
export function mirrorFromDeposit(o: NessieObject, account: string): MirrorRow {
  return {
    nessie_id: nessieId(o),
    kind: "deposit",
    account_id: "external",
    amount_cents: centsFromNessie(o.amount),
    counterparty: account,
    date: isoDate(o.transaction_date),
    raw: cleanRaw(o),
  };
}

// Spec 08: never execute an action the gate did not allow or the founder did not approve.
// `resume` re-enters an execution that was interrupted (executing) or failed part-way; it still needs
// the original authority (gate allow, or a recorded founder approval).
export function executionBlock(
  action: { status: ActionStatus; gate?: { effect: GateEffect } },
  opts: { resume: boolean; founderApproved: boolean },
): string | null {
  const authorized = action.gate?.effect === "allow" || opts.founderApproved;
  if (action.status === "allowed") return action.gate?.effect === "allow" ? null : `gate:${action.gate?.effect ?? "none"}`;
  if (action.status === "approved") return opts.founderApproved ? null : "approved_without_decision";
  if (action.status === "executing" || action.status === "failed") {
    if (!opts.resume) return `status:${action.status}`;
    return authorized ? null : `gate:${action.gate?.effect ?? "none"}`;
  }
  return `status:${action.status}`;
}
