import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { creaoFetch } from "./http";
import { isTerminal, parseRun, replyText, webhookUrl } from "./runs";

// Spec 02 VERIFY: one real Support run, a same-key retry, polling, and a threadId continuation.
// Costs two agent runs. Returns the raw API responses for convex/creao/__fixtures__/.
// Run: npx convex run creao/verify:transport

const ASSIGN = (task: string) => `[Dispatcher] @Support New task ${task}: transport test.

\`\`\`cofounder
{"type":"ASSIGN","task":"${task}","to":"support",
 "company":{"name":"Lumen Notes","product":"AI meeting notes","plans":[{"name":"Pro","price_cents":3500,"period":"month"}]},
 "brief":"Transport test. Do not call any tools. Reply with one sentence, then a REPORT envelope with no proposed_actions and one finding {claim: 'transport ok', evidence: 'test'}.",
 "token":"test","rules_in_scope":[],"data_hints":[],"refs":[],
 "reply":"End your reply with exactly one cofounder envelope. Never address other agents directly."}
\`\`\``;

async function waitForRun(runId: string): Promise<unknown> {
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const { json } = await creaoFetch(`/api/v1/runs/${encodeURIComponent(runId)}`);
    if (isTerminal(parseRun(json).status)) return json;
  }
  throw new Error(`run ${runId} did not finish in 4 min`);
}

export const transport = internalAction({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const support = await ctx.runQuery(internal.creao.verifyData.supportAgent, {});
    const task = `t_verify_${Date.now()}`;
    const body = {
      appId: support.creao_app_id,
      inputs: { [support.input_field]: ASSIGN(task) },
      webhookUrl: webhookUrl(),
      idempotencyKey: `${task}:assign:1`,
    };

    const start = await creaoFetch("/api/v1/runs", { method: "POST", body });
    const sameKey = await creaoFetch("/api/v1/runs", { method: "POST", body });
    const runId = parseRun(start.json).id;
    const completed = await waitForRun(runId);
    const run1 = parseRun(completed);

    let continuation: unknown = null;
    if (run1.threadId) {
      const next = await creaoFetch("/api/v1/runs", {
        method: "POST",
        body: {
          appId: support.creao_app_id,
          inputs: { [support.input_field]: `[Dispatcher] @Support Follow-up on ${task}: what task id did I just give you? Answer in one sentence, then the same REPORT envelope.` },
          webhookUrl: webhookUrl(),
          idempotencyKey: `${task}:followup:1`,
          threadId: run1.threadId,
        },
      });
      continuation = await waitForRun(parseRun(next.json).id);
    }

    const run2 = continuation ? parseRun(continuation) : null;
    return {
      summary: {
        task,
        startStatus: start.status,
        sameKeySameRun: parseRun(sameKey.json).id === runId,
        run1Status: run1.status,
        replyHasEnvelope: replyText(run1).includes("```cofounder"),
        chatTextHasEnvelope: !!run1.chatText?.includes("```cofounder"),
        textHasEnvelope: !!run1.text?.includes("```cofounder"),
        threadId: run1.threadId ?? null,
        continuationStatus: run2?.status ?? null,
        continuationRemembersTask: run2 ? replyText(run2).includes(task) : null,
      },
      raw: { start: start.json, sameKey: sameKey.json, completed, continuation },
    };
  },
});
