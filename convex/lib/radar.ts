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

// Used only when Apify cannot run (no token, timeout, Actor down) and there is no scan from this week, so the flow
// still has something to read. Labelled as samples in the signal itself and in the Dispatcher's note.
export const SAMPLE_SOURCE = "linkedin-sample";
export const SAMPLE_POSTS: RadarSignal[] = [
  "Head of Product, 40-person SaaS: our biggest meeting cost isn't the meeting, it's the follow-up nobody sends. The note tools we kept are the ones that turn action items into tasks on people's calendars. (310 likes, 42 comments, 18 reposts)",
  "Engineering manager: I stopped reading AI transcripts. What I want is a decision log: what we decided, who owns it, and a link to the moment it was said. (1,204 likes, 96 comments, 51 reposts)",
  "Founder, B2B startup: the bar for AI notes moved this year. If the recap isn't in my inbox before I'm back at my desk, I've already forgotten half of it. (540 likes, 37 comments, 22 reposts)",
  "Ops lead, remote team: we replaced two weekly status meetings with AI summaries of the meetings we already have. Saved 3 hours a week per manager. (880 likes, 61 comments, 40 reposts)",
  "Security lead: before rolling out a meeting assistant we ask two questions. Does it announce itself to every attendee, and can we keep recordings in our region? (260 likes, 29 comments, 12 reposts)",
].map((text, i) => {
  const url = `https://example.com/linkedin-sample/${i + 1}`;
  return { url, change: `Sample post · ${text}`, significance: 0.6, evidence_url: url };
});
