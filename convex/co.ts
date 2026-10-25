import { RateLimiter } from "@convex-dev/rate-limiter";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { httpAction, internalMutation, internalQuery, type ActionCtx, type QueryCtx } from "./_generated/server";
import { audit } from "./channels";
import {
  CO_CALLS_PER_TASK,
  CUSTOMER_LEDGER_ROWS,
  DAY_MS,
  HISTORY_LIMIT,
  VIEW_LIMITS,
  VIEWS_WITH_ID,
  canRead,
  clampLimit,
  findDuplicateCharges,
  isCoView,
  maskEmails,
  type CoView,
} from "./lib/co";
import { ruleInScope } from "./lib/rules";
import { laDate } from "./lib/time";
import { TOKEN_TTL_MS } from "./lib/tokens";
import { ACTION_TYPES, ROLES, vActionType, vRole, type ActionType, type Role } from "./lib/types";
import { verifyTaskAccess } from "./tasks";

// `co` CLI backend (spec 06): GET /co/data, GET /co/history, POST /co/radar.
// Every call is authenticated with the task token from the ASSIGN (Authorization: Bearer <token>),
// rate limited per task, role-checked per view and audited as `co_read`. Agents only read here.

// 60 calls per task: a bucket that refills once per token lifetime, so a task never gets more.
const coLimiter = new RateLimiter(components.rateLimiter, {
  coCalls: { kind: "token bucket", rate: CO_CALLS_PER_TASK, period: TOKEN_TTL_MS, capacity: CO_CALLS_PER_TASK },
});

