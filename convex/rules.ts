import { convexGateway } from "@convex-dev/ai-sdk-provider";
import { Output, generateText } from "ai";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { appendMessage, audit, getConfig, notifyFounder } from "./channels";
import { decisionFeatures } from "./gate";
import { formatDigest } from "./lib/envelope";
import {
  INDUCTION_SYSTEM,
  candidateProblem,
  covers,
  diffText,
  inductionPrompt,
  inductionTarget,
  labelOf,
  nextRuleLabel,
  normalizeCandidate,
  overrides,
  replay,
  ruleCandidateSchema,
  ruleForAssign,
  ruleToSentence,
  type DecisionRow,
  type DeptOf,
  type RuleLike,
} from "./lib/rules";
import { vActionType, vDecisionChoice, type ActionType, type DecisionChoice, type Department, type Role } from "./lib/types";
import { CONFIG_DEFAULTS } from "./seed";

// Rule learning (spec 12, system-design §8). Founder decisions → Claude proposes the narrowest rule →
// replay against every covered past decision (any disagreement rejects) → founder approves the diff →
// active, enforced by the gate. Claude only drafts a candidate; replay and approval decide (invariant 2).

const MODEL = "anthropic/claude-sonnet-5.5"; // verified with health:gateway on 2026-10-24
const RULE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const INDUCTION_TIMEOUT_MS = 60_000;
const PENDING_TTL_MS = 5 * 60 * 1000; // an induction that never reports back stops blocking after this

// One induction per action type at a time: decisions landing together each schedule maybeInduce, and
// without this claim every one of them would start its own Claude call.
const pendingKey = (t: ActionType) => `induction_pending:${t}`;
async function claimInduction(ctx: MutationCtx, actionType: ActionType, now: number): Promise<boolean> {
  const row = await ctx.db
    .query("config")
    .withIndex("by_key", (q) => q.eq("key", pendingKey(actionType)))
    .unique();
  if (row && typeof row.value === "number" && now - row.value < PENDING_TTL_MS) return false;
  if (row) await ctx.db.patch(row._id, { value: now });
  else await ctx.db.insert("config", { key: pendingKey(actionType), value: now });
  return true;
}
async function releaseInduction(ctx: MutationCtx, actionType: ActionType): Promise<void> {
  const row = await ctx.db
    .query("config")
    .withIndex("by_key", (q) => q.eq("key", pendingKey(actionType)))
    .unique();
  if (row) await ctx.db.delete(row._id);
}

// ---------------------------------------------------------------- reads

async function deptOfFn(ctx: QueryCtx): Promise<DeptOf> {
  const agents = await ctx.db.query("agents").take(100);
  const map = new Map<Role, Department>(agents.map((a) => [a.role, a.department]));
  return (role) => map.get(role);
}

const toRow = (d: Doc<"decisions">): DecisionRow => ({
  id: d._id,
  action_type: d.action_type!,
  choice: d.choice,
  features: d.features && typeof d.features === "object" ? (d.features as Record<string, unknown>) : {},
  ...(d.reason ? { reason: d.reason } : {}),
});

// The founder's own decisions on actions of a type, newest first.
async function founderDecisions(ctx: QueryCtx, actionType: ActionType): Promise<DecisionRow[]> {
  const rows = await ctx.db
    .query("decisions")
    .withIndex("by_action_type", (q) => q.eq("action_type", actionType))
    .order("desc")
    .take(1000);
  return rows.filter((d) => d.decided_by === "founder" && d.subject_kind === "action").map(toRow);
}

async function rulesWithStatus(ctx: QueryCtx, actionType: ActionType, status: Doc<"rules">["status"]): Promise<Doc<"rules">[]> {
  return await ctx.db
    .query("rules")
    .withIndex("by_type_status", (q) => q.eq("action_type", actionType).eq("status", status))
    .take(200);
}

