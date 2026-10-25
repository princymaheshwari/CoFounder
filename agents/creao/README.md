# CREAO department agents

1. Sign in at agent.creao.ai with the founder account (Pro Plus). Install the `co` skill account-wide from `skills/co/`: it is how every role agent reads company data with its task token.
2. Create the agents in this order. Flow A (the double-charge escalation) first: **Support** (`support.md`), **Ledger** (`ledger.md`), **Customer Manager** (`customer_manager.md`), **Finance Manager** (`finance_manager.md`), **Cofounder** (`cofounder.md`), **Executor** (`executor.md`). Then **Retention**, **Spend**, **Marketing Manager**, **Market Intel**, **Content**.
3. For each one, enable the tools listed in the file header, set the input form field (`message`; the Executor uses `action`) and the write autonomy, and paste everything below `---- PASTE BELOW THIS LINE INTO CREAO ----` into the chat. Run the test input once and check that the reply ends with a single valid ```` ```cofounder ```` block whose `task` and `from` match. Then click **Create Agent**. Do not let the builder copy the test company into the instructions: agents are company-agnostic and get the company in every ASSIGN.
4. Put each agent's App ID and input field id in `convex/seed.config.ts`, then run `npx convex run seed:config` and `npx convex run health:check`.
5. If you edit an instruction file later, open that agent's edit chat, say "Replace your entire instructions with the text below, word for word", and paste the new text. The App ID stays the same.

The Dispatcher (Convex code) starts every run through Creao's API Trigger and validates every reply against `convex/lib/envelope.ts`. `tests/agents.test.ts` checks that each example envelope in these files passes that validator.

Agent links (for judges):

| Agent | Instructions | App ID | Link |
| --- | --- | --- | --- |
| Cofounder | `cofounder.md` | 6eed280f-e1bc-4991-afbb-f87f5537c18e | <url> |
| Customer Manager | `customer_manager.md` | 4f3f1bd8-1185-4867-af2e-ab0204824d92 | <url> |
| Support | `support.md` | edea5cf5-b3fb-47f0-994c-b40ff2a2e9ec | <url> |
| Retention | `retention.md` | a09acafd-0043-4c33-a62f-918c3d72fc73 | <url> |
| Finance Manager | `finance_manager.md` | b1a8e7d3-6ac2-4992-9570-fd4403fa2a91 | <url> |
| Ledger | `ledger.md` | d1a6457c-ad56-453d-8ef7-343c0071b183 | <url> |
| Spend | `spend.md` | c4018e63-9f49-4f2d-b228-869638c5b8e9 | <url> |
| Marketing Manager | `marketing_manager.md` | e72deb2f-02a6-4483-be7b-16f218c635dd | <url> |
| Market Intel | `market_intel.md` | f9b172c6-95b7-48bd-912e-61f5b5538a32 | <url> |
| Content | `content.md` | 41c24869-ed73-4bb8-a5c5-10330e60d89a | <url> |
| Executor | `executor.md` | 16083e9b-5cbc-42e9-bb5a-b5488b98ca81 | <url> |
