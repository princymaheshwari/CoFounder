// Display helpers. Times are shown in America/Los_Angeles (CLAUDE.md).

const TZ = "America/Los_Angeles";

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
}

export function day(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric" });
}

export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return clock(ms);
}

const ACTION_LABEL: Record<string, string> = {
  publish_post: "Posts",
  refund: "Refunds",
  refund_batch: "Batch refunds",
  reply_customer: "Customer replies",
  file_bug: "Bug reports",
  schedule_digest: "Digests",
  pay_bill: "Bill payments",
  switch_vendor: "Vendor switches",
  price_change: "Price changes",
  marketing_spend: "Marketing spend",
};

const ROLE_LABEL: Record<string, string> = {
  content: "Content",
  support: "Support",
  ledger: "Ledger",
  spend: "Spend",
  retention: "Retention",
  market_intel: "Market Intel",
  customer_manager: "the Customer Manager",
  finance_manager: "the Finance Manager",
  marketing_manager: "the Marketing Manager",
  cofounder: "the Cofounder",
};

export const actionLabel = (type: string) => ACTION_LABEL[type] ?? type.replace(/_/g, " ");

// Rule conditions in plain words: "mentions competitor is false" → "it doesn't mention a competitor".
const CONDITION_WORDS: [RegExp, string][] = [
  [/mentions[ _]competitor is false/g, "it doesn't mention a competitor"],
  [/mentions[ _]competitor is true/g, "it mentions a competitor"],
  [/mentions[ _]pricing is false/g, "it doesn't mention pricing"],
  [/mentions[ _]pricing is true/g, "it mentions pricing"],
  [/makes[ _]commitment is false/g, "it promises nothing"],
  [/makes[ _]commitment is true/g, "it makes a promise"],
  [/grounded is true/g, "it's backed by evidence"],
  [/grounded is false/g, "it isn't backed by evidence"],
  [/channel is (\w+)/g, "it's for $1"],
  [/refund reason is/g, "the reason is"],
  [/customer tenure \(days\) is at least (\d+)/g, "the customer has been with us $1+ days"],
  [/billing_error/g, "a billing error"],
  [/changed_mind/g, "a change of mind"],
  [/\blinkedin\b/gi, "LinkedIn"],
];
export function humanCondition(text: string): string {
  return CONDITION_WORDS.reduce((s, [re, to]) => s.replace(re, to), text);
}

// "publish_post by content is allowed when …" → "Posts by Content are allowed when …"
export function humanRule(actionType: string, text: string): string {
  const body = text.replace(/^R\d+:\s*/, "").replace(/\.$/, "");
  // Hand-written rules (R7) are already prose: only capitalise them.
  if (!body.startsWith(`${actionType} `)) return `${body.charAt(0).toUpperCase()}${body.slice(1)}.`;
  const rest = body.slice(actionType.length);
  return (
    actionLabel(actionType) +
    rest
      .replace(/^ by (\w+)/, (_m, r: string) => ` by ${ROLE_LABEL[r] ?? r}`)
      .replace(/ is (allowed|denied|sent to the founder)/, " are $1")
      .replace(/ when (.*)$/, (_m, c: string) => ` when ${humanCondition(c.replace(/mentions_(\w+)/g, "mentions $1"))}`) +
    "."
  );
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The action type a stored rule sentence is about: "R7: refund company-wide …" → "refund".
export const typeOfRule = (text: string) => /^(?:R\d+:\s*)?(\w+)/.exec(text)?.[1] ?? "";
export const ruleLabelOf = (text: string) => /^(R\d+)/.exec(text)?.[1] ?? "Rule";
