import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { appendMessage, audit } from "./channels";
import { assign, rerun } from "./dispatcher";
import { scheduleExecution } from "./executor";
import { currentBudget, decisionFeatures, gateAction } from "./gate";
import { CATALOG } from "./lib/catalog";
import { CO_VIEWS, canRead } from "./lib/co";
import { MANAGER_ROLES, formatDecision, type Envelope, type ProposedAction } from "./lib/envelope";
import type { ActionType, DecisionChoice, IssueKind, Role } from "./lib/types";
import { suspendOverriddenRules } from "./rules";
import { insertTask, proposeActions, transition } from "./tasks";

// Issue ladder (spec 09, system-design §7): employee → manager → founder. Managers are woken by a new
// run in the employee's thread; only what no rule grants reaches the founder, as one Cofounder package.

const GROUP_WINDOW_MS = 2 * 60 * 60 * 1000; // related issues in a channel within 2 hours are grouped
const OPEN_TASK: readonly Doc<"tasks">["status"][] = ["queued", "assigned", "repairing"];
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export async function managerOf(ctx: MutationCtx, role: Role): Promise<Role | undefined> {
  const agent = await agentFor(ctx, role);
  return agent?.manager_role;
}

async function agentFor(ctx: MutationCtx, role: Role): Promise<Doc<"agents"> | null> {
  return await ctx.db
    .query("agents")
    .withIndex("by_role", (q) => q.eq("role", role))
    .unique();
}

async function roomNamed(ctx: MutationCtx, name: string): Promise<Doc<"rooms"> | null> {
  return await ctx.db
    .query("rooms")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
}

const threadOf = (task: Doc<"tasks">): Id<"tasks"> => task.thread ?? task._id;

async function note(ctx: MutationCtx, task: Doc<"tasks">, text: string): Promise<void> {
  await appendMessage(ctx, { room: task.room, task: task._id, sender_kind: "system", sender_name: "Dispatcher", text: `[Dispatcher] ${text}` });
}

// ---------------------------------------------------------------- raise and climb

export type RaiseOptions = {
  kind: IssueKind;
  summary: string;
  attempts: string[];
  evidence: string[];
  raisedBy?: Role; // defaults to the task's role
  toRole?: Role | null; // defaults to the raiser's manager; null = the founder
  proposedActions?: ProposedAction[]; // an ESCALATE's actions, gated at manager level
  fromEnvelope?: boolean; // raised by the agent (ISSUE / ESCALATE), not by the Dispatcher
};

export async function raiseIssue(ctx: MutationCtx, task: Doc<"tasks">, issue: RaiseOptions): Promise<Id<"issues">> {
  const raisedBy = issue.raisedBy ?? task.role;
  const toRole = issue.toRole === null ? undefined : (issue.toRole ?? (await managerOf(ctx, raisedBy)));
  const issueId = await ctx.db.insert("issues", {
    task: task._id,
    chain_id: task.chain_id,
    raised_by_role: raisedBy,
    ...(toRole ? { to_role: toRole } : {}),
    level: MANAGER_ROLES.includes(raisedBy) ? "manager" : "employee",
    kind: issue.kind,
    summary: issue.summary,
    attempts: issue.attempts,
    evidence: issue.evidence,
    status: "open",
    created_at: Date.now(),
  });
  await audit(ctx, {
    actor: raisedBy,
    kind: "issue_raised",
    ref: task._id,
    detail: { issueId, kind: issue.kind, toRole: toRole ?? "founder", chain: task.chain_id },
  });
  await climb(ctx, (await ctx.db.get(issueId))!, task, issue);
  return issueId;
}

// One step up the ladder for a new issue.
async function climb(ctx: MutationCtx, issue: Doc<"issues">, task: Doc<"tasks">, opts: RaiseOptions): Promise<void> {
  if (issue.level === "employee") {
    if (issue.kind === "information" && opts.fromEnvelope && issue.attempts.length < 2 && !(await hadInformationIssue(ctx, issue))) {
      return await returnToEmployee(ctx, issue, task);
    }
    return issue.to_role ? await toManagerTask(ctx, issue, task) : await requestPackage(ctx, issue, task, []);
  }
  // Manager level.
  switch (issue.kind) {
    case "authority":
      return await gateForFounder(ctx, issue, task, opts.proposedActions ?? []);
    case "capability":
      return await fileBug(ctx, issue, task, opts.proposedActions ?? []);
    default:
      // Coordination / information a manager cannot settle goes to the Cofounder, and from the Cofounder to the founder.
      return issue.to_role && issue.raised_by_role !== "cofounder" ? await toManagerTask(ctx, issue, task) : await requestPackage(ctx, issue, task, []);
  }
}

