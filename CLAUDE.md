# CLAUDE.md — Cofounder

Cofounder lets one founder run a company through a hierarchy of AI agents that talk to each other in typed, threaded department channels, without the founder becoming the approval bottleneck. Agents propose; a deterministic Convex gate decides; only the backend moves money or calls connectors.

Built solo at Cal Hacks 13.0 (deadline: Sunday morning, confirm exact time). Optimize for a working, demoable vertical slice over breadth.

- Full design: `docs/system-design.md`
- Build specs, one per feature, in build order: `docs/specs/README.md`
- Creao agent role prompts (pasted into Creao, not code): `agents/roles.md`

## How to work in this repo

1. **Work one spec at a time.** Before coding, read the spec named in the task plus `docs/system-design.md` sections it references. Do not start the next spec until the current one's acceptance criteria pass.
2. **Plan, then build.** For any spec, list the files you will create or change and the functions you will add, then implement.
3. **Verify external APIs before coding against them.** Every external endpoint in this file is marked with what is known. Anything marked `VERIFY` must be checked against the live docs (or a real call) first. Never invent request or response fields.
4. **Small, testable steps.** After each step, run `npx convex dev --once` (typecheck + push) and the relevant test. Keep the app runnable at all times.
5. **Update the spec's checklist** (`- [ ]` → `- [x]`) as acceptance criteria pass, and note any deviation in the spec's "Decisions made while building" section.
6. When something in a spec conflicts with this file, this file wins; when this file conflicts with reality (an API behaves differently), stop and report it.

**Terminology.** "Room" in code and specs (`rooms` table, `#customer`, …) means a **Convex channel**, rendered in the founder app Feed. It is not a Creao room: Convex never reads or posts to Creao rooms.

## Non-negotiable invariants

These are the product. Never weaken them, even to make a demo work.

1. **Agents never execute.** Role agents only propose actions inside message envelopes. Only Convex executes: Nessie calls directly, connector writes through the Executor agent.
2. **The gate is code.** `evaluateGate` is a single Convex mutation: deterministic, transactional, no LLM call inside it. LLMs (Jev, Claude) may produce *inputs* to the gate (labels), never the decision.
3. **Only the Dispatcher triggers agents.** The Dispatcher is a role in Convex code: it starts agent runs through Creao's **API Trigger** (`POST https://agent.creao.ai/api/v1/runs`), one run per task step, and every ASSIGN it sends starts with `[Dispatcher]`. Only `dispatcher.startRunForTask` (role agents) and `executor.runExecutor` (Executor) call `startRun`. Agents never address each other directly: every message between agents is a Convex record that the Dispatcher delivers as a new run.
4. **Every agent message is validated.** A message is only acted on after its envelope passes the Convex validator. Invalid → one repair request in the same thread → then an `ISSUE` to the manager.
5. **Budgets are decremented inside the gate's transaction.** Never check a budget in one function and spend it in another.
6. **Keys live only in Convex environment variables.** Never in Creao Secrets (account-scoped: every agent sees them), never in the frontend, never in logs.
7. **Everything is audited.** Every state change appends an `audit_log` row linking event → task → message → action → gate decision → executed object.
8. **Graph limits hold.** Hop limit 3 per chain, no task creates a task for its own role, at most 3 handoffs per task.

## Stack

| Layer | Choice |
| --- | --- |
| Backend, DB, orchestration | Convex (TypeScript), components: `@convex-dev/workflow`, `@convex-dev/workpool`, `@convex-dev/rate-limiter`, `@convex-dev/aggregate` |
| Models | Convex AI Gateway: Claude (rule induction, packages, digests), Jev `typesafe/jev-1.13` (labels), embeddings |
| Agents | Creao saved agents (Claude Sonnet 5.5 default), run via API Trigger; conversation stored in Convex channels and shown in the founder app Feed |
| Bank | Capital One Nessie sandbox |
| Web signals | Apify (Store change-monitor Actors + our Company Radar Actor) |
| Frontend | React + Vite + Tailwind, Convex React client (reactive queries) |
| Agent data CLI | `skills/co/` — Python 3 stdlib only, published as a GitHub skill |

