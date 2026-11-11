import { z } from "zod";
import { MONITOR_TASKS, hashText, type MonitorTask } from "./apify";

// Autonomous Apify monitors (spec 13). Pure: which pages the company should watch, and the Actor run that checks
// one of them. Convex owns the watch list and the schedule (cron), like Creao standups: nothing is created in the
// Apify account, so there is nothing there to drift or clean up.
//
// Verified 2026-11-10 (docs.apify.com/api/v2/actors-runs-post): POST /v2/acts/{username~actor}/runs, body = Actor
// input, query `webhooks` = base64 of a JSON array of ad-hoc webhooks {eventTypes, requestUrl, payloadTemplate?},
// 201 → {data: {id, status, defaultDatasetId}}. The default webhook payload carries `resource` = the run object
// (id, defaultDatasetId), which parseCallback (lib/apify.ts) already reads.

export const MONITOR_ACTOR = "monema~apify-change-monitor";
export const MAX_MONITORS = 20; // bounds Apify spend
export const DEFAULT_INTERVAL_MINUTES = 60;
export const MIN_INTERVAL_MINUTES = 15;
export const RUNS_PER_TICK = 10;
export const DISCOVERY_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

export type Watch = { watch: MonitorTask; url: string; label: string };

type Profile = {
  competitors: { name: string; pricing_url?: string; changelog_url?: string; careers_url?: string }[];
  vendors: { name: string; pricing_url?: string }[];
  review_urls: string[];
};

// A public http(s) URL without its fragment, or null.
export function cleanUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (/^(localhost|127\.|10\.|192\.168\.|0\.0\.0\.0)/.test(u.hostname) || !u.hostname.includes(".")) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

// Everything in the company profile worth watching, one entry per (watch list, url), capped.
export function desiredMonitors(p: Profile): Watch[] {
  const out: Watch[] = [];
  const seen = new Set<string>();
  const add = (watch: MonitorTask, raw: string | undefined, label: string) => {
    const url = cleanUrl(raw);
    if (!url || seen.has(`${watch} ${url}`) || out.length >= MAX_MONITORS) return;
    seen.add(`${watch} ${url}`);
    out.push({ watch, url, label });
  };
  for (const c of p.competitors) {
    add("competitor-pricing", c.pricing_url, `${c.name} pricing`);
    add("competitor-changelog", c.changelog_url, `${c.name} changelog`);
    add("competitor-careers", c.careers_url, `${c.name} careers`);
  }
  for (const v of p.vendors) add("vendor-pricing", v.pricing_url, `${v.name} pricing`);
  for (const r of p.review_urls) add("reviews", r, `Reviews: ${hostOf(r)}`);
  return out;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// Snapshots live in the Actor's named store under state_key: one key per deployment and page, so dev and prod
// (same Apify account) never overwrite each other's baseline.
export function stateKey(siteUrl: string, watch: string, url: string): string {
  const deployment = hostOf(siteUrl).split(".")[0] || "convex";
  return `cofounder-${deployment}-${watch}-${hashText(url)}`;
}

export function monitorInput(url: string, key: string) {
  // A low ratio: a price edit on a long pricing page is a tiny share of its text.
  return { url, state_key: key, min_change_ratio: 0.01, ignore_selectors: ".cookie-banner,.advertising,.ads" };
}

export function webhookUrl(siteUrl: string, token: string, watch: string): string {
  return `${siteUrl.replace(/\/$/, "")}/apify-callback?token=${encodeURIComponent(token)}&task=${encodeURIComponent(watch)}`;
}

// The `webhooks` query param: base64 of a JSON array. Default payload (no template).
export function webhooksParam(requestUrl: string): string {
  return btoa(JSON.stringify([{ eventTypes: ["ACTOR.RUN.SUCCEEDED"], requestUrl }]));
}

export function intervalMs(minutes: unknown): number {
  const m = typeof minutes === "number" && Number.isFinite(minutes) ? minutes : DEFAULT_INTERVAL_MINUTES;
  return Math.max(MIN_INTERVAL_MINUTES, m) * 60_000;
}

// ---------------------------------------------------------------- discovery (Claude proposes, a fetch confirms)

export const discoverySchema = z.object({
  pricing_url: z.string().nullable(),
  changelog_url: z.string().nullable(),
  careers_url: z.string().nullable(),
});
export type Discovered = z.infer<typeof discoverySchema>;

export const DISCOVERY_SYSTEM =
  "You find a company's official public web pages. Answer with full https URLs on the company's own domain only, never a review site, news article or search page. Use null when you are not confident the page exists. Never guess a domain.";

export function discoveryPrompt(kind: "competitor" | "vendor", name: string, context: string): string {
  return kind === "competitor"
    ? `Company: "${name}", a competitor in this market: ${context}.\nGive its official pricing page, its changelog / release notes page, and its careers page.`
    : `Company: "${name}", a vendor we pay for: ${context}.\nGive its official pricing page. Use null for changelog_url and careers_url.`;
}

// A proposed page counts only if it loads as HTML and names the company: guards against invented URLs.
export function pageConfirms(name: string, status: number, contentType: string | null, body: string): boolean {
  if (status < 200 || status >= 300 || !(contentType ?? "").includes("html")) return false;
  const words = name.toLowerCase().replace(/\.(ai|io|com|co)$/, "").split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const text = body.toLowerCase();
  return words.length > 0 && words.some((w) => text.includes(w));
}

export const isWatch = (s: string): s is MonitorTask => Object.prototype.hasOwnProperty.call(MONITOR_TASKS, s);
