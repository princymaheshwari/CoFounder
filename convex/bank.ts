import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalQuery, query } from "./_generated/server";
import { CATALOG } from "./lib/catalog";
import { NESSIE_BASE_URL, centsFromNessie, markerOf, nessieId, type NessieObject } from "./lib/nessie";
import { NessieError, nessieGet, nessieList } from "./nessieApi";

// Live proof for the founder app: these read Capital One's Nessie directly, so the screen shows Nessie's own
// answer rather than our mirror. Read-only GETs; the key stays in Convex (the shown request hides it).

const vVerify = v.object({
  requests: v.array(v.string()),
  ms: v.number(),
  objects: v.array(
    v.object({
      expected_action: v.string(),
      transfer: v.union(
        v.null(),
        v.object({ id: v.string(), amount_cents: v.number(), date: v.string(), status: v.string(), description: v.string(), action_id: v.union(v.string(), v.null()) }),
      ),
      raw: v.string(),
    }),
  ),
  error: v.union(v.string(), v.null()),
});
const vGroup = v.object({ action_id: v.string(), type: v.string(), ids: v.array(v.string()) });

const vTransfer = v.object({
  id: v.string(),
  amount_cents: v.number(),
  date: v.string(),
  status: v.string(),
  description: v.string(),
  action_id: v.union(v.string(), v.null()), // from the [cf:act-<id>-<i>] tag we wrote
});
type Transfer = typeof vTransfer.type;
const vRefunds = v.object({ request: v.string(), ms: v.number(), transfers: v.array(vTransfer), total: v.number(), error: v.union(v.string(), v.null()) });

const toTransfer = (o: NessieObject): Transfer => {
  const marker = markerOf(o) ?? "";
  return {
    id: nessieId(o),
    amount_cents: centsFromNessie(o.amount),
    date: typeof o.transaction_date === "string" ? o.transaction_date : "",
    status: typeof o.status === "string" ? o.status : "",
    description: typeof o.description === "string" ? o.description : "",
    action_id: /^act-(.+)-\d+$/.exec(marker)?.[1] ?? null,
  };
};

const failure = (err: unknown) => (err instanceof NessieError ? err.message : err instanceof Error ? err.message : String(err));
const shown = (path: string) => `GET ${NESSIE_BASE_URL}${path}?key=••••`;

// The Nessie objects a Dispatcher "Executed … in Nessie" message is about: its task's executed money actions.
export const messageObjects = internalQuery({
  args: { messageId: v.id("messages") },
  returns: v.array(vGroup),
  handler: async (ctx, { messageId }) => {
    const message = await ctx.db.get(messageId);
    if (!message?.task) return [];
    const actions = await ctx.db
      .query("actions")
      .withIndex("by_task", (q) => q.eq("task", message.task!))
      .take(20);
    return actions
      .filter((a) => CATALOG[a.type].executor === "nessie" && (a.executed_ref ?? []).length > 0)
      .map((a) => ({ action_id: a._id, type: a.type, ids: a.executed_ref ?? [] }));
  },
});

// "Verify in Nessie": fetches each transfer (or bill) the message's actions created, live.
export const verifyMessage = action({
  args: { messageId: v.id("messages") },
  returns: vVerify,
  handler: async (ctx, { messageId }): Promise<typeof vVerify.type> => {
    const groups: (typeof vGroup.type)[] = await ctx.runQuery(internal.bank.messageObjects, { messageId });
    const started = Date.now();
    const requests: string[] = [];
    const objects: { expected_action: string; transfer: Transfer | null; raw: string }[] = [];
    try {
      for (const g of groups) {
        const path = (id: string) => (g.type === "pay_bill" ? `/bills/${id}` : `/transfers/${id}`);
        const fetched = await Promise.all(g.ids.slice(0, 12).map((id) => nessieGet(path(id))));
        requests.push(...g.ids.slice(0, 12).map((id) => shown(path(id))));
        for (const o of fetched) objects.push({ expected_action: g.action_id, transfer: g.type === "pay_bill" ? null : toTransfer(o), raw: JSON.stringify(o, null, 2) });
      }
      return { requests, ms: Date.now() - started, objects, error: groups.length ? null : "No Nessie object is attached to this message yet." };
    } catch (err) {
      return { requests, ms: Date.now() - started, objects, error: failure(err) };
    }
  },
});

// The sidebar's bank panel: the newest refunds on the operating account, straight from Nessie.
export const liveRefunds = action({
  args: {},
  returns: vRefunds,
  handler: async (ctx): Promise<typeof vRefunds.type> => {
    const state: { operating_account_id: string } | null = await ctx.runQuery(internal.nessie.getState, {});
    if (!state) return { request: "", ms: 0, transfers: [], total: 0, error: "Nessie is not seeded (npx convex run nessie:seedNessie)." };
    const path = `/accounts/${state.operating_account_id}/transfers`;
    const started = Date.now();
    try {
      const ours = (await nessieList(path)).map(toTransfer).filter((t) => t.action_id !== null);
      ours.sort((a, b) => b.date.localeCompare(a.date));
      return { request: shown(path), ms: Date.now() - started, transfers: ours.slice(0, 8), total: ours.length, error: null };
    } catch (err) {
      return { request: shown(path), ms: Date.now() - started, transfers: [], total: 0, error: failure(err) };
    }
  },
});

// Changes whenever Nessie executes something, so the panel refetches live right after a refund.
export const lastMove = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const rows = await ctx.db.query("audit_log").withIndex("by_at").order("desc").take(100);
    return rows.find((r) => r.actor === "nessie" && (r.kind === "executed" || r.kind === "executed_item" || r.kind === "demo_refunds_deleted"))?.at ?? 0;
  },
});
