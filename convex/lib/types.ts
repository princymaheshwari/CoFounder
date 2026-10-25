import { v } from "convex/values";

// Shared literal unions (spec 01). Each tuple is the single source for its TS type and Convex validator.

function literals<T extends readonly [string, ...string[]]>(values: T) {
  return v.union(...values.map((value) => v.literal(value as T[number])));
}

export const ROLES = [
  "cofounder",
  "marketing_manager",
  "market_intel",
  "content",
  "customer_manager",
  "support",
  "retention",
  "finance_manager",
  "ledger",
  "spend",
  "executor",
] as const;
export type Role = (typeof ROLES)[number];
export const vRole = literals(ROLES);

export const DEPARTMENTS = ["leadership", "marketing", "customer", "finance", "none"] as const;
export type Department = (typeof DEPARTMENTS)[number];
export const vDepartment = literals(DEPARTMENTS);

export const MESSAGE_TYPES = ["ASSIGN", "REPORT", "HANDOFF", "ISSUE", "OBJECT", "ESCALATE", "DECISION"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];
export const vMessageType = literals(MESSAGE_TYPES);

export const ACTION_TYPES = [
  "reply_customer",
  "publish_post",
  "file_bug",
  "schedule_digest",
  "refund",
  "refund_batch",
  "pay_bill",
  "switch_vendor",
  "price_change",
  "marketing_spend",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
export const vActionType = literals(ACTION_TYPES);

export const ISSUE_KINDS = ["information", "coordination", "authority", "capability"] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];
export const vIssueKind = literals(ISSUE_KINDS);

export const EFFECTS = ["allow", "escalate", "deny"] as const;
export type Effect = (typeof EFFECTS)[number];
export const vEffect = literals(EFFECTS);

// Gate results add "queue" (absence mode) to the rule effects (spec 07).
export const GATE_EFFECTS = ["allow", "escalate", "deny", "queue"] as const;
export type GateEffect = (typeof GATE_EFFECTS)[number];
export const vGateEffect = literals(GATE_EFFECTS);

export const AGENT_KINDS = ["role", "executor"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];
export const vAgentKind = literals(AGENT_KINDS);

export const SENDER_KINDS = ["agent", "system", "founder"] as const; // system = Dispatcher
export type SenderKind = (typeof SENDER_KINDS)[number];
export const vSenderKind = literals(SENDER_KINDS);

export const EVENT_SOURCES = ["seed", "ticket", "apify", "replay", "founder", "system"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];
export const vEventSource = literals(EVENT_SOURCES);

export const TASK_KINDS = ["work", "issue", "handoff", "standup", "package", "review"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const vTaskKind = literals(TASK_KINDS);

export const TASK_STATUSES = [
  "queued",
  "assigned",
  "replied",
  "gated",
  "done",
  "repairing",
  "escalated",
  "failed",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const vTaskStatus = literals(TASK_STATUSES);

export const TASK_MODES = ["live", "replay"] as const;
export type TaskMode = (typeof TASK_MODES)[number];
export const vTaskMode = literals(TASK_MODES);

export const ISSUE_LEVELS = ["employee", "manager", "founder"] as const;
export type IssueLevel = (typeof ISSUE_LEVELS)[number];
export const vIssueLevel = literals(ISSUE_LEVELS);

export const ISSUE_STATUSES = ["open", "escalated", "resolved"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export const vIssueStatus = literals(ISSUE_STATUSES);

export const ACTION_STATUSES = [
  "proposed",
  "labeled",
  "allowed",
  "executing",
  "executed",
  "failed",
  "escalated",
  "approved",
  "denied",
  "queued",
] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];
export const vActionStatus = literals(ACTION_STATUSES);

export const DECISION_SUBJECTS = ["action", "issue", "rule"] as const;
export type DecisionSubject = (typeof DECISION_SUBJECTS)[number];
export const vDecisionSubject = literals(DECISION_SUBJECTS);

export const DECISION_CHOICES = ["approve", "deny"] as const;
export type DecisionChoice = (typeof DECISION_CHOICES)[number];
export const vDecisionChoice = literals(DECISION_CHOICES);

export const DECIDERS = ["founder", "cofounder", "manager"] as const;
export type Decider = (typeof DECIDERS)[number];
export const vDecider = literals(DECIDERS);

export const RULE_SCOPE_LEVELS = ["company", "department", "role"] as const;
export type RuleScopeLevel = (typeof RULE_SCOPE_LEVELS)[number];
export const vRuleScopeLevel = literals(RULE_SCOPE_LEVELS);

export const CONDITION_OPS = ["<", "<=", ">", ">=", "==", "!=", "in", "not_in"] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];
export const vConditionOp = literals(CONDITION_OPS);

export const RULE_STATUSES = ["proposed", "active", "suspended", "expired", "revoked"] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];
export const vRuleStatus = literals(RULE_STATUSES);

export const RUN_PURPOSES = ["assign", "repair", "nudge", "execute"] as const;
export type RunPurpose = (typeof RUN_PURPOSES)[number];
export const vRunPurpose = literals(RUN_PURPOSES);

// Creao API Trigger run states (CLAUDE.md "External APIs").
export const RUN_STATUSES = ["pending", "running", "completed", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const vRunStatus = literals(RUN_STATUSES);

export const TICKET_STATUSES = ["open", "handled"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const vTicketStatus = literals(TICKET_STATUSES);

export const TICKET_SOURCES = ["seed", "gmail"] as const;
export type TicketSource = (typeof TICKET_SOURCES)[number];
export const vTicketSource = literals(TICKET_SOURCES);

export const LEDGER_KINDS = ["deposit", "purchase", "transfer", "bill"] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];
export const vLedgerKind = literals(LEDGER_KINDS);

export const POST_STATUSES = ["queued", "published"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];
export const vPostStatus = literals(POST_STATUSES);

export const INBOX_KINDS = ["action", "package", "rule", "objection"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];
export const vInboxKind = literals(INBOX_KINDS);

export const INBOX_STATUSES = ["open", "decided"] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];
export const vInboxStatus = literals(INBOX_STATUSES);

export const FOUNDER_STATUSES = ["present", "away"] as const;
export type FounderStatus = (typeof FOUNDER_STATUSES)[number];
export const vFounderStatus = literals(FOUNDER_STATUSES);
