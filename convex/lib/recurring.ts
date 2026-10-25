import { z } from "zod";
import type { Role } from "./types";

// Recurring work from onboarding. Claude proposes a plan from what the founder wrote; these helpers check it,
// place each task in its owner's channel, and supply a fixed plan when Claude is unavailable.

export const HOUR_MS = 60 * 60 * 1000;
export const MAX_RECURRING = 8;

// Who can own recurring work, and the channel each one posts in. The Executor never gets tasks.
export const ROLE_ROOM = {
  support: "#customer",
  retention: "#customer",
  customer_manager: "#customer",
  ledger: "#finance",
  spend: "#finance",
  finance_manager: "#finance",
  market_intel: "#marketing",
  content: "#marketing",
  marketing_manager: "#marketing",
  cofounder: "#leadership",
} as const satisfies Partial<Record<Role, string>>;
export type RecurringRole = keyof typeof ROLE_ROOM;
const RECURRING_ROLES = Object.keys(ROLE_ROOM) as [RecurringRole, ...RecurringRole[]];

// Every department channel gets at least one recurring thread, and #leadership gets the Cofounder's memo.
export const REQUIRED_ROOMS = ["#customer", "#finance", "#marketing", "#leadership"] as const;

// Events a recurring thread can follow (see routing.ts); everything else runs on an interval.
const RECURRING_EVENTS = ["support_ticket"] as const;

const taskSchema = z.object({
  role: z.enum(RECURRING_ROLES),
  title: z.string().min(3).max(80),
  brief: z.string().min(10).max(600),
  trigger: z.enum(["interval", "event"]),
  every_hours: z.number().min(1).max(24 * 14).optional(),
  event_type: z.enum(RECURRING_EVENTS).optional(),
  cadence_label: z.string().min(2).max(40),
});
export const planSchema = z.object({ tasks: z.array(taskSchema).min(1).max(12) });

// A flow is recurring work that runs through more than one agent and ends in an action. The only one so far:
// Company Radar (Apify) pulls this week's LinkedIn posts → Market intel finds the trends → HANDOFF to Content →
// Content drafts the post → the gate allows it under the rule the founder approved at onboarding.
export const FLOWS = ["linkedin_weekly"] as const;
export type Flow = (typeof FLOWS)[number];

export type PlanTask = {
  role: RecurringRole;
  room: string;
  title: string;
  brief: string;
  trigger: "interval" | "event";
  every_ms?: number;
  event_type?: string;
  cadence_label: string;
  flow?: Flow;
};

// Recurring checks only report: no actions and no issues, so a routine run never starts an escalation of its
// own. Anything that needs a decision goes in the summary, where the manager picks it up.
export const RECURRING_SUFFIX = "This is a recurring check: reply with one REPORT, with no proposed_actions and no issue. Put anything that needs a decision in the summary for your manager.";

// What a flow's first agent is told to reply with, in place of RECURRING_SUFFIX.
export const FLOW_SUFFIX: Record<Flow, string> = {
  linkedin_weekly:
    `Reply with one HANDOFF to_role "content": summary = the trends in one or two sentences, findings = one per trend with the post's evidence_url, brief = the angle for this week's LinkedIn post about our own product development. The post must not name competitors or mention prices.`,
};

// The standing rule a flow's approval creates at onboarding: the founder approved the outcome once, so the gate
// can allow it every week. Same shape as a learned rule; supported by the onboarding decision.
export const FLOW_RULE = {
  linkedin_weekly: {
    scope: { level: "role" as const, role: "content" as const },
    action_type: "publish_post" as const,
    conditions: [
      { field: "channel", op: "in" as const, value: ["linkedin"] },
      { field: "mentions_pricing", op: "==" as const, value: false },
      { field: "mentions_competitor", op: "==" as const, value: false },
    ],
    effect: "allow" as const,
    sentence: "Content may publish the weekly LinkedIn post when it mentions no prices and no competitors. Approved at onboarding.",
  },
} satisfies Record<Flow, unknown>;

export const recurringBrief = (t: Pick<PlanTask, "cadence_label" | "title" | "brief" | "flow">) =>
  `Recurring · ${t.cadence_label} · ${t.title}. ${t.brief} ${t.flow ? FLOW_SUFFIX[t.flow] : RECURRING_SUFFIX}`;

export const nextRunAt = (everyMs: number, from: number) => from + everyMs;

// The inverse of recurringBrief, for showing a recurring ASSIGN as "@Owner · title · cadence" in the app.
export function parseRecurringBrief(brief: string): { cadence: string; title: string; brief: string } | null {
  const m = /^Recurring · (.+?) · (.+?)\. ([\s\S]*)$/.exec(brief);
  if (!m) return null;
  let body = m[3].replace(RECURRING_SUFFIX, "");
  for (const f of FLOWS) body = body.replace(FLOW_SUFFIX[f], "");
  return { cadence: m[1], title: m[2], brief: body.trim() };
}

// The weekly LinkedIn post flow (#marketing). Always part of the plan.
export const LINKEDIN_WEEKLY: PlanTask = {
  role: "market_intel",
  room: "#marketing",
  title: "Weekly LinkedIn post on product updates",
  brief: "Read this week's LinkedIn posts about AI meeting notes that Company Radar pulled from LinkedIn (co data signals). Pick the two or three trends that matter for our product.",
  trigger: "interval",
  every_ms: 7 * 24 * HOUR_MS,
  cadence_label: "every Monday",
  flow: "linkedin_weekly",
};