async function hadInformationIssue(ctx: MutationCtx, issue: Doc<"issues">): Promise<boolean> {
  const onTask = await ctx.db
    .query("issues")
    .withIndex("by_task", (q) => q.eq("task", issue.task))
    .take(50);
  return onTask.some((i) => i._id !== issue._id && i.kind === "information");
}

// An employee missing data gets one more try at its own level, with the co views it can read.
async function returnToEmployee(ctx: MutationCtx, issue: Doc<"issues">, task: Doc<"tasks">): Promise<void> {
  const views = CO_VIEWS.filter((v) => canRead(task.role, v));
  const hint = `You raised an information issue ("${clip(issue.summary, 200)}"). Try once more with the data you can read: ${views
    .map((v) => `co data ${v}`)
    .join(", ")}. If the data really is not there, send ISSUE again.`;
  await ctx.db.patch(issue._id, { status: "resolved", resolution: "returned to the employee once with data hints" });
  const reopened = await transition(ctx, task, "assigned", "information_retry", { issueId: issue._id });
  await rerun(ctx, reopened._id, "nudge", hint);
  await audit(ctx, { actor: "dispatcher", kind: "issue_returned", ref: task._id, detail: { issueId: issue._id } });
}

async function relatedOpenIssues(ctx: MutationCtx, room: Id<"rooms">, except: Id<"issues">): Promise<Doc<"issues">[]> {
  const since = Date.now() - GROUP_WINDOW_MS;
  const out: Doc<"issues">[] = [];
  for (const status of ["open", "escalated"] as const) {
    const rows = await ctx.db
      .query("issues")
      .withIndex("by_status", (q) => q.eq("status", status))
      .order("desc")
      .take(200);
    for (const i of rows) {
      if (i._id === except || i.created_at < since) continue;
      const t = await ctx.db.get(i.task);
      if (t?.room === room) out.push(i);
    }
  }
  return out;
}

async function issueAssignBrief(ctx: MutationCtx, issue: Doc<"issues">, task: Doc<"tasks">, related: Doc<"issues">[]): Promise<string> {
  const raiser = (await agentFor(ctx, issue.raised_by_role))?.display_name ?? issue.raised_by_role;
  const room = (await ctx.db.get(task.room))?.name ?? "";
  const messageId = issue.evidence[0] ? ctx.db.normalizeId("messages", issue.evidence[0]) : null;
  const message = messageId ? await ctx.db.get(messageId) : null;
  const lines = [
    `${raiser} raised an issue (${issue.kind}) on task ${task._id} in ${room}: "${issue.summary}"`,
    `Attempts: ${issue.attempts.length ? issue.attempts.join("; ") : "none"}`,
    ...(issue.evidence.length ? [`Evidence: ${issue.evidence.join(", ")}`] : []),
    ...(message ? [`Their message:\n${clip(message.text, 1500)}`] : []),
  ];
  if (related.length) {
    lines.push(`Related open issues in ${room} (last 2 hours):`);
    for (const r of related.slice(0, 10)) lines.push(`- issue ${r._id} on task ${r.task} (${r.raised_by_role}, ${r.kind}): ${clip(r.summary, 200)}`);
  }
  lines.push(
    `Read the full thread: co data thread --id ${threadOf(task)}`,
    "Group related issues into one. Then REPORT or DECISION if you can settle it, HANDOFF to the department that can, or ESCALATE (need authority or capability) with proposed_actions.",
  );
  return lines.join("\n");
}

