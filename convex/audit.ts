import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

// The audit trail of one chain (spec 09): every row whose ref is a task of the chain, or the chain itself
// (the founder's decision), oldest first. `npx convex run audit:chainAudit '{"chainId":"c_…"}'`
export const chainAudit = internalQuery({
  args: { chainId: v.string() },
  returns: v.array(v.object({ at: v.number(), actor: v.string(), kind: v.string(), ref: v.string(), detail: v.any() })),
  handler: async (ctx, { chainId }) => {
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_chain", (q) => q.eq("chain_id", chainId))
      .take(200);
    const rows = [];
    for (const ref of [chainId, ...tasks.map((t) => t._id)]) {
      rows.push(
        ...(await ctx.db
          .query("audit_log")
          .withIndex("by_ref", (q) => q.eq("ref", ref))
          .take(500)),
      );
    }
    return rows.sort((a, b) => a.at - b.at || a._creationTime - b._creationTime).map(({ at, actor, kind, ref, detail }) => ({ at, actor, kind, ref, detail }));
  },
});