## Repo layout (target)

```
cofounder/
  CLAUDE.md
  .env.example
  docs/
    system-design.md
    specs/                 one spec per feature (00-… to 17-…), index in specs/README.md
  agents/roles.md          Creao agent prompts (manual setup)
  convex/
    schema.ts
    lib/                   pure helpers: envelope.ts, rules.ts, gate.ts, tokens.ts
    creao/                 http.ts (fetch wrapper), runs.ts (API Trigger client)
    dispatcher.ts          assignTask, startRunForTask, ingestRun, recordReply, pollRuns
    tasks.ts               task creation, routing, graph limits
    workflows.ts           Workflow definitions
    gate.ts                evaluateGate mutation + action catalog
    issues.ts              issue ladder
    executor.ts            Executor runs + webhook handling
    nessie.ts              Nessie client, sync, execute
    labels.ts              Jev labeling
    rules.ts               induction, validation, activation, digests
    apify.ts               ingest + callback
    http.ts                /creao-callback, /apify-callback, /co/*
    crons.ts
    health.ts              ping, health:check (API Trigger), health:gateway
    seed.ts                seed:config (agents + channels from seed.config.ts)
    seed.config.ts         Creao App IDs + input field ids (filled by hand)
    seedData.ts            deterministic Nessie seed data (spec 08)
    replay.ts              startReplay, stepDay, replay:reset (spec 16)
  src/                     founder app (React)
  skills/co/               SKILL.md + co.py
  actors/company-radar/    Apify Actor (stretch)
  scripts/                 set-env.sh, test_api_trigger.py, inject-signal.ts (spec 13), replay/scenario.json (spec 16)
  tests/                   vitest + convex-test
```

## Commands

```bash
npm install
npx convex dev            # run backend, push schema/functions on save
npm run dev               # frontend
npx convex run seed:config   # seed agents + channels (rooms) rows from convex/seed.config.ts
npx convex run health:check  # confirm CREAO_API_KEY reaches the API Trigger
npx convex run health:gateway '{"match":"anthropic"}'  # confirm the AI Gateway token and list model ids
npx convex run story:resetInternal   # demo: clear conversations, decisions and rules (keeps company, customers, R7)
npx convex run story:start '{"act":"double_charge"}'   # demo acts: double_charge | double_charge_again | posts | after_rule (also buttons in the app; refunds hit the Nessie sandbox)
npx convex run story:primeLive   # before a pitch: reset, then send a seeded double-charge ticket through live Creao agents (~4–6 min to #founder-desk)
npx convex run nessie:seedNessie   # seed the Nessie sandbox + customers/ledger_mirror/tickets (idempotent)
npx convex run nessie:syncLedger   # mirror Nessie into ledger_mirror now (cron runs it every 10 min)
npm test                  # vitest (convex-test for functions)
npx convex env set NAME value   # set a backend secret
```

## Environment variables (Convex env, never committed)

