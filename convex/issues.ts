import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { audit } from "./channels";
import { MANAGER_ROLES } from "./lib/envelope";
import type { IssueKind, Role } from "./lib/types";

// Issue rows (spec 05 raises them; spec 09 climbs the ladder: manager runs, packages, founder inbox).

export async function managerOf(ctx: MutationCtx, role: Role): Promise<Role | undefined> {
  const agent = await ctx.db
    .query("agents")
    .withIndex("by_role", (q) => q.eq("role", role))
    .unique();
  return agent?.manager_role;
}

export async function raiseIssue(
  ctx: MutationCtx,
  task: Doc<"tasks">,
  issue: {
    kind: IssueKind;
    summary: string;
    attempts: string[];
    evidence: string[];
    raisedBy?: Role; // defaults to the task's role
    toRole?: Role | null; // defaults to the raiser's manager; null = the founder
  },
): Promise<Id<"issues">> {
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
  // Spec 09 hooks in here: start the manager's run (or the founder package) for this issue.
  return issueId;
}

// Resolves the unresolved issues raised on these tasks; returns how many were resolved.
export async function resolveIssues(
  ctx: MutationCtx,
  taskIds: Id<"tasks">[],
  resolution: string,
  by: Role,
): Promise<number> {
  let resolved = 0;
  for (const taskId of taskIds) {
    const issues = await ctx.db
      .query("issues")
      .withIndex("by_task", (q) => q.eq("task", taskId))
      .take(50);
    for (const issue of issues) {
      if (issue.status === "resolved") continue;
      await ctx.db.patch(issue._id, { status: "resolved", resolution });
      await audit(ctx, { actor: by, kind: "issue_resolved", ref: taskId, detail: { issueId: issue._id, resolution } });
      resolved++;
    }
  }
  return resolved;
}
