// Content for the landing-page org diagram: who sits where, and the stories that move through the company.
// Coordinates are in the diagram's 1100×515 viewBox; x/y is the node's centre.

export type Kind = "agent" | "code" | "human" | "ext";
export type Dept = "lead" | "mkt" | "cus" | "fin" | "exe";

export type OrgNode = {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: Kind;
  dept?: Dept;
  mgr?: boolean;
  label: string;
  sub: string;
  channels?: string[];
  job: string;
  emits: string[];
};

export const NODES = {
  founder: { x: 445, y: 50, w: 190, h: 50, kind: "human", label: "Founder", sub: "Decides only the novel", channels: ["#founder-desk"], job: "Approves one package per real decision. Every decision is logged and, once consistent, proposed back as a rule to approve as a diff.", emits: ["DECISION", "rule approval"] },
  cofounder: { x: 445, y: 160, w: 230, h: 58, kind: "agent", dept: "lead", label: "Cofounder", sub: "Orchestrator + strategist", channels: ["#leadership", "#founder-desk"], job: "Cross-department decisions, founder packages, weekly memo, and pushback when the founder contradicts a rule or the data.", emits: ["DECISION", "OBJECT", "founder package"] },

  mkt_mgr: { x: 160, y: 318, w: 210, h: 54, kind: "agent", dept: "mkt", mgr: true, label: "Marketing manager", sub: "Standup, budgets, issues", channels: ["#marketing", "#leadership"], job: "Runs standup, resolves issues from its team, proposes budgets.", emits: ["REPORT", "HANDOFF", "ESCALATE"] },
  intel: { x: 97, y: 430, w: 118, h: 56, kind: "agent", dept: "mkt", label: "Market intel", sub: "Signals → findings", channels: ["#marketing"], job: "Turns radar signals into grounded findings with evidence.", emits: ["REPORT"] },
  content: { x: 223, y: 430, w: 118, h: 56, kind: "agent", dept: "mkt", label: "Content", sub: "Drafts posts", channels: ["#marketing"], job: "Drafts posts; the target channel is a parameter.", emits: ["publish_post"] },

  cus_mgr: { x: 445, y: 318, w: 210, h: 54, kind: "agent", dept: "cus", mgr: true, label: "Customer manager", sub: "Triage, issues", channels: ["#customer", "#leadership"], job: "Runs standup, groups related issues, hands work across departments.", emits: ["HANDOFF", "ESCALATE"] },
  support: { x: 382, y: 430, w: 118, h: 56, kind: "agent", dept: "cus", label: "Support", sub: "Tickets, refunds", channels: ["#customer"], job: "Answers tickets, replies to customers, proposes refunds.", emits: ["reply_customer", "refund", "ISSUE"] },
  retention: { x: 508, y: 430, w: 118, h: 56, kind: "agent", dept: "cus", label: "Retention", sub: "Cohorts, churn", channels: ["#customer"], job: "Cohorts, churn and win-back: who stayed, who left, and why.", emits: ["REPORT", "ISSUE"] },

  fin_mgr: { x: 730, y: 318, w: 210, h: 54, kind: "agent", dept: "fin", mgr: true, label: "Finance manager", sub: "Daily close, objections", channels: ["#finance", "#leadership"], job: "Daily close, resolves issues, objects to spend with evidence.", emits: ["REPORT", "OBJECT", "ESCALATE"] },
  ledger: { x: 667, y: 430, w: 118, h: 56, kind: "agent", dept: "fin", label: "Ledger", sub: "Reconcile, bills", channels: ["#finance"], job: "Reconciles revenue and refunds against the bank, proposes bill payments.", emits: ["pay_bill", "refund_batch", "ESCALATE"] },
  spend: { x: 793, y: 430, w: 118, h: 56, kind: "agent", dept: "fin", label: "Spend", sub: "Costs, vendors", channels: ["#finance"], job: "Expenses, vendor prices, and the agents’ own credit spend.", emits: ["switch_vendor", "OBJECT", "alert"] },

  apify: { x: 987, y: 85, w: 160, h: 54, kind: "ext", label: "Company Radar", sub: "Apify monitors", job: "Change monitors on competitor, review and vendor pages. Signals above a significance threshold become tasks; the rest go to standup.", emits: ["signal"] },
  dispatcher: { x: 987, y: 180, w: 160, h: 54, kind: "code", label: "Dispatcher", sub: "Routes every run", job: "Code, not an LLM. Starts every agent run through Creao’s API Trigger with an ASSIGN and records the reply in the task’s channel thread. Agents never address agents. Hop limit 3, at most 3 handoffs per task.", emits: ["ASSIGN"] },
  gate: { x: 987, y: 275, w: 160, h: 54, kind: "code", label: "Authority gate", sub: "Allow · escalate · deny", job: "One transactional decision per proposed action: hard constraints, then label confidence (< 0.8 escalates), then novelty, then the most specific rule, else escalate. Records which rule fired.", emits: ["allow", "escalate", "deny"] },
  executor: { x: 987, y: 370, w: 160, h: 54, kind: "agent", dept: "exe", label: "Executor", sub: "Only agent with write", channels: [], job: "Performs exactly one approved connector action from its input. Sits in no channel; reached only through the gate.", emits: ["Linear bug", "Gmail reply", "Calendar hold"] },
  nessie: { x: 987, y: 465, w: 160, h: 54, kind: "ext", label: "Capital One Nessie", sub: "Money rail", job: "Refunds, bill payments and transfers. Only the gate touches money; budgets are decremented in the same transaction.", emits: ["transfer", "bill"] },
} satisfies Record<string, OrgNode>;

