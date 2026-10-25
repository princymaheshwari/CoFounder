import type { Label } from "./gate";
import type { ActionType } from "./types";

// Jev label questions (spec 11, system-design §8). Pure: the questions per action type, and Jev's
// answers turned into the typed labels the gate reasons over. No I/O.

export const JEV_MODEL = "typesafe/jev-1.13";

export type JevQuestion = { type: "choice" | "noul"; instructions: string; criteria?: Record<string, string> };
export type JevQuestions = Record<string, JevQuestion>;

export const REFUND_REASONS = {
  defect: "The product did not work.",
  billing_error: "The customer was charged wrongly or twice.",
  changed_mind: "The customer no longer wants the product.",
  abuse: "A suspicious pattern: repeat refunds, claims that do not match the records.",
} as const;

const refundReason: JevQuestion = { type: "choice", instructions: "Reason for the refund.", criteria: { ...REFUND_REASONS } };

const BY_TYPE: Partial<Record<ActionType, JevQuestions>> = {
  refund: { refund_reason: refundReason },
  refund_batch: { refund_reason: refundReason },
  publish_post: {
    mentions_pricing: { type: "noul", instructions: "Does the post mention prices, discounts or plans?" },
    mentions_competitor: { type: "noul", instructions: "Does the post name or clearly reference a competitor?" },
  },
  reply_customer: {
    makes_commitment: { type: "noul", instructions: "Does the reply promise a credit, refund, deadline or feature?" },
  },
};

const GROUNDED: JevQuestion = { type: "noul", instructions: "Does the claim follow from the cited evidence?" };

// The questions for one action. `grounded` is asked whenever the envelope carrying it had findings.
export function questionsFor(type: ActionType, hasFindings: boolean): JevQuestions {
  return { ...(BY_TYPE[type] ?? {}), ...(hasFindings ? { grounded: GROUNDED } : {}) };
}

// Labels the gate requires for a type regardless of findings: missing ones escalate.
export function requiredLabels(type: ActionType): string[] {
  return Object.keys(BY_TYPE[type] ?? {});
}

export type StateTicket = { subject: string; body: string; amount_cents?: number };
export type StateCustomer = { plan: string; tenure_days: number };
export type StateFinding = { claim: string; evidence: string; evidence_text: string };

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// Jev's `state`: the action params and rationale, plus (for refunds) the ticket text and customer summary,
// and the findings with their fetched evidence text. Customer names and emails are left out.
export function jevState(a: {
  action: { type: ActionType; role: string; params: unknown; rationale: string };
  tickets?: StateTicket[];
  customers?: StateCustomer[];
  findings?: StateFinding[];
}): Record<string, unknown> {
  return {
    action: { type: a.action.type, proposed_by: a.action.role, params: a.action.params, rationale: clip(a.action.rationale, 1_500) },
    ...(a.tickets?.length ? { tickets: a.tickets.map((t) => ({ ...t, body: clip(t.body, 1_500) })) } : {}),
    ...(a.customers?.length ? { customers: a.customers } : {}),
    ...(a.findings?.length ? { findings: a.findings.map((f) => ({ ...f, evidence_text: clip(f.evidence_text, 800) })) } : {}),
  };
}

const num = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

// choice → {value: choice, confidence}; noul → {value: noul >= 0.5, confidence: max(noul, 1 - noul)}.
// A choice's confidence is Jev's `confidence`, else the probability of the chosen option. An answer
// that is absent, of the wrong type, or outside the criteria is reported missing.
export function toLabels(questions: JevQuestions, answers: unknown): { labels: Record<string, Label>; missing: string[] } {
  const labels: Record<string, Label> = {};
  const missing: string[] = [];
  const all = answers && typeof answers === "object" ? (answers as Record<string, unknown>) : {};
  for (const [name, q] of Object.entries(questions)) {
    const raw = all[name];
    const a = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
    if (q.type === "choice") {
      const choice = typeof a?.choice === "string" ? a.choice : undefined;
      const probs = a?.probabilities && typeof a.probabilities === "object" ? (a.probabilities as Record<string, unknown>) : {};
      const confidence = num(a?.confidence) ?? (choice ? num(probs[choice]) : undefined);
      if (!choice || !(choice in (q.criteria ?? {})) || confidence === undefined) {
        missing.push(name);
        continue;
      }
      labels[name] = { value: choice, confidence: clamp01(confidence) };
    } else {
      const noul = num(a?.noul);
      if (noul === undefined) {
        missing.push(name);
        continue;
      }
      const p = clamp01(noul);
      labels[name] = { value: p >= 0.5, confidence: Math.max(p, 1 - p) };
    }
  }
  return { labels, missing };
}
