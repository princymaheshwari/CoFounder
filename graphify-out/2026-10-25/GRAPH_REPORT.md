# Graph Report - CoFounder  (2026-10-25)

## Corpus Check
- 128 files · ~143,033 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 7 file(s) not represented in the graph (top: (none) 3, .css 3, .example 1)

## Summary
- 1531 nodes · 3745 edges · 87 communities (82 shown, 5 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 96 edges (avg confidence: 0.88)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `13d823f5`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- convex/executor.ts
- Shared Type Literals
- onboarding.ts
- ChannelView.tsx
- Nessie Execution
- convex/gate.ts
- convex/co.ts
- Envelope Formatting
- Schema Validators
- convex/radar.ts
- Spec 15: Standups, Cofounder, absence, pushback
- co CLI & Smoke Test
- Package Manifest
- convex
- tasks.ts
- Ledger: bookkeeping agent
- Dev Dependencies
- seed.ts
- dispatcher.ts
- Task Tests
- Gate Tests
- Nessie Seed Data
- Spec 04 Dispatcher
- Spec 06 co CLI
- Executor Tests
- Rule Learning Spec
- Nessie Tests
- Project Invariants
- audit
- Ledger Mirror Sync
- Spec 01: Schema
- Issue Ladder Tests
- format.ts
- OrgDiagram.tsx
- Spec 03 Messages
- dispatcher.test.ts
- runs.ts
- Spec 00-02 Setup
- Spec 07: Gate and action catalog
- Spec 08 Nessie
- labels.ts
- convex/rules.ts
- Schema Tests
- Apify Signals Spec
- Spec 09: Issue ladder and founder inbox
- lib/rules.ts
- convex_generated_api
- Action Catalog
- Nessie.tsx
- bank.ts
- convex_generated_server
- lib/gate.ts
- Runtime Dependencies
- story.ts
- Spec 10 Executor
- npm Scripts
- story.test.ts
- rules.test.ts
- Spec 11: Jev labels
- Sidebar.tsx
- co.test.ts
- issues.ts
- convex_generated_api
- proposeCandidate
- System Design v4 (API Trigger)
- convex/http.ts
- Env Setup Script
- readView
- time.ts
- FakeNessie
- nessieApi.ts
- lib/co.ts
- Customer Manager: customer department manager
- Cofounder: the founder's cofounder agent
- Content: social post writer
- Finance Manager: finance department manager
- Market Intel: competitor and market research agent
- Marketing Manager: marketing department manager
- Retention: churn and win-back agent
- Spend: spending and vendor agent
- raiseIssue
- HMAC task token (convex/lib/tokens.ts)
- Executor: connector agent
- agents.test.ts
- convex_generated_server_internalquery
- README.md

## God Nodes (most connected - your core abstractions)
1. `audit()` - 65 edges
2. `convex` - 38 edges
3. `Spec 01: Schema` - 31 edges
4. `appendMessage()` - 29 edges
5. `System Design v4 (API Trigger)` - 25 edges
6. `assign()` - 22 edges
7. `vitest` - 21 edges
8. `clock()` - 20 edges
9. `gateAction()` - 19 edges
10. `Role` - 19 edges

## Surprising Connections (you probably didn't know these)
- `App()` --implements--> `Spec 14: Founder app`  [INFERRED]
  src/App.tsx → docs/specs/14-founder-app.md
- `Hard rules` --references--> `refund()`  [INFERRED]
  agents/creao/ledger.md → tests/gate.test.ts
- `Method` --references--> `refund()`  [INFERRED]
  agents/creao/ledger.md → tests/gate.test.ts
- `Hard rules` --references--> `refund()`  [INFERRED]
  agents/creao/support.md → tests/gate.test.ts
- `Method` --references--> `refund()`  [INFERRED]
  agents/creao/support.md → tests/gate.test.ts

## Import Cycles
- 3-file cycle: `convex/executor.ts -> convex/nessie.ts -> convex/gate.ts -> convex/executor.ts`
- 3-file cycle: `convex/dispatcher.ts -> convex/executor.ts -> convex/issues.ts -> convex/dispatcher.ts`
- 3-file cycle: `convex/executor.ts -> convex/issues.ts -> convex/gate.ts -> convex/executor.ts`
- 3-file cycle: `convex/dispatcher.ts -> convex/executor.ts -> convex/story.ts -> convex/dispatcher.ts`
- 3-file cycle: `convex/executor.ts -> convex/story.ts -> convex/gate.ts -> convex/executor.ts`
- 4-file cycle: `convex/executor.ts -> convex/story.ts -> convex/nessie.ts -> convex/gate.ts -> convex/executor.ts`
- 4-file cycle: `convex/dispatcher.ts -> convex/executor.ts -> convex/nessie.ts -> convex/issues.ts -> convex/dispatcher.ts`
- 4-file cycle: `convex/executor.ts -> convex/nessie.ts -> convex/issues.ts -> convex/gate.ts -> convex/executor.ts`
- 4-file cycle: `convex/executor.ts -> convex/issues.ts -> convex/rules.ts -> convex/gate.ts -> convex/executor.ts`
- 5-file cycle: `convex/dispatcher.ts -> convex/executor.ts -> convex/story.ts -> convex/nessie.ts -> convex/issues.ts -> convex/dispatcher.ts`
- 5-file cycle: `convex/executor.ts -> convex/story.ts -> convex/nessie.ts -> convex/issues.ts -> convex/gate.ts -> convex/executor.ts`
- 5-file cycle: `convex/executor.ts -> convex/nessie.ts -> convex/issues.ts -> convex/rules.ts -> convex/gate.ts -> convex/executor.ts`

## Hyperedges (group relationships)
- **Proposed action -> label -> gate -> execute pipeline** — docs_specs_11_jev_labels_labelactions, docs_specs_07_gate_evaluategate, docs_specs_10_executor_and_connectors_scheduleexecution, docs_specs_08_nessie_executemoneyaction, docs_specs_10_executor_and_connectors_runexecutor, docs_specs_08_nessie_executionblock [EXTRACTED 1.00]
- **Cofounder non-negotiable invariants** — claude_invariant_agents_never_execute, claude_invariant_gate_is_code, claude_invariant_only_dispatcher_triggers, claude_invariant_envelope_validated, claude_invariant_budget_in_gate_txn, claude_invariant_keys_in_convex_env, claude_invariant_everything_audited, claude_invariant_graph_limits [EXTRACTED 1.00]
- **Flow A duplicate-charge escalation chain** — docs_specs_08_nessie_planted_incident, docs_specs_06_co_cli_skill_duplicates_view, docs_specs_09_issue_ladder_climb, docs_specs_09_issue_ladder_founder_package, docs_specs_09_issue_ladder_recordfounderdecision, docs_specs_10_executor_and_connectors_linear_connector [EXTRACTED 1.00]
- **Run start -> webhook/poll -> reply ingest pipeline** — docs_specs_04_dispatcher_and_runs_assign_task, docs_specs_02_creao_clients_runs_client, docs_specs_04_dispatcher_and_runs_creao_callback, docs_specs_04_dispatcher_and_runs_poll_runs, docs_specs_04_dispatcher_and_runs_ingest_run_record_reply, docs_specs_05_tasks_and_orchestration_on_agent_reply [EXTRACTED 1.00]
- **Authority gate decision inputs** — docs_system_design_authority_gate, docs_system_design_gate_order, docs_system_design_jev_labels, docs_system_design_action_catalog, docs_system_design_rule_schema, docs_specs_01_schema_table_budgets [INFERRED 0.85]
- **Invalid or missing reply: repair/nudge then ISSUE** — docs_specs_05_tasks_and_orchestration_rerun_nudge, docs_specs_05_tasks_and_orchestration_check_stuck_tasks, docs_specs_05_tasks_and_orchestration_issues_module [INFERRED 0.85]

## Communities (87 total, 5 thin omitted)

### Community 0 - "convex/executor.ts"
Cohesion: 0.10
Nodes (31): rateLimiter, activity, authorized(), beginConnector, configure, consumeExecutorBudget, DEFAULT_CONFIG, enrichParams() (+23 more)

### Community 1 - "Shared Type Literals"
Cohesion: 0.05
Nodes (40): ACTION_STATUSES, AGENT_KINDS, AgentKind, DECIDERS, DECISION_CHOICES, DECISION_SUBJECTS, DecisionSubject, EVENT_SOURCES (+32 more)

### Community 2 - "onboarding.ts"
Cohesion: 0.06
Nodes (62): actionText(), ASK, block(), channel, clip(), displayNames(), dollars(), Env (+54 more)

### Community 3 - "ChannelView.tsx"
Cohesion: 0.25
Nodes (21): EntryList(), StandaloneEntry(), STATUS, ThreadEntry(), AgentReply(), AssignBody(), AssignMessage(), channelName() (+13 more)

### Community 4 - "Nessie Execution"
Cohesion: 0.09
Nodes (31): MirrorRow, customerForRefund(), dollars(), ExecItem, failExecution, finishSeed, getAction, getState (+23 more)

### Community 5 - "convex/gate.ts"
Cohesion: 0.13
Nodes (14): BudgetLimits, decisionStats(), dollars(), evaluateGate, GATEABLE, gateConfig(), GateOutcome, num() (+6 more)

### Community 6 - "convex/co.ts"
Cohesion: 0.14
Nodes (17): admit, admitCall(), auditDenied, Caller, coLimiter, Failure, limitFor(), readHistory (+9 more)

### Community 7 - "Envelope Formatting"
Cohesion: 0.10
Nodes (31): ACTION_CARRIERS, ACTION_PARAMS, AssignArgs, assignBlock(), cents, companyBlock, CompanyProfile, decisionPackage (+23 more)

### Community 8 - "Schema Validators"
Cohesion: 0.08
Nodes (23): vActionStatus, vAgentKind, vConditionOp, vDecider, vDecisionSubject, vEventSource, vFounderStatus, vInboxKind (+15 more)

### Community 9 - "convex/radar.ts"
Cohesion: 0.22
Nodes (15): LINKEDIN_ACTOR, LINKEDIN_SOURCE, linkedinInput(), linkedinQueries(), normalizeLinkedInPost(), num(), obj(), RadarSignal (+7 more)

### Community 10 - "Spec 15: Standups, Cofounder, absence, pushback"
Cohesion: 0.21
Nodes (12): budgets table, config table, contradictionCheck, Objections and Cofounder review, Spec 15: Standups, Cofounder, absence, pushback, Cofounder weekly memo, Absence mode, Authority gate (+4 more)

### Community 11 - "co CLI & Smoke Test"
Cohesion: 0.18
Nodes (9): call(), show(), start_and_wait(), call(), emit(), fail(), main(), Parser (+1 more)

### Community 12 - "Package Manifest"
Cohesion: 0.07
Nodes (30): app, name, private, type, version, ai, @convex-dev/aggregate, @convex-dev/eslint-plugin (+22 more)

### Community 13 - "convex"
Cohesion: 0.18
Nodes (17): convex, react, App(), ChannelHeader(), ChannelView(), Desk(), format(), Page (+9 more)

### Community 14 - "tasks.ts"
Cohesion: 0.09
Nodes (38): seedSupportTicket, ticketEvent, handOffIssues(), resolveIssues(), settleIssues(), Envelope, ProposedAction, AWAITING_REPLY (+30 more)

### Community 15 - "Ledger: bookkeeping agent"
Cohesion: 0.13
Nodes (15): Data you can read (the `co` skill), Example output (shape only; do not reuse these facts), Hard rules, Input, Ledger: bookkeeping agent, Method, Output schema (Envelope), Data you can read (the `co` skill) (+7 more)

### Community 16 - "Dev Dependencies"
Cohesion: 0.10
Nodes (21): devDependencies, @convex-dev/eslint-plugin, convex-test, @edge-runtime/vm, eslint, @eslint/js, eslint-plugin-react-hooks, eslint-plugin-react-refresh (+13 more)

### Community 17 - "seed.ts"
Cohesion: 0.29
Nodes (8): AGENTS, COMPANY, CONFIG_DEFAULTS, ROOMS, R7_SUPPORT, R7_TEXT, seedRules(), config

### Community 18 - "dispatcher.ts"
Cohesion: 0.10
Nodes (16): assignTask, consumeRunBudget, DEFAULT_LEVEL_TIMEOUT_MS, HandoffSource, markRunStarted, pollRuns, POOL_OPTIONS, pools (+8 more)

### Community 19 - "Task Tests"
Cohesion: 0.15
Nodes (13): extractEnvelopeBlock(), drain(), getTask(), managerTask(), modules, newEvent(), openTask(), posts (+5 more)

### Community 20 - "Gate Tests"
Cohesion: 0.12
Nodes (9): billing, Case, CASES, CONFIG, LABELS, noCommitment, NOW, R7 (+1 more)

### Community 21 - "Nessie Seed Data"
Cohesion: 0.13
Nodes (19): addMonths(), ADDRESS, BILL_PAYEE, buildSeedPlan(), CUSTOMER_ACCOUNT, dayMs(), INCIDENT_MONTHS_BACK, MERCHANTS (+11 more)

### Community 22 - "Spec 04 Dispatcher"
Cohesion: 0.23
Nodes (15): messages table, rooms table, runs table, Creao webhook delivery contract, assignTask / startRunForTask (convex/dispatcher.ts), Convex channels and task threads, /creao-callback webhook (convex/http.ts), ingestRun / recordReply (convex/dispatcher.ts) (+7 more)

### Community 23 - "Spec 06 co CLI"
Cohesion: 0.24
Nodes (11): Convex environment variables (CREAO_API_KEY, CO_TOKEN_SECRET, ...), Spec 06: co CLI skill, co admit mutation (budget + auth + role + audit in one txn), co CLI (co.py, stdlib-only), Convex HTTP routes /co/data, /co/history, /co/radar, co rate limit (60 calls per task), COFOUNDER_URL Creao secret, Task-scoped HMAC co token (+3 more)

### Community 24 - "Executor Tests"
Cohesion: 0.17
Nodes (6): executed(), modules, runResults, starts, T, wrap()

### Community 25 - "Rule Learning Spec"
Cohesion: 0.18
Nodes (17): Convex AI Gateway, company table, decisions table, rules table, maybeInduce / induceRule, Rule mirrors to agents, proposeRule / approveRule / rejectRule / suspendRule, Spec 12: Rule learning (+9 more)

### Community 26 - "Nessie Tests"
Cohesion: 0.15
Nodes (12): executionBlock(), FractionalAmountError, toNessieAmount(), HISTORY_DAYS, INCIDENT_DATE, OPERATING, PLAN_CENTS, action() (+4 more)

### Community 27 - "Project Invariants"
Cohesion: 0.16
Nodes (9): CLAUDE.md (Cofounder project instructions), Apify web signals, Cofounder (AI agent hierarchy product), CREAO CLI / Rooms API (unavailable), Dispatcher (Convex role that starts runs), Executor agent (connector holder), Room = Convex channel (Feed), audit:chainAudit (+1 more)

### Community 28 - "audit"
Cohesion: 0.24
Nodes (18): appendMessage(), audit(), assign(), assignArgs(), enqueueStart(), rerun(), scheduleExecution(), currentBudget() (+10 more)

### Community 29 - "Ledger Mirror Sync"
Cohesion: 0.42
Nodes (13): centsFromNessie(), cleanRaw(), isoDate(), mirrorFromBill(), mirrorFromDeposit(), mirrorFromPurchase(), mirrorFromTransfer(), nessieId() (+5 more)

### Community 30 - "Spec 01: Schema"
Cohesion: 0.16
Nodes (22): Action status values, Spec 01: Schema, actions table, customers table, events table, founder table, founder_inbox table, issues table (+14 more)

### Community 31 - "Issue Ladder Tests"
Cohesion: 0.19
Nodes (11): allTasks(), coordination, drain(), getTask(), managerOnIssue(), modules, reply(), T (+3 more)

### Community 32 - "format.ts"
Cohesion: 0.18
Nodes (16): AskBody(), DecidedCard(), FROM, RequestCard(), RuleBody(), Rulebook(), STATUS, Pill() (+8 more)

### Community 33 - "OrgDiagram.tsx"
Cohesion: 0.14
Nodes (24): DotWord(), GLYPHS, Landing(), Dept, Kind, node(), NODE_IDS, NodeId (+16 more)

### Community 34 - "Spec 03 Messages"
Cohesion: 0.20
Nodes (12): Lumen Notes (demo company fixture), Shared literal unions (convex/lib/types.ts), Spec 03: Message protocol, Action types and params (refund, refund_batch, pay_bill, ...), companyBlock (compact company summary <=1500 chars), cofounder envelope (agent -> Convex), formatAssign, formatDigest (+4 more)

### Community 35 - "dispatcher.test.ts"
Cohesion: 0.14
Nodes (15): encoder, fromBase64Url(), hmacKey(), signTaskToken(), TaskTokenClaims, toBase64Url(), TOKEN_TTL_MS, VerifyResult (+7 more)

### Community 36 - "runs.ts"
Cohesion: 0.12
Nodes (28): CREAO_BASE_URL, CreaoError, creaoFetch(), CreaoResponse, errorCode(), parseRetryAfter(), RateLimitedError, Artifact (+20 more)

### Community 37 - "Spec 00-02 Setup"
Cohesion: 0.15
Nodes (13): health:check / health:gateway, Manual account setup (Creao capi_ key, agents, connectors, Nessie, Apify, Convex coupon), seed.config.ts + seed:config, scripts/set-env.sh + .env.example, Spec 00: Setup and accounts, agents table, creaoFetch (convex/creao/http.ts), Creao fixtures (convex/creao/__fixtures__) (+5 more)

### Community 38 - "Spec 07: Gate and action catalog"
Cohesion: 0.21
Nodes (12): formatDecision, Spec 07: Gate and action catalog, Absence mode (founder away -> queue), Budgets (company:refund daily, company:marketing weekly), Action catalog (convex/lib/catalog.ts), Cofounder authority marketing_spend rule, evaluate (pure gate function), evaluateGate mutation (+4 more)

### Community 39 - "Spec 08 Nessie"
Cohesion: 0.23
Nodes (12): Capital One Nessie sandbox API, ledger_mirror table, co data duplicates view, ledger_mirror convention (account_id payer, counterparty receiver), Spec 08: Nessie bank, executeMoneyAction, executionBlock guard (lib/nessie.ts), Planted duplicate-charge incident (12 x $35 on 2026-10-22) (+4 more)

### Community 40 - "labels.ts"
Cohesion: 0.06
Nodes (43): crons, coSmokeTask, coSmokeToken, dropCoSmokeTask, dropDevAction, probeJev, proposeAction, setCoSmokeTokenHash (+35 more)

### Community 41 - "convex/rules.ts"
Cohesion: 0.17
Nodes (20): decisionFeatures(), formatDigest(), nextRuleLabel(), ruleForAssign(), approveFlow(), claimInduction(), digestAffected(), dropCandidate (+12 more)

### Community 42 - "Schema Tests"
Cohesion: 0.15
Nodes (12): ACTION_TYPES, DEPARTMENTS, EFFECTS, ISSUE_KINDS, MESSAGE_TYPES, vActionType, vDepartment, vEffect (+4 more)

### Community 43 - "Apify Signals Spec"
Cohesion: 0.23
Nodes (12): signals table, /apify-callback + ingestSignals (convex/apify.ts), Apify monitor tasks, scripts/inject-signal.ts, Signal significance scoring, Spec 13: Apify signals, Company Radar Actor (actors/company-radar), Spec 17: Company Radar Actor (+4 more)

### Community 44 - "Spec 09: Issue ladder and founder inbox"
Cohesion: 0.36
Nodes (9): gateAction helper, Spec 09: Issue ladder and founder inbox, Issue climb policy (employee -> manager -> founder), founder_inbox, Founder package (Cofounder REPORT package), Issue grouping (related open issues within 2 h), Inbox page (src/pages/Inbox.tsx), Ladder timeouts (level_timeout_ms) (+1 more)

### Community 45 - "lib/rules.ts"
Cohesion: 0.11
Nodes (25): candidateProblem(), conditionText(), conditionValue, DeptOf, diffText(), EFFECT_TEXT, featureRecord(), fieldName() (+17 more)

### Community 46 - "convex_generated_api"
Cohesion: 0.20
Nodes (11): COLUMNS, Competitor, Doc, EXAMPLE, FLOW_STEPS, humanRole(), Onboarding(), PLANNING_LINES (+3 more)

### Community 47 - "Action Catalog"
Cohesion: 0.20
Nodes (8): batchTotal(), BudgetScope, CatalogEntry, cents(), ExecutorKind, Params, Tier, ActionType

### Community 48 - "Nessie.tsx"
Cohesion: 0.36
Nodes (9): at(), Badge(), BankPanel(), dollars(), NessieLine(), payee(), Refunds, Verified (+1 more)

### Community 49 - "bank.ts"
Cohesion: 0.17
Nodes (15): failure(), lastMove, liveRefunds, messageObjects, shown(), toTransfer(), Transfer, verifyMessage (+7 more)

### Community 50 - "convex_generated_server"
Cohesion: 0.11
Nodes (15): FounderRequest, getConfig(), recordDelivery, decide, decideInternal, decideItem(), listOpen, vDecideArgs (+7 more)

### Community 51 - "lib/gate.ts"
Cohesion: 0.12
Nodes (20): Condition, conditionHolds(), ConditionValue, escalate(), evaluate(), features(), GateAction, GateBudget (+12 more)

### Community 52 - "Runtime Dependencies"
Cohesion: 0.18
Nodes (11): dependencies, ai, convex, @convex-dev/aggregate, @convex-dev/ai-sdk-provider, @convex-dev/rate-limiter, @convex-dev/workflow, @convex-dev/workpool (+3 more)

### Community 53 - "story.ts"
Cohesion: 0.12
Nodes (28): vRunPurpose, DEMO_RESET_KEY, BatchItem, contentTask(), dollars(), duplicateBatch(), Env, latestOfType() (+20 more)

### Community 54 - "Spec 10 Executor"
Cohesion: 0.27
Nodes (12): Flow A (duplicate charge -> refund batch -> founder -> Linear bug), raiseIssue, Spec 10: Executor and connectors, Activity page (src/pages/Activity.tsx), /creao-callback webhook handling, Linear connector (file_bug), Mock outbox (outbox table), onExecutorResult (+4 more)

### Community 55 - "npm Scripts"
Cohesion: 0.20
Nodes (10): scripts, build, dev, dev:backend, dev:frontend, lint, preview, test (+2 more)

### Community 56 - "story.test.ts"
Cohesion: 0.15
Nodes (7): convex-test, Answer, FakeJev, isJev(), Question, rule(), T

### Community 57 - "rules.test.ts"
Cohesion: 0.13
Nodes (13): DecisionRow, RuleLike, claudeCalls, contentTask(), decide(), DEPTS, drain(), GOOD (+5 more)

### Community 58 - "Spec 11: Jev labels"
Cohesion: 0.46
Nodes (8): Spec 11: Jev labels, grounded label (claim follows from evidence), Jev /alpha/decisions (typesafe/jev-1.13), labelActions, labelSpecs question set, noul/choice answer to label conversion, refund_reason label, saveLabels

### Community 59 - "Sidebar.tsx"
Cohesion: 0.24
Nodes (10): run(), ACTS, NavItem(), Sidebar(), Story(), Tape(), View, DEPT_GRAD (+2 more)

### Community 60 - "co.test.ts"
Cohesion: 0.13
Nodes (10): CO_VIEWS, CoView, findDuplicateCharges(), Role, ROLES, TaskStatus, modules, room() (+2 more)

### Community 61 - "issues.ts"
Cohesion: 0.16
Nodes (30): notifyFounder(), actionLines(), agentFor(), chainIssues(), climb(), clip(), dollars(), fileBug() (+22 more)

### Community 62 - "convex_generated_api"
Cohesion: 0.12
Nodes (16): PURPOSE, Card, ChannelData, DeptChip(), Entry, initials(), Message, Overview (+8 more)

### Community 63 - "proposeCandidate"
Cohesion: 0.22
Nodes (16): agrees(), covers(), inductionTarget(), labelOf(), normalizeCandidate(), overrides(), replay, deptOfFn() (+8 more)

### Community 64 - "System Design v4 (API Trigger)"
Cohesion: 0.19
Nodes (16): Event routing table, Convex components (Workflow, Workpool, AI Gateway, Aggregate, Rate Limiter), Demo plan (3 min) and metrics, Flow A: duplicate charges, Flow B: negotiation in #leadership, Flow E: founder asks the company, Issue ladder, Capital One Nessie integration (+8 more)

### Community 65 - "convex/http.ts"
Cohesion: 0.24
Nodes (11): authenticate(), bearer(), coData, coHistory, coRadar, json(), optionalNumber(), respond() (+3 more)

### Community 68 - "readView"
Cohesion: 0.33
Nodes (13): companyView(), customerSummary(), customerView(), duplicatesView(), fail(), ledgerRow(), ledgerView(), readView (+5 more)

### Community 69 - "time.ts"
Cohesion: 0.39
Nodes (7): budgetView(), budgetPeriod(), BudgetPeriodKind, LA_DAY, laDate(), laWeekStart(), refundBudget()

### Community 70 - "FakeNessie"
Cohesion: 0.20
Nodes (3): vitest, FakeNessie, Obj

### Community 71 - "nessieApi.ts"
Cohesion: 0.26
Nodes (14): markerOf(), readTags(), actionOfMarker(), cleanupDemoRefunds, dropWipedRefunds, executeMoneyAction, Method, nessieCreate() (+6 more)

### Community 72 - "lib/co.ts"
Cohesion: 0.15
Nodes (12): Charge, CO_CALLS_PER_TASK, CUSTOMER_LEDGER_ROWS, DAY_MS, DUPLICATE_WINDOW_MS, DuplicateGroup, HISTORY_LIMIT, MANAGERS (+4 more)

### Community 73 - "Customer Manager: customer department manager"
Cohesion: 0.22
Nodes (8): Customer Manager: customer department manager, Data you can read (the `co` skill), Example output (shape only; do not reuse these facts), Hard rules, Input, Method, Output schema (Envelope), ledger()

### Community 74 - "Cofounder: the founder's cofounder agent"
Cohesion: 0.25
Nodes (7): Cofounder: the founder's cofounder agent, Data you can read (the `co` skill), Example output (shape only; do not reuse these facts), Hard rules, Input, Method, Output schema (Envelope)

### Community 75 - "Content: social post writer"
Cohesion: 0.25
Nodes (7): Content: social post writer, Data you can read (the `co` skill), Example output (shape only; do not reuse these facts), Hard rules, Input, Method, Output schema (Envelope)

### Community 76 - "Finance Manager: finance department manager"
Cohesion: 0.25
Nodes (7): Data you can read (the `co` skill), Example output (shape only; do not reuse these facts), Finance Manager: finance department manager, Hard rules, Input, Method, Output schema (Envelope)

### Community 77 - "Market Intel: competitor and market research agent"
Cohesion: 0.25
Nodes (7): Data you can read (the `co` skill), Example output (shape only; do not reuse these facts), Hard rules, Input, Market Intel: competitor and market research agent, Method, Output schema (Envelope)

### Community 78 - "Marketing Manager: marketing department manager"
Cohesion: 0.25
Nodes (7): Data you can read (the `co` skill), Example output (shape only; do not reuse these facts), Hard rules, Input, Marketing Manager: marketing department manager, Method, Output schema (Envelope)

### Community 79 - "Retention: churn and win-back agent"
Cohesion: 0.25
Nodes (7): Data you can read (the `co` skill), Example output (shape only; do not reuse these facts), Hard rules, Input, Method, Output schema (Envelope), Retention: churn and win-back agent

### Community 80 - "Spend: spending and vendor agent"
Cohesion: 0.25
Nodes (7): Data you can read (the `co` skill), Example output (shape only; do not reuse these facts), Hard rules, Input, Method, Output schema (Envelope), Spend: spending and vendor agent

### Community 81 - "raiseIssue"
Cohesion: 0.57
Nodes (8): recordReply, climbFromLadderTask(), isLadderTask(), raiseIssue(), checkStuckTasks, onAgentReply(), onRunFailed(), transition()

### Community 82 - "HMAC task token (convex/lib/tokens.ts)"
Cohesion: 0.29
Nodes (7): TOKEN_PLACEHOLDER, audit_log table, Run idempotencyKey (task:purpose:attempt), HMAC task token (convex/lib/tokens.ts), verifyTaskAccess (token + open-task check), co CLI (agent data via /co/*), Reliability, cost, security mechanisms

### Community 83 - "Executor: connector agent"
Cohesion: 0.29
Nodes (6): Example output (shape only; do not reuse these facts), Executor: connector agent, Hard rules, Input, Method, Output schema (Envelope)

## Knowledge Gaps
- **29 isolated node(s):** `@convex-dev/eslint-plugin`, `@edge-runtime/vm`, `@eslint/js`, `@types/node`, `@types/react` (+24 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 506 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `convex` connect `convex` to `convex/executor.ts`, `Shared Type Literals`, `onboarding.ts`, `ChannelView.tsx`, `Nessie Execution`, `convex/gate.ts`, `convex/co.ts`, `Schema Validators`, `convex/radar.ts`, `Package Manifest`, `tasks.ts`, `seed.ts`, `dispatcher.ts`, `format.ts`, `runs.ts`, `labels.ts`, `convex/rules.ts`, `convex_generated_api`, `Nessie.tsx`, `bank.ts`, `convex_generated_server`, `story.ts`, `Sidebar.tsx`, `convex_generated_api`, `convex/http.ts`, `convex_generated_server_internalquery`?**
  _High betweenness centrality (0.107) - this node is a cross-community bridge._
- **What connects `@convex-dev/eslint-plugin`, `@edge-runtime/vm`, `@eslint/js` to the rest of the system?**
  _29 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `convex/executor.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.09848484848484848 - nodes in this community are weakly interconnected._
- **Why does `Spec build order` connect `Rule Learning Spec` to `Spec 03 Messages`, `Spec 00-02 Setup`, `Spec 07: Gate and action catalog`, `Spec 08 Nessie`, `Spec 15: Standups, Cofounder, absence, pushback`, `Apify Signals Spec`, `Spec 09: Issue ladder and founder inbox`, `Spec 04 Dispatcher`, `Spec 06 co CLI`, `Spec 10 Executor`, `Spec 11: Jev labels`, `Spec 01: Schema`?**
  _High betweenness centrality (0.101) - this node is a cross-community bridge._
- **Should `Shared Type Literals` be split into smaller, more focused modules?**
  _Cohesion score 0.047619047619047616 - nodes in this community are weakly interconnected._
- **Why does `Spec 12: Rule learning` connect `Rule Learning Spec` to `Spec 15: Standups, Cofounder, absence, pushback`, `lib/rules.ts`?**
  _High betweenness centrality (0.073) - this node is a cross-community bridge._
- **Should `onboarding.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05754475703324808 - nodes in this community are weakly interconnected._