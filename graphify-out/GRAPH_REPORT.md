# Graph Report - CoFounder  (2026-11-10)

## Corpus Check
- 82 files · ~168,671 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1674 nodes · 4076 edges · 88 communities (85 shown, 3 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 125 edges (avg confidence: 0.87)
- Token cost: 327,962 input · 0 output

## Community Hubs (Navigation)
- Agent Prompts & Action Types
- Shared Type Literals
- Recurring Plans & Flows
- Issue Ladder Logic
- Platform Constraints & Tables
- Inbox & Founder Decisions
- Apify Change Monitors
- Executor Connectors
- Demo Story Mode
- Creao HTTP Client
- Nessie Execution
- Dispatcher Replies & Climb
- Gate Evaluation
- Spec 07 Gate & Catalog
- Feed Rendering
- Spec 00 Setup
- Rule Matching Logic
- Package Manifest
- Landing Page
- Jev Label Specs
- Schema Validators
- API Trigger Test Script
- co HTTP Endpoints
- Task & Action Tables
- Founder App Design
- Executor Agent Prompt
- App Shell & Channels
- Message Thread UI
- Dev Dependencies
- Request Cards UI
- Message Protocol Spec
- Audit, Callbacks & Crons
- Rules Tests
- Task Tokens
- co CLI Spec
- Channel Helpers
- Task Tests
- Nessie Seed Data
- Jev Labeling
- Nessie Pure Helpers
- Gate Tests
- Ledger Agent Prompt
- co Admission & Views
- Envelope Parsing
- Nessie Amounts & Seed
- LinkedIn Radar
- Desk & UI Kit
- Onboarding UI
- Nessie Actions & Sync
- Rule Learning Spec
- Issue Ladder Tests
- Live Bank Proof
- co Tests & Views
- Routing & Graph Limits
- Spec 08 Nessie
- Fake Jev
- Executor Tests
- Spec 13 Apify Signals
- co Data Views
- Envelope Tests & Fixtures
- Dev Helpers
- Dispatcher Runs & Pools
- Action Catalog
- Spec 09 Issue Ladder
- Rule Induction
- Core Enum Lists
- Runtime Dependencies
- npm Scripts
- Nessie Panel UI
- Sidebar & Story UI
- Rule Text Formatting
- Customer Manager Prompt
- Cofounder Prompt
- Content Agent Prompt
- Finance Manager Prompt
- Market Intel Prompt
- Marketing Manager Prompt
- Retention Prompt
- Spend Prompt
- Budget & Time Views
- Message Formatting
- Seed Config
- Inject Signal Script
- Fake Nessie
- Convex Components
- Agent Prompt Tests
- Env Setup Script

## God Nodes (most connected - your core abstractions)
1. `audit()` - 68 edges
2. `convex` - 39 edges
3. `Spec 01: Schema` - 33 edges
4. `appendMessage()` - 29 edges
5. `System Design v4 (API Trigger)` - 27 edges
6. `assign()` - 22 edges
7. `vitest` - 22 edges
8. `clock()` - 20 edges
9. `Role` - 19 edges
10. `gateAction()` - 19 edges

## Surprising Connections (you probably didn't know these)
- `Hard rules` --references--> `refund()`  [INFERRED]
  agents/creao/ledger.md → tests/gate.test.ts
- `Method` --references--> `refund()`  [INFERRED]
  agents/creao/ledger.md → tests/gate.test.ts
- `Hard rules` --references--> `refund()`  [INFERRED]
  agents/creao/support.md → tests/gate.test.ts
- `Method` --references--> `refund()`  [INFERRED]
  agents/creao/support.md → tests/gate.test.ts
- `429 RateLimitedError with retryAfterMs` --references--> `RateLimitedError`  [EXTRACTED]
  docs/specs/02-creao-clients.md → convex/creao/http.ts

## Import Cycles
- 3-file cycle: `convex/dispatcher.ts -> convex/executor.ts -> convex/issues.ts -> convex/dispatcher.ts`
- 3-file cycle: `convex/dispatcher.ts -> convex/executor.ts -> convex/story.ts -> convex/dispatcher.ts`
- 3-file cycle: `convex/executor.ts -> convex/issues.ts -> convex/gate.ts -> convex/executor.ts`
- 3-file cycle: `convex/executor.ts -> convex/nessie.ts -> convex/gate.ts -> convex/executor.ts`
- 3-file cycle: `convex/executor.ts -> convex/story.ts -> convex/gate.ts -> convex/executor.ts`
- 4-file cycle: `convex/dispatcher.ts -> convex/executor.ts -> convex/nessie.ts -> convex/issues.ts -> convex/dispatcher.ts`
- 4-file cycle: `convex/executor.ts -> convex/issues.ts -> convex/rules.ts -> convex/gate.ts -> convex/executor.ts`
- 4-file cycle: `convex/executor.ts -> convex/nessie.ts -> convex/issues.ts -> convex/gate.ts -> convex/executor.ts`
- 4-file cycle: `convex/executor.ts -> convex/story.ts -> convex/nessie.ts -> convex/gate.ts -> convex/executor.ts`
- 5-file cycle: `convex/dispatcher.ts -> convex/executor.ts -> convex/story.ts -> convex/nessie.ts -> convex/issues.ts -> convex/dispatcher.ts`
- 5-file cycle: `convex/executor.ts -> convex/nessie.ts -> convex/issues.ts -> convex/rules.ts -> convex/gate.ts -> convex/executor.ts`
- 5-file cycle: `convex/executor.ts -> convex/story.ts -> convex/nessie.ts -> convex/issues.ts -> convex/gate.ts -> convex/executor.ts`

## Hyperedges (group relationships)
- **Flow A duplicate-charge escalation chain** — docs_specs_08_nessie_planted_incident, docs_specs_06_co_cli_skill_duplicates_view, docs_specs_09_issue_ladder_climb, docs_specs_09_issue_ladder_founder_package, docs_specs_09_issue_ladder_recordfounderdecision, docs_specs_10_executor_and_connectors_linear_connector [EXTRACTED 1.00]
- **Run start -> webhook/poll -> reply ingest pipeline** — docs_specs_04_dispatcher_and_runs_assign_task, docs_specs_02_creao_clients_runs_client, docs_specs_04_dispatcher_and_runs_creao_callback, docs_specs_04_dispatcher_and_runs_poll_runs, docs_specs_04_dispatcher_and_runs_ingest_run_record_reply, docs_specs_05_tasks_and_orchestration_on_agent_reply [EXTRACTED 1.00]
- **Authority gate decision inputs** — docs_system_design_authority_gate, docs_system_design_gate_order, docs_system_design_jev_labels, docs_system_design_action_catalog, docs_system_design_rule_schema, docs_specs_01_schema_table_budgets [INFERRED 0.85]
- **Invalid or missing reply: repair/nudge then ISSUE** — docs_specs_05_tasks_and_orchestration_rerun_nudge, docs_specs_05_tasks_and_orchestration_check_stuck_tasks, docs_specs_05_tasks_and_orchestration_issues_module [INFERRED 0.85]
- **Flow A: double-charge escalation chain** — agents_creao_support_support_agent, agents_creao_customer_manager_customer_manager_agent, agents_creao_ledger_ledger_agent, agents_creao_finance_manager_finance_manager_agent, agents_creao_cofounder_cofounder_agent, docs_system_design_room_founder_desk, agents_creao_executor_executor_agent [EXTRACTED 1.00]
- **Non-negotiable invariants** — claude_inv_agents_never_execute, claude_inv_gate_is_code, claude_inv_only_dispatcher_triggers, claude_inv_every_message_validated, claude_inv_budgets_in_gate_txn, claude_inv_keys_in_convex_env, claude_inv_everything_audited, claude_inv_graph_limits [EXTRACTED 1.00]
- **Weekly LinkedIn post flow (signals to post queue)** — readme_company_radar, agents_creao_market_intel_market_intel_agent, agents_creao_content_content_agent, agents_creao_cofounder_publish_post, agents_creao_marketing_manager_marketing_manager_agent [INFERRED 0.85]
- **Post-decision execution path (gate allow / founder approve -> executor)** — docs_specs_10_executor_and_connectors_scheduleexecution, docs_specs_08_nessie_executemoneyaction, docs_specs_10_executor_and_connectors_runexecutor, docs_specs_10_executor_and_connectors_post_queue, docs_specs_08_nessie_executionblock, docs_specs_10_executor_and_connectors_begin_connector [EXTRACTED 1.00]
- **Jev labeling before the gate** — docs_specs_11_jev_labels_labelactions, docs_specs_11_jev_labels_labelspecs, docs_specs_11_jev_labels_jev_decisions_api, docs_specs_11_jev_labels_savelabels, docs_specs_07_gate_gateaction, docs_specs_11_jev_labels_label_error [EXTRACTED 1.00]
- **Rule learning lifecycle (induce -> validate -> approve -> mirror -> suspend)** — docs_specs_12_rule_learning_induce_rule, docs_specs_12_rule_learning_candidate_validation, docs_specs_12_rule_learning_rules_lib, docs_specs_12_rule_learning_rule_mutations, docs_specs_12_rule_learning_override_suspend, docs_specs_12_rule_learning_rule_mirrors [EXTRACTED 1.00]
- **Marketing Department** — assets_agent_hierarchy_marketing_manager, assets_agent_hierarchy_market_intel, assets_agent_hierarchy_content, docs_system_design_room_marketing [EXTRACTED 1.00]
- **Customer Department** — assets_agent_hierarchy_customer_manager, assets_agent_hierarchy_support, assets_agent_hierarchy_retention, docs_system_design_room_customer [EXTRACTED 1.00]
- **Finance Department** — assets_agent_hierarchy_finance_manager, assets_agent_hierarchy_ledger, assets_agent_hierarchy_spend, docs_system_design_room_finance [EXTRACTED 1.00]

## Communities (88 total, 3 thin omitted)

### Community 0 - "Agent Prompts & Action Types"
Cohesion: 0.05
Nodes (72): ASSIGN message from the Dispatcher, Cofounder agent, Decision package (situation, evidence, attempts, options, recommendation), file_bug action, marketing_spend action, publish_post action, refund_batch action, Content agent (+64 more)

### Community 1 - "Shared Type Literals"
Cohesion: 0.05
Nodes (40): ACTION_STATUSES, AGENT_KINDS, AgentKind, DECIDERS, DECISION_CHOICES, DECISION_SUBJECTS, DecisionSubject, EVENT_SOURCES (+32 more)

### Community 2 - "Recurring Plans & Flows"
Cohesion: 0.10
Nodes (36): DEFAULT_PLAN, Flow, FLOW_ROLES, FLOW_RULE, FLOW_SUFFIX, FLOWS, HOUR_MS, LINKEDIN_WEEKLY (+28 more)

### Community 3 - "Issue Ladder Logic"
Cohesion: 0.14
Nodes (36): scheduleExecution(), currentBudget(), gateAction(), actionLines(), agentFor(), chainIssues(), climb(), clip() (+28 more)

### Community 4 - "Platform Constraints & Tables"
Cohesion: 0.10
Nodes (29): Rate Limiter: 60 runs/hour/role, Rooms = Convex channels (rooms table), audit_log table, messages table, rooms table, runs table, creaoFetch (convex/creao/http.ts), Creao fixtures (convex/creao/__fixtures__) (+21 more)

### Community 5 - "Inbox & Founder Decisions"
Cohesion: 0.10
Nodes (28): decisionFeatures(), decide, decideInternal, decideItem(), listOpen, vDecideArgs, vDecideResult, vItem (+20 more)

### Community 6 - "Apify Change Monitors"
Cohesion: 0.12
Nodes (24): apifyCallback, ingestSignals, saveSignals, vSignal, vTask, CallbackBody, clip(), dataHints() (+16 more)

### Community 7 - "Executor Connectors"
Cohesion: 0.09
Nodes (32): activity, authorized(), beginConnector, configure, consumeExecutorBudget, DEFAULT_CONFIG, enrichParams(), ExecutorConfig (+24 more)

### Community 8 - "Demo Story Mode"
Cohesion: 0.10
Nodes (33): vRunPurpose, DEMO_RESET_KEY, priorRefund(), refundGuardSince(), seedRules(), config, BatchItem, contentTask() (+25 more)

### Community 9 - "Creao HTTP Client"
Cohesion: 0.14
Nodes (23): CREAO_BASE_URL, CreaoError, creaoFetch(), CreaoResponse, errorCode(), parseRetryAfter(), RateLimitedError, Artifact (+15 more)

### Community 10 - "Nessie Execution"
Cohesion: 0.09
Nodes (32): actionOfMarker(), beginExecution, customerForRefund(), dollars(), dropWipedRefunds, ExecItem, failExecution, finishExecution (+24 more)

### Community 11 - "Dispatcher Replies & Climb"
Cohesion: 0.13
Nodes (31): DEFAULT_LEVEL_TIMEOUT_MS, HandoffSource, recordReply, climbFromLadderTask(), isLadderTask(), managerOf(), raiseIssue(), agentFor() (+23 more)

### Community 12 - "Gate Evaluation"
Cohesion: 0.09
Nodes (28): BudgetLimits, decisionStats(), dollars(), evaluateGate, GATEABLE, gateConfig(), GateOutcome, num() (+20 more)

### Community 13 - "Spec 07 Gate & Catalog"
Cohesion: 0.13
Nodes (28): Spec 07: Gate and action catalog, Absence mode (founder away -> queue), Budgets (company:refund daily, company:marketing weekly), Action catalog (convex/lib/catalog.ts), Cofounder authority marketing_spend rule, evaluate (pure gate function), evaluateGate mutation, features(action, customer) flat record (+20 more)

### Community 14 - "Feed Rendering"
Cohesion: 0.14
Nodes (27): actionText(), ASK, block(), channel, clip(), displayNames(), dollars(), Env (+19 more)

### Community 15 - "Spec 00 Setup"
Cohesion: 0.09
Nodes (26): Manual account setup (Creao capi_ key, agents, connectors, Nessie, Apify, Convex coupon), seed.config.ts + seed:config, scripts/set-env.sh + .env.example, Spec 00: Setup and accounts, Spec 01: Schema, agents table, budgets table, company table (+18 more)

### Community 16 - "Rule Matching Logic"
Cohesion: 0.10
Nodes (27): Condition, agrees(), candidateProblem(), conditionValue, covers(), DeptOf, EFFECT_TEXT, featureRecord() (+19 more)

### Community 17 - "Package Manifest"
Cohesion: 0.08
Nodes (25): name, private, type, version, ai, @convex-dev/ai-sdk-provider, @convex-dev/eslint-plugin, @edge-runtime/vm (+17 more)

### Community 18 - "Landing Page"
Cohesion: 0.14
Nodes (24): DotWord(), GLYPHS, Landing(), Dept, Kind, node(), NODE_IDS, NodeId (+16 more)

### Community 19 - "Jev Label Specs"
Cohesion: 0.10
Nodes (18): BY_TYPE, clamp01(), clip(), GROUNDED, JEV_MODEL, JevQuestion, JevQuestions, jevState() (+10 more)

### Community 20 - "Schema Validators"
Cohesion: 0.08
Nodes (23): vActionStatus, vAgentKind, vConditionOp, vDecider, vDecisionSubject, vEventSource, vFounderStatus, vInboxKind (+15 more)

### Community 21 - "API Trigger Test Script"
Cohesion: 0.18
Nodes (9): call(), show(), start_and_wait(), call(), emit(), fail(), main(), Parser (+1 more)

### Community 22 - "co HTTP Endpoints"
Cohesion: 0.15
Nodes (20): auditDenied, authenticate(), bearer(), Caller, coData, coHistory, coLimiter, coRadar (+12 more)

### Community 23 - "Task & Action Tables"
Cohesion: 0.16
Nodes (21): TOKEN_PLACEHOLDER, Action status values, actions table, issues table, tasks table, Task status machine values, Creao threadId continuity per task, checkStuckTasks cron (+13 more)

### Community 24 - "Founder App Design"
Cohesion: 0.15
Nodes (20): Convex component install (workflow, workpool, rate-limiter, aggregate, ai-sdk-provider), Spec 14: Founder app, Story mode (convex/story.ts, DEMO_TOOLS=on), Act double_charge_again (Charged twice, next morning), Headline chart: founder decisions per day fall as rules appear, Metrics (@convex-dev/aggregate), Replay engine (convex/replay.ts), scripts/replay/scenario.json (14 days, recorded envelopes, founder_policy) (+12 more)

### Community 25 - "Executor Agent Prompt"
Cohesion: 0.15
Nodes (20): Example output (shape only; do not reuse these facts), Executor: connector agent, Hard rules, Input, Method, Output schema (Envelope), Run idempotencyKey (task:purpose:attempt), Spec 10: Executor and connectors (+12 more)

### Community 26 - "App Shell & Channels"
Cohesion: 0.16
Nodes (17): react, react-dom, App(), ChannelHeader(), ChannelView(), Desk(), format(), Page (+9 more)

### Community 27 - "Message Thread UI"
Cohesion: 0.26
Nodes (20): EntryList(), StandaloneEntry(), STATUS, ThreadEntry(), AgentReply(), AssignBody(), AssignMessage(), channelName() (+12 more)

### Community 28 - "Dev Dependencies"
Cohesion: 0.10
Nodes (21): devDependencies, @convex-dev/eslint-plugin, convex-test, @edge-runtime/vm, eslint, @eslint/js, eslint-plugin-react-hooks, eslint-plugin-react-refresh (+13 more)

### Community 29 - "Request Cards UI"
Cohesion: 0.18
Nodes (16): AskBody(), DecidedCard(), FROM, RequestCard(), RuleBody(), Rulebook(), STATUS, Pill() (+8 more)

### Community 30 - "Message Protocol Spec"
Cohesion: 0.15
Nodes (17): Lumen Notes demo company fixture, Shared literal unions (convex/lib/types.ts), Spec 03: Message protocol, Action types and params (refund, refund_batch, pay_bill, ...), companyBlock (compact company summary <=1500 chars), cofounder envelope (agent -> Convex), formatAssign, formatDecision (+9 more)

### Community 31 - "Audit, Callbacks & Crons"
Cohesion: 0.15
Nodes (8): chainAudit, supportAgent, crons, check, gateway, ping, http, convex

### Community 32 - "Rules Tests"
Cohesion: 0.13
Nodes (13): DecisionRow, RuleLike, claudeCalls, contentTask(), decide(), DEPTS, drain(), GOOD (+5 more)

### Community 33 - "Task Tokens"
Cohesion: 0.15
Nodes (15): encoder, fromBase64Url(), hmacKey(), signTaskToken(), TaskTokenClaims, toBase64Url(), TOKEN_TTL_MS, VerifyResult (+7 more)

### Community 34 - "co CLI Spec"
Cohesion: 0.17
Nodes (14): CREAO department agents, Spec 06: co CLI skill, co admit mutation (budget + auth + role + audit in one txn), co CLI (co.py, stdlib-only), Convex HTTP routes /co/data, /co/history, /co/radar, co rate limit (60 calls per task), COFOUNDER_URL Creao secret, co data duplicates view (+6 more)

### Community 35 - "Channel Helpers"
Cohesion: 0.16
Nodes (18): appendMessage(), audit(), FounderRequest, getConfig(), notifyFounder(), recordDelivery, assign(), assignArgs() (+10 more)

### Community 36 - "Task Tests"
Cohesion: 0.15
Nodes (13): extractEnvelopeBlock(), drain(), getTask(), managerTask(), modules, newEvent(), openTask(), posts (+5 more)

### Community 37 - "Nessie Seed Data"
Cohesion: 0.14
Nodes (18): addMonths(), ADDRESS, BILL_PAYEE, buildSeedPlan(), CUSTOMER_ACCOUNT, dayMs(), INCIDENT_MONTHS_BACK, MERCHANTS (+10 more)

### Community 38 - "Jev Labeling"
Cohesion: 0.18
Nodes (17): probeJev, customerFor(), clip(), errorText(), evidenceText(), findingsFor(), finishFounderGate, jevDecide() (+9 more)

### Community 39 - "Nessie Pure Helpers"
Cohesion: 0.23
Nodes (17): centsFromNessie(), cleanRaw(), executionBlock(), isoDate(), markerOf(), mirrorFromBill(), mirrorFromDeposit(), mirrorFromPurchase() (+9 more)

### Community 40 - "Gate Tests"
Cohesion: 0.11
Nodes (10): billing, Case, CASES, CONFIG, LABELS, linkedinRule, noCommitment, NOW (+2 more)

### Community 41 - "Ledger Agent Prompt"
Cohesion: 0.13
Nodes (15): Data you can read (the `co` skill), Example output (shape only; do not reuse these facts), Hard rules, Input, Ledger: bookkeeping agent, Method, Output schema (Envelope), Data you can read (the `co` skill) (+7 more)

### Community 42 - "co Admission & Views"
Cohesion: 0.12
Nodes (16): admit, admitCall(), canRead(), Charge, CO_CALLS_PER_TASK, CUSTOMER_LEDGER_ROWS, DAY_MS, DUPLICATE_WINDOW_MS (+8 more)

### Community 43 - "Envelope Parsing"
Cohesion: 0.13
Nodes (16): ACTION_CARRIERS, ACTION_PARAMS, cents, CompanyProfile, decisionPackage, describeIssue(), Envelope, envelopeSchema (+8 more)

### Community 44 - "Nessie Amounts & Seed"
Cohesion: 0.15
Nodes (12): FractionalAmountError, toNessieAmount(), HISTORY_DAYS, INCIDENT_DATE, OPERATING, PLAN_CENTS, SEED_ANCHOR, action() (+4 more)

### Community 45 - "LinkedIn Radar"
Cohesion: 0.22
Nodes (15): LINKEDIN_ACTOR, LINKEDIN_SOURCE, linkedinInput(), linkedinQueries(), normalizeLinkedInPost(), num(), obj(), RadarSignal (+7 more)

### Community 46 - "Desk & UI Kit"
Cohesion: 0.13
Nodes (15): PURPOSE, Card, ChannelData, DeptChip(), Entry, initials(), Mention(), Overview (+7 more)

### Community 47 - "Onboarding UI"
Cohesion: 0.14
Nodes (13): convex-test, COLUMNS, Competitor, Doc, EXAMPLE, FLOW_STEPS, humanRole(), Onboarding() (+5 more)

### Community 48 - "Nessie Actions & Sync"
Cohesion: 0.27
Nodes (14): chunks(), cleanupDemoRefunds, executeMoneyAction, pool(), seedNessie, syncLedger, Method, nessieCreate() (+6 more)

### Community 49 - "Rule Learning Spec"
Cohesion: 0.24
Nodes (13): decisions table, rules table, recordFounderDecision (inbox:decide), ruleCandidateSchema + candidateProblem validation, maybeInduce / induceRule, Approve and make it a rule (makeRule, min 1), Founder override suspends rule (overrideAllowed), proposeRule / approveRule / rejectRule / suspendRule (+5 more)

### Community 50 - "Issue Ladder Tests"
Cohesion: 0.19
Nodes (11): allTasks(), coordination, drain(), getTask(), managerOnIssue(), modules, reply(), T (+3 more)

### Community 51 - "Live Bank Proof"
Cohesion: 0.19
Nodes (13): failure(), lastMove, liveRefunds, messageObjects, shown(), toTransfer(), Transfer, verifyMessage (+5 more)

### Community 52 - "co Tests & Views"
Cohesion: 0.15
Nodes (9): CO_VIEWS, CoView, findDuplicateCharges(), hashToken(), ROLES, modules, room(), T (+1 more)

### Community 53 - "Routing & Graph Limits"
Cohesion: 0.16
Nodes (13): AWAITING_REPLY, checkHandoff(), CLOSED_STATUSES, deadlineAction(), EVENT_ROUTES, FALLBACK_ROUTE, GRAPH_LIMITS, HandoffCheck (+5 more)

### Community 54 - "Spec 08 Nessie"
Cohesion: 0.26
Nodes (13): ledger_mirror table, Spec 08: Nessie bank, bank.verifyMessage / bank.liveRefunds (live Nessie proof in app), nessie.cleanupDemoRefunds (demo reset deletes rehearsal refunds), executeMoneyAction, executionBlock guard (lib/nessie.ts), Planted duplicate-charge incident (12 x $35 on 2026-10-22), convex/seedData.ts deterministic seed (mulberry32) (+5 more)

### Community 55 - "Fake Jev"
Cohesion: 0.16
Nodes (6): Answer, FakeJev, isJev(), Question, rule(), T

### Community 56 - "Executor Tests"
Cohesion: 0.15
Nodes (6): executed(), modules, runResults, starts, T, wrap()

### Community 57 - "Spec 13 Apify Signals"
Cohesion: 0.25
Nodes (14): /apify-callback + ingestSignals (convex/apify.ts), Apify monitor tasks (competitor-pricing, community, reviews, vendor-pricing, competitor-careers), monema/apify-change-monitor Actor, Weekly LinkedIn flow (harvestapi/linkedin-post-search, convex/radar.ts), Signal dedupe (url, current_hash) via signals.by_url_and_change_hash, Signal {room, source, url, change, significance, evidence_url}, Signal significance scoring, Spec 13: Apify signals (+6 more)

### Community 58 - "co Data Views"
Cohesion: 0.33
Nodes (13): companyView(), customerSummary(), customerView(), duplicatesView(), fail(), ledgerRow(), ledgerView(), readView (+5 more)

### Community 59 - "Envelope Tests & Fixtures"
Cohesion: 0.18
Nodes (9): AssignArgs, CompanyBlock, parseEnvelope(), readExecutorReply(), base, expectError(), expectOk(), refund (+1 more)

### Community 60 - "Dev Helpers"
Cohesion: 0.15
Nodes (12): coSmokeTask, coSmokeToken, dropCoSmokeTask, dropDevAction, inspectRun, proposeAction, seedSupportTicket, setCoSmokeTokenHash (+4 more)

### Community 61 - "Dispatcher Runs & Pools"
Cohesion: 0.17
Nodes (11): consumeRunBudget, ingestRun, pollRuns, POOL_OPTIONS, pools, rateLimiter, runInput, StartArgs (+3 more)

### Community 62 - "Action Catalog"
Cohesion: 0.18
Nodes (9): batchTotal(), BudgetScope, CATALOG, CatalogEntry, cents(), ExecutorKind, Params, Tier (+1 more)

### Community 63 - "Spec 09 Issue Ladder"
Cohesion: 0.27
Nodes (10): Spec 09: Issue ladder and founder inbox, audit:chainAudit, Issue climb policy (employee -> manager -> founder), Flow A (duplicate charge -> refund batch -> founder -> Linear bug), founder_inbox, Founder package (Cofounder REPORT package), Issue grouping (related open issues within 2 h), Inbox page (src/pages/Inbox.tsx) (+2 more)

### Community 64 - "Rule Induction"
Cohesion: 0.27
Nodes (11): inductionPrompt(), deptOfFn(), founderDecisions(), inductionInput, maybeInduce, previousVersion(), ruleLike(), rulesWithStatus() (+3 more)

### Community 65 - "Core Enum Lists"
Cohesion: 0.18
Nodes (10): ACTION_TYPES, DEPARTMENTS, EFFECTS, ISSUE_KINDS, MESSAGE_TYPES, vDepartment, vEffect, vIssueKind (+2 more)

### Community 66 - "Runtime Dependencies"
Cohesion: 0.18
Nodes (11): dependencies, ai, convex, @convex-dev/aggregate, @convex-dev/ai-sdk-provider, @convex-dev/rate-limiter, @convex-dev/workflow, @convex-dev/workpool (+3 more)

### Community 67 - "npm Scripts"
Cohesion: 0.18
Nodes (11): scripts, build, dev, dev:backend, dev:frontend, inject-signal, lint, preview (+3 more)

### Community 68 - "Nessie Panel UI"
Cohesion: 0.31
Nodes (10): at(), Badge(), BankPanel(), dollars(), NessieLine(), payee(), Refunds, Verified (+2 more)

### Community 69 - "Sidebar & Story UI"
Cohesion: 0.27
Nodes (10): run(), ACTS, NavItem(), Sidebar(), Story(), Tape(), View, DEPT_GRAD (+2 more)

### Community 70 - "Rule Text Formatting"
Cohesion: 0.27
Nodes (10): conditionText(), diffText(), fieldName(), labelOf(), nextRuleLabel(), normalizeCandidate(), ruleToSentence(), scopeText() (+2 more)

### Community 71 - "Customer Manager Prompt"
Cohesion: 0.22
Nodes (8): Customer Manager: customer department manager, Data you can read (the `co` skill), Example output (shape only; do not reuse these facts), Hard rules, Input, Method, Output schema (Envelope), ledger()

### Community 72 - "Cofounder Prompt"
Cohesion: 0.25
Nodes (7): Cofounder: the founder's cofounder agent, Data you can read (the `co` skill), Example output (shape only; do not reuse these facts), Hard rules, Input, Method, Output schema (Envelope)

### Community 73 - "Content Agent Prompt"
Cohesion: 0.25
Nodes (7): Content: social post writer, Data you can read (the `co` skill), Example output (shape only; do not reuse these facts), Hard rules, Input, Method, Output schema (Envelope)

### Community 74 - "Finance Manager Prompt"
Cohesion: 0.25
Nodes (7): Data you can read (the `co` skill), Example output (shape only; do not reuse these facts), Finance Manager: finance department manager, Hard rules, Input, Method, Output schema (Envelope)

### Community 75 - "Market Intel Prompt"
Cohesion: 0.25
Nodes (7): Data you can read (the `co` skill), Example output (shape only; do not reuse these facts), Hard rules, Input, Market Intel: competitor and market research agent, Method, Output schema (Envelope)

### Community 76 - "Marketing Manager Prompt"
Cohesion: 0.25
Nodes (7): Data you can read (the `co` skill), Example output (shape only; do not reuse these facts), Hard rules, Input, Marketing Manager: marketing department manager, Method, Output schema (Envelope)

### Community 77 - "Retention Prompt"
Cohesion: 0.25
Nodes (7): Data you can read (the `co` skill), Example output (shape only; do not reuse these facts), Hard rules, Input, Method, Output schema (Envelope), Retention: churn and win-back agent

### Community 78 - "Spend Prompt"
Cohesion: 0.25
Nodes (7): Data you can read (the `co` skill), Example output (shape only; do not reuse these facts), Hard rules, Input, Method, Output schema (Envelope), Spend: spending and vendor agent

### Community 79 - "Budget & Time Views"
Cohesion: 0.39
Nodes (7): budgetView(), usageView(), budgetPeriod(), BudgetPeriodKind, LA_DAY, laDate(), laWeekStart()

### Community 80 - "Message Formatting"
Cohesion: 0.50
Nodes (8): assignBlock(), fenced(), formatAssign(), formatDecision(), formatHandoffAssign(), formatNudge(), formatRepair(), oneLine()

### Community 81 - "Seed Config"
Cohesion: 0.36
Nodes (6): AGENTS, COMPANY, CONFIG_DEFAULTS, ROOMS, R7_SUPPORT, R7_TEXT

### Community 82 - "Inject Signal Script"
Cohesion: 0.36
Nodes (5): fromFile(), main(), Scenario, SCENARIOS, token()

### Community 84 - "Convex Components"
Cohesion: 0.33
Nodes (5): app, @convex-dev/aggregate, @convex-dev/rate-limiter, @convex-dev/workflow, @convex-dev/workpool

### Community 85 - "Agent Prompt Tests"
Cohesion: 0.33
Nodes (3): Role, DIR, files

## Ambiguous Edges - Review These
- `nessie.cleanupDemoRefunds (demo reset deletes rehearsal refunds)` → `story.resetDemo + demo_reset_at (repeatable rehearsals)`  [AMBIGUOUS]
  docs/specs/16-replay-and-metrics.md · relation: conceptually_related_to

## Knowledge Gaps
- **37 isolated node(s):** `Cofounder weekly memo`, `audit:chainAudit`, `Standups (Convex cron)`, `customers table`, `founder table` (+32 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 540 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Shared literal unions (convex/lib/types.ts)` connect `Message Protocol Spec` to `Shared Type Literals`, `Spec 00 Setup`?**
  _High betweenness centrality (0.136) - this node is a cross-community bridge._
- **What connects `Cofounder weekly memo`, `audit:chainAudit`, `Standups (Convex cron)` to the rest of the system?**
  _37 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Agent Prompts & Action Types` be split into smaller, more focused modules?**
  _Cohesion score 0.05269497139415839 - nodes in this community are weakly interconnected._
- **Why does `convex` connect `Audit, Callbacks & Crons` to `Shared Type Literals`, `Recurring Plans & Flows`, `Inbox & Founder Decisions`, `Apify Change Monitors`, `Executor Connectors`, `Demo Story Mode`, `Creao HTTP Client`, `Nessie Execution`, `Dispatcher Replies & Climb`, `Gate Evaluation`, `Feed Rendering`, `Package Manifest`, `Schema Validators`, `co HTTP Endpoints`, `App Shell & Channels`, `Message Thread UI`, `Request Cards UI`, `Jev Labeling`, `LinkedIn Radar`, `Desk & UI Kit`, `Onboarding UI`, `Live Bank Proof`, `Dev Helpers`, `Dispatcher Runs & Pools`, `Nessie Panel UI`, `Sidebar & Story UI`, `Seed Config`, `Convex Components`?**
  _High betweenness centrality (0.135) - this node is a cross-community bridge._
- **Should `Shared Type Literals` be split into smaller, more focused modules?**
  _Cohesion score 0.047619047619047616 - nodes in this community are weakly interconnected._
- **Why does `Spec 01: Schema` connect `Spec 00 Setup` to `Platform Constraints & Tables`, `Rule Learning Spec`, `Spec 08 Nessie`, `Task & Action Tables`, `Founder App Design`, `Message Protocol Spec`?**
  _High betweenness centrality (0.118) - this node is a cross-community bridge._

### Low-confidence Hints
_AMBIGUOUS edges — the extractor was unsure. Verify before acting on these._

- **What is the exact relationship between `nessie.cleanupDemoRefunds (demo reset deletes rehearsal refunds)` and `story.resetDemo + demo_reset_at (repeatable rehearsals)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._