// Wakes the manager with a new run in the employee's thread, or groups the issue onto the manager's open task.
async function toManagerTask(ctx: MutationCtx, issue: Doc<"issues">, task: Doc<"tasks">): Promise<void> {
  const role = issue.to_role!;
  const agent = await agentFor(ctx, role);
  if (!agent?.enabled || agent.kind !== "role") return await requestPackage(ctx, issue, task, []);
  const now = Date.now();

  const recent = await ctx.db
    .query("tasks")
    .withIndex("by_role", (q) => q.eq("role", role))
    .order("desc")
    .take(100);
  const open = recent.find((t) => t.kind === "issue" && OPEN_TASK.includes(t.status) && t.room === task.room && t.created_at >= now - GROUP_WINDOW_MS);
  if (open) {
    await ctx.db.patch(issue._id, { handler_task: open._id, level: "manager", status: "escalated" });
    await note(ctx, task, `Issue ${issue._id} is grouped with ${agent.display_name}'s open task ${open._id}.`);
    await audit(ctx, { actor: "dispatcher", kind: "issue_grouped", ref: task._id, detail: { issueId: issue._id, handlerTask: open._id } });
    return;
  }

  const related = await relatedOpenIssues(ctx, task.room, issue._id);
  const taskId = await insertTask(ctx, {
    role,
    room: task.room,
    kind: "issue",
    brief: await issueAssignBrief(ctx, issue, task, related),
    parent_task: task._id,
    ...(task.event ? { event: task.event } : {}),
    chain_id: task.chain_id,
    hop: task.hop, // climbing the ladder is not a handoff hop
    origin_refs: [threadOf(task), ...issue.evidence.filter((e) => e !== threadOf(task))].slice(0, 10),
    mode: task.mode,
    thread: threadOf(task),
    issue: issue._id,
  });
  await ctx.db.patch(issue._id, { handler_task: taskId, level: "manager", status: "escalated" });
  await assign(ctx, taskId);
  await audit(ctx, { actor: "dispatcher", kind: "issue_escalated", ref: task._id, detail: { issueId: issue._id, to: role, handlerTask: taskId, related: related.length } });
}

// Authority at manager level: Jev labels each proposed action (spec 11), then the gate decides each one;
// what it escalates goes to the founder.
async function gateForFounder(ctx: MutationCtx, issue: Doc<"issues">, task: Doc<"tasks">, proposed: ProposedAction[]): Promise<void> {
  const actionIds = await proposeActions(ctx, task, proposed);
  if (actionIds.length === 0) return await requestPackage(ctx, issue, task, []);
  await ctx.scheduler.runAfter(0, internal.labels.labelActions, { actionIds, then: { kind: "founder", issueId: issue._id, taskId: task._id } });
}

export async function gateLabeledForFounder(ctx: MutationCtx, issueId: Id<"issues">, taskId: Id<"tasks">, actionIds: Id<"actions">[]): Promise<void> {
  const [issue, task] = [await ctx.db.get(issueId), await ctx.db.get(taskId)];
  if (!issue || !task || issue.status === "resolved") return;
  const escalated: Id<"actions">[] = [];
  const outcomes: string[] = [];
  for (const id of actionIds) {
    const out = await gateAction(ctx, id, { inbox: false });
    const action = (await ctx.db.get(id))!;
    outcomes.push(`${action.type}: ${out?.effect ?? action.status}`);
    if (action.status === "escalated") escalated.push(id);
  }
  if (escalated.length || actionIds.length === 0) return await requestPackage(ctx, issue, task, escalated);
  await settleHandledIssues(ctx, task, `The gate decided under existing rules: ${outcomes.join(", ")}.`);
  await transition(ctx, task, "done", "gate_resolved", { issueId: issue._id });
}

// Capability at manager level: a defect no agent can fix becomes a Linear bug through the gate (spec 10 executes).
async function fileBug(ctx: MutationCtx, issue: Doc<"issues">, task: Doc<"tasks">, proposed: ProposedAction[]): Promise<void> {
  const bug = proposed.find((a) => a.type === "file_bug") ?? {
    type: "file_bug" as const,
    params: {
      title: clip(`[${issue.raised_by_role}] ${issue.summary}`, 120),
      body: [`Issue ${issue._id} on task ${issue.task}: ${issue.summary}`, `Attempts: ${issue.attempts.join("; ") || "none"}`, `Evidence: ${issue.evidence.join(", ") || "none"}`].join("\n"),
      severity: "high",
    },
    rationale: "A capability issue no agent can fix.",
  };
  const [actionId] = await proposeActions(ctx, task, [bug]);
  const out = await gateAction(ctx, actionId);
  await settleHandledIssues(ctx, task, `Filed as a bug (action ${actionId}, gate: ${out?.effect ?? "pending"}).`);
  await transition(ctx, task, "done", "bug_filed", { issueId: issue._id, actionId });
}

