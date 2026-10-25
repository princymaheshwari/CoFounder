import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { CATALOG } from "./lib/catalog";
import { parseRecurringBrief } from "./lib/recurring";
import { conditionText } from "./lib/rules";

// Read models for the founder app: channels, threads, the founder's requests in #founder-desk, who decided
// what, and the rulebook. Messages are turned into plain view models here so the UI never parses envelopes.

type Env = Record<string, unknown>;
const ID = /\b[a-z0-9]{32}\b/g;
// Untyped envelope fields as display text; anything that is not a string or number shows as empty.
const txt = (x: unknown): string => (typeof x === "string" ? x : typeof x === "number" ? String(x) : "");
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const tidy = (s: string) =>
  s
    .replace(/\s*\[story post \d+\]/g, "")
    .replace(/\s*\((?:task|action|handoff)\s+[a-z0-9]{32}\)/g, "")
    .replace(/\b(?:task|action|ticket|issue)\s+[a-z0-9]{32}\b/g, (m) => m.split(" ")[0])
    .replace(ID, "")
    .replace(/\s{2,}/g, " ")
    .trim();

function block(text: string): { line: string; env: Env | null } {
  const at = text.indexOf("```cofounder");
  const line = (at >= 0 ? text.slice(0, at) : text).replace(/^\[Dispatcher\]\s*/, "").trim();
  if (at < 0) return { line, env: null };
  const end = text.indexOf("```", at + 12);
  try {
    return { line, env: JSON.parse(text.slice(at + 12, end > 0 ? end : undefined).trim()) as Env };
  } catch {
    return { line, env: null };
  }
}

// One line per proposed action, in the founder's words.
function actionText(type: string, params: unknown): string {
  const p = (params && typeof params === "object" ? params : {}) as Env;
  const amount = CATALOG[type as keyof typeof CATALOG]?.amount(p);
  switch (type) {
    case "refund":
      return `Refund ${amount !== undefined ? dollars(amount) : ""}`.trim();
    case "refund_batch":
      return `Refund ${Array.isArray(p.items) ? p.items.length : 0} customers${amount !== undefined ? `, ${dollars(amount)} total` : ""}`;
    case "publish_post":
      return `Publish on ${(txt(p.channel) || "social")}: “${clip(txt(p.text), 140)}”`;
    case "file_bug":
      return `File a bug: ${txt(p.title)}`;
    case "reply_customer":
      return "Reply to the customer";
    default:
      return `${type.replace(/_/g, " ")}${amount !== undefined ? ` ${dollars(amount)}` : ""}`;
  }
}

const vEnvelope = v.object({
  type: v.string(),
  summary: v.string(),
  findings: v.array(v.object({ claim: v.string(), evidence: v.string() })),
  actions: v.array(v.object({ type: v.string(), text: v.string(), rationale: v.string() })),
  to: v.union(v.string(), v.null()),
  need: v.union(v.string(), v.null()),
  issue: v.union(v.string(), v.null()),
  package: v.union(
    v.null(),
    v.object({ situation: v.string(), recommendation: v.string(), options: v.array(v.string()), attempts: v.array(v.string()) }),
  ),
});

const vRequest = v.object({
  _id: v.id("founder_inbox"),
  kind: v.string(),
  title: v.string(),
  body: v.string(),
  status: v.string(),
  options: v.array(v.string()),
  decision: v.union(v.null(), v.object({ choice: v.string(), reason: v.union(v.string(), v.null()), at: v.number() })),
  ruleText: v.union(v.string(), v.null()),
  situation: v.union(v.string(), v.null()),
  recommendation: v.union(v.string(), v.null()),
  choices: v.array(v.string()),
  actions: v.array(v.object({ text: v.string(), by: v.string(), why: v.string(), gate: v.string(), status: v.string() })),
  diff: v.array(v.string()),
  rationale: v.union(v.string(), v.null()),
  origin: v.union(v.id("tasks"), v.null()), // the thread where the request started, in whichever channel
});

