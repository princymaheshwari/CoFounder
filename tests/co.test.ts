import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";
import {
  CO_VIEWS,
  canRead,
  clampLimit,
  findDuplicateCharges,
  maskEmail,
  maskEmails,
  type CoView,
} from "../convex/lib/co";
import { laDate } from "../convex/lib/time";
import { TOKEN_TTL_MS, hashToken, signTaskToken } from "../convex/lib/tokens";
import { ROLES, type Role, type TaskStatus } from "../convex/lib/types";

const modules = import.meta.glob("../convex/**/*.ts");
const SECRET = "test-secret";
const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t, "rateLimiter");
  return t;
}
type T = ReturnType<typeof setup>;

beforeEach(() => vi.stubEnv("CO_TOKEN_SECRET", SECRET));
afterEach(() => vi.unstubAllEnvs());

async function room(t: T, name = "#customer"): Promise<Id<"rooms">> {
  return t.run((ctx) => ctx.db.insert("rooms", { name, department: "customer", next_seq: 0 }));
}

async function taskFor(
  t: T,
  role: Role,
  opts: { status?: TaskStatus; exp?: number; roomId?: Id<"rooms">; secret?: string } = {},
): Promise<{ taskId: Id<"tasks">; token: string }> {
  const now = Date.now();
  const roomId = opts.roomId ?? (await room(t));
  const taskId = await t.run((ctx) =>
    ctx.db.insert("tasks", {
      role,
      room: roomId,
      kind: "work",
      brief: "brief",
      chain_id: "chain-1",
      hop: 0,
      attempt: 1,
      status: opts.status ?? "assigned",
      origin_refs: [],
      deadline: now + DAY,
      mode: "live",
      created_at: now,
      updated_at: now,
    }),
  );
  const token = await signTaskToken(opts.secret ?? SECRET, { task: taskId, role, exp: opts.exp ?? now + TOKEN_TTL_MS });
  const tokenHash = await hashToken(token);
  await t.run((ctx) => ctx.db.patch(taskId, { token_hash: tokenHash }));
  return { taskId, token };
}

