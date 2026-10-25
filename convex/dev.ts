import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { env, internalAction, internalMutation } from "./_generated/server";
import { TOKEN_TTL_MS, hashToken, signTaskToken } from "./lib/tokens";
import { vRole, vTaskStatus } from "./lib/types";
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

// Dev helper (spec 06): a throwaway task + signed token to call /co/* by hand, e.g.
//   npx convex run dev:coSmokeToken '{"role":"support"}'  →  python3 skills/co/co.py --token <token> data company
// No run is started. Remove the task with dev:dropCoSmokeTask.
const SMOKE_BRIEF = "[dev] co smoke test";

export const coSmokeTask = internalMutation({
  args: { role: vRole, status: vTaskStatus },
  returns: v.id("tasks"),
  handler: async (ctx, { role, status }) => {
    const agent = await ctx.db
      .query("agents")
      .withIndex("by_role", (q) => q.eq("role", role))
      .unique();
    const roomName = agent?.rooms[0] ?? "#customer";
    const room = await ctx.db
      .query("rooms")
      .withIndex("by_name", (q) => q.eq("name", roomName))
      .unique();
    if (!room) throw new Error(`room ${roomName} not seeded (npx convex run seed:config)`);
    const now = Date.now();
    return await ctx.db.insert("tasks", {
      role,
      room: room._id,
      kind: "work",
      brief: SMOKE_BRIEF,
      chain_id: `dev-co-${now}`,
      hop: 0,
      attempt: 1,
      status,
      origin_refs: [],
      deadline: now + TOKEN_TTL_MS,
      mode: "live",
      created_at: now,
      updated_at: now,
    });
  },
});

export const setCoSmokeTokenHash = internalMutation({
  args: { taskId: v.id("tasks"), tokenHash: v.string() },
  returns: v.null(),
  handler: async (ctx, { taskId, tokenHash }) => {
    await ctx.db.patch(taskId, { token_hash: tokenHash });
    return null;
  },
});

export const coSmokeToken = internalAction({
  args: { role: vRole, status: v.optional(vTaskStatus) },
  returns: v.object({ taskId: v.id("tasks"), token: v.string() }),
  handler: async (ctx, { role, status }): Promise<{ taskId: Id<"tasks">; token: string }> => {
    const secret = env.CO_TOKEN_SECRET;
    if (!secret) throw new Error("CO_TOKEN_SECRET is not set");
    const taskId: Id<"tasks"> = await ctx.runMutation(internal.dev.coSmokeTask, { role, status: status ?? "assigned" });
    const token = await signTaskToken(secret, { task: taskId, role, exp: Date.now() + TOKEN_TTL_MS });
    await ctx.runMutation(internal.dev.setCoSmokeTokenHash, { taskId, tokenHash: await hashToken(token) });
    return { taskId, token };
  },
});

export const dropCoSmokeTask = internalMutation({
  args: { taskId: v.id("tasks") },
  returns: v.null(),
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    if (task?.brief !== SMOKE_BRIEF) throw new Error(`${taskId} is not a co smoke-test task`);
    await ctx.db.delete(taskId);
    return null;
  },
});
