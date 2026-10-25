import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

// Appends a message to a Convex channel. seq comes from rooms.next_seq in the same transaction,
// so concurrent appends never share a [room, seq] (Convex retries the conflicting mutation).
export async function appendMessage(
  ctx: MutationCtx,
  m: Omit<Doc<"messages">, "_id" | "_creationTime" | "seq" | "created_at" | "thread">,
): Promise<Id<"messages">> {
  const room = await ctx.db.get(m.room);
  if (!room) throw new Error(`room ${m.room} not found`);
  // A task's messages appear under its thread root: itself, or the employee thread a manager task works in.
  const task = m.task ? await ctx.db.get(m.task) : null;
  const thread = task ? (task.thread ?? task._id) : undefined;
  await ctx.db.patch(room._id, { next_seq: room.next_seq + 1 });
  return await ctx.db.insert("messages", { ...m, ...(thread ? { thread } : {}), seq: room.next_seq, created_at: Date.now() });
}

export async function audit(
  ctx: MutationCtx,
  entry: { actor: string; kind: string; ref: string; detail?: unknown },
): Promise<void> {
  await ctx.db.insert("audit_log", { ...entry, detail: entry.detail ?? null, at: Date.now() });
}

export async function getConfig<T>(ctx: MutationCtx, key: string, fallback: T): Promise<T> {
  const row = await ctx.db
    .query("config")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  return row ? (row.value as T) : fallback;
}

type FounderRequest = Pick<Doc<"founder_inbox">, "kind" | "ref" | "title" | "body" | "options">;

// The founder is asked in one place only: every request is a founder_inbox row posted as a message in
// #founder-desk (in the package task's thread when there is one) and decided from that message.
export async function notifyFounder(ctx: MutationCtx, req: FounderRequest, opts: { task?: Id<"tasks"> } = {}): Promise<Id<"founder_inbox">> {
  const now = Date.now();
  const inboxId = await ctx.db.insert("founder_inbox", { ...req, status: "open", created_at: now });
  const desk = await ctx.db
    .query("rooms")
    .withIndex("by_name", (q) => q.eq("name", "#founder-desk"))
    .unique();
  if (desk) {
    const task = opts.task ? await ctx.db.get(opts.task) : null;
    await appendMessage(ctx, {
      room: desk._id,
      ...(task && task.room === desk._id ? { task: task._id } : {}),
      sender_kind: "system",
      sender_name: "Dispatcher",
      text: `[Dispatcher] @Founder ${req.title}`,
      inbox: inboxId,
    });
  }
  return inboxId;
}