// ---------------------------------------------------------------- founder package

// The chains a task's ladder touches: its own, plus the chains of issues grouped onto its ladder tasks.
async function relatedChains(ctx: MutationCtx, chainId: string): Promise<{ chains: string[]; tasks: Doc<"tasks">[] }> {
  const chains = new Set([chainId]);
  const own = await ctx.db
    .query("tasks")
    .withIndex("by_chain", (q) => q.eq("chain_id", chainId))
    .take(200);
  for (const t of own.filter((t) => t.kind === "issue")) {
    for (const i of await ctx.db.query("issues").withIndex("by_handler_task", (q) => q.eq("handler_task", t._id)).take(50)) chains.add(i.chain_id);
  }
  const tasks = [...own];
  for (const c of chains) {
    if (c === chainId) continue;
    tasks.push(...(await ctx.db.query("tasks").withIndex("by_chain", (q) => q.eq("chain_id", c)).take(200)));
  }
  return { chains: [...chains], tasks };
}

async function chainIssues(ctx: MutationCtx, chains: string[]): Promise<Doc<"issues">[]> {
  const out: Doc<"issues">[] = [];
  for (const c of chains) out.push(...(await ctx.db.query("issues").withIndex("by_chain", (q) => q.eq("chain_id", c)).take(100)));
  return out.sort((a, b) => a.created_at - b.created_at);
}

async function actionLines(ctx: MutationCtx, actionIds: Id<"actions">[]): Promise<string[]> {
  const lines: string[] = [];
  for (const id of actionIds) {
    const a = await ctx.db.get(id);
    if (!a) continue;
    lines.push(
      `- action ${a._id}: ${a.type}${a.amount_cents !== undefined ? ` ${dollars(a.amount_cents)}` : ""} proposed by ${a.role}; gate: ${a.gate?.reason ?? "not gated"}; why: ${clip(a.rationale, 200)}; params: ${clip(JSON.stringify(a.params), 300)}`,
    );
  }
  return lines;
}

// Asks the Cofounder for one decision package in #founder-desk; without a Cofounder the issue goes to the inbox as is.
export async function requestPackage(ctx: MutationCtx, issue: Doc<"issues">, task: Doc<"tasks">, actionIds: Id<"actions">[]): Promise<void> {
  await ctx.db.patch(issue._id, { status: "escalated", actions: actionIds });
  const cofounder = await agentFor(ctx, "cofounder");
  const desk = await roomNamed(ctx, "#founder-desk");
  if (!cofounder?.enabled || cofounder.kind !== "role" || !desk) {
    return await packageFallback(ctx, (await ctx.db.get(issue._id))!, "no Cofounder agent to write the package");
  }
  const { chains, tasks } = await relatedChains(ctx, issue.chain_id);
  const issues = await chainIssues(ctx, chains);
  const threads = [...new Set(tasks.map(threadOf))];
  const brief = [
    `Write ONE decision package for the founder about issue ${issue._id} (${issue.kind}, raised by ${issue.raised_by_role}): "${issue.summary}"`,
    "Issue chain:",
    ...issues.map((i) => `- ${i.level} ${i.raised_by_role} (${i.kind}, ${i.status}): ${clip(i.summary, 250)}; attempts: ${i.attempts.join("; ") || "none"}; evidence: ${i.evidence.join(", ") || "none"}`),
    ...(actionIds.length ? ["Actions awaiting the founder:", ...(await actionLines(ctx, actionIds))] : ["No action is attached: the founder decides the request itself."]),
    `Threads: ${threads.slice(0, 8).map((t) => `co data thread --id ${t}`).join(", ")}`,
    'Reply with a REPORT whose "package" is {situation, evidence[], attempts[], options[{label, action?}], recommendation}. Approving accepts the actions above; denying rejects them.',
  ].join("\n");
  const taskId = await insertTask(ctx, {
    role: "cofounder",
    room: desk._id,
    kind: "package",
    brief,
    parent_task: task._id,
    ...(task.event ? { event: task.event } : {}),
    chain_id: task.chain_id,
    hop: task.hop,
    origin_refs: threads.slice(0, 10),
    mode: task.mode,
    issue: issue._id,
  });
  await ctx.db.patch(issue._id, { package_task: taskId });
  await assign(ctx, taskId);
  await audit(ctx, { actor: "dispatcher", kind: "package_requested", ref: task._id, detail: { issueId: issue._id, packageTask: taskId, actions: actionIds } });
}