const vMessage = v.object({
  _id: v.id("messages"),
  seq: v.number(),
  at: v.number(),
  thread: v.union(v.id("tasks"), v.null()),
  senderKind: v.string(),
  sender: v.string(),
  role: v.union(v.string(), v.null()),
  kind: v.string(), // assign | handoff | repair | nudge | decision | digest | request | note | reply | invalid | posted | radar
  headline: v.string(),
  to: v.union(v.string(), v.null()),
  rules: v.array(v.string()),
  envelope: v.union(v.null(), vEnvelope),
  request: v.union(v.null(), vRequest),
  run: v.union(v.string(), v.null()),
  recurring: v.union(v.null(), v.object({ cadence: v.string(), title: v.string() })), // an ASSIGN for recurring work (onboarding)
});
type MessageVM = typeof vMessage.type;

// Why the gate sent something to the founder, in plain words.
const GATE_REASON: Record<string, string> = {
  "hard:budget": "Over today's refund budget",
  "hard:cap": "Over the $500 limit for any single action",
  "hard:no_amount": "No amount given",
  "hard:always_escalate": "This kind of action always needs you",
  "labels:low_confidence": "Jev wasn't confident about the content",
  "novelty:new_type": "First time this kind of action came up",
  "novelty:new_counterparty": "A payee you haven't approved before",
  "novelty:amount": "Larger than anything you've approved",
  "default:no_rule": "No rule covers it yet",
  "rule:escalate": "A rule says to ask you",
  "rule:allow": "Allowed by a rule",
  "rule:deny": "Denied by a rule",
};
const ASK: Record<string, string> = {
  publish_post: "publish this post",
  refund: "refund a customer",
  refund_batch: "refund a group of customers",
  reply_customer: "send this reply",
  file_bug: "file this bug",
  pay_bill: "pay this bill",
  marketing_spend: "spend on marketing",
  switch_vendor: "switch vendors",
  price_change: "change a price",
  schedule_digest: "schedule a digest",
};

export const gateReason = (r: string | undefined) => (r ? (GATE_REASON[r] ?? r) : "Waiting for the gate");

async function requestVM(ctx: QueryCtx, id: Id<"founder_inbox">) {
  const item = await ctx.db.get(id);
  if (!item) return null;
  const ruleId = item.kind === "rule" ? ctx.db.normalizeId("rules", item.ref) : null;
  const rule = ruleId ? await ctx.db.get(ruleId) : null;
  const names = await displayNames(ctx);
  let actionIds: Id<"actions">[] = [];
  let originTask: Id<"tasks"> | null = null;
  if (item.kind === "package") {
    const issueId = ctx.db.normalizeId("issues", item.ref);
    const issue = issueId ? await ctx.db.get(issueId) : null;
    actionIds = issue?.actions ?? [];
    originTask = issue?.task ?? null;
  } else if (item.kind === "action") {
    const actionId = ctx.db.normalizeId("actions", item.ref);
    if (actionId) actionIds = [actionId];
    originTask = actionId ? ((await ctx.db.get(actionId))?.task ?? null) : null;
  }
  const originDoc = originTask ? await ctx.db.get(originTask) : null;
  const origin = originDoc ? (originDoc.thread ?? originDoc._id) : null;
  const actions = [];
  const actionTypes: string[] = [];
  for (const aid of actionIds) {
    const a = await ctx.db.get(aid);
    if (a) actionTypes.push(a.type);
    if (a) actions.push({ text: actionText(a.type, a.params), by: names.get(a.role) ?? a.role, why: a.rationale, gate: gateReason(a.gate?.reason), status: a.status });
  }
  const lines = item.body.split("\n");
  const after = (prefix: string) => lines.find((l) => l.startsWith(prefix))?.slice(prefix.length).trim() ?? null;
  const optionsAt = lines.indexOf("Options:");
  const choices: string[] = [];
  if (optionsAt >= 0) for (const l of lines.slice(optionsAt + 1)) if (/^\d+\.\s/.test(l)) choices.push(l.replace(/^\d+\.\s/, ""));
  const whyAt = lines.findIndex((l) => l.startsWith("Why: "));
  return {
    situation: item.kind === "package" ? after("Situation:") : item.kind === "action" ? (actions[0] ? `${actions[0].by} wants to ${ASK[actionTypes[0]] ?? "do this"}.` : (lines[0] ?? null)) : null,
    recommendation: after("Recommendation:"),
    choices,
    actions,
    diff: item.kind === "rule" ? lines.slice(0, whyAt >= 0 ? whyAt : lines.length).filter((l) => !l.startsWith("Expires")) : [],
    rationale: item.kind === "rule" && whyAt >= 0 ? lines[whyAt].slice(5) : null,
    origin,
    _id: item._id,
    kind: item.kind,
    title: item.title,
    body: item.body,
    status: item.status,
    options: (item.options ?? []).map((o) => o.label),
    decision: item.decision ? { choice: item.decision.choice, reason: item.decision.reason ?? null, at: item.decision.at } : null,
    ruleText: rule?.text ?? null,
  };
}