export const DEFAULT_PLAN: PlanTask[] = [
  {
    role: "support",
    room: "#customer",
    title: "Triage new support tickets",
    brief: "Summarize the open ticket queue (co data tickets): how many, the oldest, and any problem that repeats across tickets. Each new ticket opens its own thread for handling.",
    trigger: "event",
    event_type: "support_ticket",
    cadence_label: "as soon as a ticket arrives",
  },
  {
    role: "retention",
    room: "#customer",
    title: "Churn watch",
    brief: "Look at recent cancellations and public review signals (co data tickets, co data signals). Report who left, why, and one cohort worth a win-back.",
    trigger: "interval",
    every_ms: 7 * 24 * HOUR_MS,
    cadence_label: "every Monday",
  },
  {
    role: "spend",
    room: "#finance",
    title: "Vendor and credit spend check",
    brief: "Compare this week's vendor costs and the agents' own credit usage with last week (co data ledger, co data usage, co data signals). Report anything that moved more than 10%.",
    trigger: "interval",
    every_ms: 24 * HOUR_MS,
    cadence_label: "daily at 9:00",
  },
  LINKEDIN_WEEKLY,
  {
    role: "cofounder",
    room: "#leadership",
    title: "Weekly memo",
    brief: "Summarize the week for the founder: signals, budgets, open issues and decisions made by rules (co data company, co data budget).",
    trigger: "interval",
    every_ms: 7 * 24 * HOUR_MS,
    cadence_label: "Mondays at 8:00",
  },
];

// Keeps the valid tasks from Claude's plan, places each in its owner's channel, fills any department channel
// Claude left out from DEFAULT_PLAN, and caps the list. Never throws: the worst case is DEFAULT_PLAN.
export function normalizePlan(raw: unknown): PlanTask[] {
  const items: unknown[] = raw && typeof raw === "object" && Array.isArray((raw as { tasks?: unknown }).tasks) ? (raw as { tasks: unknown[] }).tasks : [];
  const seen = new Set<string>();
  const tasks: PlanTask[] = [];
  for (const item of items) {
    const parsed = taskSchema.safeParse(item);
    if (!parsed.success) continue;
    const t = parsed.data;
    const key = `${t.role}:${t.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const base = { role: t.role, room: ROLE_ROOM[t.role], title: t.title, brief: t.brief, cadence_label: t.cadence_label };
    tasks.push(
      t.trigger === "event" && t.event_type
        ? { ...base, trigger: "event", event_type: t.event_type }
        : { ...base, trigger: "interval", every_ms: Math.round((t.every_hours ?? 24) * HOUR_MS) },
    );
  }
  // The LinkedIn flow leads #marketing whatever Claude proposed.
  tasks.unshift(LINKEDIN_WEEKLY);
  for (const room of REQUIRED_ROOMS) {
    if (!tasks.some((t) => t.room === room)) tasks.push(DEFAULT_PLAN.find((t) => t.room === room)!);
  }
  // Cap without dropping a department: one per required channel first, then the rest in Claude's order.
  const firsts = REQUIRED_ROOMS.map((room) => tasks.find((t) => t.room === room)!);
  const rest = tasks.filter((t) => !firsts.includes(t));
  return [...firsts, ...rest].slice(0, MAX_RECURRING);
}

export type OnboardingInput = {
  name: string;
  what: string;
  priorities: string;
  goals: string;
  links: string[];
  docs: { name: string; excerpt: string }[];
};

export const PLAN_SYSTEM = `You set up recurring work for a company run by AI agents. Each agent can read company data with \`co data\` commands and replies with a REPORT.
Owners and what they can read:
- support (#customer): co data tickets, co data ticket --id, co data customer --id
- retention (#customer): co data tickets, co data customer, co data signals (reviews)
- customer_manager (#customer): co data tickets, co data thread
- ledger (#finance): co data ledger, co data duplicates, co data budget
- spend (#finance): co data ledger, co data usage, co data signals (vendor prices)
- finance_manager (#finance): co data ledger, co data budget
- market_intel (#marketing): co data signals (competitors, social and community trends)
- content (#marketing): co data company
- marketing_manager (#marketing): co data signals, co data budget
- cofounder (#leadership): co data company, co data budget
Propose 5 to 8 recurring tasks the founder would otherwise do by hand, with at least one owned in each of #customer, #finance and #marketing, plus a weekly memo for the founder owned by cofounder.
A weekly LinkedIn post flow (market_intel reads this week's LinkedIn trends, content drafts the post) is already planned: do not propose another post-drafting or trend-scanning task.
Use trigger "event" with event_type "support_ticket" only for work that should happen as soon as a ticket arrives; everything else is "interval" with every_hours.
cadence_label is a short human label like "as soon as a ticket arrives", "every 2 days", "daily at 9:00", "Mondays".
Each brief says what to check and what to report, in one or two sentences, using only data the owner can read. Never ask an agent to spend money, post, or contact customers.`;

export function planPrompt(o: OnboardingInput): string {
  const docs = o.docs.map((d) => `--- ${d.name}\n${d.excerpt}`).join("\n");
  return [
    `Company: ${o.name}`,
    `What we do: ${o.what}`,
    `Priorities this quarter: ${o.priorities}`,
    `Goals: ${o.goals}`,
    o.links.length ? `Links: ${o.links.join(", ")}` : "",
    docs ? `Documents:\n${docs}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