| Name | Purpose |
| --- | --- |
| `CREAO_API_KEY` | `capi_` **account** key from agent.creao.ai → Settings → API Keys (runs any of the founder's agents). Used for every role-agent and Executor run |
| `CREAO_WEBHOOK_TOKEN` | random string appended to every run's `webhookUrl` (`/creao-callback?token=…`) |
| `NESSIE_API_KEY` | Nessie key (sent as `?key=`) |
| `APIFY_TOKEN` | Apify API token |
| `APIFY_WEBHOOK_TOKEN` | random string appended to Apify webhook URL |
| `CO_TOKEN_SECRET` | HMAC secret for task-scoped `co` tokens |
| `AI_GATEWAY_URL` | optional override of `https://ai-gateway.convex.dev` (spec 11 points it at a broken URL to test the Jev failure path) |
| `DEMO_TOOLS` | `on` enables story mode and the demo reset (`convex/story.ts`). Leave unset in production |

Agent App IDs and each agent's input field id are data, stored in the `agents` table by the seed, not env vars. Channels (`rooms` table) are Convex-only.

## External APIs: what is known

### Creao API Trigger — base `https://agent.creao.ai`, header `Authorization: Bearer capi_…`

This is the **only** Creao API we use. Known from Creao docs (https://docs.creao.ai/pro/api-trigger):
- `POST /api/v1/runs` `{appId, inputs, webhookUrl?, threadId?, idempotencyKey?, chatModelId?}` → `202 {id, status, appId, appName}`. `inputs` keys match the agent's Input Form field ids. `idempotencyKey` 8–128 chars; same key returns the same run. `threadId` continues an earlier conversation.
- `GET /api/v1/runs/{id}` → status `pending|running|completed|failed|cancelled`, `result {text, chatText?, artifacts[]}`, `threadId`, `errorCode`. `GET /api/v1/runs` lists; `POST /api/v1/runs/{id}/cancel` cancels.
- Webhook POST to `webhookUrl` with `{runId, status, threadId, result}`; header `X-Creao-Delivery-Id` (same on every retry). Up to 3 attempts, 10 s timeout, no redirects; at least once → dedupe. Not signed → re-fetch the run and trust only that. A run that fails before starting sends **no** webhook → poll.
- Every API run appears in the Creao sidebar as `[API] …` (shareable: use for Devpost run links).
- Errors are `{ "error": "CODE" }`; `429` includes `Retry-After`.

**Unavailable this weekend:** the CREAO CLI API on developer.creao.ai (`cr_sk_` keys: Rooms API, `/v1/agents/{id}/memory`, `/v1/account/usage`). Creao staff said not to use it. Do not write code against it. Creao rooms can still be used by hand in the UI, but Convex never reads or posts to them.

`VERIFY` before relying on it:
- Each agent's Input Form field id (expected `message`; Executor `action`).
- Which result field holds the reply (`result.text` vs `result.chatText`) and that a fenced `cofounder` block arrives intact.
- That `threadId` continuation keeps the earlier turns in context.
- Whether `chatModelId` is accepted for `anthropic/claude-sonnet-5-5` (omit it if rejected).

### Convex AI Gateway — base `https://ai-gateway.convex.dev`, token from `getServiceToken("ai-gateway")` inside an action (paid plan required; apply hackathon coupon)
- Text: AI SDK `convexGateway("anthropic/<model>")` from `@convex-dev/ai-sdk-provider`; or `POST /v1/messages` (Anthropic shape). Verified 2026-10-25 with `npx convex run health:gateway '{"match":"anthropic"}'`: Claude ids use dots, e.g. `anthropic/claude-sonnet-5.5`. Structured output: `generateText` + `Output.object` (`generateObject` is deprecated in `ai` 7).
- Jev: `POST /alpha/decisions` `{model: "typesafe/jev-1.13", state, questions: {name: {type: "choice"|"score"|"noul", instructions, criteria?: {option: description}}}}` → `answers.name.{choice|score|noul, confidence?, probabilities?}`, `usage.cost` (USD). Verified 2026-10-24: a choice returns `confidence` + `probabilities`, a noul only `noul`. Alpha: wrap every call; failure ⇒ escalate, never block.
- Embeddings: `POST /v1/embeddings` (OpenAI shape).

### Nessie — key as query param `?key=…`
- Base: `https://prod-api.nessieisreal.com` (production server in the official docs, https://prod.nessieisreal.com/docs; spec at `/nessie-openapi-spec.yaml`). `api.nessieisreal.com` serves the same data; plain `http` times out.
- Customers `/customers`, accounts `/customers/{id}/accounts`, `/accounts/{id}`, purchases `/accounts/{id}/purchases` (GET/POST), transfers `/accounts/{id}/transfers` (GET/POST), deposits, bills `/accounts/{id}/bills` (GET/POST), `PUT /bills/{id}`, merchants `/merchants` (GET/POST). Verified request bodies are in spec 08's "Decisions made while building".
- Verified quirks: transfers have **no payee** (body `{transaction_date, status, amount, description}`) and move no balance; amounts are **whole dollars** (decimals truncated); nothing is idempotent (we tag objects `[cf:<key>]` in description/nickname); a wrong key returns `200 []`.

### Apify — base `https://api.apify.com/v2`, `Authorization: Bearer <token>`
- Webhook events `ACTOR.RUN.SUCCEEDED` etc.; custom `payloadTemplate` with `{{resource}}` variables. Dataset items: `GET /v2/datasets/{datasetId}/items`.
- Change-monitor Actor candidates: `monema/apify-change-monitor`, `scrapemint/website-change-monitor` — `VERIFY` input schema on the Actor page.

## Plan constraints (founder account, Pro Plus)

- **One founder account does everything.** The Dispatcher is code, not a Creao user. The `capi_` account key runs every agent.
- **Executor.** One **Executor** agent (input field `action`) holds all connectors; Pro Plus allows several per agent. Linear is required (`file_bug`, end of flow A); Gmail (`reply_customer`) and Google Calendar (`schedule_digest`) are optional, with a mock outbox in the app when not connected.
- **Schedules.** Standups and the weekly review are started by Convex crons, not Creao schedules.
- **Credits.** Every run costs credits; the Rate Limiter caps 60 runs/hour/role. Spend is shown from our own `runs` table (no usage API).

## Conventions

- TypeScript strict. Validators (`v.*`) on every Convex function argument. No `any` in `convex/lib`.
- Pure logic (envelope parsing, rule matching, gate evaluation, novelty) lives in `convex/lib/` as plain functions with unit tests. Convex functions are thin wrappers.
- External calls only in Convex **actions**; DB writes only in **mutations**. Actions call `ctx.runMutation` to persist.
- Every external call has a timeout and an idempotency key where the API supports one (Creao `idempotencyKey`, Apify run ids, Nessie object ids stored on the action).
- IDs: store Creao/Nessie/Apify ids as strings with the prefix in the field name (`creao_app_id`, `creao_run_id`, `nessie_id`).
- Money is integer cents everywhere (`amount_cents`). Never floats.
- Times are epoch ms (`Date.now()`); display in America/Los_Angeles.
- Logs: never log keys, tokens, or full customer emails.
- Tests: `vitest` + `convex-test`. Every gate rule path, envelope parse path and ladder transition has a test.

## Demo company (fixture)

Agents are **company-agnostic**: no company name in any agent prompt. The company comes from the `company` profile table, sent as a compact `company` block in every ASSIGN and in full via `co data company`. The demo profile is the fictional SaaS **"Lumen Notes"** (AI meeting notes, $35/mo Pro plan), seeded as data. Do not use real company names or branding in seed data. Competitors in Apify monitors may be real public URLs (read-only).

## Out of scope (do not build unless a spec says so)

- Engineering department / code-writing agents (removed).
- Creao workspaces.
- Creao Rooms API / CREAO CLI `/v1/*` (unavailable; see External APIs).
- Real social posting (post queue is mock).
- Auth beyond a single founder login.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.

Project notes:
- Start every session (and every spec) with `graphify query` / `graphify explain` instead of re-reading `docs/system-design.md` and the specs in full. Open a spec file only for the exact section the graph points to.
- The graph covers `docs/`, `agents/` and this file even though `docs/` is git-ignored: `graphify-out/.graphify_build.json` sets `gitignore: false` with explicit excludes (node_modules, convex/_generated, .claude, .convex, tsconfigs, and the superseded `docs/specs/04-dispatcher-and-room-reader.md`; the live spec 04 is `04-dispatcher-and-runs.md`). Keep that config when rebuilding.
- `graphify update .` only refreshes code. After editing any doc, spec or agent file, run `/graphify --update` so the semantic (doc) nodes are re-extracted.
- `graphify-out/` is git-ignored (it summarizes the private docs).
- `docs/` is the source of truth for the plan. When it changes, update stale text elsewhere (`agents/`, this file, code comments) to match.

## Convex

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
