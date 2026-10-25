// Filled by hand from agent.creao.ai (spec 00, manual step 2), then loaded by seed:config.
// creao_app_id: the App ID on each agent's page.
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
  { role: "cofounder", department: "leadership", creao_app_id: "", input_field: "message",
    display_name: "Cofounder", rooms: ["#leadership", "#founder-desk"], kind: "role" },
  { role: "marketing_manager", department: "marketing", manager_role: "cofounder", creao_app_id: "",
    input_field: "message", display_name: "Marketing Manager", rooms: ["#marketing", "#leadership"], kind: "role" },
  { role: "market_intel", department: "marketing", manager_role: "marketing_manager", creao_app_id: "",
    input_field: "message", display_name: "Market Intel", rooms: ["#marketing"], kind: "role" },
  { role: "content", department: "marketing", manager_role: "marketing_manager", creao_app_id: "",
    input_field: "message", display_name: "Content", rooms: ["#marketing"], kind: "role" },
  { role: "customer_manager", department: "customer", manager_role: "cofounder", creao_app_id: "",
    input_field: "message", display_name: "Customer Manager", rooms: ["#customer", "#leadership"], kind: "role" },
  { role: "support", department: "customer", manager_role: "customer_manager", creao_app_id: "",
    input_field: "message", display_name: "Support", rooms: ["#customer"], kind: "role" },
  { role: "retention", department: "customer", manager_role: "customer_manager", creao_app_id: "",
    input_field: "message", display_name: "Retention", rooms: ["#customer"], kind: "role" },
  { role: "finance_manager", department: "finance", manager_role: "cofounder", creao_app_id: "",
    input_field: "message", display_name: "Finance Manager", rooms: ["#finance", "#leadership"], kind: "role" },
  { role: "ledger", department: "finance", manager_role: "finance_manager", creao_app_id: "",
    input_field: "message", display_name: "Ledger", rooms: ["#finance"], kind: "role" },
  { role: "spend", department: "finance", manager_role: "finance_manager", creao_app_id: "",
    input_field: "message", display_name: "Spend", rooms: ["#finance"], kind: "role" },
  // Executors run only via the API Trigger and sit in no channel. One per connector.
  { role: "executor", department: "none", creao_app_id: "", input_field: "action",
    display_name: "Executor-Linear", rooms: [], kind: "executor" },
  // Optional: set enabled to true once Executor-Gmail exists (reply_customer).
  { role: "executor", department: "none", creao_app_id: "", input_field: "action",
    display_name: "Executor-Gmail", rooms: [], kind: "executor", enabled: false },
] as const;