async function messageVM(ctx: QueryCtx, m: Doc<"messages">, names: Map<string, string>): Promise<MessageVM> {
  const common = {
    _id: m._id,
    seq: m.seq,
    at: m.created_at,
    thread: m.thread ?? null,
    senderKind: m.sender_kind,
    sender: m.sender_name,
    role: m.sender_role ?? null,
    to: null as string | null,
    rules: [] as string[],
    envelope: null,
    request: m.inbox ? await requestVM(ctx, m.inbox) : null,
    run: m.creao_run_id && !m.creao_run_id.startsWith("story-") ? m.creao_run_id : null,
    recurring: null as { cadence: string; title: string } | null,
  };
  if (m.sender_kind === "agent") {
    const e = m.envelope && typeof m.envelope === "object" ? (m.envelope as Env) : null;
    if (!e) return { ...common, kind: "invalid", headline: `Reply did not pass validation: ${m.envelope_error ?? "unknown error"}` };
    const pkg = e.package && typeof e.package === "object" ? (e.package as Env) : null;
    const issue = e.issue && typeof e.issue === "object" ? (e.issue as Env) : null;
    return {
      ...common,
      kind: "reply",
      headline: txt(e.summary),
      to: typeof e.to_role === "string" ? (names.get(e.to_role) ?? e.to_role) : null,
      envelope: {
        type: String(e.type),
        summary: txt(e.summary),
        findings: Array.isArray(e.findings) ? (e.findings as Env[]).map((f) => ({ claim: txt(f.claim), evidence: txt(f.evidence) })) : [],
        actions: Array.isArray(e.proposed_actions)
          ? (e.proposed_actions as Env[]).map((a) => ({ type: String(a.type), text: actionText(String(a.type), a.params), rationale: txt(a.rationale) }))
          : [],
        to: typeof e.to_role === "string" ? (names.get(e.to_role) ?? e.to_role) : null,
        need: typeof e.need === "string" ? e.need : typeof e.kind === "string" ? e.kind : null,
        issue: issue ? txt(issue.summary) : null,
        package: pkg
          ? {
              situation: txt(pkg.situation),
              recommendation: txt(pkg.recommendation),
              options: Array.isArray(pkg.options) ? (pkg.options as Env[]).map((o) => txt(o.label)) : [],
              attempts: Array.isArray(pkg.attempts) ? (pkg.attempts as unknown[]).map(String) : [],
            }
          : null,
      },
    };
  }
  if (m.sender_kind === "founder") return { ...common, kind: "note", headline: m.text };
  const { line, env } = block(m.text);
  if (m.inbox) return { ...common, kind: "request", headline: tidy(line.replace(/^@Founder\s*/, "")) };
  const type = typeof env?.type === "string" ? env.type : null;
  if (type === "ASSIGN") {
    const to = typeof env?.to === "string" ? env.to : null;
    const isHandoff = /handoff from/i.test(line);
    const rec = parseRecurringBrief(txt(env?.brief));
    return {
      ...common,
      kind: isHandoff ? "handoff" : "assign",
      to: to ? (names.get(to) ?? to) : null,
      headline: tidy(rec?.brief || txt(env?.brief) || line),
      recurring: rec ? { cadence: rec.cadence, title: rec.title } : null,
      rules: Array.isArray(env?.rules_in_scope) ? (env.rules_in_scope as unknown[]).map(String) : [],
    };
  }
  // Execution of a post (executor.ts markExecuted): "Posted on <channel> (demo post queue, …): <text>".
  const posted = /^Posted on (\w+) \(demo post queue[^)]*\): ([\s\S]*)$/.exec(line);
  if (posted) return { ...common, kind: "posted", to: posted[1], headline: posted[2] };
  if (line.startsWith("Company Radar (Apify)")) return { ...common, kind: "radar", headline: tidy(line) };
  if (type === "REPAIR" || type === "NUDGE") return { ...common, kind: type.toLowerCase(), headline: tidy(line) };
  if (type === "DECISION") return { ...common, kind: "decision", headline: tidy(txt(env?.note) || line) };
  if (type === "DIGEST") {
    return { ...common, kind: "digest", headline: tidy(line), rules: Array.isArray(env?.rules) ? (env.rules as unknown[]).map(String) : [] };
  }
  return { ...common, kind: "note", headline: tidy(line) };
}