export type NodeId = keyof typeof NODES;
export const NODE_IDS = Object.keys(NODES) as NodeId[];
export const node = (id: NodeId): OrgNode => NODES[id];

export type Step = { from?: NodeId; to?: NodeId; at?: NodeId; tag: string; text: string };
export type Story = { id: string; name: string; title: string; steps: Step[] };

export const STORIES: Story[] = [
  {
    id: "dup",
    name: "Duplicate charges",
    title: "One decision, not twelve",
    steps: [
      { from: "support", to: "gate", tag: "refund $35", text: "Support refunds a $35 duplicate charge. Rule R7 already covers it, so the gate allows it without the founder." },
      { from: "gate", to: "nessie", tag: "transfer", text: "The refund goes out through Nessie. Today’s refund budget is decremented in the same transaction." },
      { from: "support", to: "cus_mgr", tag: "ISSUE", text: "Five more tickets mention a double charge. Support raises a coordination ISSUE to its manager." },
      { from: "cus_mgr", to: "ledger", tag: "HANDOFF", text: "The Customer manager groups the tickets and hands them to Finance. The Dispatcher starts Ledger with an ASSIGN quoting the thread." },
      { from: "ledger", to: "fin_mgr", tag: "ESCALATE", text: "Ledger finds 12 duplicates, $420 total. That exceeds today’s refund budget, so it escalates." },
      { from: "fin_mgr", to: "cofounder", tag: "ESCALATE", text: "No rule grants a $420 batch, so the Finance manager escalates to the Cofounder." },
      { from: "cofounder", to: "founder", tag: "package", text: "The Cofounder writes one package for #founder-desk: evidence, what each level tried, options and a recommendation." },
      { from: "founder", to: "gate", tag: "DECISION", text: "The founder approves once. The decision is logged toward a future rule, so next time nobody has to ask." },
      { from: "gate", to: "nessie", tag: "refund_batch", text: "Twelve refunds go out through Nessie." },
      { from: "gate", to: "executor", tag: "file_bug", text: "The Executor files the root-cause bug in Linear. Six agents worked the incident; the founder made one decision." },
    ],
  },
  {
    id: "neg",
    name: "Negotiation",
    title: "A disagreement the founder never sees",
    steps: [
      { from: "apify", to: "intel", tag: "signal", text: "Company Radar sees a competitor cut prices." },
      { from: "intel", to: "mkt_mgr", tag: "REPORT", text: "Market intel turns the signal into a grounded finding with evidence links." },
      { from: "mkt_mgr", to: "cofounder", tag: "propose $500", text: "In #leadership, the Marketing manager proposes a $500 ad test in response." },
      { from: "spend", to: "cofounder", tag: "OBJECT", text: "Spend objects with evidence: a vendor price rise is already hitting margin." },
      { from: "cofounder", to: "gate", tag: "DECISION $200", text: "The Cofounder settles on $200, inside its marketing budget rule, with a review in two weeks." },
      { from: "gate", to: "mkt_mgr", tag: "allow", text: "The gate allows it. Agents disagreed, resolved it, and the founder was never interrupted." },
    ],
  },
  {
    id: "task",
    name: "Life of a task",
    title: "How every run is routed",
    steps: [
      { at: "dispatcher", tag: "event", text: "An event arrives (a support ticket, a radar signal, a cron) and becomes a task in Convex." },
      { from: "dispatcher", to: "support", tag: "ASSIGN", text: "The Dispatcher starts one agent run through Creao’s API Trigger: the brief, the rules in scope, a short-lived token." },
      { from: "support", to: "dispatcher", tag: "envelope", text: "The agent answers as itself and ends with one typed envelope. Malformed output gets one repair request, then an ISSUE." },
      { from: "dispatcher", to: "gate", tag: "proposed action", text: "Jev labels the proposed action. Any label under 0.8 confidence escalates instead of executing." },
      { from: "gate", to: "executor", tag: "allow", text: "Hard constraints, novelty, then the most specific rule decide. If allowed, the Executor performs exactly that one action." },
    ],
  },
];
