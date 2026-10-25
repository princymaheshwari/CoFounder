import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  vActionStatus,
  vActionType,
  vAgentKind,
  vConditionOp,
  vDecider,
  vDecisionChoice,
  vDecisionSubject,
  vDepartment,
  vEffect,
  vEventSource,
  vFounderStatus,
  vGateEffect,
  vInboxKind,
  vInboxStatus,
  vIssueKind,
  vIssueLevel,
  vIssueStatus,
  vLedgerKind,
  vPostStatus,
  vRole,
  vRuleScopeLevel,
  vRuleStatus,
  vRunPurpose,
  vRunStatus,
  vSenderKind,
  vTaskKind,
  vTaskMode,
  vTaskStatus,
  vTicketSource,
  vTicketStatus,
} from "./lib/types";

// Spec 01. Money is integer cents; times are epoch ms; external ids carry their prefix in the field name.

// Jev label values: choice → string, noul → boolean, score → number (spec 11).
const vLabel = v.object({
  value: v.union(v.string(), v.boolean(), v.number()),
  confidence: v.number(),
});

const vConditionValue = v.union(
  v.number(),
  v.string(),
  v.boolean(),
  v.array(v.string()),
  v.array(v.number()),
);

export default defineSchema({
  agents: defineTable({
    role: vRole,
    department: vDepartment,
    manager_role: v.optional(vRole),
    kind: vAgentKind,
    creao_app_id: v.string(),
    input_field: v.string(), // "message" for role agents, "action" for the Executor
    display_name: v.string(),
    rooms: v.array(v.string()),
    enabled: v.boolean(),
  }).index("by_role", ["role"]),

  // Convex-only channels, not Creao rooms.
  rooms: defineTable({
    name: v.string(),
    department: vDepartment,
    next_seq: v.number(),
  }).index("by_name", ["name"]),

  messages: defineTable({
    room: v.id("rooms"),
    seq: v.number(), // per-channel counter from rooms.next_seq
    task: v.optional(v.id("tasks")), // the task that wrote or received it
    thread: v.optional(v.id("tasks")), // the thread root it appears under (a ladder task writes into its employee's thread)
    sender_kind: vSenderKind,
    sender_name: v.string(),
    sender_role: v.optional(vRole),
    text: v.string(),
    envelope: v.optional(v.any()),
    envelope_error: v.optional(v.string()),
    creao_run_id: v.optional(v.string()),
    inbox: v.optional(v.id("founder_inbox")), // a founder request posted in #founder-desk (decided in the channel)
    created_at: v.number(),
  })
    .index("by_room_seq", ["room", "seq"])
    .index("by_task", ["task"])
    .index("by_thread", ["thread"]),

  events: defineTable({
    type: v.string(),
    payload: v.any(),
    source: vEventSource,
    processed: v.boolean(),
    created_at: v.number(),
  }).index("by_processed", ["processed"]),

  tasks: defineTable({
    role: vRole,
    room: v.id("rooms"),
    kind: vTaskKind,
    brief: v.string(),
    parent_task: v.optional(v.id("tasks")),
    event: v.optional(v.id("events")),
    chain_id: v.string(),
    hop: v.number(),
    attempt: v.number(),
    status: vTaskStatus,
    creao_run_id: v.optional(v.string()), // current run
    creao_thread_id: v.optional(v.string()), // Creao conversation for this task
    origin_refs: v.array(v.string()),
    token_hash: v.optional(v.string()),
    deadline: v.number(),
    nudged: v.optional(v.boolean()), // the one deadline nudge was sent (spec 05)
    mode: vTaskMode,
    thread: v.optional(v.id("tasks")), // thread root when not the task itself (spec 09 manager tasks)
    issue: v.optional(v.id("issues")), // the issue an issue/package task works on (spec 09)
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_role", ["role"])
    .index("by_chain", ["chain_id"])
    .index("by_creao_run", ["creao_run_id"]),

  issues: defineTable({
    task: v.id("tasks"),
    chain_id: v.string(),
    raised_by_role: vRole,
    to_role: v.optional(vRole), // who acts next; absent = the founder (spec 05)
    level: vIssueLevel,
    kind: vIssueKind,
    summary: v.string(),
    attempts: v.array(v.string()),
    evidence: v.array(v.string()),
    status: vIssueStatus,
    resolution: v.optional(v.string()),
    handler_task: v.optional(v.id("tasks")), // the manager task working on it (spec 09)
    package_task: v.optional(v.id("tasks")), // the Cofounder's package task, once it climbs to the founder
    actions: v.optional(v.array(v.id("actions"))), // escalated actions awaiting the founder's decision
    created_at: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_task", ["task"])
    .index("by_chain", ["chain_id"])
    .index("by_handler_task", ["handler_task"]),

  actions: defineTable({
    task: v.id("tasks"),
    chain_id: v.string(),
    role: vRole,
    type: vActionType,
    params: v.any(),
    rationale: v.string(),
    amount_cents: v.optional(v.number()),
    counterparty: v.optional(v.string()),
    labels: v.optional(v.record(v.string(), vLabel)),
    label_error: v.optional(v.string()),
    status: vActionStatus,
    gate: v.optional(
      v.object({
        effect: vGateEffect,
        reason: v.string(),
        rule_id: v.optional(v.id("rules")),
        constraint: v.optional(v.string()),
      }),
    ),
    // Provider ids of what was executed; refund_batch accumulates one per transfer (spec 08).
    executed_ref: v.optional(v.array(v.string())),
    created_at: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_type", ["type"])
    .index("by_task", ["task"]),

  decisions: defineTable({
    subject_kind: vDecisionSubject,
    action: v.optional(v.id("actions")),
    issue: v.optional(v.id("issues")),
    rule: v.optional(v.id("rules")),
    action_type: v.optional(vActionType),
    choice: vDecisionChoice,
    reason: v.optional(v.string()),
    features: v.any(),
    decided_by: vDecider,
    created_at: v.number(),
  }).index("by_action_type", ["action_type"]),

  rules: defineTable({
    scope: v.object({
      level: vRuleScopeLevel,
      department: v.optional(vDepartment),
      role: v.optional(vRole),
    }),
    action_type: vActionType,
    conditions: v.array(
      v.object({
        field: v.string(),
        op: vConditionOp,
        value: vConditionValue,
      }),
    ),
    effect: vEffect,
    status: vRuleStatus,
    version: v.number(),
    supporting_decisions: v.array(v.id("decisions")),
    agreement: v.object({ agree: v.number(), total: v.number() }),
    text: v.string(),
    expires_at: v.optional(v.number()),
    created_at: v.number(),
  }).index("by_type_status", ["action_type", "status"]),

  budgets: defineTable({
    scope: v.string(), // e.g. "company:refund"
    period: v.string(), // YYYY-MM-DD in America/Los_Angeles
    limit_cents: v.number(),
    spent_cents: v.number(),
  }).index("by_scope_period", ["scope", "period"]),

  // Every Creao run: role agents and the Executor.
  runs: defineTable({
    purpose: vRunPurpose,
    role: vRole,
    action: v.optional(v.id("actions")),
    task: v.optional(v.id("tasks")),
    creao_run_id: v.string(),
    idempotency_key: v.string(),
    status: vRunStatus,
    delivery_ids: v.array(v.string()),
    result_raw: v.optional(v.any()),
    error_code: v.optional(v.string()),
    started_at: v.number(),
    finished_at: v.optional(v.number()),
  })
    .index("by_creao_run_id", ["creao_run_id"])
    .index("by_status", ["status"])
    .index("by_role_started", ["role", "started_at"]),

  customers: defineTable({
    name: v.string(),
    email: v.string(), // fake
    nessie_customer_id: v.string(),
    nessie_account_id: v.string(),
    signup_at: v.number(),
    plan: v.string(),
  }).index("by_nessie_account", ["nessie_account_id"]),

  tickets: defineTable({
    customer: v.optional(v.id("customers")),
    from_email: v.string(),
    subject: v.string(),
    body: v.string(),
    amount_cents: v.optional(v.number()),
    status: vTicketStatus,
    source: vTicketSource,
    created_at: v.number(),
  }).index("by_status", ["status"]),

  ledger_mirror: defineTable({
    nessie_id: v.string(),
    kind: vLedgerKind,
    account_id: v.string(),
    amount_cents: v.number(),
    counterparty: v.string(),
    date: v.string(), // ISO
    raw: v.any(),
  })
    .index("by_nessie_id", ["nessie_id"])
    .index("by_kind", ["kind"])
    // co views (spec 06): account_id is the paying account, counterparty the receiving one.
    .index("by_account_date", ["account_id", "date"])
    .index("by_counterparty_date", ["counterparty", "date"])
    .index("by_date", ["date"]),

  // Vector index by_embedding is added in spec 13 once the embedding model (and its dimensions) is verified.
  signals: defineTable({
    room: v.id("rooms"),
    source: v.string(),
    url: v.string(),
    change: v.string(),
    significance: v.number(), // 0–1
    evidence_url: v.string(),
    embedding: v.optional(v.array(v.float64())),
    consumed: v.boolean(),
    created_at: v.number(),
  }).index("by_room", ["room"]),

  post_queue: defineTable({
    action: v.id("actions"),
    channel: v.string(),
    text: v.string(),
    status: vPostStatus,
    created_at: v.number(),
  }).index("by_status", ["status"]),

  // Mock outbox (spec 10): connector actions whose connector is not connected to the Executor.
  outbox: defineTable({
    action: v.id("actions"),
    connector: v.union(v.literal("linear"), v.literal("gmail"), v.literal("calendar")),
    payload: v.any(),
    reason: v.string(),
    created_at: v.number(),
  }).index("by_action", ["action"]),

  founder_inbox: defineTable({
    kind: vInboxKind,
    ref: v.string(),
    title: v.string(),
    body: v.string(),
    options: v.optional(v.array(v.object({ label: v.string(), action: v.optional(v.any()) }))),
    status: vInboxStatus,
    decision: v.optional(v.object({ choice: vDecisionChoice, reason: v.optional(v.string()), at: v.number() })),
    created_at: v.number(),
  }).index("by_status", ["status"]),

  audit_log: defineTable({
    actor: v.string(),
    kind: v.string(),
    ref: v.string(),
    detail: v.any(),
    at: v.number(),
  })
    .index("by_ref", ["ref"])
    .index("by_at", ["at"]),

  founder: defineTable({
    status: vFounderStatus,
    free_slots: v.optional(v.array(v.object({ start: v.number(), end: v.number() }))),
    updated_at: v.number(),
  }),

  // Single row: one company per deployment for now. Sent to agents as the ASSIGN company block.
  company: defineTable({
    name: v.string(),
    product: v.string(),
    description: v.string(),
    plans: v.array(v.object({ name: v.string(), price_cents: v.number(), period: v.string() })),
    customer_type: v.string(),
    voice: v.string(),
    policies: v.array(v.string()),
    competitors: v.array(
      v.object({
        name: v.string(),
        pricing_url: v.optional(v.string()),
        changelog_url: v.optional(v.string()),
        careers_url: v.optional(v.string()),
      }),
    ),
    vendors: v.array(v.object({ name: v.string(), pricing_url: v.optional(v.string()) })),
    review_urls: v.array(v.string()),
    communities: v.array(v.string()),
    // What the founder wrote at onboarding (#start); the recurring plan was drawn from it.
    onboarding: v.optional(
      v.object({
        what: v.string(),
        priorities: v.string(),
        goals: v.string(),
        links: v.array(v.string()),
        docs: v.array(v.object({ name: v.string(), excerpt: v.string() })),
        at: v.number(),
      }),
    ),
    updated_at: v.number(),
  }),

  // Recurring work set up at onboarding. Each row has one thread in its owner's channel; every run posts there.
  recurring: defineTable({
    role: vRole,
    room: v.id("rooms"),
    title: v.string(),
    brief: v.string(),
    cadence_label: v.string(),
    trigger: v.union(v.literal("interval"), v.literal("event")),
    every_ms: v.optional(v.number()),
    event_type: v.optional(v.string()),
    next_run_at: v.optional(v.number()), // interval rows only
    thread: v.id("tasks"), // the first run's task: the thread root every later run writes into
    flow: v.optional(v.literal("linkedin_weekly")), // multi-agent recurring work (lib/recurring.ts FLOWS)
    runs: v.number(),
    active: v.boolean(),
    created_at: v.number(),
  })
    .index("by_active_and_next_run_at", ["active", "next_run_at"])
    .index("by_active_and_event_type", ["active", "event_type"]),

  config: defineTable({
    key: v.string(),
    value: v.any(),
  }).index("by_key", ["key"]),
});
