// Apify change monitors (spec 13). Pure: webhook body parsing, item normalization, significance, dedupe hash.
//
// Monitor Actor: monema/apify-change-monitor. VERIFIED 2026-11-10 from its build's actorDefinition
// (GET https://api.apify.com/v2/acts/monema~apify-change-monitor/builds/default):
//   input  {url, selector?, ignore_selectors?, min_change_ratio? (default 0.05), webhook_url?, state_key?, user_agent?, timeout_seconds?}
//   output one dataset item per run: {url, selector, status: "initial_snapshot" | "unchanged" | "minor_change" | "changed",
//          raw_changed, significant_change, change_ratio, message, fetched_at, final_url,
//          current_hash, previous_hash, current_excerpt, previous_excerpt, webhook_sent, webhook_error}

// One Apify Task per watch list. Its name arrives as ?task=<name> on the webhook URL.
export const MONITOR_TASKS = {
  "competitor-pricing": { room: "#marketing", event: "signal.marketing", kind: "pricing" },
  community: { room: "#marketing", event: "signal.marketing", kind: "text" },
  reviews: { room: "#customer", event: "signal.reviews", kind: "reviews" },
  "vendor-pricing": { room: "#finance", event: "signal.vendor_price", kind: "pricing" },
  "competitor-careers": { room: "#leadership", event: "signal.leadership", kind: "entries" },
} as const;

export type MonitorTask = keyof typeof MONITOR_TASKS;
export const isMonitorTask = (s: string): s is MonitorTask => Object.prototype.hasOwnProperty.call(MONITOR_TASKS, s);

// Signals at or above this become events (and tasks); the rest wait for standups.
export const EVENT_THRESHOLD = 0.6;
const MAX_CHANGE = 500;

export type MonitorSignal = { url: string; change: string; significance: number; evidence_url: string; change_hash: string };

const obj = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
const str = (x: unknown): string => (typeof x === "string" ? x : "");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

// Webhook body: Apify's default payload ({eventType, resource: {id, defaultDatasetId}}) or our payload template
// ({runId, datasetId}). `items` (monitor-shaped) is accepted inline for scripts/inject-signal.ts.
export type CallbackBody = { runId: string; datasetId: string | null; items: unknown[] | null };

export function parseCallback(body: unknown): CallbackBody | null {
  const b = obj(body);
  const resource = obj(b.resource);
  const runId = str(b.runId) || str(resource.id);
  const datasetId = str(b.datasetId) || str(resource.defaultDatasetId) || null;
  const items = Array.isArray(b.items) ? b.items : null;
  if (!runId || (!datasetId && !items)) return null;
  return { runId, datasetId, items };
}

// "…before… → …after…": the part of the excerpt that changed, with a little context on each side.
export function diffSummary(before: string, after: string, max = MAX_CHANGE): string {
  const d = diffSegments(before, after);
  if (d.old === null) return clip(d.neu, max);
  const half = Math.floor((max - 3) / 2);
  return `${clip(d.old, half)} → ${clip(d.neu, half)}`;
}

// The differing middle of two excerpts plus 40 chars of context each side. old is null when there is no
// earlier excerpt or nothing differs.
export function diffSegments(before: string, after: string): { old: string | null; neu: string } {
  const a = squash(before);
  const b = squash(after);
  if (!a || a === b) return { old: null, neu: b };
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const ctx = 40;
  const lo = Math.max(0, start - ctx);
  return { old: a.slice(lo, Math.min(a.length, a.length - end + ctx)), neu: b.slice(lo, Math.min(b.length, b.length - end + ctx)) };
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const PRICE = /(\$\s?\d|\d\s?(?:usd|eur|€|£)|\/\s?(?:mo|month|yr|year|user|seat)\b|\bper (?:month|year|user|seat)\b|\bprice|\bpricing\b|\bplans?\b|\btier\b)/i;
const COMPLAINT = /\b(price|pricing|expensive|charged?|bug|broken|crash|cancel+(?:ed|ing|ation)?|refund)\b/i;
const ENTRY_URL = /(changelog|release|careers|jobs|hiring)/i;

// Star rating in review text ("2/5", "1 star", "★★☆☆☆"); null when none is written.
export function reviewStars(text: string): number | null {
  const filled = text.match(/★+/);
  if (filled && /[☆★]{5}/.test(text)) return filled[0].length;
  const m = text.match(/\b([1-5])(?:\.\d)?\s*(?:\/\s*5|out of 5|stars?)\b/i);
  return m ? Number(m[1]) : null;
}

// Spec 13 significance, rule-based and capped at 0.9.
export function significance(task: MonitorTask, url: string, changed: string): number {
  const { kind } = MONITOR_TASKS[task];
  if ((kind === "pricing" || /pricing|plans/i.test(url)) && PRICE.test(changed)) return 0.9;
  if (kind === "reviews") {
    const stars = reviewStars(changed);
    if (stars !== null && stars <= 2 && COMPLAINT.test(changed)) return 0.7;
  }
  if (kind === "entries" || ENTRY_URL.test(url)) return 0.5;
  return 0.2;
}

// FNV-1a, hex. Dedupe key for (url, change) when the Actor gives no snapshot hash.
export function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// One monitor dataset item → one signal, or null when nothing changed (first snapshot, unchanged, malformed).
export function normalizeMonitorItem(task: MonitorTask, item: unknown): MonitorSignal | null {
  const it = obj(item);
  const url = str(it.url) || str(it.final_url);
  const status = str(it.status);
  if (!url || (status !== "changed" && status !== "minor_change")) return null;
  const before = str(it.previous_excerpt);
  const after = str(it.current_excerpt);
  const body = after || before ? diffSummary(before, after) : squash(str(it.message));
  if (!body) return null;
  // Score the changed part only (old and new), so an unchanged price elsewhere on the page doesn't count.
  const d = diffSegments(before, after);
  const scored = after || before ? `${d.old ?? ""} ${d.neu}` : body;
  const change = clip(body, MAX_CHANGE);
  return {
    url,
    change,
    significance: significance(task, url, scored),
    evidence_url: str(it.final_url) || url,
    change_hash: str(it.current_hash) || hashText(change),
  };
}

// The task brief for a significant signal (the agent reads the rest with `co data signals`).
export function signalBrief(task: MonitorTask, s: Pick<MonitorSignal, "url" | "change" | "significance">): string {
  const lead: Record<MonitorTask, string> = {
    "competitor-pricing": "A competitor changed its pricing page.",
    community: "A community thread we watch changed.",
    reviews: "A new low-star public review mentions price, bugs or cancelling.",
    "vendor-pricing": "One of our vendors changed its pricing page. Work out the monthly impact from the ledger.",
    "competitor-careers": "A competitor posted a new careers or changelog entry.",
  };
  return `${lead[task]} Change on ${s.url} (significance ${s.significance}): ${s.change}`;
}

export function dataHints(task: MonitorTask): string[] {
  return task === "vendor-pricing" ? ["co data signals", "co data ledger", "co data usage"] : ["co data signals", "co data company"];
}
