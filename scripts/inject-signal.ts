// Posts a fake but realistic change-monitor result to /apify-callback (spec 13), for rehearsal and demo safety.
// The items have the exact shape of monema/apify-change-monitor's dataset items, so they take the same path as a
// real Apify run: normalize → score → dedupe → signal → (≥ 0.6) event → task in the monitor's channel.
//
//   npm run inject-signal                     vendor price rise → Spend task in #finance
//   npm run inject-signal -- competitor-price competitor price cut → Market intel task in #marketing
//   npm run inject-signal -- review           1-star review about a billing bug → Retention task in #customer
//   npm run inject-signal -- careers          competitor careers entry (0.5) → signal kept for standups, no task
//   npm run inject-signal -- vendor-price --run demo-1   reuse a run id (sending it twice shows dedupe)
//
// Site URL: CONVEX_SITE_URL, else VITE_CONVEX_SITE_URL in .env.local.
// Token: APIFY_WEBHOOK_TOKEN, else .env.local.secrets, else `npx convex env get APIFY_WEBHOOK_TOKEN`. Never printed.

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

type Scenario = { task: string; url: string; before: string; after: string };

const SCENARIOS: Record<string, Scenario> = {
  "vendor-price": {
    task: "vendor-pricing",
    url: "https://modelapi.example.com/pricing",
    before: "Scale plan: $0.40 per 1,000 transcription minutes, billed monthly. Volume discounts above 500k minutes.",
    after: "Scale plan: $0.55 per 1,000 transcription minutes, billed monthly. Volume discounts above 500k minutes.",
  },
  "competitor-price": {
    task: "competitor-pricing",
    url: "https://rival-notes.example.com/pricing",
    before: "Pro $30 per user per month. Unlimited recordings, AI summaries, calendar sync.",
    after: "Pro $18 per user per month. Unlimited recordings, AI summaries, calendar sync.",
  },
  review: {
    task: "reviews",
    url: "https://reviews.example.com/apps/ai-meeting-notes",
    before: "Latest reviews: 5/5 stars. The summaries save me an hour a week.",
    after: "Latest reviews: 1/5 stars. Charged twice this month and support hasn't answered, cancelling. 5/5 stars. The summaries save me an hour a week.",
  },
  careers: {
    task: "competitor-careers",
    url: "https://rival-notes.example.com/careers",
    before: "Open roles: Account Executive (Remote).",
    after: "Open roles: Head of Enterprise Sales (NYC). Account Executive (Remote).",
  },
};

function fromFile(path: string, name: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const line = readFileSync(path, "utf8").split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
  return line?.slice(name.length + 1).trim() || undefined;
}

function token(): string {
  const t =
    process.env.APIFY_WEBHOOK_TOKEN ||
    fromFile(".env.local.secrets", "APIFY_WEBHOOK_TOKEN") ||
    execSync("npx convex env get APIFY_WEBHOOK_TOKEN", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (!t) throw new Error("APIFY_WEBHOOK_TOKEN is not set (npx convex env set APIFY_WEBHOOK_TOKEN <random>)");
  return t;
}

async function main() {
  const args = process.argv.slice(2);
  const name = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--run") ?? "vendor-price";
  const s = SCENARIOS[name];
  if (!s) throw new Error(`unknown scenario "${name}" (one of: ${Object.keys(SCENARIOS).join(", ")})`);
  const runFlag = args.indexOf("--run");
  const runId = runFlag >= 0 && args[runFlag + 1] ? args[runFlag + 1] : `inject-${Date.now()}`;
  const site = (process.env.CONVEX_SITE_URL || fromFile(".env.local", "VITE_CONVEX_SITE_URL") || "").replace(/\/$/, "");
  if (!site) throw new Error("set CONVEX_SITE_URL (https://<deployment>.convex.site)");

  const now = new Date().toISOString();
  const item = {
    url: s.url,
    final_url: s.url,
    selector: "main",
    status: "changed",
    raw_changed: true,
    significant_change: true,
    change_ratio: 0.07,
    message: "Content changed",
    fetched_at: now,
    previous_hash: `prev-${runId}`,
    current_hash: `cur-${runId}`, // one signal per run id; a repeated --run is deduplicated
    previous_excerpt: s.before,
    current_excerpt: s.after,
    webhook_sent: false,
  };
  const res = await fetch(`${site}/apify-callback?token=${encodeURIComponent(token())}&task=${s.task}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId, items: [item] }),
    signal: AbortSignal.timeout(15_000),
  });
  console.log(`${name} → ${s.task} (run ${runId}): ${res.status} ${res.status === 200 ? "accepted" : await res.text()}`);
  if (res.status !== 200) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