async function displayNames(ctx: QueryCtx): Promise<Map<string, string>> {
  return new Map((await ctx.db.query("agents").take(100)).map((a) => [a.role as string, a.display_name]));
}

// ---------------------------------------------------------------- decisions tally

type Who = "rule" | "founder" | "waiting";

async function tally(ctx: QueryCtx) {
  const actions = await ctx.db.query("actions").order("desc").take(400);
  const founderDecided = new Set<string>();
  for (const d of await ctx.db.query("decisions").order("desc").take(800)) {
    if (d.decided_by === "founder" && d.subject_kind === "action" && d.action) founderDecided.add(d.action);
  }
  const marks: { at: number; who: Who; text: string; rule: string | null }[] = [];
  const ruleText = new Map<string, string>();
  for (const a of actions.reverse()) {
    let who: Who | null = null;
    if (founderDecided.has(a._id)) who = "founder";
    else if ((a.gate?.effect === "allow" || a.gate?.effect === "deny") && a.gate.rule_id) who = "rule";
    else if (a.status === "escalated" || a.status === "queued") who = "waiting";
    if (!who) continue;
    let rule: string | null = null;
    if (who === "rule" && a.gate?.rule_id) {
      if (!ruleText.has(a.gate.rule_id)) ruleText.set(a.gate.rule_id, (await ctx.db.get(a.gate.rule_id))?.text ?? "");
      rule = /^(R\d+):/.exec(ruleText.get(a.gate.rule_id) ?? "")?.[1] ?? null;
    }
    marks.push({ at: a.created_at, who, text: actionText(a.type, a.params), rule });
  }
  return {
    byRules: marks.filter((m) => m.who === "rule").length,
    byFounder: marks.filter((m) => m.who === "founder").length,
    waiting: marks.filter((m) => m.who === "waiting").length,
    marks: marks.slice(-60),
  };
}

const vTally = v.object({
  byRules: v.number(),
  byFounder: v.number(),
  waiting: v.number(),
  marks: v.array(v.object({ at: v.number(), who: v.union(v.literal("rule"), v.literal("founder"), v.literal("waiting")), text: v.string(), rule: v.union(v.string(), v.null()) })),
});

// ---------------------------------------------------------------- queries

export const overview = query({
  args: {},
  returns: v.object({
    company: v.object({ name: v.string(), product: v.string() }),
    channels: v.array(
      v.object({ _id: v.id("rooms"), name: v.string(), department: v.string(), messages: v.number(), lastAt: v.union(v.number(), v.null()), members: v.array(v.string()), waiting: v.number() }),
    ),
    agents: v.array(v.object({ role: v.string(), name: v.string(), department: v.string(), rooms: v.array(v.string()), state: v.string(), doing: v.union(v.string(), v.null()) })),
    tally: vTally,
  }),
  handler: async (ctx) => {
    const company = await ctx.db.query("company").first();
    const agents = (await ctx.db.query("agents").take(100)).filter((a) => a.enabled);
    const open = await ctx.db
      .query("founder_inbox")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .take(100);
    const ORDER = ["#founder-desk", "#customer", "#finance", "#marketing", "#leadership"];
    const rooms = (await ctx.db.query("rooms").take(50)).sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name));
    const channels = [];
    for (const r of rooms) {
      const last = await ctx.db
        .query("messages")
        .withIndex("by_room_seq", (q) => q.eq("room", r._id))
        .order("desc")
        .first();
      channels.push({
        _id: r._id,
        name: r.name,
        department: r.department,
        messages: r.next_seq - 1,
        lastAt: last?.created_at ?? null,
        members: agents.filter((a) => a.kind === "role" && a.rooms.includes(r.name)).map((a) => a.display_name),
        waiting: r.name === "#founder-desk" ? open.length : 0,
      });
    }
    const roster = [];
    for (const a of agents.filter((x) => x.kind === "role")) {
      const latest = await ctx.db
        .query("tasks")
        .withIndex("by_role", (q) => q.eq("role", a.role))
        .order("desc")
        .first();
      const state = !latest ? "idle" : latest.status === "assigned" || latest.status === "queued" || latest.status === "repairing" ? "working" : latest.status === "escalated" ? "escalated" : "idle";
      roster.push({ role: a.role, name: a.display_name, department: a.department, rooms: a.rooms, state, doing: state === "working" && latest ? tidy(clip(latest.brief, 90)) : null });
    }
    return {
      company: { name: company?.name ?? "Company", product: company?.product ?? "" },
      channels,
      agents: roster,
      tally: await tally(ctx),
    };
  },
});

