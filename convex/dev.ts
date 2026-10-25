import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { taskFromEvent } from "./tasks";

// Dev helper: a seeded support_ticket event, routed by spec 05 (→ Support task in #customer → ASSIGN).
export const seedSupportTicket = internalMutation({
  args: { subject: v.string(), body: v.string(), fromEmail: v.optional(v.string()) },
  returns: v.object({ taskId: v.id("tasks"), messageId: v.id("messages") }),
  handler: async (ctx, { subject, body, fromEmail }) => {
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
      payload: {
        ticket: ticketId,
        brief: `Handle ticket ${ticketId}: "${subject}" ${body}`,
        data_hints: [`co data ticket --id ${ticketId}`],
      },
      source: "seed",
      processed: false,
      created_at: now,
    });
    const created = await taskFromEvent(ctx, eventId);
    if (!created) throw new Error(`event ${eventId} was already processed`);
    return created;
  },
});
