import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import { audit } from "../channels";

// One Creao webhook delivery (at-least-once). Deduped on X-Creao-Delivery-Id (runs.delivery_ids) and
// on terminal run state; the body is never trusted: ingestRun re-fetches the run.
export const recordDelivery = internalMutation({
  args: { deliveryId: v.string(), runId: v.string(), status: v.optional(v.string()) },
  returns: v.object({ duplicate: v.boolean(), scheduled: v.boolean() }),
  handler: async (ctx, { deliveryId, runId, status }) => {
    const run = await ctx.db
      .query("runs")
      .withIndex("by_creao_run_id", (q) => q.eq("creao_run_id", runId))
      .unique();
    if (!run) {
      // Not started by us yet (markRunStarted lags) or not ours: pollRuns covers the first case.
      await audit(ctx, { actor: "creao", kind: "webhook_unknown_run", ref: runId, detail: { deliveryId, status } });
      return { duplicate: false, scheduled: false };
    }
    const terminal = run.status === "completed" || run.status === "failed" || run.status === "cancelled";
    if (run.delivery_ids.includes(deliveryId) || terminal) return { duplicate: true, scheduled: false };
    await ctx.db.patch(run._id, { delivery_ids: [...run.delivery_ids, deliveryId] });
    await ctx.scheduler.runAfter(0, internal.dispatcher.ingestRun, { runId });
    await audit(ctx, { actor: "creao", kind: "webhook", ref: runId, detail: { deliveryId, status } });
    return { duplicate: false, scheduled: true };
  },
});
