import { env } from "../_generated/server";
import type { RunStatus } from "../lib/types";
import { RUN_STATUSES } from "../lib/types";
import { CreaoError, creaoFetch } from "./http";

// Creao API Trigger run client (spec 02). The only way Convex talks to Creao agents.

export type Artifact = Record<string, unknown>;

// Shapes from real responses in ./__fixtures__ (2026-10-24): POST returns {id, status, appId, appName};
// GET adds threadId, result {text, chatText}, errorCode (null when ok) and ISO timestamps.
export type CreaoRun = {
  id: string;
  status: RunStatus;
  appId?: string;
  appName?: string;
  threadId?: string;
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  text?: string; // result.text: the agent's structured output, shape differs per agent
  chatText?: string; // result.chatText: the plain reply that carries the cofounder envelope
  artifacts?: Artifact[];
  errorCode?: string;
};

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function str(x: unknown): string | undefined {
  return typeof x === "string" ? x : undefined;
}

export function parseRun(json: unknown): CreaoRun {
  if (!isRecord(json)) throw new CreaoError("BAD_RESPONSE", 200);
  const id = str(json.id) ?? str(json.runId);
  const status = str(json.status);
  if (!id || !status || !(RUN_STATUSES as readonly string[]).includes(status)) {
    throw new CreaoError("BAD_RESPONSE", 200);
  }
  const result = isRecord(json.result) ? json.result : {};
  return {
    id,
    status: status as RunStatus,
    appId: str(json.appId),
    appName: str(json.appName),
    threadId: str(json.threadId),
    createdAt: str(json.createdAt),
    startedAt: str(json.startedAt),
    completedAt: str(json.completedAt),
    text: str(result.text),
    chatText: str(result.chatText),
    artifacts: Array.isArray(result.artifacts) ? result.artifacts.filter(isRecord) : undefined,
    errorCode: str(json.errorCode),
  };
}

// The agent's reply: chatText carries the envelope (verified 2026-10-24); text is per-agent JSON.
// Falls back to whichever field contains a cofounder block.
export function replyText(run: Pick<CreaoRun, "text" | "chatText">): string {
  const hasBlock = (s?: string) => !!s && s.includes("```cofounder");
  if (hasBlock(run.chatText)) return run.chatText!;
  if (hasBlock(run.text)) return run.text!;
  return run.chatText ?? run.text ?? "";
}

export function isTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function webhookUrl(): string {
  const token = env.CREAO_WEBHOOK_TOKEN;
  if (!token) throw new CreaoError("MISSING_WEBHOOK_TOKEN", 0);
  return `${env.CONVEX_SITE_URL}/creao-callback?token=${encodeURIComponent(token)}`;
}

export async function startRun(args: {
  appId: string;
  inputs: Record<string, string>;
  webhookUrl: string;
  idempotencyKey: string; // `${taskId}:${purpose}:${attempt}`, 8–128 chars
  threadId?: string;
  chatModelId?: string;
}): Promise<{ runId: string; status: RunStatus }> {
  if (args.idempotencyKey.length < 8 || args.idempotencyKey.length > 128) {
    throw new CreaoError("BAD_IDEMPOTENCY_KEY", 0);
  }
  const { json } = await creaoFetch("/api/v1/runs", {
    method: "POST",
    body: {
      appId: args.appId,
      inputs: args.inputs,
      webhookUrl: args.webhookUrl,
      idempotencyKey: args.idempotencyKey,
      ...(args.threadId ? { threadId: args.threadId } : {}),
      ...(args.chatModelId ? { chatModelId: args.chatModelId } : {}),
    },
  });
  const run = parseRun(json);
  return { runId: run.id, status: run.status };
}

export async function getRun(runId: string): Promise<CreaoRun> {
  const { json } = await creaoFetch(`/api/v1/runs/${encodeURIComponent(runId)}`);
  return parseRun(json);
}

export async function cancelRun(runId: string): Promise<void> {
  await creaoFetch(`/api/v1/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
}
