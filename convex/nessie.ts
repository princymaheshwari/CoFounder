import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { env, internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { appendMessage, audit, getConfig } from "./channels";
import { raiseIssue } from "./issues";
import { CATALOG } from "./lib/catalog";
import {
  FractionalAmountError,
  executionBlock,
  markerOf,
  mirrorFromBill,
  mirrorFromDeposit,
  mirrorFromPurchase,
  mirrorFromTransfer,
  nessieId,
  readTags,
  tag,
  toNessieAmount,
  type MirrorRow,
  type NessieObject,
} from "./lib/nessie";
import { currentBudget } from "./gate";
import { DAY_MS } from "./lib/co";
import { vLedgerKind } from "./lib/types";
import { nessieCreate, nessieGet, nessieList, nessieUpdate } from "./nessieApi";
import { ADDRESS, CUSTOMER_ACCOUNT, MERCHANTS, OPERATING, buildSeedPlan, type SeedItem } from "./seedData";

// Spec 08: the Lumen Notes sandbox bank. Seed, ledger mirror sync, and money-action execution.
// Only Convex calls Nessie (invariant 1); execution re-checks the gate's decision first.

const STATE_KEY = "nessie";
const vState = v.object({
  operating_customer_id: v.string(),
  operating_account_id: v.string(),
  merchants: v.record(v.string(), v.string()), // name → Nessie merchant id
  seeded_at: v.optional(v.number()),
});
type NessieState = Infer<typeof vState>;

const vMirrorRow = v.object({
  nessie_id: v.string(),
  kind: vLedgerKind,
  account_id: v.string(),
  amount_cents: v.number(),
  counterparty: v.optional(v.string()),
  date: v.string(),
  raw: v.any(),
});

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

// Bounded parallelism for Nessie calls.
async function pool<T>(items: readonly T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

// ---------------------------------------------------------------- state, customers, mirror

export const getState = internalQuery({
  args: {},
  returns: v.union(v.null(), vState),
  handler: async (ctx) => {
    const row = await ctx.db
      .query("config")
      .withIndex("by_key", (q) => q.eq("key", STATE_KEY))
      .unique();
    return row ? (row.value as NessieState) : null;
  },
});

export const saveState = internalMutation({
  args: { state: vState },
  returns: v.null(),
  handler: async (ctx, { state }) => {
    const row = await ctx.db
      .query("config")
      .withIndex("by_key", (q) => q.eq("key", STATE_KEY))
      .unique();
    if (row) await ctx.db.patch(row._id, { value: state });
    else await ctx.db.insert("config", { key: STATE_KEY, value: state });
    return null;
  },
});

export const upsertCustomer = internalMutation({
  args: {
    name: v.string(),
    email: v.string(),
    nessie_customer_id: v.string(),
    nessie_account_id: v.string(),
    signup_at: v.number(),
    plan: v.string(),
  },
  returns: v.id("customers"),
  handler: async (ctx, c) => {
    const existing = await ctx.db
      .query("customers")
      .withIndex("by_nessie_account", (q) => q.eq("nessie_account_id", c.nessie_account_id))
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("customers", c);
  },
});

async function upsertRows(ctx: MutationCtx, rows: Infer<typeof vMirrorRow>[]): Promise<{ inserted: number; updated: number }> {
  let inserted = 0;
  let updated = 0;
  for (const row of rows) {
    const existing = await ctx.db
      .query("ledger_mirror")
      .withIndex("by_nessie_id", (q) => q.eq("nessie_id", row.nessie_id))
      .unique();
    if (!existing) {
      await ctx.db.insert("ledger_mirror", { ...row, counterparty: row.counterparty ?? "unknown" });
      inserted++;
      continue;
    }
    // A transfer without a [to:] tag keeps the counterparty we recorded when we created it.
    const next = { kind: row.kind, account_id: row.account_id, amount_cents: row.amount_cents, date: row.date, raw: row.raw, counterparty: row.counterparty ?? existing.counterparty };
    const prev = { kind: existing.kind, account_id: existing.account_id, amount_cents: existing.amount_cents, date: existing.date, raw: existing.raw, counterparty: existing.counterparty };
    if (JSON.stringify(next) !== JSON.stringify(prev)) {
      await ctx.db.patch(existing._id, next);
      updated++;
    }
  }
  return { inserted, updated };
}

export const upsertLedgerRows = internalMutation({
  args: { rows: v.array(vMirrorRow), source: v.union(v.literal("seed"), v.literal("sync")) },
  returns: v.object({ inserted: v.number(), updated: v.number() }),
  handler: async (ctx, { rows, source }) => {
    const counts = await upsertRows(ctx, rows);
    if (source === "sync" && counts.inserted + counts.updated > 0) {
      await audit(ctx, { actor: "nessie", kind: "ledger_synced", ref: "ledger_mirror", detail: counts });
    }
    return counts;
  },
});

export const upsertSeedTickets = internalMutation({
  args: {
    tickets: v.array(
      v.object({
        customer: v.id("customers"),
        subject: v.string(),
        body: v.string(),
        amount_cents: v.number(),
        created_at: v.number(),
      }),
    ),
  },
  returns: v.number(),
  handler: async (ctx, { tickets }) => {
    const existing = await ctx.db.query("tickets").take(2000);
    let inserted = 0;
    for (const t of tickets) {
      if (existing.some((e) => e.customer === t.customer && e.subject === t.subject)) continue;
      const customer = await ctx.db.get(t.customer);
      if (!customer) throw new Error(`customer ${t.customer} not found`);
      await ctx.db.insert("tickets", { ...t, from_email: customer.email, status: "open", source: "seed" });
      inserted++;
    }
    return inserted;
  },
});

export const finishSeed = internalMutation({
  args: { state: vState, summary: v.any() },
  returns: v.null(),
  handler: async (ctx, { state, summary }) => {
    const row = await ctx.db
      .query("config")
      .withIndex("by_key", (q) => q.eq("key", STATE_KEY))
      .unique();
    if (row) await ctx.db.patch(row._id, { value: state });
    else await ctx.db.insert("config", { key: STATE_KEY, value: state });
    await audit(ctx, { actor: "nessie", kind: "nessie_seeded", ref: state.operating_account_id, detail: summary });
    return null;
  },
});

// ---------------------------------------------------------------- seed

const vSeedResult = v.object({
  skipped: v.boolean(),
  created: v.number(), // Nessie objects created by this run
  customers: v.number(),
  ledger_rows: v.number(),
  tickets: v.number(),
});

// Idempotent and resumable: finds what already exists (customers by name, accounts by nickname,
// merchants by name, ledger objects by their [cf:<key>] tag) and creates only what is missing.
export const seedNessie = internalAction({
  args: {},
  returns: vSeedResult,
  handler: async (ctx): Promise<Infer<typeof vSeedResult>> => {
    const plan = buildSeedPlan();
    const saved: NessieState | null = await ctx.runQuery(internal.nessie.getState, {});
    const nessieCustomers = await nessieList("/customers");
    const lumen = nessieCustomers.find((c) => c.first_name === OPERATING.first_name && c.last_name === OPERATING.last_name);
    if (lumen && saved?.seeded_at && saved.operating_customer_id === nessieId(lumen)) {
      return { skipped: true, created: 0, customers: 0, ledger_rows: 0, tickets: 0 };
    }

    let created = 0;
    const create = async (path: string, body: Record<string, unknown>) => {
      const obj = await nessieCreate(path, body);
      created++;
      return obj;
    };
    const accountFor = async (customerId: string, nickname: string, balance: number): Promise<string> => {
      const accounts = await nessieList(`/customers/${customerId}/accounts`);
      const found = accounts.find((a) => a.nickname === nickname);
      return nessieId(found ?? (await create(`/customers/${customerId}/accounts`, { type: "Checking", nickname, rewards: 0, balance })));
    };

    // 1. The company: customer "Lumen Notes Inc" with its operating checking account.
    const operatingCustomerId = nessieId(lumen ?? (await create("/customers", { first_name: OPERATING.first_name, last_name: OPERATING.last_name, address: ADDRESS })));
    const operating = await accountFor(operatingCustomerId, OPERATING.nickname, OPERATING.balance);
    const state: NessieState = { operating_customer_id: operatingCustomerId, operating_account_id: operating, merchants: {} };
    await ctx.runMutation(internal.nessie.saveState, { state });

    // 2. Vendors.
    const existingMerchants = await nessieList("/merchants");
    for (const m of MERCHANTS) {
      const found = existingMerchants.find((x) => x.name === m.name);
      state.merchants[m.name] = nessieId(
        found ?? (await create("/merchants", { name: m.name, category: m.category, address: ADDRESS, geocode: { lat: 37.79, lng: -122.4 } })),
      );
    }
    await ctx.runMutation(internal.nessie.saveState, { state });
    const merchantNames = Object.fromEntries(Object.entries(state.merchants).map(([name, id]) => [id, name]));

    // 3. Customers, each with a checking account, mirrored into `customers`.
    const accountOf: Record<string, string> = { operating };
    const customerIdOf: Record<string, Id<"customers">> = {};
    await pool(plan.customers, 5, async (c) => {
      const found = nessieCustomers.find((x) => x.first_name === c.first_name && x.last_name === c.last_name);
      const nessieCustomerId = nessieId(found ?? (await create("/customers", { first_name: c.first_name, last_name: c.last_name, address: ADDRESS })));
      accountOf[c.key] = await accountFor(nessieCustomerId, CUSTOMER_ACCOUNT.nickname, CUSTOMER_ACCOUNT.balance);
      customerIdOf[c.key] = await ctx.runMutation(internal.nessie.upsertCustomer, {
        name: c.name,
        email: c.email,
        nessie_customer_id: nessieCustomerId,
        nessie_account_id: accountOf[c.key],
        signup_at: c.signup_at,
        plan: c.plan,
      });
    });

    // 4. Ledger history. Index what a previous (partial) run already created, by tag.
    const payerOf = (item: SeedItem) => (item.kind === "transfer" ? item.from : "operating");
    const existing = new Map<string, MirrorRow>();
    await pool([...new Set(plan.items.map(payerOf))], 5, async (payer) => {
      const account = accountOf[payer];
      for (const o of await nessieList(`/accounts/${account}/transfers`)) {
        const marker = markerOf(o);
        if (marker) existing.set(marker, mirrorFromTransfer(o, account));
      }
      if (payer !== "operating") return;
      for (const o of await nessieList(`/accounts/${account}/purchases`)) {
        const marker = markerOf(o);
        if (marker) existing.set(marker, mirrorFromPurchase(o, account, merchantNames));
      }
      for (const o of await nessieList(`/accounts/${account}/bills`)) {
        const marker = markerOf(o);
        if (marker) existing.set(marker, mirrorFromBill(o, account));
      }
    });

    const reused: MirrorRow[] = [];
    await pool(plan.items, 6, async (item) => {
      const have = existing.get(item.key);
      if (have) {
        reused.push(have);
        return;
      }
      let row: MirrorRow;
      if (item.kind === "transfer") {
        const from = accountOf[item.from];
        const to = accountOf[item.to];
        const o = await create(`/accounts/${from}/transfers`, {
          transaction_date: item.date,
          status: "completed",
          amount: toNessieAmount(item.amount_cents),
          description: `${item.description} ${tag("cf", item.key)} ${tag("to", to)}`,
        });
        row = mirrorFromTransfer(o, from);
      } else if (item.kind === "purchase") {
        const o = await create(`/accounts/${operating}/purchases`, {
          merchant_id: state.merchants[item.merchant],
          medium: "balance",
          purchase_date: item.date,
          amount: toNessieAmount(item.amount_cents),
          status: "completed",
          description: `${item.description} ${tag("cf", item.key)}`,
        });
        row = mirrorFromPurchase(o, operating, merchantNames);
      } else {
        // recurring_date is required: without it Nessie can no longer list the account's bills.
        const o = await create(`/accounts/${operating}/bills`, {
          status: item.status,
          payee: item.payee,
          nickname: `${item.nickname} ${tag("cf", item.key)}`,
          payment_date: item.date,
          recurring_date: Number(item.date.slice(8, 10)),
          payment_amount: toNessieAmount(item.amount_cents),
        });
        row = mirrorFromBill(o, operating);
      }
      // Mirror immediately; don't wait for the sync cron.
      await ctx.runMutation(internal.nessie.upsertLedgerRows, { rows: [row], source: "seed" });
    });
    for (const rows of chunks(reused, 100)) await ctx.runMutation(internal.nessie.upsertLedgerRows, { rows, source: "seed" });

    // 5. Tickets from six of the double-charged customers.
    const tickets = await ctx.runMutation(internal.nessie.upsertSeedTickets, {
      tickets: plan.tickets.map((t) => ({ ...t, customer: customerIdOf[t.customer] })),
    });

    const result = { skipped: false, created, customers: plan.customers.length, ledger_rows: plan.items.length, tickets };
    await ctx.runMutation(internal.nessie.finishSeed, { state: { ...state, seeded_at: Date.now() }, summary: result });
    return result;
  },
});

// ---------------------------------------------------------------- sync

export const syncTargets = internalQuery({
  args: {},
  returns: v.object({ state: v.union(v.null(), vState), customer_accounts: v.array(v.string()) }),
  handler: async (ctx) => {
    const row = await ctx.db
      .query("config")
      .withIndex("by_key", (q) => q.eq("key", STATE_KEY))
      .unique();
    const customers = await ctx.db.query("customers").take(1000);
    return { state: row ? (row.value as NessieState) : null, customer_accounts: customers.map((c) => c.nessie_account_id) };
  },
});

const vSyncResult = v.object({ skipped: v.boolean(), rows: v.number(), inserted: v.number(), updated: v.number() });

// Mirrors every object on the operating account and the customer accounts into ledger_mirror.
// Cron every 10 minutes (crons.ts); run on demand with `npx convex run nessie:syncLedger`.
export const syncLedger = internalAction({
  args: {},
  returns: vSyncResult,
  handler: async (ctx): Promise<Infer<typeof vSyncResult>> => {
    if (!env.NESSIE_API_KEY) return { skipped: true, rows: 0, inserted: 0, updated: 0 };
    const { state, customer_accounts } = await ctx.runQuery(internal.nessie.syncTargets, {});
    if (!state) return { skipped: true, rows: 0, inserted: 0, updated: 0 };
    const op = state.operating_account_id;
    const merchantNames = Object.fromEntries(Object.entries(state.merchants).map(([name, id]) => [id, name]));

    const rows: MirrorRow[] = [];
    const [transfers, purchases, bills, deposits] = await Promise.all([
      nessieList(`/accounts/${op}/transfers`),
      nessieList(`/accounts/${op}/purchases`),
      nessieList(`/accounts/${op}/bills`),
      nessieList(`/accounts/${op}/deposits`),
    ]);
    rows.push(
      ...transfers.map((o) => mirrorFromTransfer(o, op)),
      ...purchases.map((o) => mirrorFromPurchase(o, op, merchantNames)),
      ...bills.map((o) => mirrorFromBill(o, op)),
      ...deposits.map((o) => mirrorFromDeposit(o, op)),
    );
    await pool(customer_accounts, 5, async (account) => {
      rows.push(...(await nessieList(`/accounts/${account}/transfers`)).map((o) => mirrorFromTransfer(o, account)));
    });

    let inserted = 0;
    let updated = 0;
    for (const batch of chunks(rows, 100)) {
      const r = await ctx.runMutation(internal.nessie.upsertLedgerRows, { rows: batch, source: "sync" });
      inserted += r.inserted;
      updated += r.updated;
    }
    return { skipped: false, rows: rows.length, inserted, updated };
  },
});

// ---------------------------------------------------------------- execution

const vExecItem = v.union(
  v.object({ kind: v.literal("transfer"), marker: v.string(), to_account: v.string(), amount_cents: v.number(), description: v.string() }),
  v.object({ kind: v.literal("bill_payment"), marker: v.string(), bill_id: v.string(), amount_cents: v.number() }),
);
type ExecItem = Infer<typeof vExecItem>;

class PlanError extends Error {}

// The founder approved this specific action (spec 09 writes the decision before setting `approved`).
async function founderApproved(ctx: MutationCtx, action: Doc<"actions">): Promise<boolean> {
  const decisions = await ctx.db
    .query("decisions")
    .withIndex("by_action_type", (q) => q.eq("action_type", action.type))
    .order("desc")
    .take(1000);
  return decisions.some((d) => d.action === action._id && d.decided_by === "founder" && d.choice === "approve");
}

async function customerForRefund(ctx: MutationCtx, p: Record<string, unknown>): Promise<Doc<"customers">> {
  const raw = typeof p.customer_id === "string" ? p.customer_id : undefined;
  const byId = raw ? ctx.db.normalizeId("customers", raw) : null;
  if (byId) {
    const c = await ctx.db.get(byId);
    if (c) return c;
  }
  if (raw) {
    const byAccount = await ctx.db
      .query("customers")
      .withIndex("by_nessie_account", (q) => q.eq("nessie_account_id", raw))
      .unique();
    if (byAccount) return byAccount;
  }
  const ticketId = typeof p.ticket_id === "string" ? ctx.db.normalizeId("tickets", p.ticket_id) : null;
  const ticket = ticketId ? await ctx.db.get(ticketId) : null;
  const viaTicket = ticket?.customer ? await ctx.db.get(ticket.customer) : null;
  if (viaTicket) return viaTicket;
  throw new PlanError(`unknown customer ${raw ?? "(none)"}`);
}

function refundItem(actionId: Id<"actions">, i: number, customer: Doc<"customers">, amount: unknown): ExecItem {
  if (typeof amount !== "number") throw new PlanError(`item ${i} has no amount_cents`);
  toNessieAmount(amount); // whole dollars only; throws FractionalAmountError
  return {
    kind: "transfer",
    marker: `act-${actionId}-${i}`,
    to_account: customer.nessie_account_id,
    amount_cents: amount,
    description: `Lumen Notes refund to ${customer.name}`,
  };
}

async function planItems(ctx: MutationCtx, action: Doc<"actions">): Promise<ExecItem[]> {
  const p = action.params && typeof action.params === "object" ? (action.params as Record<string, unknown>) : {};
  switch (action.type) {
    case "refund":
      return [refundItem(action._id, 0, await customerForRefund(ctx, p), p.amount_cents)];
    case "refund_batch": {
      if (!Array.isArray(p.items) || p.items.length === 0) throw new PlanError("refund_batch has no items");
      const items: ExecItem[] = [];
      for (const [i, raw] of (p.items as unknown[]).entries()) {
        const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
        items.push(refundItem(action._id, i, await customerForRefund(ctx, item), item.amount_cents));
      }
      return items;
    }
    case "pay_bill": {
      // Agents only propose pay_bill for a bill in the ledger: pay the matching pending one.
      const merchant = typeof p.merchant === "string" ? p.merchant : "";
      const bills = await ctx.db
        .query("ledger_mirror")
        .withIndex("by_counterparty_date", (q) => q.eq("counterparty", merchant))
        .take(200);
      const due = typeof p.due_date === "string" ? p.due_date.slice(0, 10) : undefined;
      const bill = bills.find(
        (b) =>
          b.kind === "bill" &&
          b.amount_cents === p.amount_cents &&
          (b.raw as NessieObject | null)?.status === "pending" &&
          (!due || b.date.startsWith(due)),
      );
      if (!bill) throw new PlanError(`no pending ${merchant} bill for ${typeof p.amount_cents === "number" ? dollars(p.amount_cents) : "?"}`);
      return [{ kind: "bill_payment", marker: `act-${action._id}-0`, bill_id: bill.nessie_id, amount_cents: bill.amount_cents }];
    }
    default:
      throw new PlanError(`${action.type} is not a Nessie action`);
  }
}

async function markFailed(ctx: MutationCtx, action: Doc<"actions">, error: string): Promise<void> {
  const task = await ctx.db.get(action.task);
  await ctx.db.patch(action._id, { status: "failed" });
  await audit(ctx, { actor: "nessie", kind: "execution_failed", ref: action.task, detail: { actionId: action._id, type: action.type, error, executed_ref: action.executed_ref ?? [] } });
  if (!task) return;
  await raiseIssue(ctx, task, {
    kind: "capability",
    summary: `Nessie could not execute ${action.type} ${action._id}: ${error}`,
    attempts: [`executeMoneyAction ${action._id}`],
    evidence: [action._id, ...(action.executed_ref ?? [])],
    toRole: task.role === "finance_manager" ? null : "finance_manager",
  });
  await appendMessage(ctx, {
    room: task.room,
    task: task._id,
    sender_kind: "system",
    sender_name: "Dispatcher",
    text: `[Dispatcher] ${action.type} ${action._id} failed in Nessie (${error}). Raised to the Finance manager.`,
  });
}

const vBegin = v.union(
  v.object({ kind: v.literal("refused"), reason: v.string() }),
  v.object({ kind: v.literal("failed"), error: v.string() }),
  v.object({
    kind: v.literal("ready"),
    operating_account_id: v.string(),
    items: v.array(vExecItem),
    done: v.array(v.string()), // markers already executed
    resume: v.boolean(),
    skipped: v.array(v.object({ marker: v.string(), to_account: v.string(), reason: v.string() })),
  }),
);

// Double-refund guard (spec 09 live run): the founder may approve overlapping actions (a Support refund and a
// Ledger batch for the same customer). A refund item is skipped when the customer got a refund from the
// operating account in the last REFUND_GUARD_DAYS, another executing action is refunding them, or the batch
// lists them twice. Checked inside beginExecution, so concurrent executions serialize on it.
const REFUND_GUARD_DAYS = 30;

// The gate (on allow) or the founder's approval debited the action's full amount; items the guard skips are
// never paid, so their amount goes back to the current budget period. Each marker is credited once (resumes re-skip).
async function creditSkipped(ctx: MutationCtx, action: Doc<"actions">, items: ExecItem[], markers: string[]): Promise<void> {
  const scope = CATALOG[action.type].budgetScope;
  if (!scope) return;
  const credited = new Set(
    (await ctx.db.query("audit_log").withIndex("by_ref", (q) => q.eq("ref", action.task)).take(1000))
      .filter((r) => r.kind === "budget_credit" && (r.detail as { actionId?: string } | null)?.actionId === action._id)
      .flatMap((r) => (r.detail as { markers: string[] }).markers),
  );
  const fresh = markers.filter((m) => !credited.has(m));
  const cents = items.filter((i) => fresh.includes(i.marker)).reduce((n, i) => n + i.amount_cents, 0);
  if (!cents) return;
  const budget = await currentBudget(ctx, scope, Date.now());
  if (budget) await ctx.db.patch(budget._id, { spent_cents: Math.max(0, budget.spent_cents - cents) });
  await audit(ctx, { actor: "nessie", kind: "budget_credit", ref: action.task, detail: { actionId: action._id, scope, markers: fresh, cents } });
}

async function refundConflicts(ctx: MutationCtx, action: Doc<"actions">, items: ExecItem[], op: string): Promise<Map<string, { to_account: string; reason: string }>> {
  const skips = new Map<string, { to_account: string; reason: string }>();
  const ownPrefix = `act-${action._id}-`;
  const since = new Date(Date.now() - REFUND_GUARD_DAYS * DAY_MS).toISOString();
  const inFlight = new Map<string, Id<"actions">>();
  for (const other of await ctx.db.query("actions").withIndex("by_status", (q) => q.eq("status", "executing")).take(50)) {
    if (other._id === action._id || CATALOG[other.type].executor !== "nessie") continue;
    try {
      for (const i of await planItems(ctx, other)) if (i.kind === "transfer") inFlight.set(i.to_account, other._id);
    } catch {
      // an unplannable action refunds no one
    }
  }
  const seen = new Set<string>();
  for (const item of items) {
    if (item.kind !== "transfer") continue;
    const skip = (reason: string) => skips.set(item.marker, { to_account: item.to_account, reason });
    const prior = (
      await ctx.db
        .query("ledger_mirror")
        .withIndex("by_counterparty_date", (q) => q.eq("counterparty", item.to_account).gte("date", since))
        .take(50)
    ).find((r) => r.kind === "transfer" && r.account_id === op && !(markerOf(r.raw as NessieObject) ?? "").startsWith(ownPrefix));
    if (seen.has(item.to_account)) skip("listed twice in this batch");
    else if (prior) skip(`already refunded ${dollars(prior.amount_cents)} on ${prior.date.slice(0, 10)} (transfer ${prior.nessie_id})`);
    else if (inFlight.has(item.to_account)) skip(`a refund is in flight in action ${inFlight.get(item.to_account)}`);
    seen.add(item.to_account);
  }
  return skips;
}

export const beginExecution = internalMutation({
  args: { actionId: v.id("actions"), resume: v.boolean() },
  returns: vBegin,
  handler: async (ctx, { actionId, resume }): Promise<Infer<typeof vBegin>> => {
    const action = await ctx.db.get(actionId);
    if (!action) return { kind: "refused", reason: "not_found" };
    const block =
      CATALOG[action.type].executor !== "nessie"
        ? `executor:${CATALOG[action.type].executor}`
        : executionBlock(action, { resume, founderApproved: await founderApproved(ctx, action) });
    if (block) {
      await audit(ctx, { actor: "nessie", kind: "execution_refused", ref: action.task, detail: { actionId, type: action.type, status: action.status, gate: action.gate ?? null, reason: block } });
      return { kind: "refused", reason: block };
    }
    const state = await getConfig<NessieState | null>(ctx, STATE_KEY, null);
    let items: ExecItem[];
    try {
      if (!state) throw new PlanError("Nessie is not seeded (run nessie:seedNessie)");
      items = await planItems(ctx, action);
    } catch (err) {
      if (!(err instanceof PlanError || err instanceof FractionalAmountError)) throw err;
      await markFailed(ctx, action, err.message);
      return { kind: "failed", error: err.message };
    }
    // Which items a previous attempt already executed (executed_ref holds their Nessie ids).
    const refs = action.executed_ref ?? [];
    const doneMarkers = new Set<string>();
    for (const id of refs) {
      const row = await ctx.db
        .query("ledger_mirror")
        .withIndex("by_nessie_id", (q) => q.eq("nessie_id", id))
        .unique();
      const marker = row ? markerOf(row.raw as NessieObject) : undefined;
      if (marker) doneMarkers.add(marker);
    }
    const done = items.filter((i) => (i.kind === "transfer" ? doneMarkers.has(i.marker) : refs.includes(i.bill_id))).map((i) => i.marker);

    const conflicts = await refundConflicts(ctx, action, items.filter((i) => !done.includes(i.marker)), state.operating_account_id);
    const skipped = [...conflicts].map(([marker, s]) => ({ marker, ...s }));
    const run = items.filter((i) => !conflicts.has(i.marker));
    if (skipped.length) {
      await audit(ctx, { actor: "nessie", kind: "execution_skipped_items", ref: action.task, detail: { actionId, skipped } });
      await creditSkipped(ctx, action, items, skipped.map((x) => x.marker));
    }
    if (!run.some((i) => !done.includes(i.marker)) && done.length === 0) {
      // Nothing left to pay: not a capability failure, so no ISSUE; the thread says why.
      const error = `nothing to execute: ${skipped.map((s) => s.reason).join("; ")}`;
      await ctx.db.patch(actionId, { status: "failed" });
      await audit(ctx, { actor: "nessie", kind: "execution_failed", ref: action.task, detail: { actionId, type: action.type, error, executed_ref: [] } });
      const task = await ctx.db.get(action.task);
      if (task) {
        await appendMessage(ctx, { room: task.room, task: task._id, sender_kind: "system", sender_name: "Dispatcher", text: `[Dispatcher] ${action.type} ${actionId} was not executed: ${error}.` });
      }
      return { kind: "failed", error };
    }

    await ctx.db.patch(actionId, { status: "executing" });
    await audit(ctx, { actor: "nessie", kind: "execution_started", ref: action.task, detail: { actionId, type: action.type, items: run.length, done: done.length, skipped: skipped.length, resume } });
    return { kind: "ready", operating_account_id: state.operating_account_id, items: run, done, resume, skipped };
  },
});

export const recordExecutedItem = internalMutation({
  args: { actionId: v.id("actions"), marker: v.string(), row: vMirrorRow },
  returns: v.null(),
  handler: async (ctx, { actionId, marker, row }) => {
    const action = await ctx.db.get(actionId);
    if (!action) throw new Error(`action ${actionId} not found`);
    const refs = action.executed_ref ?? [];
    if (!refs.includes(row.nessie_id)) await ctx.db.patch(actionId, { executed_ref: [...refs, row.nessie_id] });
    await upsertRows(ctx, [row]);
    await audit(ctx, { actor: "nessie", kind: "executed_item", ref: action.task, detail: { actionId, marker, nessie_id: row.nessie_id, kind: row.kind, amount_cents: row.amount_cents } });
    return null;
  },
});

const vExecResult = v.object({ status: v.union(v.literal("executed"), v.literal("failed")), executed_ref: v.array(v.string()), error: v.optional(v.string()) });

export const finishExecution = internalMutation({
  args: { actionId: v.id("actions"), skipped: v.optional(v.array(v.string())) },
  returns: vExecResult,
  handler: async (ctx, { actionId, skipped }): Promise<Infer<typeof vExecResult>> => {
    const action = await ctx.db.get(actionId);
    if (!action) throw new Error(`action ${actionId} not found`);
    const refs = action.executed_ref ?? [];
    await ctx.db.patch(actionId, { status: "executed" });
    await audit(ctx, { actor: "nessie", kind: "executed", ref: action.task, detail: { actionId, type: action.type, executed_ref: refs, amount_cents: action.amount_cents ?? null } });
    const task = await ctx.db.get(action.task);
    if (task) {
      const what = action.type === "pay_bill" ? `bill ${refs[0]}` : refs.length === 1 ? `transfer ${refs[0]}` : `${refs.length} transfers`;
      let paid = 0;
      for (const id of refs) {
        const row = await ctx.db
          .query("ledger_mirror")
          .withIndex("by_nessie_id", (q) => q.eq("nessie_id", id))
          .unique();
        paid += row?.amount_cents ?? 0;
      }
      const amount = action.amount_cents === undefined ? "" : paid && paid !== action.amount_cents ? ` ${dollars(paid)} of ${dollars(action.amount_cents)}` : ` ${dollars(action.amount_cents)}`;
      await appendMessage(ctx, {
        room: task.room,
        task: task._id,
        sender_kind: "system",
        sender_name: "Dispatcher",
        text: `[Dispatcher] Executed ${action.type}${amount} in Nessie (${what}).${
          skipped?.length ? ` Skipped ${skipped.length} to avoid a double refund: ${skipped.join("; ")}.` : ""
        }`,
      });
    }
    return { status: "executed", executed_ref: refs };
  },
});

export const failExecution = internalMutation({
  args: { actionId: v.id("actions"), error: v.string() },
  returns: v.null(),
  handler: async (ctx, { actionId, error }) => {
    const action = await ctx.db.get(actionId);
    if (!action) throw new Error(`action ${actionId} not found`);
    await markFailed(ctx, action, error);
    return null;
  },
});

// Executes one gate-allowed (or founder-approved) refund, refund_batch or pay_bill. Scheduled by the gate on
// allow; `resume: true` continues an interrupted or failed run without repeating items already done.
export const executeMoneyAction = internalAction({
  args: { actionId: v.id("actions"), resume: v.optional(v.boolean()) },
  returns: vExecResult,
  handler: async (ctx, { actionId, resume }): Promise<Infer<typeof vExecResult>> => {
    const begin = await ctx.runMutation(internal.nessie.beginExecution, { actionId, resume: resume ?? false });
    if (begin.kind === "refused") throw new Error(`action ${actionId} cannot execute: ${begin.reason}`);
    if (begin.kind === "failed") return { status: "failed", executed_ref: [], error: begin.error };
    const op = begin.operating_account_id;
    try {
      // A crash between a Nessie POST and its record leaves a tagged transfer behind: reuse it.
      const tagged = new Map<string, NessieObject>();
      if (begin.resume) {
        for (const o of await nessieList(`/accounts/${op}/transfers`)) {
          const marker = markerOf(o);
          if (marker) tagged.set(marker, o);
        }
      }
      for (const item of begin.items) {
        if (begin.done.includes(item.marker)) continue;
        let row: MirrorRow;
        if (item.kind === "transfer") {
          const o =
            tagged.get(item.marker) ??
            (await nessieCreate(`/accounts/${op}/transfers`, {
              transaction_date: new Date().toISOString(),
              status: "completed",
              amount: toNessieAmount(item.amount_cents),
              description: `${item.description} ${tag("cf", item.marker)} ${tag("to", item.to_account)}`,
            }));
          row = mirrorFromTransfer(o, op);
          if (!row.counterparty) row.counterparty = readTags(o.description).to ?? item.to_account;
        } else {
          const bill = await nessieGet(`/bills/${item.bill_id}`);
          row = mirrorFromBill(bill.status === "completed" ? bill : await nessieUpdate(`/bills/${item.bill_id}`, { status: "completed" }), op);
        }
        await ctx.runMutation(internal.nessie.recordExecutedItem, { actionId, marker: item.marker, row });
      }
      return await ctx.runMutation(internal.nessie.finishExecution, { actionId, skipped: begin.skipped.map((s) => s.reason) });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(internal.nessie.failExecution, { actionId, error });
      const action: Doc<"actions"> | null = await ctx.runQuery(internal.nessie.getAction, { actionId });
      return { status: "failed", executed_ref: action?.executed_ref ?? [], error };
    }
  },
});

export const getAction = internalQuery({
  args: { actionId: v.id("actions") },
  returns: v.union(v.null(), v.any()),
  handler: async (ctx, { actionId }) => await ctx.db.get(actionId),
});
