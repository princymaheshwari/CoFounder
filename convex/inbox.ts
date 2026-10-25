import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { recordFounderDecision } from "./issues";
import { vDecisionChoice, vInboxKind, vInboxStatus } from "./lib/types";

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

const vDecideArgs = { inboxId: v.id("founder_inbox"), choice: vDecisionChoice, reason: v.optional(v.string()) };
const vDecideResult = v.object({ actions: v.number(), threads: v.number(), issues: v.number() });

export const decide = mutation({
  args: vDecideArgs,
  returns: vDecideResult,
  handler: (ctx, a) => recordFounderDecision(ctx, { inboxId: a.inboxId, choice: a.choice, ...(a.reason?.trim() ? { reason: a.reason.trim() } : {}) }),
});

// Same decision from the CLI: npx convex run inbox:decideInternal '{"inboxId":"…","choice":"approve"}'
export const decideInternal = internalMutation({
  args: vDecideArgs,
  returns: vDecideResult,
  handler: (ctx, a) => recordFounderDecision(ctx, a),
});
