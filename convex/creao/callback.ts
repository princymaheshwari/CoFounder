import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

// Records one Creao webhook delivery, deduped on X-Creao-Delivery-Id (at-least-once delivery).
// Webhooks are unsigned: spec 04's ingestRun re-fetches the run and trusts only that.
export const recordDelivery = internalMutation({
  args: { deliveryId: v.string(), runId: v.string(), body: v.any() },
  returns: v.object({ duplicate: v.boolean() }),
  handler: async (ctx, { deliveryId, runId, body }) => {
    const ref = `creao_delivery:${deliveryId}`;
    const seen = await ctx.db
      .query("audit_log")
      .withIndex("by_ref", (q) => q.eq("ref", ref))
      .first();
    if (seen) return { duplicate: true };
    await ctx.db.insert("audit_log", {
      actor: "creao",
      kind: "creao_webhook",
      ref,
      detail: { runId, body },
      at: Date.now(),
    });
    return { duplicate: false };
  },
});
