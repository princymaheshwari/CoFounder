import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

export const supportAgent = internalQuery({
  args: {},
  returns: v.object({ creao_app_id: v.string(), input_field: v.string() }),
  handler: async (ctx) => {
    const agent = await ctx.db
      .query("agents")
      .withIndex("by_role", (q) => q.eq("role", "support"))
      .unique();
    if (!agent?.creao_app_id) throw new Error("Support agent not seeded (npx convex run seed:config)");
    return { creao_app_id: agent.creao_app_id, input_field: agent.input_field };
  },
});