type Package = NonNullable<Envelope["package"]>;

function packageBody(p: Package, actions: string[]): string {
  return [
    `Situation: ${p.situation}`,
    `Recommendation: ${p.recommendation}`,
    "Options:",
    ...p.options.map((o, i) => `${i + 1}. ${o.label}`),
    ...(p.evidence.length ? ["Evidence:", ...p.evidence.map((e) => `- ${e}`)] : []),
    ...(p.attempts.length ? ["Attempts:", ...p.attempts.map((a) => `- ${a}`)] : []),
    ...(actions.length ? ["Actions awaiting your decision:", ...actions] : []),
  ].join("\n");
}

// The Cofounder's package becomes one founder inbox item.
export async function onPackage(ctx: MutationCtx, task: Doc<"tasks">, env: Envelope, messageId: Id<"messages">): Promise<void> {
  const issue = task.issue ? await ctx.db.get(task.issue) : null;
  if (!issue || !env.package) {
    await transition(ctx, task, "done", "package_without_issue", { messageId });
    return;
  }
  const p = env.package;
  const inboxId = await ctx.db.insert("founder_inbox", {
    kind: "package",
    ref: issue._id,
    title: clip(`Decide: ${p.situation.split(/\r?\n/)[0]}`, 140),
    body: packageBody(p, await actionLines(ctx, issue.actions ?? [])),
    options: [...p.options.map((o) => ({ label: o.label, ...(o.action !== undefined ? { action: o.action } : {}) }))],
    status: "open",
    created_at: Date.now(),
  });
  await ctx.db.patch(issue._id, { level: "founder" });
  await transition(ctx, task, "done", "package", { messageId, inboxId });
  await audit(ctx, { actor: "cofounder", kind: "package_ready", ref: task._id, detail: { issueId: issue._id, inboxId, chain: task.chain_id } });
}

// The issue reaches the founder without a package (no Cofounder, or the Cofounder did not answer in time).
export async function packageFallback(ctx: MutationCtx, issue: Doc<"issues">, why: string): Promise<void> {
  const { chains } = await relatedChains(ctx, issue.chain_id);
  const issues = await chainIssues(ctx, chains);
  const body = [
    `No Cofounder package (${why}).`,
    `Situation: ${issue.summary}`,
    "Issue chain:",
    ...issues.map((i) => `- ${i.raised_by_role} (${i.kind}): ${clip(i.summary, 250)}; attempts: ${i.attempts.join("; ") || "none"}`),
    ...((issue.actions ?? []).length ? ["Actions awaiting your decision:", ...(await actionLines(ctx, issue.actions ?? []))] : []),
  ].join("\n");
  const inboxId = await ctx.db.insert("founder_inbox", {
    kind: "package",
    ref: issue._id,
    title: clip(`Decide: ${issue.summary}`, 140),
    body,
    options: [{ label: "Approve" }, { label: "Deny" }],
    status: "open",
    created_at: Date.now(),
  });
  await ctx.db.patch(issue._id, { level: "founder", status: "escalated" });
  await audit(ctx, { actor: "dispatcher", kind: "package_fallback", ref: issue.task, detail: { issueId: issue._id, inboxId, why } });
}

// ---------------------------------------------------------------- resolution

async function resolveOne(ctx: MutationCtx, issue: Doc<"issues">, resolution: string, by: string): Promise<boolean> {
  if (issue.status === "resolved") return false;
  await ctx.db.patch(issue._id, { status: "resolved", resolution });
  await audit(ctx, { actor: by, kind: "issue_resolved", ref: issue.task, detail: { issueId: issue._id, resolution } });
  return true;
}

async function settleIssues(ctx: MutationCtx, issues: Doc<"issues">[], resolution: string, by: Role): Promise<number> {
  let n = 0;
  for (const i of issues) if (await resolveOne(ctx, i, resolution, by)) n++;
  return n;
}

