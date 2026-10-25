import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { getConfig } from "./channels";
import { assign } from "./dispatcher";

// Dev helper for spec 04's acceptance check: a seeded support_ticket event → Support task → ASSIGN.
// Spec 05's createTaskFromEvent replaces the task creation here with real routing.
export const seedSupportTicket = internalMutation({
  args: { subject: v.string(), body: v.string(), fromEmail: v.optional(v.string()) },
  returns: v.object({ taskId: v.id("tasks"), messageId: v.id("messages") }),
  handler: async (ctx, { subject, body, fromEmail }) => {
    const room = await ctx.db
      .query("rooms")
      .withIndex("by_name", (q) => q.eq("name", "#customer"))
      .unique();
    if (!room) throw new Error("channels not seeded (npx convex run seed:config)");
    const now = Date.now();
    const ticketId = await ctx.db.insert("tickets", {
      from_email: fromEmail ?? "customer@example.com",
      subject,
      body,
      status: "open",
      source: "seed",
      created_at: now,
    });
    const eventId = await ctx.db.insert("events", {
      type: "support_ticket",
      payload: { ticket: ticketId, data_hints: [`co data ticket --id ${ticketId}`] },
      source: "seed",
      processed: true,
      created_at: now,
    });
    const taskId: Id<"tasks"> = await ctx.db.insert("tasks", {
      role: "support",
      room: room._id,
      kind: "work",
      brief: `Handle ticket ${ticketId}: "${subject}" ${body}`,
      event: eventId,
      chain_id: `c_${eventId}`,
      hop: 0,
      attempt: 1,
      status: "queued",
      origin_refs: [],
      deadline: now + (await getConfig(ctx, "level_timeout_ms", 300_000)),
      mode: "live",
      created_at: now,
      updated_at: now,
    });
    const messageId = await assign(ctx, taskId);
    return { taskId, messageId };
  },
});
