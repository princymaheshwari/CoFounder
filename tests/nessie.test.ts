import rateLimiterTest from "@convex-dev/rate-limiter/test";
import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { findDuplicateCharges } from "../convex/lib/co";
import {
  FractionalAmountError,
  cleanRaw,
  executionBlock,
  isoDate,
  markerOf,
  mirrorFromBill,
  mirrorFromPurchase,
  mirrorFromTransfer,
  readTags,
  toNessieAmount,
} from "../convex/lib/nessie";
import type { ActionType } from "../convex/lib/types";
import { FakeNessie } from "./fakes/nessie";
import { laDate } from "../convex/lib/time";
import { HISTORY_DAYS, INCIDENT_DATE, OPERATING, PLAN_CENTS, SEED_ANCHOR, buildSeedPlan } from "../convex/seedData";

const DAY = 24 * 60 * 60 * 1000;

let fake: FakeNessie;
beforeEach(() => {
  fake = new FakeNessie();
  vi.stubEnv("NESSIE_API_KEY", "nessie_test");
  vi.stubGlobal("fetch", vi.fn(fake.fetch));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------- pure helpers

describe("lib/nessie", () => {
  test("amounts are whole dollars both ways", () => {
    expect(toNessieAmount(3500)).toBe(35);
    expect(() => toNessieAmount(3550)).toThrow(FractionalAmountError);
    expect(() => toNessieAmount(0)).toThrow(FractionalAmountError);
    expect(() => toNessieAmount(-100)).toThrow(FractionalAmountError);
  });

  test("tags round-trip through descriptions and nicknames", () => {
    const d = "Lumen Notes refund [cf:act-x-0] [to:acct42]";
    expect(readTags(d)).toEqual({ cf: "act-x-0", to: "acct42" });
    expect(readTags(undefined)).toEqual({});
    expect(markerOf({ nickname: "Ledgerly 2026-11 [cf:bill-ledgerly-2026-11-01]" })).toBe("bill-ledgerly-2026-11-01");
  });

  test("dates normalize to ISO; date-only becomes UTC midnight", () => {
    expect(isoDate("2026-10-22")).toBe("2026-10-22T00:00:00.000Z");
    expect(isoDate("2026-10-22T10:05:00Z")).toBe("2026-10-22T10:05:00.000Z");
  });

  test("mirror rows: transfer counterparty from [to:], purchase from merchant name, bill from payee; raw has no _id", () => {
    const t = mirrorFromTransfer({ id: "t1", amount: 35, transaction_date: "2026-10-22T10:05:00.000Z", description: "x [to:op]" }, "cust");
    expect(t).toMatchObject({ nessie_id: "t1", kind: "transfer", account_id: "cust", counterparty: "op", amount_cents: 3500 });
    const p = mirrorFromPurchase({ _id: "p1", amount: 12, merchant_id: "m1", payer_id: "op", purchase_date: "2026-10-19" }, "op", { m1: "CloudHost" });
    expect(p).toMatchObject({ nessie_id: "p1", counterparty: "CloudHost", amount_cents: 1200 });
    expect(p.raw).not.toHaveProperty("_id");
    expect(p.raw).toHaveProperty("id", "p1");
    const b = mirrorFromBill({ _id: "b1", payee: "Ledgerly Accounting", payment_amount: 400.0, payment_date: "2026-11-01", account_id: "op" }, "op");
    expect(b).toMatchObject({ kind: "bill", counterparty: "Ledgerly Accounting", amount_cents: 40_000, date: "2026-11-01T00:00:00.000Z" });
    expect(cleanRaw({ _id: "x", $weird: 1 })).toEqual({ id: "x", weird: 1 });
  });

  test("executionBlock: only gate-allowed or founder-approved actions execute; resume needs the flag", () => {
    const allow = { effect: "allow" as const };
    const esc = { effect: "escalate" as const };
    const no = { resume: false, founderApproved: false };
    expect(executionBlock({ status: "allowed", gate: allow }, no)).toBeNull();
    expect(executionBlock({ status: "escalated", gate: esc }, no)).toBe("status:escalated");
    expect(executionBlock({ status: "proposed" }, no)).toBe("status:proposed");
    expect(executionBlock({ status: "queued", gate: { effect: "queue" } }, no)).toBe("status:queued");
    expect(executionBlock({ status: "allowed", gate: esc }, no)).toBe("gate:escalate");
    expect(executionBlock({ status: "approved", gate: esc }, no)).toBe("approved_without_decision");
    expect(executionBlock({ status: "approved", gate: esc }, { resume: false, founderApproved: true })).toBeNull();
    expect(executionBlock({ status: "executed", gate: allow }, { resume: true, founderApproved: false })).toBe("status:executed");
    expect(executionBlock({ status: "executing", gate: allow }, no)).toBe("status:executing");
    expect(executionBlock({ status: "failed", gate: allow }, { resume: true, founderApproved: false })).toBeNull();
    expect(executionBlock({ status: "failed", gate: esc }, { resume: true, founderApproved: false })).toBe("gate:escalate");
  });
});

// ---------------------------------------------------------------- seed plan

describe("seedData", () => {
  const plan = buildSeedPlan();

  test("is deterministic", () => {
    expect(buildSeedPlan()).toEqual(plan);
  });

  test("20 customers, signups 5 to 400 days before the anchor, 12 in the incident", () => {
    expect(plan.customers).toHaveLength(20);
    const anchor = Date.parse(`${SEED_ANCHOR}T00:00:00Z`);
    for (const c of plan.customers) {
      const days = Math.round((anchor - Date.parse(`${c.signup_date}T00:00:00Z`)) / DAY);
      expect(days).toBeGreaterThanOrEqual(5);
      expect(days).toBeLessThanOrEqual(400);
    }
    expect(plan.customers.filter((c) => c.incident)).toHaveLength(12);
    expect(new Set(plan.customers.map((c) => c.email)).size).toBe(20);
  });

  test("the only duplicate charges are the 12 planted ones: same day, under 10 minutes apart", () => {
    const transfers = plan.items.filter((i) => i.kind === "transfer");
    const groups = findDuplicateCharges(transfers.map((t) => ({ nessie_id: t.key, account_id: t.from, amount_cents: t.amount_cents, date: t.date })));
    expect(groups).toHaveLength(12);
    const incident = new Set(plan.customers.filter((c) => c.incident).map((c) => c.key));
    for (const g of groups) {
      expect(incident.has(g.account_id)).toBe(true);
      expect(g.charges).toHaveLength(2);
      expect(g.charges[0].date.startsWith(INCIDENT_DATE)).toBe(true);
      expect(Date.parse(g.charges[1].date) - Date.parse(g.charges[0].date)).toBeLessThan(10 * 60_000);
      expect(g.extra_cents).toBe(PLAN_CENTS);
    }
    expect(groups.reduce((n, g) => n + g.extra_cents, 0)).toBe(42_000);
  });

  test("12 weeks of history, whole-dollar amounts, unique keys, 6 tickets from incident customers", () => {
    const start = new Date(Date.parse(`${SEED_ANCHOR}T00:00:00Z`) - HISTORY_DAYS * DAY).toISOString().slice(0, 10);
    for (const i of plan.items) {
      expect(i.amount_cents % 100).toBe(0);
      expect(i.key).toMatch(/^[a-z0-9-]+$/);
      if (i.kind !== "bill") expect(i.date.slice(0, 10) >= start && i.date.slice(0, 10) <= SEED_ANCHOR).toBe(true);
    }
    expect(new Set(plan.items.map((i) => i.key)).size).toBe(plan.items.length);
    expect(plan.items.filter((i) => i.kind === "purchase")).toHaveLength(36);
    expect(plan.items.filter((i) => i.kind === "bill" && i.status === "pending")).toHaveLength(1);
    const incident = new Set(plan.customers.filter((c) => c.incident).map((c) => c.key));
    expect(plan.tickets).toHaveLength(6);
    for (const t of plan.tickets) expect(incident.has(t.customer)).toBe(true);
  });
});

// ---------------------------------------------------------------- Convex functions

// A failed execution raises an ISSUE that wakes the Finance manager (spec 09), so the Dispatcher's components are needed.
function setup() {
  const t = convexTest(schema, import.meta.glob("../convex/**/*.ts"));
  for (const name of ["marketingPool", "customerPool", "financePool", "leadershipPool"]) workpoolTest.register(t, name);
  rateLimiterTest.register(t, "rateLimiter");
  return t;
}
type T = ReturnType<typeof setup>;

async function ledgerTask(t: T, role: Doc<"tasks">["role"] = "ledger"): Promise<Id<"tasks">> {
  await t.mutation(internal.seed.config, {});
  return t.run(async (ctx) => {
    const room = (await ctx.db.query("rooms").withIndex("by_name", (q) => q.eq("name", "#finance")).unique())!;
    const now = Date.now();
    return ctx.db.insert("tasks", {
      role,
      room: room._id,
      kind: "work",
      brief: "Fix the duplicate charges.",
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
  });
}

async function action(
  t: T,
  taskId: Id<"tasks">,
  type: ActionType,
  params: Record<string, unknown>,
  status: Doc<"actions">["status"],
  effect?: "allow" | "escalate",
): Promise<Id<"actions">> {
  return t.run((ctx) =>
    ctx.db.insert("actions", {
      task: taskId,
      chain_id: "chain-1",
      role: "ledger",
      type,
      params,
      rationale: "Duplicate charges on Oct 22.",
      status,
      ...(effect ? { gate: { effect, reason: effect === "allow" ? "rule:allow" : "hard:budget" } } : {}),
      created_at: Date.now(),
    }),
  );
}

const getAction = (t: T, id: Id<"actions">) => t.run(async (ctx) => (await ctx.db.get(id))!);
const auditKinds = (t: T, ref: string) =>
  t.run(async (ctx) => (await ctx.db.query("audit_log").withIndex("by_ref", (q) => q.eq("ref", ref)).collect()).map((a) => a.kind));
const state = (t: T) => t.query(internal.nessie.getState, {});

describe("seedNessie", () => {
  test("seeds Nessie and mirrors everything; a re-run detects Lumen Notes and skips", async () => {
    const t = setup();
    const plan = buildSeedPlan();
    const first = await t.action(internal.nessie.seedNessie, {});
    // 21 customers + 21 accounts + 3 merchants + every ledger item.
    expect(first).toEqual({ skipped: false, created: 45 + plan.items.length, customers: 20, ledger_rows: plan.items.length, tickets: 6 });
    expect(fake.customers.filter((c) => c.first_name === OPERATING.first_name)).toHaveLength(1);

    const counts = await t.run(async (ctx) => ({
      customers: (await ctx.db.query("customers").collect()).length,
      ledger: (await ctx.db.query("ledger_mirror").collect()).length,
      tickets: await ctx.db.query("tickets").collect(),
    }));
    expect(counts.customers).toBe(20);
    expect(counts.ledger).toBe(plan.items.length);
    expect(counts.tickets).toHaveLength(6);
    for (const ticket of counts.tickets) expect(ticket.customer).toBeDefined();

    const posts = fake.posts;
    expect(await t.action(internal.nessie.seedNessie, {})).toMatchObject({ skipped: true, created: 0 });
    expect(fake.posts).toBe(posts);
    expect((await state(t))?.seeded_at).toBeTypeOf("number");
  });

  test("resumes after a failure without creating anything twice", async () => {
    const t = setup();
    const plan = buildSeedPlan();
    fake.failPostAfter = 60;
    await expect(t.action(internal.nessie.seedNessie, {})).rejects.toThrow();
    expect((await state(t))?.seeded_at).toBeUndefined();
    fake.failPostAfter = Infinity;
    expect(await t.action(internal.nessie.seedNessie, {})).toMatchObject({ skipped: false, customers: 20, tickets: 6 });
    expect(fake.customers).toHaveLength(21);
    expect(fake.accounts).toHaveLength(21);
    expect(fake.merchants).toHaveLength(3);
    expect(fake.transfers.length + fake.purchases.length + fake.bills.length).toBe(plan.items.length);
    expect(await t.run(async (ctx) => (await ctx.db.query("ledger_mirror").collect()).length)).toBe(plan.items.length);
    expect(await t.run(async (ctx) => (await ctx.db.query("tickets").collect()).length)).toBe(6);
  });

  test("co data duplicates returns exactly the 12 planted duplicates ($420)", async () => {
    const t = setup();
    await t.action(internal.nessie.seedNessie, {});
    const taskId = await ledgerTask(t);
    const view = await t.query(internal.co.readView, { taskId, role: "ledger", view: "duplicates" });
    expect(view.ok).toBe(true);
    const data = (view as { ok: true; data: { duplicates: { customer_name: string; charges: { date: string }[] }[]; duplicate_charges: number; total_extra_cents: number } }).data;
    expect(data.duplicates).toHaveLength(12);
    expect(data.duplicate_charges).toBe(12);
    expect(data.total_extra_cents).toBe(42_000);
    for (const d of data.duplicates) expect(d.charges[0].date.startsWith(INCIDENT_DATE)).toBe(true);
  });

  test("syncLedger restores missing mirror rows with counterparties from tags", async () => {
    const t = setup();
    await t.action(internal.nessie.seedNessie, {});
    const before = await t.run(async (ctx) => (await ctx.db.query("ledger_mirror").collect()).map(({ nessie_id, counterparty, amount_cents, kind }) => ({ nessie_id, counterparty, amount_cents, kind })));
    await t.run(async (ctx) => {
      for (const r of (await ctx.db.query("ledger_mirror").collect()).slice(0, 10)) await ctx.db.delete(r._id);
    });
    const r = await t.action(internal.nessie.syncLedger, {});
    expect(r).toMatchObject({ skipped: false, inserted: 10, updated: 0 });
    const after = await t.run(async (ctx) => (await ctx.db.query("ledger_mirror").collect()).map(({ nessie_id, counterparty, amount_cents, kind }) => ({ nessie_id, counterparty, amount_cents, kind })));
    const byId = (xs: typeof before) => [...xs].sort((a, b) => a.nessie_id.localeCompare(b.nessie_id));
    expect(byId(after)).toEqual(byId(before));
    expect(await t.action(internal.nessie.syncLedger, {})).toMatchObject({ inserted: 0, updated: 0 });
  });

  test("syncLedger is a no-op before the seed", async () => {
    const t = setup();
    expect(await t.action(internal.nessie.syncLedger, {})).toEqual({ skipped: true, rows: 0, inserted: 0, updated: 0 });
  });
});

describe("executeMoneyAction", () => {
  async function seeded(t: T) {
    await t.action(internal.nessie.seedNessie, {});
    const taskId = await ledgerTask(t);
    const customers = await t.run((ctx) => ctx.db.query("customers").collect());
    const op = (await state(t))!.operating_account_id;
    return { taskId, customers, op };
  }

  test("a gate-allowed $35 refund creates a Nessie transfer; its id is on the action and in ledger_mirror", async () => {
    const t = setup();
    const { taskId, customers, op } = await seeded(t);
    const c = customers[0];
    const id = await action(t, taskId, "refund", { customer_id: c._id, amount_cents: 3500, reason: "billing_error" }, "allowed", "allow");
    const r = await t.action(internal.nessie.executeMoneyAction, { actionId: id });
    expect(r.status).toBe("executed");
    expect(r.executed_ref).toHaveLength(1);

    const transfer = fake.transfersOf(op).find((x) => x._id === r.executed_ref[0])!;
    expect(transfer).toMatchObject({ amount: 35, status: "completed" });
    expect(readTags(transfer.description)).toEqual({ cf: `act-${id}-0`, to: c.nessie_account_id });

    expect(await getAction(t, id)).toMatchObject({ status: "executed", executed_ref: r.executed_ref });
    const row = await t.run((ctx) => ctx.db.query("ledger_mirror").withIndex("by_nessie_id", (q) => q.eq("nessie_id", r.executed_ref[0])).unique());
    expect(row).toMatchObject({ kind: "transfer", account_id: op, counterparty: c.nessie_account_id, amount_cents: 3500 });
    expect(await auditKinds(t, taskId)).toEqual(["execution_started", "executed_item", "executed"]);
    const msgs = await t.run((ctx) => ctx.db.query("messages").withIndex("by_task", (q) => q.eq("task", taskId)).collect());
    expect(msgs.at(-1)?.text).toContain(`[Dispatcher] Executed refund`);

    // The customer view now shows the refund as a credit.
    const view = await t.query(internal.co.readView, { taskId, role: "ledger", view: "customer", id: c._id });
    const ledger = (view as { ok: true; data: { ledger: { nessie_id: string; direction: string }[] } }).data.ledger;
    expect(ledger.find((l) => l.nessie_id === r.executed_ref[0])?.direction).toBe("credit");
  });

  test("an escalated (undecided) action throws and audits; nothing is sent to Nessie", async () => {
    const t = setup();
    const { taskId, customers } = await seeded(t);
    const id = await action(t, taskId, "refund", { customer_id: customers[0]._id, amount_cents: 48_000 }, "escalated", "escalate");
    const posts = fake.posts;
    await expect(t.action(internal.nessie.executeMoneyAction, { actionId: id })).rejects.toThrow(/cannot execute: status:escalated/);
    expect(fake.posts).toBe(posts);
    expect(await getAction(t, id)).toMatchObject({ status: "escalated" });
    const audits = await t.run(async (ctx) => (await ctx.db.query("audit_log").withIndex("by_ref", (q) => q.eq("ref", taskId)).collect()));
    expect(audits.map((a) => a.kind)).toEqual(["execution_refused"]);
    expect(audits[0].detail).toMatchObject({ actionId: id, reason: "status:escalated" });
  });

  test("a second run of an executed action is refused (no double refund)", async () => {
    const t = setup();
    const { taskId, customers } = await seeded(t);
    const id = await action(t, taskId, "refund", { customer_id: customers[0]._id, amount_cents: 3500 }, "allowed", "allow");
    await t.action(internal.nessie.executeMoneyAction, { actionId: id });
    await expect(t.action(internal.nessie.executeMoneyAction, { actionId: id })).rejects.toThrow(/status:executed/);
    await expect(t.action(internal.nessie.executeMoneyAction, { actionId: id, resume: true })).rejects.toThrow(/status:executed/);
  });

  test("a founder-approved escalated action executes", async () => {
    const t = setup();
    const { taskId, customers } = await seeded(t);
    const id = await action(t, taskId, "refund", { customer_id: customers[1]._id, amount_cents: 3500 }, "approved", "escalate");
    await expect(t.action(internal.nessie.executeMoneyAction, { actionId: id })).rejects.toThrow(/approved_without_decision/);
    await t.run((ctx) =>
      ctx.db.insert("decisions", { subject_kind: "action", action: id, action_type: "refund", choice: "approve", features: {}, decided_by: "founder", created_at: Date.now() }),
    );
    expect(await t.action(internal.nessie.executeMoneyAction, { actionId: id })).toMatchObject({ status: "executed" });
  });

  test("refund_batch: a failure part-way marks failed and raises a capability ISSUE; resume finishes without repeats", async () => {
    const t = setup();
    const { taskId, customers, op } = await seeded(t);
    const items = customers.slice(0, 3).map((c) => ({ customer_id: c._id, amount_cents: 3500 }));
    const id = await action(t, taskId, "refund_batch", { items, reason: "billing_error" }, "allowed", "allow");
    const before = fake.transfersOf(op).length;

    fake.failPostAfter = fake.posts + 2; // the second transfer fails
    const r1 = await t.action(internal.nessie.executeMoneyAction, { actionId: id });
    expect(r1).toMatchObject({ status: "failed" });
    expect(r1.executed_ref).toHaveLength(1);
    expect(await getAction(t, id)).toMatchObject({ status: "failed" });
    const [issue] = await t.run((ctx) => ctx.db.query("issues").withIndex("by_task", (q) => q.eq("task", taskId)).collect());
    expect(issue).toMatchObject({ kind: "capability", to_role: "finance_manager", status: "escalated", level: "manager" });

    // Without resume a failed action is refused.
    fake.failPostAfter = Infinity;
    await expect(t.action(internal.nessie.executeMoneyAction, { actionId: id })).rejects.toThrow(/status:failed/);

    const r2 = await t.action(internal.nessie.executeMoneyAction, { actionId: id, resume: true });
    expect(r2.status).toBe("executed");
    expect(r2.executed_ref).toHaveLength(3);
    expect(new Set(r2.executed_ref).size).toBe(3);
    expect(fake.transfersOf(op).length - before).toBe(3);
  });

  test("resume reuses a transfer that was created but never recorded (crash after POST)", async () => {
    const t = setup();
    const { taskId, customers, op } = await seeded(t);
    const c = customers[2];
    const id = await action(t, taskId, "refund", { customer_id: c._id, amount_cents: 3500 }, "executing", "allow");
    fake.transfers.push({ _id: "orphan1", _payer: op, amount: 35, status: "completed", transaction_date: "2026-10-24T12:00:00.000Z", description: `x [cf:act-${id}-0] [to:${c.nessie_account_id}]` });
    const posts = fake.posts;
    const r = await t.action(internal.nessie.executeMoneyAction, { actionId: id, resume: true });
    expect(r).toMatchObject({ status: "executed", executed_ref: ["orphan1"] });
    expect(fake.posts).toBe(posts);
  });

  test("a fractional amount fails before Nessie (whole dollars only) and raises an ISSUE", async () => {
    const t = setup();
    const { taskId, customers } = await seeded(t);
    const id = await action(t, taskId, "refund", { customer_id: customers[0]._id, amount_cents: 3550 }, "allowed", "allow");
    const posts = fake.posts;
    const r = await t.action(internal.nessie.executeMoneyAction, { actionId: id });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/whole dollars/);
    expect(fake.posts).toBe(posts);
    expect(await t.run((ctx) => ctx.db.query("issues").collect())).toHaveLength(1);
  });

  test("an unknown customer fails with an ISSUE", async () => {
    const t = setup();
    const { taskId } = await seeded(t);
    const id = await action(t, taskId, "refund", { customer_id: "nobody", amount_cents: 3500 }, "allowed", "allow");
    expect(await t.action(internal.nessie.executeMoneyAction, { actionId: id })).toMatchObject({ status: "failed", error: "unknown customer nobody" });
  });

  test("pay_bill pays the matching pending bill", async () => {
    const t = setup();
    const { taskId } = await seeded(t);
    const id = await action(t, taskId, "pay_bill", { merchant: "Ledgerly Accounting", amount_cents: 40_000, due_date: "2026-11-01" }, "allowed", "allow");
    const r = await t.action(internal.nessie.executeMoneyAction, { actionId: id });
    expect(r.status).toBe("executed");
    const bill = fake.bills.find((b) => b._id === r.executed_ref[0])!;
    expect(bill.status).toBe("completed");
    const row = await t.run((ctx) => ctx.db.query("ledger_mirror").withIndex("by_nessie_id", (q) => q.eq("nessie_id", r.executed_ref[0])).unique());
    expect((row!.raw as { status: string }).status).toBe("completed");

    // Nothing pending is left to pay.
    const again = await action(t, taskId, "pay_bill", { merchant: "Ledgerly Accounting", amount_cents: 40_000 }, "allowed", "allow");
    expect(await t.action(internal.nessie.executeMoneyAction, { actionId: again })).toMatchObject({ status: "failed" });
  });

  test("double-refund guard: a customer refunded in the last 30 days is not refunded again", async () => {
    const t = setup();
    const { taskId, customers } = await seeded(t);
    const c = customers[3];
    const first = await action(t, taskId, "refund", { customer_id: c._id, amount_cents: 3500 }, "allowed", "allow");
    expect(await t.action(internal.nessie.executeMoneyAction, { actionId: first })).toMatchObject({ status: "executed" });

    const again = await action(t, taskId, "refund", { customer_id: c._id, amount_cents: 3500 }, "allowed", "allow");
    const posts = fake.posts;
    const r = await t.action(internal.nessie.executeMoneyAction, { actionId: again });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/^nothing to execute: already refunded \$35\.00 on \d{4}-\d{2}-\d{2}/);
    expect(fake.posts).toBe(posts);
    // Not a capability failure: no ISSUE, but the thread says why.
    expect(await t.run((ctx) => ctx.db.query("issues").collect())).toHaveLength(0);
    const msgs = await t.run((ctx) => ctx.db.query("messages").withIndex("by_task", (q) => q.eq("task", taskId)).collect());
    expect(msgs.at(-1)!.text).toContain("was not executed: nothing to execute: already refunded");
  });

  test("double-refund guard: a batch skips already-refunded, repeated and in-flight customers and pays the rest", async () => {
    const t = setup();
    const { taskId, customers, op } = await seeded(t);
    const [a, b, c, d] = customers;
    await t.action(internal.nessie.executeMoneyAction, { actionId: await action(t, taskId, "refund", { customer_id: a._id, amount_cents: 3500 }, "allowed", "allow") });
    // Another action is mid-execution for d.
    await action(t, taskId, "refund", { customer_id: d._id, amount_cents: 3500 }, "executing", "allow");

    const items = [a, b, b, c, d].map((x) => ({ customer_id: x._id, amount_cents: 3500 }));
    const batch = await action(t, taskId, "refund_batch", { items, reason: "billing_error" }, "allowed", "allow");
    await t.run(async (ctx) => {
      await ctx.db.patch(batch, { amount_cents: 17_500 });
      await ctx.db.insert("budgets", { scope: "company:refund", period: laDate(Date.now()), limit_cents: 30_000, spent_cents: 17_500 });
    });
    const before = fake.transfersOf(op).length;
    const r = await t.action(internal.nessie.executeMoneyAction, { actionId: batch });
    expect(r.status).toBe("executed");
    expect(r.executed_ref).toHaveLength(2); // b once, c
    expect(fake.transfersOf(op).length - before).toBe(2);
    const paid = fake.transfersOf(op).slice(-2).map((x) => readTags(x.description).to);
    expect(paid).toEqual([b.nessie_account_id, c.nessie_account_id]);

    const audits = await t.run(async (ctx) => (await ctx.db.query("audit_log").withIndex("by_ref", (q) => q.eq("ref", taskId)).collect()).filter((x) => x.kind === "execution_skipped_items"));
    const reasons = (audits.at(-1)!.detail as { skipped: { reason: string }[] }).skipped.map((s) => s.reason);
    expect(reasons).toHaveLength(3);
    expect(reasons[0]).toMatch(/^already refunded/);
    expect(reasons[1]).toBe("listed twice in this batch");
    expect(reasons[2]).toMatch(/^a refund is in flight in action /);
    const msgs = await t.run((ctx) => ctx.db.query("messages").withIndex("by_task", (q) => q.eq("task", taskId)).collect());
    expect(msgs.at(-1)!.text).toContain("Executed refund_batch $70.00 of $175.00 in Nessie (2 transfers). Skipped 3 to avoid a double refund");
    // The 3 skipped items ($105) go back to today's budget, once.
    const budget = await t.run((ctx) => ctx.db.query("budgets").withIndex("by_scope_period", (q) => q.eq("scope", "company:refund").eq("period", laDate(Date.now()))).unique());
    expect(budget!.spent_cents).toBe(7_000);
  });

  test("non-Nessie actions are refused", async () => {
    const t = setup();
    const { taskId } = await seeded(t);
    const id = await action(t, taskId, "file_bug", { title: "x" }, "allowed", "allow");
    await expect(t.action(internal.nessie.executeMoneyAction, { actionId: id })).rejects.toThrow(/executor:executor/);
  });

  test("the gate schedules Nessie execution on allow (and only then)", async () => {
    const t = setup();
    const { taskId, customers } = await seeded(t);
    const labels = { refund_reason: { value: "billing_error", confidence: 0.95 } };
    const loyal = customers.find((c) => Date.now() - c.signup_at > 120 * DAY)!;
    const mk = (amount: number) =>
      t.run((ctx) =>
        ctx.db.insert("actions", {
          task: taskId,
          chain_id: "chain-1",
          role: "support",
          type: "refund",
          params: { customer_id: loyal._id, amount_cents: amount, reason: "billing_error" },
          rationale: "Double charge.",
          labels,
          status: "proposed",
          created_at: Date.now(),
        }),
      );
    const allowed = await mk(3500);
    const escalated = await mk(48_000);
    expect(await t.mutation(internal.gate.evaluateGate, { actionId: allowed })).toMatchObject({ effect: "allow" });
    expect(await t.mutation(internal.gate.evaluateGate, { actionId: escalated })).toMatchObject({ effect: "escalate" });
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const exec = scheduled.filter((s) => s.name.includes("executeMoneyAction"));
    expect(exec.map((s) => s.args[0])).toEqual([{ actionId: allowed }]);
  });
});
