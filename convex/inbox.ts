import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { recordFounderDecision } from "./issues";
import { vDecisionChoice, vInboxKind, vInboxStatus, type DecisionChoice } from "./lib/types";
import { decideRule } from "./rules";

// Founder inbox (spec 09): open items for the app, and the founder's approve / deny.
// No auth yet: single-founder app, login is spec 14's. These are the only public functions that decide.

const vItem = v.object({
  _id: v.id("founder_inbox"),
  _creationTime: v.number(),
  kind: vInboxKind,
  ref: v.string(),
  title: v.string(),
  body: v.string(),
  options: v.optional(v.array(v.object({ label: v.string(), action: v.optional(v.any()) }))),
  status: vInboxStatus,
  created_at: v.number(),
});

export const listOpen = query({
  args: {},
  returns: v.array(vItem),
  handler: async (ctx) =>
    await ctx.db
      .query("founder_inbox")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .order("desc")
      .take(50),
});

// `makeRule`: approve, and ask Claude to draft a rule from this decision (spec 12; the founder still approves the rule).
const vDecideArgs = { inboxId: v.id("founder_inbox"), choice: vDecisionChoice, reason: v.optional(v.string()), makeRule: v.optional(v.boolean()) };
const vDecideResult = v.object({ actions: v.number(), threads: v.number(), issues: v.number() });

// Rule items (spec 12) approve or reject the proposed rule; everything else decides actions and issues.
async function decideItem(ctx: MutationCtx, a: { inboxId: Id<"founder_inbox">; choice: DecisionChoice; reason?: string; makeRule?: boolean }) {
  const item = await ctx.db.get(a.inboxId);
  if (item?.kind === "rule") {
    if (item.status !== "open") throw new Error(`inbox item ${a.inboxId} is already decided`);
    await decideRule(ctx, item, a.choice, a.reason);
    return { actions: 0, threads: 0, issues: 0 };
  }
  return await recordFounderDecision(ctx, a);
}

export const decide = mutation({
  args: vDecideArgs,
  returns: vDecideResult,
  handler: (ctx, a) =>
    decideItem(ctx, { inboxId: a.inboxId, choice: a.choice, ...(a.reason?.trim() ? { reason: a.reason.trim() } : {}), ...(a.makeRule ? { makeRule: true } : {}) }),
});

// Same decision from the CLI: npx convex run inbox:decideInternal '{"inboxId":"…","choice":"approve"}'
export const decideInternal = internalMutation({
  args: vDecideArgs,
  returns: vDecideResult,
  handler: (ctx, a) => decideItem(ctx, a),
});