// Resolves the unresolved issues raised on these tasks; returns how many were resolved.
export async function resolveIssues(ctx: MutationCtx, taskIds: Id<"tasks">[], resolution: string, by: Role): Promise<number> {
  let resolved = 0;
  for (const taskId of taskIds) {
    const issues = await ctx.db
      .query("issues")
      .withIndex("by_task", (q) => q.eq("task", taskId))
      .take(50);
    resolved += await settleIssues(ctx, issues, resolution, by);
  }
  return resolved;
}

// A manager's (or the Cofounder's) REPORT / DECISION on an issue task settles what it handled, and the
// outstanding issues of the chains involved; a DECISION note goes to every other origin thread.
export async function settleHandledIssues(ctx: MutationCtx, task: Doc<"tasks">, resolution: string, choice: DecisionChoice = "approve"): Promise<number> {
  const handled = await ctx.db
    .query("issues")
    .withIndex("by_handler_task", (q) => q.eq("handler_task", task._id))
    .take(50);
  const chains = [...new Set([task.chain_id, ...handled.map((i) => i.chain_id)])];
  const open = (await chainIssues(ctx, chains)).filter((i) => i.status !== "resolved");
  const resolved = await settleIssues(ctx, open, resolution, task.role);
  const threads = new Set<Id<"tasks">>();
  for (const i of [...handled, ...open]) {
    const t = await ctx.db.get(i.task);
    if (t) threads.add(threadOf(t));
  }
  threads.delete(threadOf(task)); // the manager's own reply is already in this thread
  for (const root of threads) await recordDecisionMessage(ctx, root, "manager", choice, resolution);
  return resolved;
}

// A manager's HANDOFF passes the problem on: the issues it handled are resolved as handed off.
export async function handOffIssues(ctx: MutationCtx, task: Doc<"tasks">, toRole: Role, childId: Id<"tasks">): Promise<void> {
  const handled = await ctx.db
    .query("issues")
    .withIndex("by_handler_task", (q) => q.eq("handler_task", task._id))
    .take(50);
  await settleIssues(ctx, handled, `Handed off to ${toRole} (task ${childId}).`, task.role);
}

async function recordDecisionMessage(ctx: MutationCtx, root: Id<"tasks">, decidedBy: "founder" | "manager", choice: DecisionChoice, text: string): Promise<void> {
  const rootTask = await ctx.db.get(root);
  if (!rootTask) return;
  await appendMessage(ctx, {
    room: rootTask.room,
    task: root,
    sender_kind: "system",
    sender_name: "Dispatcher",
    text: formatDecision({ taskId: root, decidedBy, choice, note: text }),
  });
}

// ---------------------------------------------------------------- founder decision

