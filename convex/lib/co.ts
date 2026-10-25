import type { Role } from "./types";

// `co` CLI (spec 06): views, role access, limits, email masking and duplicate-charge detection.

export const CO_VIEWS = [
  "ticket",
  "tickets",
  "customer",
  "ledger",
  "duplicates",
  "signals",
  "budget",
  "usage",
  "thread",
  "rules",
  "company",
] as const;
export type CoView = (typeof CO_VIEWS)[number];

export function isCoView(s: string): s is CoView {
  return (CO_VIEWS as readonly string[]).includes(s);
}

const MANAGERS: readonly Role[] = ["marketing_manager", "customer_manager", "finance_manager"];

export const VIEW_ACCESS: Record<CoView, readonly Role[] | "all"> = {
  ticket: ["support", "customer_manager"],
  tickets: ["support", "customer_manager", "retention"],
  customer: ["support", "retention", "ledger", "customer_manager"],
  ledger: ["ledger", "spend", "finance_manager", "cofounder"],
  duplicates: ["ledger", "finance_manager"],
  signals: ["market_intel", "spend", "retention", "cofounder", ...MANAGERS],
  budget: [...MANAGERS, "cofounder", "spend"],
  usage: ["spend", "finance_manager"],
  thread: [...MANAGERS, "cofounder"],
  rules: "all",
  company: "all",
};

export function canRead(role: Role, view: CoView): boolean {
  const allowed = VIEW_ACCESS[view];
  return allowed === "all" || allowed.includes(role);
}

export const VIEWS_WITH_ID: readonly CoView[] = ["ticket", "customer", "thread"];

// Default and maximum rows per list view; `--limit` is clamped into [1, max].
export const VIEW_LIMITS: Partial<Record<CoView, { def: number; max: number }>> = {
  tickets: { def: 50, max: 50 },
  ledger: { def: 200, max: 200 },
  signals: { def: 25, max: 50 },
  thread: { def: 50, max: 50 },
};
export const HISTORY_LIMIT = { def: 10, max: 50 };
export const CUSTOMER_LEDGER_ROWS = 10;
export const CO_CALLS_PER_TASK = 60;

export function clampLimit(raw: number | undefined, bounds: { def: number; max: number }): number {
  if (raw === undefined || !Number.isFinite(raw)) return bounds.def;
  return Math.min(bounds.max, Math.max(1, Math.floor(raw)));
}

// "jane.doe@example.com" → "j***@example.com".
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return email;
  return `${email[0]}***${email.slice(at)}`;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Masks every email in every string of a JSON value, except the addresses in `keep`
// (the subject of a by-id view, which the agent needs to reply to).
export function maskEmails<T>(value: T, keep: readonly string[] = []): T {
  const kept = new Set(keep.map((e) => e.toLowerCase()));
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") return x.replace(EMAIL_RE, (m) => (kept.has(m.toLowerCase()) ? m : maskEmail(m)));
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      return Object.fromEntries(Object.entries(x).map(([k, val]) => [k, walk(val)]));
    }
    return x;
  };
  return walk(value) as T;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
export const DUPLICATE_WINDOW_MS = DAY_MS;

export type Charge = { nessie_id: string; account_id: string; amount_cents: number; date: string };
export type DuplicateGroup = {
  account_id: string;
  amount_cents: number;
  charges: { nessie_id: string; date: string }[];
  extra_cents: number; // refundable: every charge after the first
};

// Same account, same amount, each charge ≤ 24 h after the previous one in the group.
export function findDuplicateCharges(charges: readonly Charge[]): DuplicateGroup[] {
  const byKey = new Map<string, Charge[]>();
  for (const c of charges) {
    const key = `${c.account_id}|${c.amount_cents}`;
    const list = byKey.get(key);
    if (list) list.push(c);
    else byKey.set(key, [c]);
  }
  const groups: DuplicateGroup[] = [];
  for (const list of byKey.values()) {
    const sorted = list
      .map((c) => ({ c, t: Date.parse(c.date) }))
      .filter((x) => Number.isFinite(x.t))
      .sort((a, b) => a.t - b.t || a.c.nessie_id.localeCompare(b.c.nessie_id));
    let run: typeof sorted = [];
    const flush = () => {
      if (run.length >= 2) {
        const first = run[0].c;
        groups.push({
          account_id: first.account_id,
          amount_cents: first.amount_cents,
          charges: run.map(({ c }) => ({ nessie_id: c.nessie_id, date: c.date })),
          extra_cents: first.amount_cents * (run.length - 1),
        });
      }
    };
    for (const x of sorted) {
      if (run.length && x.t - run[run.length - 1].t > DUPLICATE_WINDOW_MS) {
        flush();
        run = [];
      }
      run.push(x);
    }
    flush();
  }
  return groups.sort((a, b) => a.charges[0].date.localeCompare(b.charges[0].date) || a.account_id.localeCompare(b.account_id));
}