const vEntry = v.object({
  kind: v.union(v.literal("thread"), v.literal("message")),
  at: v.number(),
  message: vMessage, // the thread's first message, or the standalone message
  thread: v.union(
    v.null(),
    v.object({ root: v.id("tasks"), replies: v.number(), people: v.array(v.string()), lastAt: v.number(), status: v.string(), last: v.string(), waiting: v.boolean(), request: v.union(v.null(), vRequest) }),
  ),
});

// A channel as Slack-style entries: one per task thread (its first message plus a summary) and one per standalone message.
export const channel = query({
  args: { roomId: v.id("rooms") },
  returns: v.object({ name: v.string(), department: v.string(), entries: v.array(vEntry) }),
  handler: async (ctx, { roomId }) => {
    const room = await ctx.db.get(roomId);
    if (!room) throw new Error("channel not found");
    const names = await displayNames(ctx);
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_room_seq", (q) => q.eq("room", roomId))
      .order("desc")
      .take(400);
    rows.reverse();
    const threads = new Map<string, Doc<"messages">[]>();
    const entries: (typeof vEntry.type)[] = [];
    const order: (string | Doc<"messages">)[] = [];
    for (const m of rows) {
      if (m.thread) {
        if (!threads.has(m.thread)) {
          threads.set(m.thread, []);
          order.push(m.thread);
        }
        threads.get(m.thread)!.push(m);
      } else order.push(m);
    }
    for (const item of order) {
      if (typeof item !== "string") {
        entries.push({ kind: "message", at: item.created_at, message: await messageVM(ctx, item, names), thread: null });
        continue;
      }
      const msgs = threads.get(item)!;
      const root = await ctx.db.get(item as Id<"tasks">);
      const last = msgs[msgs.length - 1];
      const lastVM = await messageVM(ctx, last, names);
      let waiting = false;
      let request = null;
      for (const m of msgs) {
        if (!m.inbox) continue;
        request = await requestVM(ctx, m.inbox);
        if (request?.status === "open") waiting = true;
      }
      entries.push({
        kind: "thread",
        at: msgs[0].created_at,
        message: await messageVM(ctx, msgs[0], names),
        thread: {
          root: item as Id<"tasks">,
          replies: msgs.length - 1,
          people: [...new Set(msgs.filter((m) => m.sender_kind === "agent").map((m) => m.sender_name))],
          lastAt: last.created_at,
          status: root?.status ?? "done",
          last: lastVM.headline,
          waiting,
          request,
        },
      });
    }
    return { name: room.name, department: room.department, entries };
  },
});

// One thread: every message, plus the actions its tasks proposed and how each was decided.
export const thread = query({
  args: { taskId: v.id("tasks") },
  returns: v.object({
    title: v.string(),
    role: v.string(),
    room: v.string(),
    status: v.string(),
    messages: v.array(vMessage),
    actions: v.array(
      v.object({
        _id: v.id("actions"),
        text: v.string(),
        by: v.string(),
        status: v.string(),
        effect: v.union(v.string(), v.null()),
        reason: v.union(v.string(), v.null()),
        rule: v.union(v.string(), v.null()),
        labels: v.array(v.object({ name: v.string(), value: v.string(), confidence: v.number() })),
      }),
    ),
  }),
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    if (!task) throw new Error("thread not found");
    const names = await displayNames(ctx);
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_thread", (q) => q.eq("thread", taskId))
      .take(300);
    const taskIds = [...new Set([taskId, ...msgs.map((m) => m.task).filter((t): t is Id<"tasks"> => !!t)])];
    const actions = [];
    for (const t of taskIds) {
      for (const a of await ctx.db.query("actions").withIndex("by_task", (q) => q.eq("task", t)).take(50)) {
        const rule = a.gate?.rule_id ? await ctx.db.get(a.gate.rule_id) : null;
        actions.push({
          _id: a._id,
          text: actionText(a.type, a.params),
          by: names.get(a.role) ?? a.role,
          status: a.status,
          effect: a.gate?.effect ?? null,
          reason: a.gate ? gateReason(a.gate.reason) : null,
          rule: rule?.text ?? null,
          labels: Object.entries(a.labels ?? {}).map(([name, l]) => ({ name, value: String(l.value), confidence: l.confidence })),
        });
      }
    }
    const room = await ctx.db.get(task.room);
    return {
      title: tidy(parseRecurringBrief(task.brief)?.title ?? clip(task.brief, 160)),
      role: names.get(task.role) ?? task.role,
      room: room?.name ?? "",
      status: task.status,
      messages: await Promise.all(msgs.map((m) => messageVM(ctx, m, names))),
      actions,
    };
  },
});