type Failure = { ok: false; status: number; error: string };
const vFailure = v.object({ ok: v.literal(false), status: v.number(), error: v.string() });
const fail = (status: number, error: string): Failure => ({ ok: false, status, error });

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function bearer(req: Request): string | null {
  const m = req.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

type Caller = { taskId: Id<"tasks">; role: Role };

// 401 for a missing, malformed, expired, revoked or closed-task token. Denials are audited without the token.
async function authenticate(ctx: ActionCtx, req: Request, path: string): Promise<{ ok: true; caller: Caller } | { ok: false; response: Response }> {
  const token = bearer(req);
  let error: string;
  if (!token) {
    error = "missing_token";
  } else {
    let result: Awaited<ReturnType<typeof verifyTaskAccess>>;
    try {
      result = await verifyTaskAccess(ctx, token);
    } catch {
      return { ok: false, response: json(500, { error: "server misconfigured" }) };
    }
    if (result.ok) return { ok: true, caller: { taskId: result.taskId, role: result.role } };
    error = result.error;
  }
  await ctx.runMutation(internal.co.auditDenied, { path, error });
  return { ok: false, response: json(401, { error: `unauthorized: ${error}` }) };
}

export const auditDenied = internalMutation({
  args: { path: v.string(), error: v.string() },
  returns: v.null(),
  handler: async (ctx, { path, error }) => {
    await audit(ctx, { actor: "co", kind: "co_read", ref: "co", detail: { path, status: 401, error } });
    return null;
  },
});

// One transaction per call: spend the task's call budget, validate the request, check the role, audit.
export const admit = internalMutation({
  args: {
    taskId: v.id("tasks"),
    role: vRole,
    path: v.string(),
    view: v.optional(v.string()),
    actionType: v.optional(v.string()),
    id: v.optional(v.string()),
  },
  returns: v.union(v.object({ ok: v.literal(true) }), vFailure),
  handler: async (ctx, a) => {
    const result = await admitCall(a, () => coLimiter.limit(ctx, "coCalls", { key: a.taskId }));
    await audit(ctx, {
      actor: a.role,
      kind: "co_read",
      ref: a.taskId,
      detail: {
        path: a.path,
        view: a.view ?? null,
        action_type: a.actionType ?? null,
        id: a.id ?? null,
        status: result.ok ? 200 : result.status,
        ...(result.ok ? {} : { error: result.error }),
      },
    });
    return result;
  },
});

async function admitCall(
  a: { role: Role; path: string; view?: string; actionType?: string; id?: string },
  spend: () => Promise<{ ok: boolean; retryAfter?: number }>,
): Promise<{ ok: true } | Failure> {
  const budget = await spend();
  if (!budget.ok) return fail(429, `rate limited: ${CO_CALLS_PER_TASK} co calls per task`);
  if (a.path === "/co/data") {
    const view = a.view ?? "";
    if (!isCoView(view)) return fail(400, `unknown view "${view}"`);
    if (!canRead(a.role, view)) return fail(403, `role ${a.role} cannot read ${view}`);
    if (VIEWS_WITH_ID.includes(view) && !a.id) return fail(400, `view ${view} needs --id`);
  }
  if (a.path === "/co/history" && !(ACTION_TYPES as readonly string[]).includes(a.actionType ?? "")) {
    return fail(400, `unknown action_type "${a.actionType ?? ""}"`);
  }
  if (a.path === "/co/radar") {
    if (!a.id) return fail(400, 'body must be {"url": "..."}');
    return fail(501, "radar is not available yet (spec 17)");
  }
  return { ok: true };
}

// ---------------------------------------------------------------- views

type ViewResult = { ok: true; data: unknown } | Failure;
const vViewResult = v.union(v.object({ ok: v.literal(true), data: v.any() }), vFailure);

function customerSummary(c: Doc<"customers">, now: number) {
  return {
    id: c._id,
    name: c.name,
    email: c.email,
    plan: c.plan,
    signup_at: c.signup_at,
    tenure_days: Math.max(0, Math.floor((now - c.signup_at) / DAY_MS)),
  };
}

function ledgerRow(r: Doc<"ledger_mirror">) {
  return {
    nessie_id: r.nessie_id,
    kind: r.kind,
    account_id: r.account_id,
    counterparty: r.counterparty,
    amount_cents: r.amount_cents,
    date: r.date,
  };
}

const limitFor = (view: CoView, raw: number | undefined) => clampLimit(raw, VIEW_LIMITS[view] ?? { def: 50, max: 50 });

async function ticketView(ctx: QueryCtx, id: string, now: number): Promise<ViewResult> {
  const ticketId = ctx.db.normalizeId("tickets", id);
  const ticket = ticketId ? await ctx.db.get(ticketId) : null;
  if (!ticket) return fail(404, `ticket ${id} not found`);
  const customer = ticket.customer ? await ctx.db.get(ticket.customer) : null;
  const data = {
    ticket: {
      id: ticket._id,
      subject: ticket.subject,
      body: ticket.body,
      from_email: ticket.from_email,
      amount_cents: ticket.amount_cents ?? null,
      status: ticket.status,
      source: ticket.source,
      created_at: ticket.created_at,
    },
    customer: customer ? customerSummary(customer, now) : null,
  };
  // The ticket's own sender is the reply address; every other email stays masked.
  return { ok: true, data: maskEmails(data, [ticket.from_email, ...(customer ? [customer.email] : [])]) };
}

async function ticketsView(ctx: QueryCtx, limit: number): Promise<ViewResult> {
  const open = await ctx.db
    .query("tickets")
    .withIndex("by_status", (q) => q.eq("status", "open"))
    .order("desc")
    .take(limit);
  const tickets = open.map((t) => ({
    id: t._id,
    customer_id: t.customer ?? null,
    from_email: t.from_email,
    subject: t.subject,
    body: t.body.length > 300 ? `${t.body.slice(0, 299)}…` : t.body,
    amount_cents: t.amount_cents ?? null,
    created_at: t.created_at,
  }));
  return { ok: true, data: maskEmails({ tickets }) };
}

async function customerView(ctx: QueryCtx, id: string, now: number): Promise<ViewResult> {
  const customerId = ctx.db.normalizeId("customers", id);
  const customer = customerId ? await ctx.db.get(customerId) : null;
  if (!customer) return fail(404, `customer ${id} not found`);
  const account = customer.nessie_account_id;
  // Money out of the customer's account (charges) and into it (refunds), newest first.
  const [debits, credits] = await Promise.all([
    ctx.db
      .query("ledger_mirror")
      .withIndex("by_account_date", (q) => q.eq("account_id", account))
      .order("desc")
      .take(CUSTOMER_LEDGER_ROWS),
    ctx.db
      .query("ledger_mirror")
      .withIndex("by_counterparty_date", (q) => q.eq("counterparty", account))
      .order("desc")
      .take(CUSTOMER_LEDGER_ROWS),
  ]);
  const ledger = [
    ...debits.map((r) => ({ ...ledgerRow(r), direction: "debit" as const })),
    ...credits.map((r) => ({ ...ledgerRow(r), direction: "credit" as const })),
  ]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, CUSTOMER_LEDGER_ROWS);
  return { ok: true, data: maskEmails({ customer: customerSummary(customer, now), ledger }, [customer.email]) };
}