const ruleLike = (r: Doc<"rules">): RuleLike => ({ scope: r.scope, action_type: r.action_type, conditions: r.conditions, effect: r.effect });
const sameScope = (a: RuleLike["scope"], b: RuleLike["scope"]) => a.level === b.level && a.role === b.role && a.department === b.department;

// The active rule a candidate would replace: same type, scope and effect.
async function previousVersion(ctx: QueryCtx, rule: RuleLike): Promise<Doc<"rules"> | null> {
  const active = await rulesWithStatus(ctx, rule.action_type, "active");
  return active.find((r) => r.effect === rule.effect && sameScope(r.scope, rule.scope)) ?? null;
}

// ---------------------------------------------------------------- digest

// Channels a rule reaches: those with an enabled role agent the rule is in scope for.
async function roomsFor(ctx: QueryCtx, rule: Pick<Doc<"rules">, "scope" | "action_type">): Promise<Doc<"rooms">[]> {
  const agents = (await ctx.db.query("agents").take(100)).filter((a) => a.enabled && a.kind === "role");
  const names = new Set(agents.filter((a) => ruleForAssign({ status: "active", scope: rule.scope, action_type: rule.action_type }, a.role, a.department, 0)).flatMap((a) => a.rooms));
  const rooms = await ctx.db.query("rooms").take(50);
  return rooms.filter((r) => names.has(r.name));
}

// One DIGEST message (no run) listing the channel's active rules (spec 12 mirror).
export async function postRulesDigest(ctx: MutationCtx, roomId: Id<"rooms">): Promise<Id<"messages"> | null> {
  const room = await ctx.db.get(roomId);
  if (!room) return null;
  const now = Date.now();
  const agents = (await ctx.db.query("agents").take(100)).filter((a) => a.enabled && a.kind === "role" && a.rooms.includes(room.name));
  // Same relevance as the ASSIGN mirror: in scope for someone here, of a type someone here proposes.
  const active = (await ctx.db.query("rules").take(500)).filter((r) => agents.some((a) => ruleForAssign(r, a.role, a.department, now)));
  return await appendMessage(ctx, { room: room._id, sender_kind: "system", sender_name: "Dispatcher", text: formatDigest(room.name, active.map((r) => r.text)) });
}

async function digestAffected(ctx: MutationCtx, rule: Pick<Doc<"rules">, "scope" | "action_type">): Promise<number> {
  const rooms = await roomsFor(ctx, rule);
  for (const r of rooms) await postRulesDigest(ctx, r._id);
  return rooms.length;
}

export const postDigest = internalMutation({
  args: { roomId: v.id("rooms") },
  returns: v.union(v.null(), v.id("messages")),
  handler: (ctx, { roomId }) => postRulesDigest(ctx, roomId),
});

// ---------------------------------------------------------------- induction

// Scheduled after each founder decision: enough uncovered decisions in one direction start an induction.
export const maybeInduce = internalMutation({
  args: { actionType: vActionType },
  returns: v.boolean(),
  handler: async (ctx, { actionType }) => {
    if ((await rulesWithStatus(ctx, actionType, "proposed")).length) return false; // one awaiting review at a time
    const min = await getConfig(ctx, "induction_min", CONFIG_DEFAULTS.induction_min);
    const target = inductionTarget(await founderDecisions(ctx, actionType), (await rulesWithStatus(ctx, actionType, "active")).map(ruleLike), await deptOfFn(ctx), min);
    if (!target || !(await claimInduction(ctx, actionType, Date.now()))) return false;
    await audit(ctx, { actor: "rules", kind: "induction_started", ref: actionType, detail: { choice: target.choice, decisions: target.decisions.map((d) => d.id) } });
    await ctx.scheduler.runAfter(0, internal.rules.induceRule, { actionType });
    return true;
  },
});

