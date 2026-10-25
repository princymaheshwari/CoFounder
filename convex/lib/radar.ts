// Company Radar (spec 13), LinkedIn trends: Apify's harvestapi/linkedin-post-search Actor.
// Verified 2026-10-25 on apify.com/harvestapi/linkedin-post-search (input schema + README example output):
//   input  {searchQueries: string[], maxPosts: number, postedLimit: "week", sortBy: "relevance" | "date"}
//   output item {type: "post", linkedinUrl, content, author: {name, info}, postedAt: {date}, engagement: {likes, comments, shares}}

export const LINKEDIN_ACTOR = "harvestapi~linkedin-post-search";
export const LINKEDIN_SOURCE = "linkedin-weekly";
export const SCAN_REUSE_MS = 6 * 24 * 60 * 60 * 1000; // a scan this recent is this week's scan
const MAX_CHANGE = 500;

export function linkedinInput(queries: string[]) {
  return { searchQueries: queries.slice(0, 3), maxPosts: 8, postedLimit: "week", sortBy: "relevance" };
}

// What we search for: the company's product category, plus the generic category name.
export function linkedinQueries(product: string): string[] {
  const p = product.trim();
  return [...new Set([p, "AI meeting notes", "AI note taker"].filter(Boolean))];
}

export type RadarSignal = { url: string; change: string; significance: number; evidence_url: string };

const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
const obj = (x: unknown): Record<string, unknown> => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});

// One dataset item → one signal: who posted, what they said (trimmed), and its engagement. Null when unusable.
export function normalizeLinkedInPost(item: unknown): RadarSignal | null {
  const it = obj(item);
  const url = typeof it.linkedinUrl === "string" ? it.linkedinUrl : null;
  const content = typeof it.content === "string" ? it.content.replace(/\s+/g, " ").trim() : "";
  if (!url || !content || (it.type !== undefined && it.type !== "post")) return null;
  const author = obj(it.author);
  const e = obj(it.engagement);
  const likes = num(e.likes);
  const comments = num(e.comments);
  const shares = num(e.shares);
  const who = typeof author.name === "string" && author.name ? author.name : "Someone";
  const tail = ` (${likes} likes, ${comments} comments, ${shares} reposts)`;
  const body = `${who} on LinkedIn: ${content}`;
  const change = body.length + tail.length > MAX_CHANGE ? `${body.slice(0, MAX_CHANGE - tail.length - 1)}…${tail}` : `${body}${tail}`;
  // Engagement as significance: 0.2 for a quiet post up to 0.9 for a widely shared one.
  const significance = Math.min(0.9, 0.2 + Math.log10(1 + likes + 3 * comments + 5 * shares) / 5);
  return { url, change, significance: Math.round(significance * 100) / 100, evidence_url: url };
}