async function ledgerView(ctx: QueryCtx, limit: number, since: string | undefined): Promise<ViewResult> {
  if (since !== undefined && !Number.isFinite(Date.parse(since))) return fail(400, `--since must be an ISO date, got "${since}"`);
  const rows = await ctx.db
    .query("ledger_mirror")
    .withIndex("by_date", (q) => (since === undefined ? q : q.gte("date", since)))
    .order("desc")
    .take(limit);
  return { ok: true, data: maskEmails({ ledger: rows.map(ledgerRow) }) };
}

// Customer charges are transfers paid from a customer's account (spec 08 data model).
async function duplicatesView(ctx: QueryCtx): Promise<ViewResult> {
  const customers = await ctx.db.query("customers").take(1000);
  const byAccount = new Map(customers.map((c) => [c.nessie_account_id, c]));
  const transfers = await ctx.db
    .query("ledger_mirror")
    .withIndex("by_kind", (q) => q.eq("kind", "transfer"))
    .take(5000);
  const groups = findDuplicateCharges(transfers.filter((r) => byAccount.has(r.account_id)));
  const duplicates = groups.map((g) => {
    const c = byAccount.get(g.account_id)!;
    return { customer_id: c._id, customer_name: c.name, ...g };
  });
  return {
    ok: true,
    data: maskEmails({
      duplicates,
      duplicate_charges: groups.reduce((n, g) => n + g.charges.length - 1, 0),
      total_extra_cents: groups.reduce((n, g) => n + g.extra_cents, 0),
    }),
  };
}

async function signalsView(ctx: QueryCtx, room: Id<"rooms">, limit: number): Promise<ViewResult> {
  const rows = await ctx.db
    .query("signals")
    .withIndex("by_room", (q) => q.eq("room", room))
    .order("desc")
    .take(limit);
  const signals = rows.map((s) => ({
    id: s._id,
    source: s.source,
    url: s.url,
    change: s.change,
    significance: s.significance,
    evidence_url: s.evidence_url,
    consumed: s.consumed,
    created_at: s.created_at,
  }));
  return { ok: true, data: maskEmails({ signals }) };
}

async function budgetView(ctx: QueryCtx, now: number): Promise<ViewResult> {
  const period = laDate(now);
  const rows = (await ctx.db.query("budgets").take(500)).filter((b) => b.period === period);
  const budgets = rows.map((b) => ({
    scope: b.scope,
    limit_cents: b.limit_cents,
    spent_cents: b.spent_cents,
    remaining_cents: b.limit_cents - b.spent_cents,
  }));
  return { ok: true, data: { period, budgets } };
}

const USAGE_DAYS = 7;

