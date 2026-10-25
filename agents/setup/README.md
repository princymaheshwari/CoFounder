# Creao setup — order and tracker

Everything runs on the **founder** account. The Dispatcher is Convex code that starts each agent's runs through Creao's API Trigger with your `capi_` account key; every ASSIGN starts with `[Dispatcher]`. Agents you already created need no prompt changes: they still receive an ASSIGN, just as run input instead of a room post. (The manuals were later reworded for channels and for repairs arriving as an ASSIGN with `repair`/`attempt`; re-pasting them into existing agents is optional.) One **Executor** holds all connectors (Pro Plus allows several per agent): Linear required, Gmail and Google Calendar optional (`11-executor.md`). Each file is a paste-ready chat script: Step 1 manual → Step 2 practice task → Step 3 Create Agent → Step 4 settings.

Build order (flow A first): 01 Support → 02 Ledger → 03 Customer Manager → 04 Finance Manager → 05 Cofounder → 11 Executor → then 06–10.

## Tracker (fill as you go; feeds `convex/seed.config.ts` and the Devpost README)

| # | Agent | App ID | Input field id | Practice run share link | Live `[API]` run share link (after flow A) |
| --- | --- | --- | --- | --- | --- |
| 01 | Support | edea5cf5-b3fb-47f0-994c-b40ff2a2e9ec | `message`? | | |
| 02 | Ledger | d1a6457c-ad56-453d-8ef7-343c0071b183 | `message`? | | |
| 03 | Customer Manager | 4f3f1bd8-1185-4867-af2e-ab0204824d92 | `message`? | | |
| 04 | Finance Manager | b1a8e7d3-6ac2-4992-9570-fd4403fa2a91 | `message`? | | |
| 05 | Cofounder | 6eed280f-e1bc-4991-afbb-f87f5537c18e | `message`? | | |
| 06 | Retention | a09acafd-0043-4c33-a62f-918c3d72fc73 | `message`? | | |
| 07 | Spend | c4018e63-9f49-4f2d-b228-869638c5b8e9 | `message`? | | |
| 08 | Marketing Manager | e72deb2f-02a6-4483-be7b-16f218c635dd | `message`? | | |
| 09 | Market Intel | f9b172c6-95b7-48bd-912e-61f5b5538a32 | `message`? | | |
| 10 | Content | 41c24869-ed73-4bb8-a5c5-10330e60d89a | `message`? | | |
| 11 | Executor (Linear required; Gmail, Calendar optional) | 16083e9b-5cbc-42e9-bb5a-b5488b98ca81 | `action` | | |

**Input field id:** agent page → Advanced → Configuration → Input Form. Expected `message` (Executors: `action`). If an agent has no input form, add one text field with that id.

**Rooms** are optional now: Convex never reads or posts to them (the Rooms API needs the developer console). The channels live in the founder app Feed.
