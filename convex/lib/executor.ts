import { parseEnvelope } from "./envelope";
import type { ActionType, Department, Role } from "./types";

// Executor (spec 10): which connector each action needs, the run input, and reading the Executor's reply. Pure.

export type Connector = "linear" | "gmail" | "calendar";
export const CONNECTORS: readonly Connector[] = ["linear", "gmail", "calendar"];

export const CONNECTOR_OF: Partial<Record<ActionType, Connector>> = {
  file_bug: "linear",
  reply_customer: "gmail",
  schedule_digest: "calendar",
};

// Who hears about a failed action: the manager of the proposing role's department.
export const DEPARTMENT_MANAGER: Record<Department, Role> = {
  customer: "customer_manager",
  finance: "finance_manager",
  marketing: "marketing_manager",
  leadership: "cofounder",
  none: "cofounder",
};

export const EXECUTOR_INSTRUCTIONS =
  "Perform exactly this one action. Do nothing else. Reply with a cofounder REPORT envelope containing executed_ref.";

export function executorInput(a: { actionId: string; type: ActionType; params: Record<string, unknown> }): string {
  return JSON.stringify({ action_id: a.actionId, action_type: a.type, params: a.params, instructions: EXECUTOR_INSTRUCTIONS });
}

export type ExecutorOutcome =
  | { kind: "executed"; refs: string[] }
  | { kind: "not_connected"; connector: string }
  | { kind: "failed"; reason: string };

// The Executor ends with {"type":"REPORT","task":"<action_id>","from":"executor","summary":"executed"|"failed: …",
// "findings":[{"claim":"executed","evidence":"<provider id or URL>"}]} (agents/creao/executor.md).
export function readExecutorReply(text: string, actionId: string): ExecutorOutcome {
  const parsed = parseEnvelope(text, { taskId: actionId, role: "executor" });
  if (!parsed.ok) return { kind: "failed", reason: `invalid envelope: ${parsed.error}` };
  const env = parsed.env;
  const summary = env.summary.trim();
  const missing = /^failed:\s*(.+?)\s+not connected/i.exec(summary);
  if (missing) return { kind: "not_connected", connector: missing[1] };
  if (env.type !== "REPORT" || /^failed/i.test(summary)) return { kind: "failed", reason: summary };
  const refs = (env.findings ?? []).map((f) => f.evidence.trim()).filter(Boolean);
  if (!refs.length) return { kind: "failed", reason: `no executed_ref in the Executor's REPORT ("${summary}")` };
  // Provider links the Executor mentions only in its prose (e.g. the Linear issue URL) are kept too.
  for (const url of text.match(/https?:\/\/[^\s"'`)\]]+/g) ?? []) {
    const clean = url.replace(/[.,;:]+$/, "");
    if (!refs.includes(clean)) refs.push(clean);
  }
  return { kind: "executed", refs };
}