// Spec 09 step 5: decisions rows, approve/deny the actions (debiting budgets and executing what was approved),
// DECISION in every origin thread, issues resolved, escalated tasks closed. One transaction.
export async function recordFounderDecision(
  ctx: MutationCtx,
  a: { inboxId: Id<"founder_inbox">; choice: DecisionChoice; reason?: string },
): Promise<{ actions: number; threads: number; issues: number }> {
  const item = await ctx.db.get(a.inboxId);
  if (!item) throw new Error(`inbox item ${a.inboxId} not found`);
  if (item.status !== "open") throw new Error(`inbox item ${a.inboxId} is already decided`);
  if (item.kind !== "package" && item.kind !== "action") throw new Error(`inbox item kind ${item.kind} is decided elsewhere`);
  const now = Date.now();

  let issue: Doc<"issues"> | null = null;
  let actionIds: Id<"actions">[];
  if (item.kind === "package") {
    const issueId = ctx.db.normalizeId("issues", item.ref);
    issue = issueId ? await ctx.db.get(issueId) : null;
    if (!issue) throw new Error(`package ${a.inboxId} has no issue`);
    actionIds = issue.actions ?? [];
  } else {
    const actionId = ctx.db.normalizeId("actions", item.ref);
    if (!actionId) throw new Error(`inbox item ${a.inboxId} has no action`);
    actionIds = [actionId];
  }

  let decided = 0;
  const decidedTypes = new Set<ActionType>();
  let chainId = issue?.chain_id;
  for (const id of actionIds) {
    const action = await ctx.db.get(id);
    if (!action || action.status !== "escalated") continue;
    chainId ??= action.chain_id;
    const features = await decisionFeatures(ctx, action, now);
    const decisionId = await ctx.db.insert("decisions", {
      subject_kind: "action",
      action: id,
      ...(issue ? { issue: issue._id } : {}),
      action_type: action.type,
      choice: a.choice,
      ...(a.reason ? { reason: a.reason } : {}),
      features,
      decided_by: "founder",
      created_at: now,
    });
    await ctx.db.patch(id, { status: a.choice === "approve" ? "approved" : "denied" });
    // Spec 12: a decision against an active rule that covers it suspends that rule here, in this mutation.
    await suspendOverriddenRules(ctx, action.type, { id: decisionId, action_type: action.type, choice: a.choice, features });
    decidedTypes.add(action.type);
    decided++;
    if (a.choice !== "approve") continue;
    const entry = CATALOG[action.type];
    // Escalated actions were not debited by the gate: the approval debits, in this transaction (spec 07).
    if (entry.budgetScope && action.amount_cents !== undefined) {
      const budget = await currentBudget(ctx, entry.budgetScope, now);
      if (budget) await ctx.db.patch(budget._id, { spent_cents: budget.spent_cents + action.amount_cents });
    }
    await scheduleExecution(ctx, (await ctx.db.get(id))!, "founder");
  }
  if (issue) {
    await ctx.db.insert("decisions", {
      subject_kind: "issue",
      issue: issue._id,
      choice: a.choice,
      ...(a.reason ? { reason: a.reason } : {}),
      features: { kind: issue.kind, actions: actionIds.length },
      decided_by: "founder",
      created_at: now,
    });
  }

  // DECISION in every origin thread of the chains involved (no runs), then close them out.
  const { chains, tasks } = chainId ? await relatedChains(ctx, chainId) : { chains: [], tasks: [] };
  const verdict = `Founder ${a.choice === "approve" ? "approved" : "denied"}${a.reason ? `: ${a.reason}` : "."}`;
  const threads = [...new Set(tasks.map(threadOf))];
  for (const root of threads) await recordDecisionMessage(ctx, root, "founder", a.choice, verdict);
  const issues = (await chainIssues(ctx, chains)).filter((i) => i.status !== "resolved");
  for (const i of issues) await resolveOne(ctx, i, verdict, "founder");
  for (const t of tasks) if (t.status === "escalated") await transition(ctx, t, "done", "founder_decision", { inboxId: a.inboxId });

  await ctx.db.patch(a.inboxId, { status: "decided" });
  // Spec 12: enough consistent founder decisions of a type become a proposed rule.
  for (const actionType of decidedTypes) await ctx.scheduler.runAfter(0, internal.rules.maybeInduce, { actionType });
  await audit(ctx, {
    actor: "founder",
    kind: "founder_decision",
    ref: chainId ?? item.ref,
    detail: { inboxId: a.inboxId, choice: a.choice, reason: a.reason ?? null, actions: actionIds, issueId: issue?._id ?? null, threads: threads.length },
  });
  return { actions: decided, threads: threads.length, issues: issues.length };
}

// ---------------------------------------------------------------- ladder failures

export const isLadderTask = (task: Doc<"tasks">) => task.kind === "issue" || task.kind === "package";

// A ladder task that times out, fails its run or cannot send a valid envelope climbs one level with
// `note` as the attempt (spec 09: timeout → "timed out"). Package tasks go to the inbox without a package.
export async function climbFromLadderTask(ctx: MutationCtx, task: Doc<"tasks">, trigger: string, note: string): Promise<void> {
  const out = task.status === "escalated" ? task : await transition(ctx, task, "escalated", trigger, { ladder: true });
  if (task.kind === "package") {
    const issue = task.issue ? await ctx.db.get(task.issue) : null;
    if (issue) await packageFallback(ctx, issue, `the Cofounder ${note}`);
    return;
  }
  const handled = await ctx.db
    .query("issues")
    .withIndex("by_handler_task", (q) => q.eq("handler_task", task._id))
    .take(50);
  await raiseIssue(ctx, out, {
    kind: handled[0]?.kind ?? "coordination",
    summary: `${task.role} ${note} on ${handled.length ? `issue ${handled[0]._id}` : `task ${task._id}`}: ${clip(handled[0]?.summary ?? task.brief, 200)}`,
    attempts: [note],
    evidence: handled.map((i) => i._id),
  });
}