async function get(t: T, path: string, token?: string) {
  const res = await t.fetch(path, { method: "GET", headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const coAudits = (t: T) =>
  t.run(async (ctx) => (await ctx.db.query("audit_log").collect()).filter((r) => r.kind === "co_read"));

async function customer(t: T, name: string, email: string, account: string, signupDaysAgo = 100) {
  return t.run((ctx) =>
    ctx.db.insert("customers", {
      name,
      email,
      nessie_customer_id: `c-${account}`,
      nessie_account_id: account,
      signup_at: Date.now() - signupDaysAgo * DAY,
      plan: "Pro",
    }),
  );
}

async function ledger(t: T, rows: { id: string; kind?: "transfer" | "purchase"; from: string; to: string; cents?: number; date: string }[]) {
  await t.run(async (ctx) => {
    for (const r of rows) {
      await ctx.db.insert("ledger_mirror", {
        nessie_id: r.id,
        kind: r.kind ?? "transfer",
        account_id: r.from,
        counterparty: r.to,
        amount_cents: r.cents ?? 3500,
        date: r.date,
        raw: {},
      });
    }
  });
}

// ---------------------------------------------------------------- pure helpers

describe("lib/co", () => {
  // The spec 06 access table, written out independently of VIEW_ACCESS.
  const managers: Role[] = ["marketing_manager", "customer_manager", "finance_manager"];
  const expected: Record<CoView, Role[] | "all"> = {
    ticket: ["support", "customer_manager"],
    tickets: ["support", "customer_manager", "retention"],
    customer: ["support", "retention", "ledger", "customer_manager"],
    ledger: ["ledger", "spend", "finance_manager", "cofounder"],
    duplicates: ["ledger", "finance_manager"],
    signals: ["market_intel", "spend", "retention", "cofounder", ...managers],
    budget: [...managers, "cofounder", "spend"],
    usage: ["spend", "finance_manager"],
    thread: [...managers, "cofounder"],
    rules: "all",
    company: "all",
  };
  test.each(CO_VIEWS.map((v) => [v]))("role access for %s matches the spec table", (view) => {
    const allowed = expected[view];
    for (const role of ROLES) expect(canRead(role, view), `${role} → ${view}`).toBe(allowed === "all" || allowed.includes(role));
  });

  test("maskEmail keeps the first letter and the domain", () => {
    expect(maskEmail("jane.doe@example.com")).toBe("j***@example.com");
    expect(maskEmail("not-an-email")).toBe("not-an-email");
  });

  test("maskEmails walks nested values and keeps listed addresses", () => {
    const out = maskEmails(
      { a: "mail bob@x.io and Ann@Y.com", list: [{ e: "ann@y.com" }], n: 3, nil: null },
      ["ann@y.com"],
    );
    expect(out).toEqual({ a: "mail b***@x.io and Ann@Y.com", list: [{ e: "ann@y.com" }], n: 3, nil: null });
  });

  test("clampLimit uses the default and clamps into [1, max]", () => {
    const b = { def: 50, max: 200 };
    expect(clampLimit(undefined, b)).toBe(50);
    expect(clampLimit(Number.NaN, b)).toBe(50);
    expect(clampLimit(0, b)).toBe(1);
    expect(clampLimit(999, b)).toBe(200);
    expect(clampLimit(7.9, b)).toBe(7);
  });

  test("findDuplicateCharges groups same account and amount within 24 h", () => {
    const c = (nessie_id: string, account_id: string, date: string, amount_cents = 3500) => ({ nessie_id, account_id, amount_cents, date });
    const groups = findDuplicateCharges([
      c("a1", "A", "2026-10-22T10:00:00Z"),
      c("a2", "A", "2026-10-22T10:08:00Z"),
      c("a3", "A", "2026-09-22T10:00:00Z"), // a month earlier: not a duplicate
      c("b1", "B", "2026-10-22T10:00:00Z"),
      c("b2", "B", "2026-10-22T11:00:00Z", 1200), // different amount
      c("d1", "D", "2026-10-22"),
      c("d2", "D", "2026-10-22"), // date-only Nessie dates
      c("d3", "D", "2026-10-24"), // 48 h later: separate
    ]);
    expect(groups.map((g) => [g.account_id, g.charges.map((x) => x.nessie_id), g.extra_cents])).toEqual([
      ["D", ["d1", "d2"], 3500],
      ["A", ["a1", "a2"], 3500],
    ]);
  });

  test("laDate is the America/Los_Angeles calendar day", () => {
    expect(laDate(Date.parse("2026-10-24T06:59:00Z"))).toBe("2026-10-23");
    expect(laDate(Date.parse("2026-10-24T07:01:00Z"))).toBe("2026-10-24");
  });
});

// ---------------------------------------------------------------- auth

describe("co HTTP auth", () => {
  test("no token → 401 and an audit row", async () => {
    const t = setup();
    const res = await get(t, "/co/data?view=company");
    expect(res).toEqual({ status: 401, body: { error: "unauthorized: missing_token" } });
    const audits = await coAudits(t);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor: "co", ref: "co", detail: { status: 401, error: "missing_token" } });
  });

  test("expired token → 401", async () => {
    const t = setup();
    const { token } = await taskFor(t, "support", { exp: Date.now() - 1 });
    expect(await get(t, "/co/data?view=company", token)).toEqual({ status: 401, body: { error: "unauthorized: expired" } });
  });

  test("closed task → 401", async () => {
    const t = setup();
    for (const status of ["done", "failed", "cancelled"] as const) {
      const { token } = await taskFor(t, "support", { status });
      expect(await get(t, "/co/data?view=company", token)).toEqual({ status: 401, body: { error: "unauthorized: closed" } });
    }
  });

  test("bad signature, garbage, and a superseded token → 401", async () => {
    const t = setup();
    const forged = await taskFor(t, "support", { secret: "other-secret" });
    expect((await get(t, "/co/data?view=company", forged.token)).body.error).toBe("unauthorized: bad_signature");
    expect((await get(t, "/co/data?view=company", "garbage")).body.error).toBe("unauthorized: malformed");
    const { taskId, token } = await taskFor(t, "support");
    await t.run((ctx) => ctx.db.patch(taskId, { token_hash: "rotated" }));
    expect((await get(t, "/co/data?view=company", token)).body.error).toBe("unauthorized: revoked");
  });

  test("the token is never written to the audit log", async () => {
    const t = setup();
    const { token } = await taskFor(t, "support");
    await get(t, "/co/data?view=company", token);
    await get(t, "/co/data?view=company", `${token}x`);
    expect(JSON.stringify(await coAudits(t))).not.toContain(token.split(".")[1]);
  });
});

// ---------------------------------------------------------------- role access and validation

describe("co HTTP role access", () => {
  test("Support cannot read ledger → 403, audited", async () => {
    const t = setup();
    const { taskId, token } = await taskFor(t, "support");
    expect(await get(t, "/co/data?view=ledger", token)).toEqual({
      status: 403,
      body: { error: "role support cannot read ledger" },
    });
    const audits = await coAudits(t);
    expect(audits[0]).toMatchObject({ actor: "support", ref: taskId, detail: { path: "/co/data", view: "ledger", status: 403 } });
  });

  test("unknown view, missing id, unknown id, unknown action type", async () => {
    const t = setup();
    const { token } = await taskFor(t, "support");
    expect(await get(t, "/co/data?view=secrets", token)).toEqual({ status: 400, body: { error: 'unknown view "secrets"' } });
    expect(await get(t, "/co/data?view=ticket", token)).toEqual({ status: 400, body: { error: "view ticket needs --id" } });
    expect((await get(t, "/co/data?view=ticket&id=nope", token)).status).toBe(404);
    expect(await get(t, "/co/history?action_type=launch_rocket", token)).toEqual({
      status: 400,
      body: { error: 'unknown action_type "launch_rocket"' },
    });
  });

  test("60 calls per task, then 429", async () => {
    const t = setup();
    await t.run((ctx) => ctx.db.insert("rules", ruleRow("company", {})));
    const { token } = await taskFor(t, "support");
    for (let i = 0; i < 60; i++) expect((await get(t, "/co/data?view=rules", token)).status).toBe(200);
    const res = await get(t, "/co/data?view=rules", token);
    expect(res.status).toBe(429);
    // A different task has its own budget.
    const other = await taskFor(t, "support");
    expect((await get(t, "/co/data?view=rules", other.token)).status).toBe(200);
  });
});

// ---------------------------------------------------------------- views

function ruleRow(level: "company" | "department" | "role", scope: { department?: "customer" | "finance"; role?: Role }, status: "active" | "proposed" = "active") {
  return {
    scope: { level, ...scope },
    action_type: "refund" as const,
    conditions: [{ field: "amount_cents", op: "<=" as const, value: 5000 }],
    effect: "allow" as const,
    status,
    version: 1,
    supporting_decisions: [],
    agreement: { agree: 5, total: 5 },
    text: `${level} ${scope.department ?? scope.role ?? ""}`.trim(),
    created_at: Date.now(),
  };
}

describe("co data views", () => {
  test("ticket --id: ticket + customer summary; own email in full, others masked", async () => {
    const t = setup();
    const cust = await customer(t, "Ann Lee", "ann.lee@example.com", "acct-ann", 40);
    const ticketId = await t.run((ctx) =>
      ctx.db.insert("tickets", {
        customer: cust,
        from_email: "ann.lee@example.com",
        subject: "Double charge",
        body: "I was charged twice. My colleague bob.smith@example.com too.",
        amount_cents: 3500,
        status: "open",
        source: "seed",
        created_at: Date.now(),
      }),
    );
    const { taskId, token } = await taskFor(t, "support");
    const res = await get(t, `/co/data?view=ticket&id=${ticketId}`, token);
    expect(res.status).toBe(200);
    expect(res.body.ticket).toMatchObject({ id: ticketId, from_email: "ann.lee@example.com", amount_cents: 3500 });
    expect(res.body.ticket.body).toContain("b***@example.com");
    expect(res.body.ticket.body).not.toContain("bob.smith");
    expect(res.body.customer).toMatchObject({ id: cust, name: "Ann Lee", plan: "Pro", tenure_days: 40, email: "ann.lee@example.com" });
    const audits = await coAudits(t);
    expect(audits[0]).toMatchObject({ actor: "support", kind: "co_read", ref: taskId, detail: { view: "ticket", id: ticketId, status: 200 } });
  });

  test("tickets: open only, newest first, every email masked", async () => {
    const t = setup();
    await t.run(async (ctx) => {
      for (const [i, status] of (["open", "handled", "open"] as const).entries()) {
        await ctx.db.insert("tickets", {
          from_email: `user${i}@example.com`,
          subject: `s${i}`,
          body: "b",
          status,
          source: "seed",
          created_at: i,
        });
      }
    });
    const { token } = await taskFor(t, "retention");
    const res = await get(t, "/co/data?view=tickets", token);
    expect(res.body.tickets.map((x: { subject: string }) => x.subject)).toEqual(["s2", "s0"]);
    expect(res.body.tickets[0].from_email).toBe("u***@example.com");
  });

  test("customer --id: tenure, plan and the last 10 ledger rows both directions", async () => {
    const t = setup();
    const cust = await customer(t, "Ann", "ann@example.com", "acct-ann", 12);
    const rows = Array.from({ length: 12 }, (_, i) => ({
      id: `chg-${i}`,
      from: "acct-ann",
      to: "acct-op",
      date: `2026-10-${String(i + 1).padStart(2, "0")}`,
    }));
    await ledger(t, [...rows, { id: "refund-1", from: "acct-op", to: "acct-ann", date: "2026-10-20" }, { id: "other", from: "acct-zed", to: "acct-op", date: "2026-10-21" }]);
    const { token } = await taskFor(t, "ledger");
    const res = await get(t, `/co/data?view=customer&id=${cust}`, token);
    expect(res.body.customer).toMatchObject({ tenure_days: 12, plan: "Pro", email: "ann@example.com" });
    expect(res.body.ledger).toHaveLength(10);
    expect(res.body.ledger[0]).toMatchObject({ nessie_id: "refund-1", direction: "credit" });
    expect(res.body.ledger[1]).toMatchObject({ nessie_id: "chg-11", direction: "debit" });
    expect(res.body.ledger.map((r: { nessie_id: string }) => r.nessie_id)).not.toContain("other");
  });

  test("ledger: newest first, --since and --limit", async () => {
    const t = setup();
    await ledger(t, [
      { id: "l1", from: "a", to: "b", date: "2026-10-01" },
      { id: "l2", from: "a", to: "b", date: "2026-10-10" },
      { id: "l3", from: "a", to: "b", date: "2026-10-20" },
    ]);
    const { token } = await taskFor(t, "finance_manager");
    const ids = async (q: string) => (await get(t, `/co/data?view=ledger${q}`, token)).body.ledger.map((r: { nessie_id: string }) => r.nessie_id);
    expect(await ids("")).toEqual(["l3", "l2", "l1"]);
    expect(await ids("&since=2026-10-05")).toEqual(["l3", "l2"]);
    expect(await ids("&limit=1")).toEqual(["l3"]);
    expect((await get(t, "/co/data?view=ledger&since=yesterday", token)).status).toBe(400);
  });

  test("duplicates: customer charges with the same amount ≤ 24 h apart", async () => {
    const t = setup();
    const ann = await customer(t, "Ann", "ann@example.com", "acct-ann");
    await customer(t, "Bo", "bo@example.com", "acct-bo");
    await ledger(t, [
      { id: "ann-sep", from: "acct-ann", to: "acct-op", date: "2026-09-22" },
      { id: "ann-1", from: "acct-ann", to: "acct-op", date: "2026-10-22" },
      { id: "ann-2", from: "acct-ann", to: "acct-op", date: "2026-10-22" },
      { id: "bo-1", from: "acct-bo", to: "acct-op", date: "2026-10-22" },
      { id: "refund-bo", from: "acct-op", to: "acct-bo", date: "2026-10-22" }, // refund, not a charge
      { id: "op-buy-1", kind: "purchase", from: "acct-op", to: "CloudHost", date: "2026-10-22" },
      { id: "op-buy-2", kind: "purchase", from: "acct-op", to: "CloudHost", date: "2026-10-22" },
    ]);
    const { token } = await taskFor(t, "ledger");
    const res = await get(t, "/co/data?view=duplicates", token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ duplicate_charges: 1, total_extra_cents: 3500 });
    expect(res.body.duplicates).toEqual([
      {
        customer_id: ann,
        customer_name: "Ann",
        account_id: "acct-ann",
        amount_cents: 3500,
        extra_cents: 3500,
        charges: [
          { nessie_id: "ann-1", date: "2026-10-22" },
          { nessie_id: "ann-2", date: "2026-10-22" },
        ],
      },
    ]);
  });

  test("signals: only the caller's channel, newest first, no embeddings", async () => {
    const t = setup();
    const marketing = await room(t, "#marketing");
    const finance = await room(t, "#finance");
    await t.run(async (ctx) => {
      const base = { source: "apify", url: "https://x.test", significance: 0.8, evidence_url: "https://x.test/e", consumed: false, embedding: [0.1] };
      await ctx.db.insert("signals", { ...base, room: marketing, change: "old", created_at: 1 });
      await ctx.db.insert("signals", { ...base, room: marketing, change: "new", created_at: 2 });
      await ctx.db.insert("signals", { ...base, room: finance, change: "vendor", created_at: 3 });
    });
    const { token } = await taskFor(t, "market_intel", { roomId: marketing });
    const res = await get(t, "/co/data?view=signals", token);
    expect(res.body.signals.map((s: { change: string }) => s.change)).toEqual(["new", "old"]);
    expect(res.body.signals[0]).not.toHaveProperty("embedding");
  });

  test("budget: today's LA period only", async () => {
    const t = setup();
    const today = laDate(Date.now());
    await t.run(async (ctx) => {
      await ctx.db.insert("budgets", { scope: "company:refund", period: today, limit_cents: 10000, spent_cents: 3500 });
      await ctx.db.insert("budgets", { scope: "company:refund", period: "2020-01-01", limit_cents: 1, spent_cents: 1 });
    });
    const { token } = await taskFor(t, "spend");
    expect((await get(t, "/co/data?view=budget", token)).body).toEqual({
      period: today,
      budgets: [{ scope: "company:refund", limit_cents: 10000, spent_cents: 3500, remaining_cents: 6500 }],
    });
  });

  test("usage: run counts per role and LA day over the last 7 days", async () => {
    const t = setup();
    const now = Date.now();
    await t.run(async (ctx) => {
      const run = (role: Role, status: "completed" | "failed", started_at: number, n: number) =>
        ctx.db.insert("runs", { purpose: "assign", role, creao_run_id: `r${n}`, idempotency_key: `k${n}`, status, delivery_ids: [], started_at });
      await run("support", "completed", now - 1000, 1);
      await run("support", "failed", now - 2000, 2);
      await run("ledger", "completed", now - 3000, 3);
      await run("support", "completed", now - 30 * DAY, 4); // too old
    });
    const { token } = await taskFor(t, "spend");
    const res = await get(t, "/co/data?view=usage", token);
    const day = laDate(now);
    expect(res.body.usage).toEqual(
      expect.arrayContaining([
        { day, role: "support", runs: 2, completed: 1, failed: 1 },
        { day, role: "ledger", runs: 1, completed: 1, failed: 0 },
      ]),
    );
    expect(res.body.usage.reduce((n: number, r: { runs: number }) => n + r.runs, 0)).toBe(3);
  });

  test("thread --id: messages oldest first, emails masked", async () => {
    const t = setup();
    const { taskId: workTask } = await taskFor(t, "support");
    await t.run(async (ctx) => {
      const task = (await ctx.db.get(workTask))!;
      for (const [seq, text] of ["[Dispatcher] ASSIGN", "Support: refunded jane@example.com"].entries()) {
        await ctx.db.insert("messages", { room: task.room, seq, task: workTask, sender_kind: "agent", sender_name: "Support", text, created_at: seq });
      }
    });
    const { token } = await taskFor(t, "customer_manager");
    const res = await get(t, `/co/data?view=thread&id=${workTask}`, token);
    expect(res.body.task).toMatchObject({ id: workTask, role: "support" });
    expect(res.body.messages.map((m: { text: string }) => m.text)).toEqual(["[Dispatcher] ASSIGN", "Support: refunded j***@example.com"]);
  });

  test("rules: active rules in the caller's scope only", async () => {
    const t = setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("agents", {
        role: "support",
        department: "customer",
        kind: "role",
        creao_app_id: "app",
        input_field: "message",
        display_name: "Support",
        rooms: ["#customer"],
        enabled: true,
      });
      await ctx.db.insert("rules", ruleRow("company", {}));
      await ctx.db.insert("rules", ruleRow("department", { department: "customer" }));
      await ctx.db.insert("rules", ruleRow("department", { department: "finance" }));
      await ctx.db.insert("rules", ruleRow("role", { role: "support" }));
      await ctx.db.insert("rules", ruleRow("role", { role: "ledger" }));
      await ctx.db.insert("rules", ruleRow("company", {}, "proposed"));
    });
    const { token } = await taskFor(t, "support");
    const res = await get(t, "/co/data?view=rules", token);
    expect(res.body.rules.map((r: { text: string }) => r.text).sort()).toEqual(["company", "department customer", "role support"]);
  });

  test("company: full profile for any role", async () => {
    const t = setup();
    await t.run((ctx) =>
      ctx.db.insert("company", {
        name: "Lumen Notes",
        product: "AI meeting notes",
        description: "d",
        plans: [{ name: "Pro", price_cents: 3500, period: "month" }],
        customer_type: "teams",
        voice: "warm",
        policies: ["refunds within 30 days"],
        competitors: [],
        vendors: [],
        review_urls: [],
        communities: [],
        updated_at: 1,
      }),
    );
    const { token } = await taskFor(t, "content");
    const res = await get(t, "/co/data?view=company", token);
    expect(res.status).toBe(200);
    expect(res.body.company).toMatchObject({ name: "Lumen Notes", policies: ["refunds within 30 days"] });
    expect(res.body.company).not.toHaveProperty("_id");
  });
});

