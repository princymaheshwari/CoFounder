# Graph Report - CoFounder  (2026-10-24)

## Corpus Check
- 37 files · ~46,742 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 629 nodes · 1383 edges · 30 communities (29 shown, 1 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 65 edges (avg confidence: 0.89)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Dispatcher & Task State Machine
- Backend Specs 01-05
- Message Protocol
- Shared Literal Types
- Creao Run Client
- Agent Role Prompts
- Schema Validators
- Package Manifest
- Project Stack & Nessie
- Dev Dependencies
- Task Tests
- Issue Ladder & Flow A
- Spec Build Order
- App Entry & HTTP
- Schema Tests
- Apify Signals
- Dispatcher Tests
- API Trigger Script
- Runtime Dependencies
- Task Tokens
- npm Scripts
- Authority Gate
- Seed Config
- Rule Learning
- Convex Components
- Test Harness
- Task Transitions Contract
- Vite Config
- Flow B Pushback
- Env Setup Script

## God Nodes (most connected - your core abstractions)
1. `Spec 01: Schema` - 34 edges
2. `System Design v4 (API Trigger)` - 26 edges
3. `Spec 05: Tasks, routing, orchestration` - 21 edges
4. `Spec build order` - 19 edges
5. `Spec 04: Dispatcher and run receiver` - 18 edges
6. `Cofounder (project)` - 17 edges
7. `audit()` - 17 edges
8. `Spec 02: Creao run client (API Trigger)` - 17 edges
9. `Spec 03: Message protocol` - 17 edges
10. `convex` - 15 edges

## Surprising Connections (you probably didn't know these)
- `App()` --implements--> `Spec 14: Founder app`  [INFERRED]
  src/App.tsx → docs/specs/14-founder-app.md
- `429 RateLimitedError with retryAfterMs` --references--> `RateLimitedError`  [EXTRACTED]
  docs/specs/02-creao-clients.md → convex/creao/http.ts
- `creaoFetch (convex/creao/http.ts)` --references--> `creaoFetch()`  [EXTRACTED]
  docs/specs/02-creao-clients.md → convex/creao/http.ts
- `Creao runs client (convex/creao/runs.ts)` --references--> `replyText()`  [EXTRACTED]
  docs/specs/02-creao-clients.md → convex/creao/runs.ts
- `Creao runs client (convex/creao/runs.ts)` --references--> `startRun()`  [EXTRACTED]
  docs/specs/02-creao-clients.md → convex/creao/runs.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Non-negotiable invariants** — claude_invariant_agents_never_execute, claude_invariant_gate_is_code, claude_invariant_only_dispatcher_triggers, claude_invariant_every_message_validated, claude_invariant_budget_in_gate_txn, claude_invariant_keys_in_convex_env, claude_invariant_everything_audited, claude_invariant_graph_limits [EXTRACTED 1.00]
- **Run start -> webhook/poll -> reply ingest pipeline** — docs_specs_04_dispatcher_and_runs_assign_task, docs_specs_02_creao_clients_runs_client, docs_specs_04_dispatcher_and_runs_creao_callback, docs_specs_04_dispatcher_and_runs_poll_runs, docs_specs_04_dispatcher_and_runs_ingest_run_record_reply, docs_specs_05_tasks_and_orchestration_on_agent_reply [EXTRACTED 1.00]
- **Authority gate decision inputs** — docs_system_design_authority_gate, docs_system_design_gate_order, docs_system_design_jev_labels, docs_system_design_action_catalog, docs_system_design_rule_schema, docs_specs_01_schema_table_budgets [INFERRED 0.85]
- **Invalid or missing reply: repair/nudge then ISSUE** — docs_specs_03_message_protocol_parse_envelope, docs_specs_03_message_protocol_repair_message, docs_specs_05_tasks_and_orchestration_rerun_nudge, docs_specs_05_tasks_and_orchestration_check_stuck_tasks, docs_specs_05_tasks_and_orchestration_issues_module [INFERRED 0.85]

## Communities (30 total, 1 thin omitted)

### Community 0 - "Dispatcher & Task State Machine"
Cohesion: 0.06
Nodes (68): appendMessage(), audit(), getConfig(), recordDelivery, supportAgent, seedSupportTicket, assign(), assignArgs() (+60 more)

### Community 1 - "Backend Specs 01-05"
Cohesion: 0.06
Nodes (66): Executor agent, Setup script: executor, TOKEN_PLACEHOLDER, health:check / health:gateway, Manual account setup (Creao capi_ key, agents, connectors, Nessie, Apify, Convex coupon), seed.config.ts + seed:config, scripts/set-env.sh + .env.example, Spec 00: Setup and accounts (+58 more)

### Community 2 - "Message Protocol"
Cohesion: 0.06
Nodes (50): ACTION_CARRIERS, ACTION_PARAMS, AssignArgs, assignBlock(), cents, CompanyBlock, CompanyProfile, decisionPackage (+42 more)

### Community 3 - "Shared Literal Types"
Cohesion: 0.04
Nodes (47): ACTION_STATUSES, ActionStatus, AGENT_KINDS, AgentKind, CONDITION_OPS, ConditionOp, DECIDERS, DECISION_CHOICES (+39 more)

### Community 4 - "Creao Run Client"
Cohesion: 0.11
Nodes (26): CREAO_BASE_URL, CreaoError, creaoFetch(), CreaoResponse, errorCode(), parseRetryAfter(), RateLimitedError, Artifact (+18 more)

### Community 5 - "Agent Role Prompts"
Cohesion: 0.15
Nodes (28): Cofounder agent, Content agent, Customer Manager agent, Finance Manager agent, Ledger agent, Market Intel agent, Marketing Manager agent, Retention agent (+20 more)

### Community 6 - "Schema Validators"
Cohesion: 0.07
Nodes (27): vActionStatus, vAgentKind, vConditionOp, vDecider, vDecisionChoice, vDecisionSubject, vEventSource, vFounderStatus (+19 more)

### Community 7 - "Package Manifest"
Cohesion: 0.09
Nodes (22): name, private, type, version, ai, @convex-dev/ai-sdk-provider, @convex-dev/eslint-plugin, @edge-runtime/vm (+14 more)

### Community 8 - "Project Stack & Nessie"
Cohesion: 0.12
Nodes (13): Apify API, Cofounder (project), Convex AI Gateway, Creao API Trigger, Convex environment variables, Jev (typesafe/jev-1.13), Lumen Notes (demo company), Capital One Nessie API (+5 more)

### Community 9 - "Dev Dependencies"
Cohesion: 0.10
Nodes (21): devDependencies, @convex-dev/eslint-plugin, convex-test, @edge-runtime/vm, eslint, @eslint/js, eslint-plugin-react-hooks, eslint-plugin-react-refresh (+13 more)

### Community 10 - "Task Tests"
Cohesion: 0.15
Nodes (13): extractEnvelopeBlock(), drain(), getTask(), managerTask(), modules, newEvent(), openTask(), posts (+5 more)

### Community 11 - "Issue Ladder & Flow A"
Cohesion: 0.18
Nodes (16): founder_inbox table, issues table, ledger_mirror table, Seed rule R7, Founder package, Spec 09 ladder functions (convex/issues.ts: escalateIssue, onManagerReply, recordFounderDecision), Metrics (@convex-dev/aggregate), Convex components (Workflow, Workpool, AI Gateway, Aggregate, Rate Limiter) (+8 more)

### Community 12 - "Spec Build Order"
Cohesion: 0.25
Nodes (17): convex/lib/catalog.ts, evaluate() pure gate (convex/lib/gate.ts), features(action, customer), Spec 07: Gate and action catalog, Spec 09: Issue ladder and founder inbox, labelAction (convex/labels.ts), Label questions (convex/lib/labelSpecs.ts), Spec 11: Jev labels (+9 more)

### Community 13 - "App Entry & HTTP"
Cohesion: 0.18
Nodes (7): crons, http, convex, react, react-dom, App(), convex

### Community 14 - "Schema Tests"
Cohesion: 0.14
Nodes (13): ACTION_TYPES, DEPARTMENTS, EFFECTS, ISSUE_KINDS, MESSAGE_TYPES, ROLES, vActionType, vDepartment (+5 more)

### Community 15 - "Apify Signals"
Cohesion: 0.23
Nodes (12): signals table, /apify-callback + ingestSignals (convex/apify.ts), Apify monitor tasks, scripts/inject-signal.ts, Signal significance scoring, Spec 13: Apify signals, Company Radar Actor (actors/company-radar), Spec 17: Company Radar Actor (+4 more)

### Community 16 - "Dispatcher Tests"
Cohesion: 0.21
Nodes (6): modules, seedTicket(), startAssign(), started(), stubCreao(), T

### Community 17 - "API Trigger Script"
Cohesion: 0.29
Nodes (3): call(), show(), start_and_wait()

### Community 18 - "Runtime Dependencies"
Cohesion: 0.18
Nodes (11): dependencies, ai, convex, @convex-dev/aggregate, @convex-dev/ai-sdk-provider, @convex-dev/rate-limiter, @convex-dev/workflow, @convex-dev/workpool (+3 more)

### Community 19 - "Task Tokens"
Cohesion: 0.29
Nodes (9): encoder, fromBase64Url(), hmacKey(), signTaskToken(), TaskTokenClaims, toBase64Url(), TOKEN_TTL_MS, VerifyResult (+1 more)

### Community 20 - "npm Scripts"
Cohesion: 0.20
Nodes (10): scripts, build, dev, dev:backend, dev:frontend, lint, preview, test (+2 more)

### Community 21 - "Authority Gate"
Cohesion: 0.39
Nodes (6): budgets table, config table, evaluateGate mutation (convex/gate.ts), Absence mode, Authority gate, Gate order (first match decides)

### Community 22 - "Seed Config"
Cohesion: 0.43
Nodes (5): AGENTS, COMPANY, CONFIG_DEFAULTS, ROOMS, config

### Community 23 - "Rule Learning"
Cohesion: 0.33
Nodes (7): decisions table, rules table, Inbox page (src/pages/Inbox.tsx), recordFounderDecision, Flow C: marketing loop, Rule learning loop, Rule schema

### Community 24 - "Convex Components"
Cohesion: 0.33
Nodes (5): app, @convex-dev/aggregate, @convex-dev/rate-limiter, @convex-dev/workflow, @convex-dev/workpool

### Community 25 - "Test Harness"
Cohesion: 0.33
Nodes (3): convex-test, vitest, modules

### Community 26 - "Task Transitions Contract"
Cohesion: 0.40
Nodes (4): Task status machine values, Task transitions contract, Replay engine (convex/replay.ts), Open decisions

### Community 27 - "Vite Config"
Cohesion: 0.40
Nodes (3): @tailwindcss/vite, vite, @vitejs/plugin-react

### Community 28 - "Flow B Pushback"
Cohesion: 0.50
Nodes (4): contradictionCheck, Objections and Cofounder review, Flow B: negotiation in #leadership, Cofounder pushback

## Knowledge Gaps
- **25 isolated node(s):** `ai`, `@convex-dev/ai-sdk-provider`, `@convex-dev/eslint-plugin`, `@edge-runtime/vm`, `eslint` (+20 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 202 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `convex` connect `App Entry & HTTP` to `Dispatcher & Task State Machine`, `Shared Literal Types`, `Creao Run Client`, `Schema Validators`, `Package Manifest`, `Seed Config`, `Convex Components`?**
  _High betweenness centrality (0.137) - this node is a cross-community bridge._
- **What connects `ai`, `@convex-dev/ai-sdk-provider`, `@convex-dev/eslint-plugin` to the rest of the system?**
  _25 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Dispatcher & Task State Machine` be split into smaller, more focused modules?**
  _Cohesion score 0.055077452667814115 - nodes in this community are weakly interconnected._
- **Why does `Spec 01: Schema` connect `Backend Specs 01-05` to `Message Protocol`, `Project Stack & Nessie`, `Issue Ladder & Flow A`, `Spec Build Order`, `Apify Signals`, `Authority Gate`, `Rule Learning`, `Task Transitions Contract`?**
  _High betweenness centrality (0.092) - this node is a cross-community bridge._
- **Should `Backend Specs 01-05` be split into smaller, more focused modules?**
  _Cohesion score 0.05543859649122807 - nodes in this community are weakly interconnected._
- **Why does `Spec 09: Issue ladder and founder inbox` connect `Spec Build Order` to `Dispatcher & Task State Machine`, `Backend Specs 01-05`, `Project Stack & Nessie`, `Issue Ladder & Flow A`, `Rule Learning`?**
  _High betweenness centrality (0.069) - this node is a cross-community bridge._
- **Should `Message Protocol` be split into smaller, more focused modules?**
  _Cohesion score 0.06412583182093164 - nodes in this community are weakly interconnected._