async function usageView(ctx: QueryCtx, now: number): Promise<ViewResult> {
  const from = now - USAGE_DAYS * DAY_MS;
  const counts = new Map<string, { day: string; role: Role; runs: number; completed: number; failed: number }>();
  for (const role of ROLES) {
    const runs = await ctx.db
      .query("runs")
      .withIndex("by_role_started", (q) => q.eq("role", role).gte("started_at", from))
      .take(2000);
    for (const r of runs) {
      const day = laDate(r.started_at);
      const key = `${day}|${role}`;
      const row = counts.get(key) ?? { day, role, runs: 0, completed: 0, failed: 0 };
      row.runs += 1;
      if (r.status === "completed") row.completed += 1;
      if (r.status === "failed") row.failed += 1;
      counts.set(key, row);
    }
  }
  const usage = [...counts.values()].sort((a, b) => b.day.localeCompare(a.day) || a.role.localeCompare(b.role));
  return { ok: true, data: { days: USAGE_DAYS, usage } };
}

async function threadView(ctx: QueryCtx, id: string, limit: number): Promise<ViewResult> {
  const taskId = ctx.db.normalizeId("tasks", id);
  const task = taskId ? await ctx.db.get(taskId) : null;
  if (!task) return fail(404, `task ${id} not found`);
  const messages = await ctx.db
    .query("messages")
    .withIndex("by_task", (q) => q.eq("task", task._id))
    .order("asc")
    .take(limit);
  const data = {
    task: { id: task._id, role: task.role, kind: task.kind, status: task.status, brief: task.brief, chain_id: task.chain_id },
    messages: messages.map((m) => ({
      seq: m.seq,
      sender_kind: m.sender_kind,
      sender_name: m.sender_name,
      sender_role: m.sender_role ?? null,
      text: m.text,
      envelope: m.envelope ?? null,
      created_at: m.created_at,
    })),
  };
  return { ok: true, data: maskEmails(data) };
}

async function rulesView(ctx: QueryCtx, role: Role): Promise<ViewResult> {
  const agent = await ctx.db
    .query("agents")
    .withIndex("by_role", (q) => q.eq("role", role))
    .unique();
  const department = agent?.department ?? "none";
  const rules = (await ctx.db.query("rules").take(500))
    .filter((r) => ruleInScope(r, role, department))
    .map((r) => ({
      id: r._id,
      action_type: r.action_type,
      effect: r.effect,
      scope: r.scope,
      conditions: r.conditions,
      text: r.text,
      version: r.version,
      expires_at: r.expires_at ?? null,
    }));
  return { ok: true, data: { rules } };
}

async function companyView(ctx: QueryCtx): Promise<ViewResult> {
  const company = await ctx.db.query("company").first();
  if (!company) return fail(404, "company profile not seeded");
  const { _id, _creationTime, ...profile } = company;
  return { ok: true, data: maskEmails({ company: profile }) };
}

export const readView = internalQuery({
  args: {
    taskId: v.id("tasks"),
    role: vRole,
    view: v.string(),
    id: v.optional(v.string()),
    limit: v.optional(v.number()),
    since: v.optional(v.string()),
  },
  returns: vViewResult,
  handler: async (ctx, a): Promise<ViewResult> => {
    const task = await ctx.db.get(a.taskId);
    if (!task) return fail(401, "unauthorized: unknown_task");
    if (!isCoView(a.view)) return fail(400, `unknown view "${a.view}"`);
    const now = Date.now();
    const id = a.id ?? "";
    switch (a.view) {
      case "ticket":
        return ticketView(ctx, id, now);
      case "tickets":
        return ticketsView(ctx, limitFor("tickets", a.limit));
      case "customer":
        return customerView(ctx, id, now);
      case "ledger":
        return ledgerView(ctx, limitFor("ledger", a.limit), a.since);
      case "duplicates":
        return duplicatesView(ctx);
      case "signals":
        return signalsView(ctx, task.room, limitFor("signals", a.limit));
      case "budget":
        return budgetView(ctx, now);
      case "usage":
        return usageView(ctx, now);
      case "thread":
        return threadView(ctx, id, limitFor("thread", a.limit));
      case "rules":
        return rulesView(ctx, a.role);
      case "company":
        return companyView(ctx);
    }
  },
});

