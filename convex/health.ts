import { env, internalAction, query } from "./_generated/server";

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
