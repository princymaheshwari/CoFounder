// Filled by hand from agent.creao.ai (spec 00, manual step 2), then loaded by seed:config.
// creao_app_id: the App ID on each agent's page (tracker: agents/setup/README.md).
// input_field: the agent's Input Form field id (Advanced → Configuration → Input Form).

// Convex-only channels, rendered in the founder app Feed. Not Creao rooms.
export const ROOMS = [
  { name: "#marketing", department: "marketing" },
  { name: "#customer", department: "customer" },
  { name: "#finance", department: "finance" },
  { name: "#leadership", department: "leadership" },
  { name: "#founder-desk", department: "leadership" },
] as const;

export const AGENTS = [
  { role: "cofounder", department: "leadership", creao_app_id: "6eed280f-e1bc-4991-afbb-f87f5537c18e",
    input_field: "message", display_name: "Cofounder", rooms: ["#leadership", "#founder-desk"], kind: "role" },
  { role: "marketing_manager", department: "marketing", manager_role: "cofounder",
    creao_app_id: "e72deb2f-02a6-4483-be7b-16f218c635dd", input_field: "message",
    display_name: "Marketing Manager", rooms: ["#marketing", "#leadership"], kind: "role" },
  { role: "market_intel", department: "marketing", manager_role: "marketing_manager",
    creao_app_id: "f9b172c6-95b7-48bd-912e-61f5b5538a32", input_field: "message",
    display_name: "Market Intel", rooms: ["#marketing"], kind: "role" },
  { role: "content", department: "marketing", manager_role: "marketing_manager",
    creao_app_id: "41c24869-ed73-4bb8-a5c5-10330e60d89a", input_field: "message",
    display_name: "Content", rooms: ["#marketing"], kind: "role" },
  { role: "customer_manager", department: "customer", manager_role: "cofounder",
    creao_app_id: "4f3f1bd8-1185-4867-af2e-ab0204824d92", input_field: "message",
    display_name: "Customer Manager", rooms: ["#customer", "#leadership"], kind: "role" },
  { role: "support", department: "customer", manager_role: "customer_manager",
    creao_app_id: "edea5cf5-b3fb-47f0-994c-b40ff2a2e9ec", input_field: "message",
    display_name: "Support", rooms: ["#customer"], kind: "role" },
  { role: "retention", department: "customer", manager_role: "customer_manager",
    creao_app_id: "a09acafd-0043-4c33-a62f-918c3d72fc73", input_field: "message",
    display_name: "Retention", rooms: ["#customer"], kind: "role" },
  { role: "finance_manager", department: "finance", manager_role: "cofounder",
    creao_app_id: "b1a8e7d3-6ac2-4992-9570-fd4403fa2a91", input_field: "message",
    display_name: "Finance Manager", rooms: ["#finance", "#leadership"], kind: "role" },
  { role: "ledger", department: "finance", manager_role: "finance_manager",
    creao_app_id: "d1a6457c-ad56-453d-8ef7-343c0071b183", input_field: "message",
    display_name: "Ledger", rooms: ["#finance"], kind: "role" },
  { role: "spend", department: "finance", manager_role: "finance_manager",
    creao_app_id: "c4018e63-9f49-4f2d-b228-869638c5b8e9", input_field: "message",
    display_name: "Spend", rooms: ["#finance"], kind: "role" },
  // One Executor holds every connector: Linear (required), Gmail and Google Calendar (optional).
  // Runs only via the API Trigger and sits in no channel.
  { role: "executor", department: "none", creao_app_id: "16083e9b-5cbc-42e9-bb5a-b5488b98ca81",
    input_field: "action", display_name: "Executor", rooms: [], kind: "executor" },
] as const;