// Last N founder decisions for an action type, newest first: what the founder chose and why.
export const readHistory = internalQuery({
  args: { actionType: vActionType, limit: v.optional(v.number()) },
  returns: vViewResult,
  handler: async (ctx, { actionType, limit }): Promise<ViewResult> => {
    const n = clampLimit(limit, HISTORY_LIMIT);
    const decisions: Doc<"decisions">[] = [];
    for await (const d of ctx.db
      .query("decisions")
      .withIndex("by_action_type", (q) => q.eq("action_type", actionType))
      .order("desc")) {
      if (d.decided_by === "founder") decisions.push(d);
      if (decisions.length >= n) break;
    }
    const history = await Promise.all(
      decisions.map(async (d) => {
        const action = d.action ? await ctx.db.get(d.action) : null;
        return {
          decision_id: d._id,
          decided_at: d.created_at,
          choice: d.choice,
          reason: d.reason ?? null,
          params: action?.params ?? null,
          amount_cents: action?.amount_cents ?? null,
          labels: action?.labels ?? null,
        };
      }),
    );
    return { ok: true, data: maskEmails({ action_type: actionType, history }) };
  },
});

// ---------------------------------------------------------------- HTTP handlers

function respond(result: ViewResult | Failure): Response {
  return result.ok ? json(200, result.data) : json(result.status, { error: result.error });
}

function optionalNumber(raw: string | null): number | undefined {
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

// GET /co/data?view=<view>[&id=ID][&limit=N][&since=ISO]
export const coData = httpAction(async (ctx, req) => {
  const path = "/co/data";
  const auth = await authenticate(ctx, req, path);
  if (!auth.ok) return auth.response;
  const p = new URL(req.url).searchParams;
  const view = p.get("view") ?? "";
  const id = p.get("id") || undefined;
  const admitted = await ctx.runMutation(internal.co.admit, { ...auth.caller, path, view, id });
  if (!admitted.ok) return respond(admitted);
  const result = await ctx.runQuery(internal.co.readView, {
    ...auth.caller,
    view,
    id,
    limit: optionalNumber(p.get("limit")),
    since: p.get("since") || undefined,
  });
  return respond(result);
});

// GET /co/history?action_type=<type>[&limit=N]
export const coHistory = httpAction(async (ctx, req) => {
  const path = "/co/history";
  const auth = await authenticate(ctx, req, path);
  if (!auth.ok) return auth.response;
  const p = new URL(req.url).searchParams;
  const actionType = p.get("action_type") ?? "";
  const admitted = await ctx.runMutation(internal.co.admit, { ...auth.caller, path, actionType });
  if (!admitted.ok) return respond(admitted);
  const result = await ctx.runQuery(internal.co.readHistory, {
    actionType: actionType as ActionType, // validated by admit
    limit: optionalNumber(p.get("limit")),
  });
  return respond(result);
});

// POST /co/radar {"url": "..."}: on-demand Company Radar scan, 501 until spec 17.
export const coRadar = httpAction(async (ctx, req) => {
  const path = "/co/radar";
  const auth = await authenticate(ctx, req, path);
  if (!auth.ok) return auth.response;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const url = body && typeof body === "object" && "url" in body && typeof body.url === "string" ? body.url : undefined;
  // admit answers 400 / 501 (and audits it) until the Company Radar Actor exists.
  const admitted = await ctx.runMutation(internal.co.admit, { ...auth.caller, path, id: url });
  return respond(admitted.ok ? fail(501, "radar is not available yet (spec 17)") : admitted);
});
