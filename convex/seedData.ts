// Deterministic Nessie seed data for the Lumen Notes demo company (spec 08). Pure: no I/O, fixed
// random seed, fixed anchor date, so every run plans the same objects with the same keys.

export const SEED_ANCHOR = "2026-10-24"; // the demo's "today"
export const INCIDENT_DATE = "2026-10-22"; // flow A: 12 customers charged twice
export const HISTORY_DAYS = 84; // 12 weeks
export const PLAN_CENTS = 3500; // Pro, $35/month
const RANDOM_SEED = 20261022;

export const OPERATING = { first_name: "Lumen Notes", last_name: "Inc", nickname: "Lumen Notes Operating", balance: 25_000 };
export const CUSTOMER_ACCOUNT = { nickname: "Personal Checking", balance: 500 };
export const ADDRESS = { street_number: "100", street_name: "Market St", city: "San Francisco", state: "CA", zip: "94105" };
export const MERCHANTS = [
  { name: "ModelAPI Co", category: "software" },
  { name: "CloudHost", category: "cloud" },
  { name: "MailTool", category: "software" },
] as const;
export const BILL_PAYEE = "Ledgerly Accounting";

export type SeedCustomer = {
  key: string; // c01…c20
  first_name: string;
  last_name: string;
  name: string;
  email: string; // fake
  signup_date: string; // YYYY-MM-DD
  signup_at: number;
  incident: boolean;
  plan: "Pro";
};

// `from` / `to` are customer keys or "operating"; the seed resolves them to Nessie account ids.
export type SeedItem =
  | { key: string; kind: "transfer"; from: string; to: string; amount_cents: number; date: string; description: string }
  | { key: string; kind: "purchase"; merchant: string; amount_cents: number; date: string; description: string }
  | { key: string; kind: "bill"; payee: string; amount_cents: number; date: string; status: "pending" | "completed"; nickname: string };

export type SeedTicket = { customer: string; subject: string; body: string; amount_cents: number; created_at: number };

export type SeedPlan = { customers: SeedCustomer[]; items: SeedItem[]; tickets: SeedTicket[] };

const NAMES: [string, string][] = [
  ["Maya", "Patel"], ["Jonah", "Reyes"], ["Priya", "Nair"], ["Lucas", "Ortega"], ["Hana", "Kim"],
  ["Omar", "Haddad"], ["Elena", "Rossi"], ["Ben", "Carter"], ["Aisha", "Bello"], ["Tom", "Novak"],
  ["Sofia", "Lind"], ["Ravi", "Menon"], ["Grace", "Liu"], ["Diego", "Alvarez"], ["Nina", "Petrova"],
  ["Sam", "Okafor"], ["Leah", "Brooks"], ["Kenji", "Sato"], ["Zara", "Ahmed"], ["Paul", "Meyer"],
];
// Incident customers signed up on the 22nd, this many months before the incident (32 to 397 days ago).
const INCIDENT_MONTHS_BACK = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13];
// Everyone else: days before the anchor (5 to 400), nudged off the 21st–23rd and month ends.
const OTHER_TENURE_DAYS = [5, 19, 47, 88, 136, 214, 290, 371];

const TICKETS: { subject: string; body: string }[] = [
  { subject: "Charged twice this month", body: "Hi, I was charged $35 twice on Oct 22 for my Pro plan. Please refund the extra charge." },
  { subject: "Double charge on my card", body: "My card shows two $35 charges from Lumen Notes a few minutes apart on Oct 22. Can you refund one?" },
  { subject: "Duplicate payment", body: "Looks like my subscription renewed twice today. I only have one account. Please fix this." },
  { subject: "Why two charges?", body: "I got two receipts for $35 on October 22. Is this a mistake? I'd like the duplicate refunded." },
  { subject: "Billed twice for Pro", body: "Hello, my bank statement has two identical $35 payments to you on Oct 22. Please refund the second one." },
  { subject: "Refund duplicate charge", body: "You charged me twice for the same month. Please refund the duplicate $35 as soon as you can." },
];

// mulberry32: tiny deterministic PRNG.
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (date: string) => Date.parse(`${date}T00:00:00Z`);
const pad = (n: number) => String(n).padStart(2, "0");

function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + months, d)); // d ≤ 28 by construction, so no overflow
  return ymd(t.getTime());
}

