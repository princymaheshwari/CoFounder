# CLAUDE.md — Cofounder

Cofounder lets one founder run a company through a hierarchy of AI agents that talk to each other in Creao rooms, without the founder becoming the approval bottleneck. Agents propose; a deterministic Convex gate decides; only the backend moves money or calls connectors.

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

## Non-negotiable invariants

These are the product. Never weaken them, even to make a demo work.

1. **Agents never execute.** Role agents only propose actions inside message envelopes. Only Convex executes: Nessie calls directly, connector writes through the Executor agent.
2. **The gate is code.** `evaluateGate` is a single Convex mutation: deterministic, transactional, no LLM call inside it. LLMs (Jev, Claude) may produce *inputs* to the gate (labels), never the decision.
3. **Only the Dispatcher triggers agents.** Agents never @mention other agents. Every agent-triggering post is made by Convex through the Dispatcher account with `trigger_agents: true`. All other posts use `trigger_agents: false`.
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
| Agents | Creao saved agents (Claude Sonnet 5.5 default) working in Creao rooms |
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
    creao/                 rooms.ts (Rooms API client), runs.ts (/v1/runs client)
    dispatcher.ts          postToRoom, assign, handoff
    roomReader.ts          polling reader + message ingestion
    tasks.ts               task creation, routing, graph limits
    workflows.ts           Workflow definitions
    gate.ts                evaluateGate mutation + action catalog
    issues.ts              issue ladder
    executor.ts            Executor runs + webhook handling
    nessie.ts              Nessie client, sync, execute
    labels.ts              Jev labeling
    rules.ts               induction, validation, activation, memory sync
    apify.ts               ingest + callback
    http.ts                /creao-callback, /apify-callback, /co/*
    crons.ts
    seed.ts
  src/                     founder app (React)
  skills/co/               SKILL.md + co.py
  actors/company-radar/    Apify Actor (stretch)
  scripts/                 seed-nessie.ts, replay.ts
  tests/                   vitest + convex-test
```

## Commands

```bash
npm install
npx convex dev            # run backend, push schema/functions on save
npm run dev               # frontend
npx convex run seed:all   # seed agents/rooms/rules rows after env vars are set
npm test                  # vitest (convex-test for functions)
npx convex env set NAME value   # set a backend secret
```

## Environment variables (Convex env, never committed)

| Name | Purpose |
| --- | --- |
| `CREAO_DISPATCHER_KEY` | `cr_sk_` key of the **Dispatcher** account: Rooms API posting/reading |
| `CREAO_OWNER_KEY` | `cr_sk_` key of the **founder** account: `/v1/runs` (Executor), agent memory, usage |
| `CREAO_WEBHOOK_TOKEN` | random string appended to Executor `webhook_url` |
| `NESSIE_API_KEY` | Nessie key (sent as `?key=`) |
| `APIFY_TOKEN` | Apify API token |
| `APIFY_WEBHOOK_TOKEN` | random string appended to Apify webhook URL |
| `CO_TOKEN_SECRET` | HMAC secret for task-scoped `co` tokens |

Agent IDs and room IDs are data, stored in the `agents` and `rooms` tables by the seed, not env vars.

## External APIs: what is known

### Creao (account-level API) — base `https://developer.creao.ai`, header `Authorization: Bearer cr_sk_…`

Known from Creao docs:
- `POST /v1/runs` `{agent_id, input, model?, conversation_id?, webhook_url?}` → 202 `{run_id, status, agent_id, conversation_id}`. `GET /v1/runs/{run_id}` → status `pending|running|completed|failed|cancelled`, `result`, `error.code`.
- Webhook POST body includes `runId`, `status`, `conversationId`, `model`, `result` or `error`. Header `X-Creao-Delivery-Id` (same on every retry). Up to 3 attempts, 10 s timeout, no redirects. Delivery is at least once → dedupe. Webhooks are not signed → re-fetch the run and trust only that. A run that fails before starting sends **no** webhook → poll.
- `GET|PUT|DELETE /v1/agents/{agent_id}/memory` — items `{name, content, trigger, rationale, status}`; PUT replaces the whole set; max 100 items, 8 KB each.
- `GET /v1/account/usage` — remaining credits + rolling 24 h spend.
- Rooms: `GET /v1/rooms`, `GET /v1/rooms/{room_id}`, `GET|POST /v1/rooms/{room_id}/messages`, `GET /v1/rooms/{room_id}/agents`, SSE `GET /v1/rooms/{room_id}/events`.
  - POST message: `text` (1–16,000 chars), `client_msg_id` (idempotent; retry returns `duplicate: true`), `reply_to_seq`, `mentions` (member ids), `trigger_agents` (default true), `expand_shortcut` (default true). `@Name` in text resolves to a member; ambiguous → `400 ROOM_MENTION_AMBIGUOUS` with `candidates`. Response lists `agent_invocations`.
  - GET messages: page by `seq` with one of `before` / `after` / `around`, `limit` ≤ 100 (default 50), or `root` for a thread; continue from `cursor_seq`.
  - Agent reply: `sender.kind === "agent"` and `reply_to_seq` = the triggering message's `seq`; done when the agent's status returns to `idle` (or `failed`).
  - Limits: 60 posts/min per account; **30 new agent-triggering posts per hour per account per room** (posts with `trigger_agents: false` don't count); 10 open event streams.
- Errors are `{ "error": "CODE" }`; `429` includes `Retry-After`.

`VERIFY` before relying on it:
- Exact JSON shapes of room message objects (field names for `seq`, `sender`, `text`, thread root).
- Whether an agent's reply that @mentions another agent wakes it (we forbid it either way).
- Whether a fenced code block in an agent reply arrives intact via the API.
- Whether room creation, announcements and scheduled messages are API-accessible (assume UI-only; seed stores room IDs).
- Exact agent-status field in `GET /v1/rooms/{room_id}/agents`.

### Convex AI Gateway — base `https://ai-gateway.convex.dev`, token from `getServiceToken("ai-gateway")` inside an action (paid plan required; apply hackathon coupon)
- Text: AI SDK `convexGateway("anthropic/<model>")` from `@convex-dev/ai-sdk-provider`; or `POST /v1/messages` (Anthropic shape). `VERIFY` the exact Claude model id with `GET /v1/models`.
- Jev: `POST /alpha/decisions` `{model: "typesafe/jev-1.13", state, questions: {name: {type: "choice"|"score"|"noul", instructions, criteria?}}}` → `answers.name.{choice|score|noul, confidence?, probabilities?}`. Alpha: wrap every call; failure ⇒ escalate, never block.
- Embeddings: `POST /v1/embeddings` (OpenAI shape).

### Nessie — key as query param `?key=…`
- Base: `VERIFY` (`http://api.nessieisreal.com` vs `https://prod-api.nessieisreal.com`).
- Customers `/customers`, accounts `/customers/{id}/accounts`, `/accounts/{id}`, purchases `/accounts/{id}/purchases` (GET/POST), transfers `/accounts/{id}/transfers` (GET/POST), deposits, bills `/accounts/{id}/bills`, merchants `/merchants` (GET/POST). `VERIFY` request bodies in Nessie's interactive docs before writing the seed.

### Apify — base `https://api.apify.com/v2`, `Authorization: Bearer <token>`
- Webhook events `ACTOR.RUN.SUCCEEDED` etc.; custom `payloadTemplate` with `{{resource}}` variables. Dataset items: `GET /v2/datasets/{datasetId}/items`.
- Change-monitor Actor candidates: `monema/apify-change-monitor`, `scrapemint/website-change-monitor` — `VERIFY` input schema on the Actor page.

## Conventions

- TypeScript strict. Validators (`v.*`) on every Convex function argument. No `any` in `convex/lib`.
- Pure logic (envelope parsing, rule matching, gate evaluation, novelty) lives in `convex/lib/` as plain functions with unit tests. Convex functions are thin wrappers.
- External calls only in Convex **actions**; DB writes only in **mutations**. Actions call `ctx.runMutation` to persist.
- Every external call has a timeout and an idempotency key where the API supports one (`client_msg_id`, Apify run ids, Nessie object ids stored on the action).
- IDs: store Creao/Nessie/Apify ids as strings with the prefix in the field name (`creao_room_id`, `nessie_id`).
- Money is integer cents everywhere (`amount_cents`). Never floats.
- Times are epoch ms (`Date.now()`); display in America/Los_Angeles.
- Logs: never log keys, tokens, or full customer emails.
- Tests: `vitest` + `convex-test`. Every gate rule path, envelope parse path and ladder transition has a test.

## Demo company (fixture)

Fictional SaaS **"Lumen Notes"** (AI meeting notes, $19/mo). Do not use real company names or branding in seed data. Competitors in Apify monitors may be real public URLs (read-only).

## Out of scope (do not build unless a spec says so)

- Engineering department / code-writing agents (removed).
- Creao workspaces (replaced by rooms).
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
- Start every session (and every spec) with `graphify query` / `graphify explain` against the graph instead of re-reading `docs/system-design.md` and the specs in full. Open a spec file only for the exact section the graph points to.
- The graph covers `docs/`, `agents/roles.md` and this file even though `docs/` is git-ignored: `graphify-out/.graphify_build.json` sets `gitignore: false` with explicit excludes (node_modules, convex/_generated, .claude, .convex, tsconfigs). Keep that config when rebuilding.
- `graphify update .` only refreshes code. After editing any doc or spec, run `/graphify --update` so the semantic (doc) nodes are re-extracted.
- `graphify-out/` is git-ignored (it summarizes the private docs).

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
