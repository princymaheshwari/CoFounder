import { getServiceToken } from "convex/server";
import { v } from "convex/values";
import { env, internalAction, query } from "./_generated/server";

// Spec 00: confirms the AI Gateway token works and lists model ids, e.g.
//   npx convex run health:gateway '{"match":"claude"}'
export const gateway = internalAction({
  args: { match: v.optional(v.string()) },
  returns: v.object({ status: v.number(), models: v.array(v.string()) }),
  handler: async (_ctx, { match }) => {
    const base = (env.AI_GATEWAY_URL ?? "https://ai-gateway.convex.dev").replace(/\/+$/, "");
    const res = await fetch(`${base}/v1/models`, {
      headers: { Authorization: `Bearer ${await getServiceToken("ai-gateway")}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { data?: { id?: unknown }[] };
    const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
    return { status: res.status, models: match ? ids.filter((id) => id.includes(match)) : ids };
  },
});

// Placeholder read so the founder app can confirm it is connected to Convex.
export const ping = query({
  args: {},
  handler: async () => {
    return { ok: true, at: Date.now() };
  },
});

// Confirms CREAO_API_KEY can reach the Creao API Trigger.
// Explicit User-Agent: Creao's Cloudflare rejects some default client signatures (403 "error code: 1010").
export const check = internalAction({
  args: {},
  handler: async () => {
    const key = env.CREAO_API_KEY;
    if (!key) {
      throw new Error("CREAO_API_KEY is not set (npx convex env set CREAO_API_KEY ...)");
    }
    const res = await fetch("https://agent.creao.ai/api/v1/runs?limit=1", {
      headers: {
        Authorization: `Bearer ${key}`,
        "User-Agent": "cofounder/1.0",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
    let error: string | null = null;
    if (!res.ok) {
      const body = await res.text();
      try {
        const parsed: unknown = JSON.parse(body);
        if (parsed && typeof parsed === "object" && "error" in parsed) {
          error = String(parsed.error);
        }
      } catch {
        error = body.slice(0, 80);
      }
    }
    return { status: res.status, ok: res.ok, error };
  },
});
