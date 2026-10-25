import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { env, httpAction } from "./_generated/server";

const http = httpRouter();

// Creao API Trigger webhook: POST /creao-callback?token=<CREAO_WEBHOOK_TOKEN>.
http.route({
  path: "/creao-callback",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const token = new URL(req.url).searchParams.get("token");
    if (!env.CREAO_WEBHOOK_TOKEN || token !== env.CREAO_WEBHOOK_TOKEN) {
      return new Response("unauthorized", { status: 401 });
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("invalid json", { status: 400 });
    }
    const runId =
      body && typeof body === "object" && "runId" in body && typeof body.runId === "string" ? body.runId : null;
    if (!runId) return new Response("missing runId", { status: 400 });
    // Fall back to the run id when the delivery header is absent so retries still dedupe.
    const deliveryId = req.headers.get("X-Creao-Delivery-Id") ?? `run:${runId}`;
    await ctx.runMutation(internal.creao.callback.recordDelivery, { deliveryId, runId, body });
    return new Response(null, { status: 200 });
  }),
});

export default http;