export function buildSeedPlan(): SeedPlan {
  const rand = prng(RANDOM_SEED);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const anchor = dayMs(SEED_ANCHOR);
  const windowStart = ymd(anchor - HISTORY_DAYS * DAY_MS);

  // Deterministic shuffle decides which customers are in the incident.
  const slots = NAMES.map((_, i) => i);
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  const incidentSlots = new Set(slots.slice(0, INCIDENT_MONTHS_BACK.length));

  let nextIncident = 0;
  let nextOther = 0;
  const customers: SeedCustomer[] = NAMES.map(([first, last], i) => {
    const incident = incidentSlots.has(i);
    let signup: string;
    if (incident) {
      signup = addMonths(INCIDENT_DATE, -INCIDENT_MONTHS_BACK[nextIncident++]);
    } else {
      let days = OTHER_TENURE_DAYS[nextOther++];
      signup = ymd(anchor - days * DAY_MS);
      while ([21, 22, 23].includes(Number(signup.slice(8))) || Number(signup.slice(8)) > 28) {
        days += 1;
        signup = ymd(anchor - days * DAY_MS);
      }
    }
    return {
      key: `c${pad(i + 1)}`,
      first_name: first,
      last_name: last,
      name: `${first} ${last}`,
      email: `${first}.${last}@example.com`.toLowerCase(),
      signup_date: signup,
      signup_at: Date.parse(`${signup}T17:00:00Z`),
      incident,
      plan: "Pro",
    };
  });

  const items: SeedItem[] = [];

  // Monthly $35 subscription transfers (customer → operating) on each signup anniversary in the window.
  customers.forEach((c, i) => {
    const time = `T${pad(15 + (i % 5))}:${pad((i * 7) % 60)}:00.000Z`;
    for (let n = 0; ; n++) {
      const date = addMonths(c.signup_date, n);
      if (date > SEED_ANCHOR) break;
      if (date < windowStart) continue;
      const description = `Lumen Notes Pro subscription ${date}`;
      items.push({ key: `sub-${c.key}-${date}`, kind: "transfer", from: c.key, to: "operating", amount_cents: PLAN_CENTS, date: `${date}${time}`, description });
      if (c.incident && date === INCIDENT_DATE) {
        // The planted duplicate: same amount, same description, 2–9 minutes later.
        const at = new Date(Date.parse(`${date}${time}`) + int(2, 9) * 60_000).toISOString();
        items.push({ key: `dup-${c.key}-${date}`, kind: "transfer", from: c.key, to: "operating", amount_cents: PLAN_CENTS, date: at, description });
      }
    }
  });

  // Weekly vendor purchases from the operating account, on Mondays.
  for (let w = HISTORY_DAYS / 7 - 1; w >= 0; w--) {
    const date = ymd(anchor - (5 + 7 * w) * DAY_MS);
    const growth = (HISTORY_DAYS / 7 - 1 - w) * 5;
    const amounts: Record<string, number> = {
      "ModelAPI Co": 170 + growth + int(0, 20),
      CloudHost: 90 + int(0, 25),
      MailTool: 29,
    };
    for (const m of MERCHANTS) {
      const slug = m.name.toLowerCase().replace(/[^a-z]/g, "");
      items.push({
        key: `pur-${slug}-${date}`,
        kind: "purchase",
        merchant: m.name,
        amount_cents: amounts[m.name] * 100,
        date: `${date}T16:00:00.000Z`,
        description: `${m.name} weekly usage ${date}`,
      });
    }
  }

  // Monthly accounting bill: three paid, next one pending (the one `pay_bill` can pay).
  for (const [date, status] of [
    ["2026-08-01", "completed"],
    ["2026-09-01", "completed"],
    ["2026-10-01", "completed"],
    ["2026-11-01", "pending"],
  ] as const) {
    items.push({ key: `bill-ledgerly-${date}`, kind: "bill", payee: BILL_PAYEE, amount_cents: 40_000, date, status, nickname: `${BILL_PAYEE} ${date.slice(0, 7)}` });
  }

  // Six of the twelve double-charged customers write in.
  const tickets: SeedTicket[] = customers
    .filter((c) => c.incident)
    .slice(0, TICKETS.length)
    .map((c, i) => ({
      customer: c.key,
      ...TICKETS[i],
      amount_cents: PLAN_CENTS,
      created_at: Date.parse(`${INCIDENT_DATE}T19:00:00Z`) + i * 3 * 60 * 60 * 1000,
    }));

  return { customers, items, tickets };
}
