import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { plural } from "../lib/format";
import { ChannelHeader, PURPOSE } from "./ChannelView";
import { RequestCard } from "./RequestCard";
import { useFresh, type Overview, type Request } from "./ui";

// #founder-desk: the founder's only channel. Agents never message the founder anywhere else; every request
// lands here as a card and is answered here. Open requests come first, then what was already decided.

type Card = { request: Request; at: number; thread: Id<"tasks"> | null; key: string };

export function Desk({ roomId, overview, onOpen }: { roomId: Id<"rooms">; overview: Overview; onOpen: (t: Id<"tasks">) => void }) {
  const data = useQuery(api.feed.channel, { roomId });
  const cards: Card[] = [];
  for (const e of data?.entries ?? []) {
    const request = e.thread?.request ?? e.message.request;
    if (request) cards.push({ request, at: e.thread?.lastAt ?? e.message.at, thread: request.origin ?? e.thread?.root ?? null, key: e.message._id });
  }
  const open = cards.filter((c) => c.request.status === "open").sort((a, b) => a.at - b.at);
  const done = cards.filter((c) => c.request.status !== "open").sort((a, b) => (b.request.decision?.at ?? 0) - (a.request.decision?.at ?? 0));
  const fresh = useFresh(cards.map((c) => c.key));
  const cofounder = overview.agents.filter((a) => a.role === "cofounder");
  const t = overview.tally;

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <ChannelHeader name="Founder desk" room="#founder-desk" purpose={PURPOSE["#founder-desk"]} members={cofounder} />
      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-8 py-6">
        {data === undefined ? <p className="text-muted">Loading…</p> : null}
        {data && !open.length ? (
          <div className="max-w-[60ch] rounded-[14px] border border-dashed border-ink/20 bg-white/40 px-6 py-8">
            <p className="text-[24px] font-medium leading-snug tracking-[-0.025em] text-ink">Nothing needs you right now.</p>
            <p className="mt-2 text-[15px] text-muted">
              {t.byRules + t.byFounder > 0
                ? `Rules have made ${plural(t.byRules, "decision")} without you; you've made ${t.byFounder}. When something is new, risky or over budget, it shows up here.`
                : "When an agent proposes something new, risky or over budget, it shows up here for you to approve or decline."}
            </p>
          </div>
        ) : null}
        {open.length ? (
          <>
            <h2 className="text-[15px] font-semibold text-ink">{plural(open.length, "request")} waiting for you</h2>
            <ol className="mt-3 max-w-[820px] space-y-4">
              {open.map((c) => (
                <li key={c.key} className={fresh.has(c.key) ? "arrive rounded-lg" : ""}>
                  <RequestCard request={c.request} at={c.at} onOpenThread={c.thread ? () => onOpen(c.thread!) : undefined} />
                </li>
              ))}
            </ol>
          </>
        ) : null}
        {done.length ? (
          <>
            <h2 className="mt-10 text-[15px] font-semibold text-ink">Decided by you</h2>
            <ol className="mt-3 max-w-[820px] space-y-3 opacity-90">
              {done.map((c) => (
                <li key={c.key}>
                  <RequestCard request={c.request} at={c.at} onOpenThread={c.thread ? () => onOpen(c.thread!) : undefined} />
                </li>
              ))}
            </ol>
          </>
        ) : null}
      </div>
    </section>
  );
}