// ---------------------------------------------------------------- history and radar

describe("co history and radar", () => {
  test("history: founder decisions for the type, newest first, with params and labels", async () => {
    const t = setup();
    const { taskId, token } = await taskFor(t, "support");
    await t.run(async (ctx) => {
      const action = (params: unknown, amount: number) =>
        ctx.db.insert("actions", {
          task: taskId,
          chain_id: "chain-1",
          role: "support",
          type: "refund",
          params,
          rationale: "r",
          amount_cents: amount,
          labels: { severity: { value: "low", confidence: 0.9 } },
          status: "approved",
          created_at: 1,
        });
      const a1 = await action({ to: "ann@example.com" }, 3500);
      const a2 = await action({ customer_id: "c2" }, 9900);
      const decision = (actionId: Id<"actions">, choice: "approve" | "deny", decided_by: "founder" | "cofounder", created_at: number, action_type: "refund" | "file_bug" = "refund") =>
        ctx.db.insert("decisions", { subject_kind: "action", action: actionId, action_type, choice, reason: `${choice} ${created_at}`, features: {}, decided_by, created_at });
      await decision(a1, "approve", "founder", 1);
      await decision(a2, "deny", "founder", 2);
      await decision(a2, "approve", "cofounder", 3); // not the founder
      await decision(a1, "approve", "founder", 4, "file_bug"); // other type
    });
    const res = await get(t, "/co/history?action_type=refund", token);
    expect(res.status).toBe(200);
    expect(res.body.history.map((h: { reason: string }) => h.reason)).toEqual(["deny 2", "approve 1"]);
    expect(res.body.history[1]).toMatchObject({
      choice: "approve",
      params: { to: "a***@example.com" },
      amount_cents: 3500,
      labels: { severity: { value: "low", confidence: 0.9 } },
    });
    expect((await get(t, "/co/history?action_type=refund&limit=1", token)).body.history).toHaveLength(1);
  });

  test("radar: authenticated → 501 until spec 17; bad body → 400; no token → 401", async () => {
    const t = setup();
    const { token } = await taskFor(t, "market_intel");
    const post = (body: string, auth = true) =>
      t.fetch("/co/radar", { method: "POST", headers: auth ? { Authorization: `Bearer ${token}` } : {}, body });
    expect((await post(JSON.stringify({ url: "https://competitor.test/pricing" }))).status).toBe(501);
    expect((await post("not json")).status).toBe(400);
    expect((await post(JSON.stringify({ url: "https://x.test" }), false)).status).toBe(401);
    const statuses = (await coAudits(t)).map((r) => (r.detail as { status: number }).status);
    expect(statuses).toEqual([501, 400, 401]);
  });
});