export const inductionInput = internalQuery({
  args: { actionType: vActionType },
  returns: v.union(v.null(), v.object({ choice: vDecisionChoice, decisions: v.array(v.string()), prompt: v.string() })),
  handler: async (ctx, { actionType }) => {
    const min = (await ctx.db.query("config").withIndex("by_key", (q) => q.eq("key", "induction_min")).unique())?.value ?? CONFIG_DEFAULTS.induction_min;
    const active = await rulesWithStatus(ctx, actionType, "active");
    const target = inductionTarget(await founderDecisions(ctx, actionType), active.map(ruleLike), await deptOfFn(ctx), typeof min === "number" ? min : CONFIG_DEFAULTS.induction_min);
    if (!target) return null;
    return {
      choice: target.choice,
      decisions: target.decisions.map((d) => d.id),
      prompt: inductionPrompt({ actionType, choice: target.choice, decisions: target.decisions, activeRules: active.map((r) => r.text) }),
    };
  },
});

// Claude drafts a candidate with structured output; anything it cannot produce is dropped with an audit row.
export const induceRule = internalAction({
  args: { actionType: vActionType },
  returns: v.null(),
  handler: async (ctx, { actionType }) => {
    const input = await ctx.runQuery(internal.rules.inductionInput, { actionType });
    if (!input) {
      await ctx.runMutation(internal.rules.dropCandidate, { actionType, why: "nothing left to induce" });
      return null;
    }
    let candidate: unknown;
    let cost: number | undefined;
    try {
      const result = await generateText({
        model: convexGateway(MODEL),
        system: INDUCTION_SYSTEM,
        prompt: input.prompt,
        output: Output.object({ schema: ruleCandidateSchema, name: "rule" }),
        abortSignal: AbortSignal.timeout(INDUCTION_TIMEOUT_MS),
        maxRetries: 1,
      });
      candidate = result.output;
      const meta = result.providerMetadata?.convexGateway as { cost?: unknown } | undefined;
      cost = typeof meta?.cost === "number" ? meta.cost : undefined;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      await ctx.runMutation(internal.rules.dropCandidate, { actionType, why: `claude: ${why.slice(0, 300)}` });
      return null;
    }
    await ctx.runMutation(internal.rules.proposeRule, { actionType, choice: input.choice, candidate, ...(cost !== undefined ? { cost_usd: cost } : {}) });
    return null;
  },
});

export const dropCandidate = internalMutation({
  args: { actionType: vActionType, why: v.string() },
  returns: v.null(),
  handler: async (ctx, { actionType, why }) => {
    await releaseInduction(ctx, actionType);
    await audit(ctx, { actor: "rules", kind: "rule_dropped", ref: actionType, detail: { why } });
    return null;
  },
});

const vProposeResult = v.union(
  v.object({ ok: v.literal(true), ruleId: v.id("rules"), agree: v.number(), total: v.number() }),
  v.object({ ok: v.literal(false), why: v.string(), counterexamples: v.array(v.string()) }),
);

// Validates a candidate (schema, fields, direction), replays it against every founder decision of the type,
// and only on 100% agreement stores it as `proposed` with a founder inbox item showing the diff.
export const proposeRule = internalMutation({
  args: { actionType: vActionType, choice: vDecisionChoice, candidate: v.any(), cost_usd: v.optional(v.number()) },
  returns: vProposeResult,
  handler: async (ctx, a) => {
    await releaseInduction(ctx, a.actionType);
    return await proposeCandidate(ctx, a);
  },
});

