import { z } from "zod";
import {
  ACTION_TYPES,
  ISSUE_KINDS,
  MESSAGE_TYPES,
  ROLES,
  type ActionType,
  type DecisionChoice,
  type Decider,
  type Role,
  type TaskKind,
} from "./types";

// Message protocol (spec 03): parse agent envelopes, format Dispatcher messages. Pure, no I/O.

export const MANAGER_ROLES: readonly Role[] = ["cofounder", "marketing_manager", "customer_manager", "finance_manager"];
const MAX_ACTIONS = 5;
const MAX_SUMMARY = 500;
const MAX_COMPANY_BLOCK = 1500;

const text = z.string().min(1);
const cents = z.number().int().min(0);

// Minimum params per action type; extra params are kept (looseObject).
const ACTION_PARAMS: Record<ActionType, z.ZodType> = {
  refund: z.looseObject({ customer_id: text, amount_cents: cents, reason: text, ticket_id: text.optional() }),
  refund_batch: z.looseObject({
    items: z.array(z.looseObject({ customer_id: text, amount_cents: cents })).min(1),
    reason: text,
  }),
  pay_bill: z.looseObject({ merchant: text, amount_cents: cents, due_date: text }),
  reply_customer: z.looseObject({ ticket_id: text, body: text }),
  publish_post: z.looseObject({ channel: text, text }),
  file_bug: z.looseObject({ title: text, body: text, severity: text }),
  schedule_digest: z.looseObject({ when_hint: text }),
  switch_vendor: z.looseObject({ from_vendor: text, to_vendor: text, monthly_impact_cents: cents }),
  marketing_spend: z.looseObject({ channel: text, amount_cents: cents, duration_days: z.number().int().min(1) }),
  price_change: z.looseObject({ plan: text, new_price_cents: cents }),
};

const proposedAction = z.object({
  type: z.enum(ACTION_TYPES),
  params: z.record(z.string(), z.unknown()),
  rationale: z.string(),
});

const decisionPackage = z.object({
  situation: text,
  evidence: z.array(z.string()),
  attempts: z.array(z.string()),
  options: z.array(z.object({ label: text, action: z.unknown().optional() })).min(1),
  recommendation: text,
});

// A REPORT may also raise an issue: the agent finished its task but saw a problem beyond its role (spec 09).
const reportIssue = z.object({
  kind: z.enum(ISSUE_KINDS),
  summary: z.string().min(1).max(MAX_SUMMARY),
  attempts: z.array(z.string()).min(1),
});

// Unknown top-level fields are ignored (stripped).
const envelopeSchema = z.object({
  type: z.enum(MESSAGE_TYPES),
  task: text,
  from: z.enum(ROLES),
  summary: z.string().min(1).max(MAX_SUMMARY),
  findings: z.array(z.object({ claim: text, evidence: text })).optional(),
  proposed_actions: z.array(proposedAction).max(MAX_ACTIONS).optional(),
  to_role: z.enum(ROLES).optional(),
  brief: text.optional(),
  kind: z.enum(ISSUE_KINDS).optional(),
  need: z.enum(ISSUE_KINDS).optional(),
  attempts: z.array(z.string()).optional(),
  refs: z.array(z.string()).optional(),
  package: decisionPackage.optional(),
  issue: reportIssue.optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export type Envelope = z.infer<typeof envelopeSchema>;
export type ProposedAction = z.infer<typeof proposedAction>;
export type ParseResult = { ok: true; env: Envelope } | { ok: false; error: string };

const ACTION_CARRIERS = new Set(["REPORT", "ESCALATE", "DECISION"]);

function fieldPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>(
    (out, key) => (typeof key === "number" ? `${out}[${key}]` : out ? `${out}.${String(key)}` : String(key)),
    "",
  );
}

function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let cur = root;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[key];
  }
  return cur;
}

// One sentence naming the field, used verbatim in the REPAIR.
function describeIssue(issue: z.core.$ZodIssue, root: unknown): string {
  const field = fieldPath(issue.path);
  const name = `Field "${field}"`;
  if (valueAt(root, issue.path) === undefined) return `${name} is required.`;
  if (field.endsWith("_cents")) return `${name} must be a non-negative integer number of cents.`;
  switch (issue.code) {
    case "invalid_value":
      return `${name} must be one of: ${issue.values.map(String).join(", ")}.`;
    case "too_big":
      return issue.origin === "array"
        ? `${name} has too many items (at most ${String(issue.maximum)}).`
        : issue.origin === "string"
          ? `${name} must be at most ${String(issue.maximum)} characters.`
          : `${name} must be at most ${String(issue.maximum)}.`;
    case "too_small":
      return issue.origin === "array"
        ? `${name} needs at least ${String(issue.minimum)} item(s).`
        : issue.origin === "string"
          ? `${name} must not be empty.`
          : `${name} must be at least ${String(issue.minimum)}.`;
    case "invalid_type": {
      const expected = issue.expected === "int" ? "integer" : issue.expected;
      return `${name} must be ${/^[aeiou]/.test(expected) ? "an" : "a"} ${expected}.`;
    }
    default:
      return `${name} is invalid.`;
  }
}