// The rulebook: every rule with how often it decided, plus the learning timeline.
export const rulebook = query({
  args: {},
  returns: v.object({
    rules: v.array(
      v.object({
        _id: v.id("rules"),
        label: v.string(),
        text: v.string(),
        actionType: v.string(),
        status: v.string(),
        version: v.number(),
        agree: v.number(),
        total: v.number(),
        supporting: v.number(),
        decided: v.number(),
        createdAt: v.number(),
        expiresAt: v.union(v.number(), v.null()),
        conditions: v.array(v.string()),
      }),
    ),
    timeline: v.array(v.object({ at: v.number(), kind: v.string(), text: v.string() })),
  }),
  handler: async (ctx) => {
    const rules = (await ctx.db.query("rules").order("desc").take(200)).filter((r) => r.status !== "revoked" || r.version > 0);
    const uses = new Map<string, number>();
    for (const a of await ctx.db.query("actions").order("desc").take(1000)) if (a.gate?.rule_id) uses.set(a.gate.rule_id, (uses.get(a.gate.rule_id) ?? 0) + 1);
    const labelOf = (r: Doc<"rules">) => /^(R\d+):/.exec(r.text)?.[1] ?? "Rule";
    const byId = new Map(rules.map((r) => [r._id as string, r]));
    const KINDS: Record<string, (d: Env, ref: string) => string> = {
      induction_started: (d) => `${Array.isArray(d.decisions) ? d.decisions.length : 0} matching decisions of yours. Asked Claude to draft a rule.`,
      rule_proposed: (d) => `Claude drafted ${(txt(d.label) || "a rule")}. It agrees with ${txt((d.agreement as Env | undefined)?.agree) || "0"} of ${txt((d.agreement as Env | undefined)?.total) || "0"} past decisions it covers, so it was sent to you.`,
      rule_rejected: (d) => `A draft was thrown out: it ${(txt(d.why) || "disagreed with a past decision")}.`,
      rule_dropped: (d) => `A draft was dropped: ${(txt(d.why) || "invalid")}.`,
      rule_approved: (_d, ref) => `You approved ${byId.get(ref) ? labelOf(byId.get(ref)!) : "a rule"}. Agents see it in their next task.`,
      rule_rejected_by_founder: (_d, ref) => `You rejected ${byId.get(ref) ? labelOf(byId.get(ref)!) : "a rule"}.`,
      rule_suspended: (d, ref) => `${byId.get(ref) ? labelOf(byId.get(ref)!) : "A rule"} was suspended: ${txt(d.why)}.`,
    };
    const audit = await ctx.db.query("audit_log").withIndex("by_at").order("desc").take(600);
    const timeline = audit
      .filter((r) => r.kind in KINDS)
      .map((r) => ({ at: r.at, kind: r.kind, text: tidy(KINDS[r.kind]((r.detail ?? {}) as Env, r.ref)) }))
      .reverse();
    return {
      rules: rules.map((r) => ({
        _id: r._id,
        label: labelOf(r),
        text: r.text.replace(/^R\d+:\s*/, ""),
        actionType: r.action_type,
        status: r.status,
        version: r.version,
        agree: r.agreement.agree,
        total: r.agreement.total,
        supporting: r.supporting_decisions.length,
        decided: uses.get(r._id) ?? 0,
        createdAt: r.created_at,
        expiresAt: r.expires_at ?? null,
        conditions: r.conditions.map(conditionText),
      })),
      timeline,
    };
  },
});