export async function proposeCandidate(
  ctx: MutationCtx,
  a: { actionType: ActionType; choice: DecisionChoice; candidate: unknown; cost_usd?: number },
): Promise<{ ok: true; ruleId: Id<"rules">; agree: number; total: number } | { ok: false; why: string; counterexamples: string[] }> {
  const reject = async (kind: "rule_dropped" | "rule_rejected", why: string, extra: Record<string, unknown> = {}) => {
    await audit(ctx, { actor: "rules", kind, ref: a.actionType, detail: { why, candidate: a.candidate ?? null, cost_usd: a.cost_usd ?? null, ...extra } });
    return { ok: false as const, why, counterexamples: (extra.counterexamples as string[] | undefined) ?? [] };
  };
  const parsed = ruleCandidateSchema.safeParse(a.candidate);
  if (!parsed.success) return await reject("rule_dropped", `schema: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const decisions = await founderDecisions(ctx, a.actionType);
  const problem = candidateProblem(parsed.data, a.actionType, a.choice, decisions);
  if (problem) return await reject("rule_dropped", problem);

  const rule = normalizeCandidate(parsed.data);
  const deptOf = await deptOfFn(ctx);
  const result = replay(rule, decisions, deptOf);
  const min = await getConfig(ctx, "induction_min", CONFIG_DEFAULTS.induction_min);
  const agreement = { agree: result.agree, total: result.total };
  if (result.counterexamples.length) return await reject("rule_rejected", "contradicts past founder decisions", { agreement, counterexamples: result.counterexamples });
  if (result.total < min) return await reject("rule_rejected", `covers only ${result.total} decisions (needs ${min})`, { agreement, counterexamples: [] });

  const now = Date.now();
  const label = nextRuleLabel((await ctx.db.query("rules").take(1000)).map((r) => r.text));
  const previous = await previousVersion(ctx, rule);
  const supporting = result.covered.map((id) => ctx.db.normalizeId("decisions", id)).filter((id): id is Id<"decisions"> => id !== null);
  const ruleId = await ctx.db.insert("rules", {
    ...rule,
    status: "proposed",
    version: 0, // set on approval
    supporting_decisions: supporting,
    agreement,
    text: ruleToSentence(rule, label),
    expires_at: now + RULE_TTL_MS,
    created_at: now,
  });
  const diff = diffText(rule, { label, ...(previous ? { previous: { ...ruleLike(previous), label: labelOf(previous.text) } } : {}), agreement });
  await notifyFounder(ctx, {
    kind: "rule",
    ref: ruleId,
    title: `Approve rule ${label} for ${a.actionType}?`,
    body: [diff, ...(parsed.data.rationale ? ["", `Why: ${parsed.data.rationale}`] : []), "", `Expires in 30 days unless renewed.`].join("\n"),
    options: [{ label: "Approve" }, { label: "Reject" }],
  });
  await audit(ctx, { actor: "rules", kind: "rule_proposed", ref: a.actionType, detail: { ruleId, label, agreement, supporting: supporting.length, cost_usd: a.cost_usd ?? null } });
  return { ok: true, ruleId, ...agreement };
}

// ---------------------------------------------------------------- lifecycle

// The founder's answer to a `rule` inbox item (inbox.decide routes here): approve activates, deny revokes.
export async function decideRule(ctx: MutationCtx, item: Doc<"founder_inbox">, choice: DecisionChoice, reason?: string): Promise<{ digests: number }> {
  const ruleId = ctx.db.normalizeId("rules", item.ref);
  const rule = ruleId ? await ctx.db.get(ruleId) : null;
  if (!rule) throw new Error(`inbox item ${item._id} has no rule`);
  if (rule.status !== "proposed") throw new Error(`rule ${rule._id} is ${rule.status}, not proposed`);
  const now = Date.now();
  await ctx.db.insert("decisions", {
    subject_kind: "rule",
    rule: rule._id,
    action_type: rule.action_type,
    choice,
    ...(reason ? { reason } : {}),
    features: { agree: rule.agreement.agree, total: rule.agreement.total },
    decided_by: "founder",
    created_at: now,
  });
  await ctx.db.patch(item._id, { status: "decided", decision: { choice, ...(reason ? { reason } : {}), at: now } });
  if (choice === "deny") {
    await ctx.db.patch(rule._id, { status: "revoked" });
    await audit(ctx, { actor: "founder", kind: "rule_rejected_by_founder", ref: rule._id, detail: { reason: reason ?? null } });
    return { digests: 0 };
  }
  const previous = await previousVersion(ctx, ruleLike(rule));
  if (previous) await ctx.db.patch(previous._id, { status: "revoked" });
  await ctx.db.patch(rule._id, { status: "active", version: (previous?.version ?? 0) + 1, expires_at: now + RULE_TTL_MS });
  const digests = await digestAffected(ctx, rule);
  await audit(ctx, { actor: "founder", kind: "rule_approved", ref: rule._id, detail: { replaced: previous?._id ?? null, version: (previous?.version ?? 0) + 1, digests } });
  return { digests };
}

async function suspend(ctx: MutationCtx, rule: Doc<"rules">, why: string): Promise<void> {
  if (rule.status !== "active") return;
  await ctx.db.patch(rule._id, { status: "suspended" });
  await audit(ctx, { actor: "founder", kind: "rule_suspended", ref: rule._id, detail: { why } });
  await digestAffected(ctx, rule);
  await ctx.scheduler.runAfter(0, internal.rules.maybeInduce, { actionType: rule.action_type });
}

// Spec 12 override: a founder decision against an active rule that covers it suspends the rule, in the
// caller's mutation (recordFounderDecision). Returns how many were suspended.
export async function suspendOverriddenRules(ctx: MutationCtx, actionType: ActionType, decision: DecisionRow): Promise<number> {
  const deptOf = await deptOfFn(ctx);
  let n = 0;
  for (const r of await rulesWithStatus(ctx, actionType, "active")) {
    if (covers(ruleLike(r), decision, deptOf) && overrides(r.effect, decision.choice)) {
      await suspend(ctx, r, `founder ${decision.choice === "approve" ? "approved" : "denied"} decision ${decision.id} against it`);
      n++;
    }
  }
  return n;
}

// The founder disagrees with an action a rule already allowed (Activity page): a deny decision, and the rule suspended.
export const overrideAllowed = mutation({
  args: { actionId: v.id("actions"), reason: v.optional(v.string()) },
  returns: v.object({ suspended: v.number() }),
  handler: async (ctx, { actionId, reason }) => {
    const action = await ctx.db.get(actionId);
    if (!action || action.gate?.effect !== "allow" || !action.gate.rule_id) throw new Error(`action ${actionId} was not allowed by a rule`);
    const now = Date.now();
    const features = await decisionFeatures(ctx, action, now);
    const decisionId = await ctx.db.insert("decisions", {
      subject_kind: "action",
      action: actionId,
      action_type: action.type,
      choice: "deny",
      ...(reason?.trim() ? { reason: reason.trim() } : {}),
      features,
      decided_by: "founder",
      created_at: now,
    });
    const rule = await ctx.db.get(action.gate.rule_id);
    const wasActive = rule?.status === "active";
    if (rule) await suspend(ctx, rule, `founder overrode action ${actionId} it allowed`);
    await audit(ctx, { actor: "founder", kind: "rule_override", ref: action.task, detail: { actionId, decisionId, ruleId: action.gate.rule_id } });
    return { suspended: wasActive ? 1 : 0 };
  },
});

export const suspendRule = mutation({
  args: { ruleId: v.id("rules"), reason: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { ruleId, reason }) => {
    const rule = await ctx.db.get(ruleId);
    if (!rule) throw new Error(`rule ${ruleId} not found`);
    await suspend(ctx, rule, reason?.trim() || "suspended by the founder");
    return null;
  },
});

// Rules page (spec 14): proposed, active and suspended rules, newest first.
export const list = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("rules"),
      action_type: vActionType,
      status: v.string(),
      text: v.string(),
      version: v.number(),
      agreement: v.object({ agree: v.number(), total: v.number() }),
      expires_at: v.union(v.number(), v.null()),
    }),
  ),
  handler: async (ctx) =>
    (await ctx.db.query("rules").order("desc").take(200))
      .filter((r) => r.status === "proposed" || r.status === "active" || r.status === "suspended")
      .map((r) => ({ _id: r._id, action_type: r.action_type, status: r.status, text: r.text, version: r.version, agreement: r.agreement, expires_at: r.expires_at ?? null })),
});
