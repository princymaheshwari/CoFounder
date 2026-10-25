import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

// Appends a message to a Convex channel. seq comes from rooms.next_seq in the same transaction,
// so concurrent appends never share a [room, seq] (Convex retries the conflicting mutation).
export async function appendMessage(
  ctx: MutationCtx,
  m: Omit<Doc<"messages">, "_id" | "_creationTime" | "seq" | "created_at">,
): Promise<Id<"messages">> {
  const room = await ctx.db.get(m.room);
  if (!room) throw new Error(`room ${m.room} not found`);
  await ctx.db.patch(room._id, { next_seq: room.next_seq + 1 });
  return await ctx.db.insert("messages", { ...m, seq: room.next_seq, created_at: Date.now() });
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
