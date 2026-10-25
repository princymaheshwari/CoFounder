import type { Role, TaskKind, TaskStatus } from "./types";

// Routing and graph limits (spec 05, CLAUDE.md invariant 8). Pure, no I/O.

export type Route = { role: Role; room: string };

const EVENT_ROUTES: ReadonlyMap<string, Route> = new Map([
  ["support_ticket", { role: "support", room: "#customer" }],
  ["ledger_check", { role: "ledger", room: "#finance" }],
  ["signal.marketing", { role: "market_intel", room: "#marketing" }],
  ["signal.vendor_price", { role: "spend", room: "#finance" }],
  ["signal.reviews", { role: "retention", room: "#customer" }],
  ["signal.leadership", { role: "cofounder", room: "#leadership" }],
  ["weekly_review", { role: "cofounder", room: "#leadership" }],
]);
const FALLBACK_ROUTE: Route = { role: "cofounder", room: "#leadership" };

// Unknown event types go to the Cofounder in #leadership.
export function routeEvent(type: string): Route {
  return EVENT_ROUTES.get(type) ?? FALLBACK_ROUTE;
}

export const GRAPH_LIMITS = { maxHop: 3, maxChildren: 3 } as const;

export type HandoffRejection = "executor_target" | "self_role" | "max_children" | "hop_limit";
export type HandoffCheck = { ok: true; hop: number } | { ok: false; reason: HandoffRejection };

// Whether `parent` may create a child task for `toRole`, given how many children it already has.
export function checkHandoff(parent: { role: Role; hop: number }, toRole: Role, childCount: number): HandoffCheck {
  if (toRole === "executor") return { ok: false, reason: "executor_target" }; // only the gate dispatches the Executor
  if (toRole === parent.role) return { ok: false, reason: "self_role" };
  if (childCount >= GRAPH_LIMITS.maxChildren) return { ok: false, reason: "max_children" };
  const hop = parent.hop + 1;
  if (hop > GRAPH_LIMITS.maxHop) return { ok: false, reason: "hop_limit" };
  return { ok: true, hop };
}

export const AWAITING_REPLY: readonly TaskStatus[] = ["assigned", "repairing"];
// A token for a closed task no longer reads data (spec 06). Escalated tasks stay open: the ladder still works on them.
export const CLOSED_STATUSES: readonly TaskStatus[] = ["done", "failed", "cancelled"];

// What checkStuckTasks does with a task: nudge once, then escalate. A repair that goes unanswered escalates directly.
// Ladder tasks (spec 09: issue, package) get one attempt per level and climb at the deadline, without a nudge.
export function deadlineAction(
  task: { status: TaskStatus; deadline: number; nudged?: boolean; kind?: TaskKind },
  now: number,
): "nudge" | "escalate" | null {
  if (task.deadline > now) return null;
  const ladder = task.kind === "issue" || task.kind === "package";
  if (task.status === "assigned") return task.nudged || ladder ? "escalate" : "nudge";
  if (task.status === "repairing") return "escalate";
  return null;
}