// The envelope is the LAST fenced block whose info string is exactly "cofounder".
export function extractEnvelopeBlock(message: string): string | null {
  const fence = /```[ \t]*([^\n`]*)\r?\n([\s\S]*?)```/g;
  let last: string | null = null;
  for (const match of message.matchAll(fence)) {
    if (match[1].trim() === "cofounder") last = match[2];
  }
  return last;
}

export function parseEnvelope(
  message: string,
  expected: { taskId: string; role: Role; kind?: TaskKind },
): ParseResult {
  const fail = (error: string): ParseResult => ({ ok: false, error });

  const block = extractEnvelopeBlock(message);
  if (block === null) {
    return fail('No envelope found: end your reply with one fenced block whose info string is "cofounder".');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch {
    return fail("The cofounder envelope is not valid JSON, so resend it as one JSON object.");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("The cofounder envelope must be a JSON object with type, task, from and summary.");
  }

  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) return fail(describeIssue(parsed.error.issues[0], raw));
  const env = parsed.data;

  if (env.task !== expected.taskId) {
    return fail(`Field "task" must be "${expected.taskId}" (the task id from your ASSIGN), not "${env.task}".`);
  }
  if (env.from !== expected.role) {
    return fail(`Field "from" must be "${expected.role}", not "${env.from}".`);
  }

  switch (env.type) {
    case "ASSIGN":
      return fail('Field "type" cannot be ASSIGN because only the Dispatcher sends ASSIGN.');
    case "HANDOFF":
      if (!env.to_role) return fail('Field "to_role" is required for HANDOFF.');
      if (!env.brief) return fail('Field "brief" is required for HANDOFF.');
      break;
    case "ISSUE":
      if (!env.kind) return fail('Field "kind" is required for ISSUE.');
      if (!env.attempts?.length) return fail('Field "attempts" needs at least one entry for ISSUE.');
      break;
    case "ESCALATE":
      if (!env.need) return fail('Field "need" is required for ESCALATE.');
      if (!env.attempts?.length) return fail('Field "attempts" needs at least one entry for ESCALATE.');
      break;
    case "OBJECT":
      if (!env.findings?.length) return fail('Field "findings" needs at least one finding with evidence for OBJECT.');
      if (!env.refs?.length) return fail('Field "refs" must reference the message you object to for OBJECT.');
      break;
    case "DECISION":
      if (!MANAGER_ROLES.includes(env.from)) {
        return fail(`Field "type" cannot be DECISION for role "${env.from}" because only managers and the Cofounder decide.`);
      }
      break;
    case "REPORT":
      if (expected.kind === "package" && !env.package) {
        return fail('Field "package" is required in a REPORT on a package task.');
      }
      break;
  }

  // Only REPORT, ESCALATE and DECISION carry actions, and only REPORT carries an issue; elsewhere they are ignored.
  if (!ACTION_CARRIERS.has(env.type)) delete env.proposed_actions;
  if (env.type !== "REPORT") delete env.issue;

  for (const [i, action] of (env.proposed_actions ?? []).entries()) {
    const params = ACTION_PARAMS[action.type].safeParse(action.params);
    if (!params.success) {
      const issue = params.error.issues[0];
      return fail(
        describeIssue({ ...issue, path: ["proposed_actions", i, "params", ...issue.path] }, raw),
      );
    }
  }

  return { ok: true, env };
}

// ---------------------------------------------------------------- Dispatcher → agent messages

export type CompanyProfile = {
  name: string;
  product: string;
  description?: string;
  plans: { name: string; price_cents: number; period: string }[];
  customer_type?: string;
  voice?: string;
  policies?: string[];
};

export type CompanyBlock = {
  name: string;
  product: string;
  plans: { name: string; price_cents: number; period: string }[];
  customer_type?: string;
  voice?: string;
  policies?: string[];
};

// Compact company summary for every ASSIGN (≤ 1,500 chars); agents fetch the rest with `co data company`.
export function companyBlock(profile: CompanyProfile): CompanyBlock {
  const block: CompanyBlock = {
    name: profile.name,
    product: profile.product,
    plans: [...profile.plans],
    ...(profile.customer_type ? { customer_type: profile.customer_type } : {}),
    ...(profile.voice ? { voice: profile.voice } : {}),
    ...(profile.policies?.length ? { policies: [...profile.policies] } : {}),
  };
  const size = () => JSON.stringify(block).length;
  while (size() > MAX_COMPANY_BLOCK && block.policies?.length) block.policies.pop();
  if (block.policies?.length === 0) delete block.policies;
  while (size() > MAX_COMPANY_BLOCK && block.plans.length > 1) block.plans.pop();
  return block;
}

export type AssignArgs = {
  mention: string; // agent display name
  taskId: string;
  role: Role;
  brief: string;
  token: string;
  company: CompanyBlock;
  rules: string[];
  dataHints: string[];
  refs: string[];
  headline?: string; // human line; defaults to the brief's first line
};

const REPLY_RULE =
  "End your reply with exactly one cofounder envelope: a fenced block whose info string is cofounder, written out in full in this reply. Never describe or summarize an envelope instead of writing it. Never address other agents directly.";

function oneLine(s: string, max = 200): string {
  const line = s.replace(/`/g, "'").split(/\r?\n/)[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// JSON inside a fence; backticks are escaped so no string can close the fence early.
function fenced(block: Record<string, unknown>): string {
  return "```cofounder\n" + JSON.stringify(block).replace(/`/g, "\\u0060") + "\n```";
}

function assignBlock(a: AssignArgs, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "ASSIGN",
    task: a.taskId,
    to: a.role,
    company: a.company,
    brief: a.brief,
    token: a.token,
    rules_in_scope: a.rules,
    data_hints: a.dataHints,
    reply: REPLY_RULE,
    refs: a.refs,
    ...extra,
  };
}

export function formatAssign(a: AssignArgs): string {
  return `[Dispatcher] @${a.mention} New task ${a.taskId}: ${oneLine(a.headline ?? a.brief)}\n\n${fenced(assignBlock(a))}`;
}

// A repair is a full ASSIGN for the same task (agents only answer full ASSIGNs, verified 2026-10-24).
export function formatRepair(a: AssignArgs & { attempt: number; error: string }): string {
  const brief = `Your previous envelope for this task was invalid: ${a.error} Resend only a corrected cofounder envelope for the same task. Original brief: ${a.brief}`;
  return (
    `[Dispatcher] @${a.mention} Repair on task ${a.taskId} (attempt ${a.attempt}): your envelope was invalid. ${oneLine(a.error)}\n\n` +
    fenced(assignBlock({ ...a, brief }, { attempt: a.attempt, repair: a.error }))
  );
}

// A nudge is a full ASSIGN re-sent once when no reply arrived before the task's deadline (spec 05).
export function formatNudge(a: AssignArgs & { attempt: number; note: string }): string {
  return (
    `[Dispatcher] @${a.mention} Reminder on task ${a.taskId} (attempt ${a.attempt}): ${oneLine(a.note)}\n\n` +
    fenced(assignBlock(a, { attempt: a.attempt, nudge: a.note }))
  );
}

export function formatHandoffAssign(
  a: AssignArgs & { fromName: string; sourceRef: string; sourceSummary: string },
): string {
  const refs = a.refs.includes(a.sourceRef) ? a.refs : [a.sourceRef, ...a.refs];
  const brief = `${a.brief}\n\nHandoff from ${a.fromName} (${a.sourceRef}): "${a.sourceSummary}"`;
  return (
    `[Dispatcher] @${a.mention} New task ${a.taskId} (handoff from ${a.fromName}): ${oneLine(a.headline ?? a.brief)}\n\n` +
    fenced(assignBlock({ ...a, brief, refs }))
  );
}

export function formatDecision(d: {
  taskId: string;
  decidedBy: Decider;
  choice: DecisionChoice;
  note: string;
  proposedActions?: ProposedAction[];
}): string {
  return (
    `[Dispatcher] Decision on ${d.taskId}: ${d.choice} by ${d.decidedBy}. ${oneLine(d.note)}\n\n` +
    fenced({
      type: "DECISION",
      task: d.taskId,
      decided_by: d.decidedBy,
      choice: d.choice,
      note: d.note,
      ...(d.proposedActions?.length ? { proposed_actions: d.proposedActions } : {}),
    })
  );
}

export function formatDigest(room: string, rules: string[]): string {
  const count = rules.length === 1 ? "1 active rule" : `${rules.length} active rules`;
  return `[Dispatcher] Rules digest for ${room}: ${count}.\n\n${fenced({ type: "DIGEST", room, rules })}`;
}
