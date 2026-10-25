import { useQuery } from "convex/react";
import { useEffect, useRef } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { ago, clock, plural } from "../lib/format";
import { AssignBody, Digest, PostedBadge, RadarLine } from "./Messages";
import { RequestCard } from "./RequestCard";
import { Avatar, DeptChip, Pill, ROOM_DEPT, useFresh, useNow, type Entry, type Overview } from "./ui";

// A department channel: one entry per task thread. Opening a thread shows the whole conversation beside it.
// #founder-desk uses the same data but leads with the founder's requests (see Desk).

export const PURPOSE: Record<string, string> = {
  "#customer": "Tickets, refunds and churn. Support and Retention work here; the Customer Manager steps in when they're stuck.",
  "#finance": "The ledger, bills and vendors. Ledger and Spend work here, with the Finance Manager.",
  "#marketing": "Competitor moves and posts. Market Intel and Content work here, with the Marketing Manager.",
  "#leadership": "Managers and the Cofounder. Cross-department handoffs are announced here.",
  "#founder-desk": "The only place agents can reach you. Everything here is waiting on, or was decided by, you.",
};

const STATUS: Record<string, { tone: "you" | "rule" | "quiet" | "ink"; text: string }> = {
  queued: { tone: "quiet", text: "Working" },
  assigned: { tone: "quiet", text: "Working" },
  repairing: { tone: "quiet", text: "Fixing its reply" },
  replied: { tone: "quiet", text: "Replied" },
  gated: { tone: "quiet", text: "Done" },
  escalated: { tone: "quiet", text: "Escalated" },
  done: { tone: "quiet", text: "Done" },
  failed: { tone: "quiet", text: "Failed" },
};

export function ChannelHeader({ name, purpose, members, room }: { name: string; purpose: string; members: Overview["agents"]; room?: string }) {
  const dept = ROOM_DEPT[room ?? name];
  return (
    <header className="border-b border-white/60 bg-white/30 px-8 pb-4 pt-6">
      <div>
        <div className="min-w-0">
          {dept ? <DeptChip dept={dept}>{dept === "leadership" && name === "Founder desk" ? "Founder" : dept}</DeptChip> : null}
          <h1 className="mt-2 text-[30px] font-medium leading-tight tracking-[-0.035em]">{name}</h1>
          <p className="mt-1 max-w-[80ch] text-[14px] text-muted">{purpose}</p>
        </div>
        {members.length ? (
          <ul className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
            {members.map((a) => (
              <li key={a.role} className="flex items-center gap-2" title={a.doing ? `${a.name}: ${a.doing}` : `${a.name}: ${a.state}`}>
                <span className="relative">
                  <Avatar name={a.name} kind="agent" size={28} />
                  <span
                    className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white ${a.state === "working" ? "working bg-rule" : a.state === "escalated" ? "bg-you" : "bg-line-2"}`}
                  />
                </span>
                <span className="text-[13px] leading-tight">
                  <span className="font-semibold text-ink">{a.name}</span>{" "}
                  <span className={a.state === "working" ? "text-rule" : "text-faint"}>{a.state === "working" ? "is working" : a.state === "escalated" ? "escalated" : "idle"}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </header>
  );
}

function ThreadEntry({ entry, onOpen, selected, fresh, now }: { entry: Entry; onOpen: (t: Id<"tasks">) => void; selected: boolean; fresh: boolean; now: number }) {
  const t = entry.thread!;
  const m = entry.message;
  const status = t.waiting ? { tone: "you" as const, text: "Waiting for you" } : (STATUS[t.status] ?? { tone: "quiet" as const, text: t.status });
  return (
    <li>
      <button
        onClick={() => onOpen(t.root)}
        className={`group flex w-full gap-3 rounded-[14px] px-4 py-3 text-left transition-colors ${selected ? "bg-white/75 ring-1 ring-white" : "hover:bg-white/55"} ${fresh ? "arrive" : ""}`}
      >
        <Avatar name={m.sender} kind={m.senderKind} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-semibold text-ink">{m.sender}</span>
            {m.kind === "assign" || m.kind === "handoff" ? <span className="text-[13px] text-muted">{m.kind === "handoff" ? "handed off" : "assigned"}</span> : null}
            <span className="text-[12px] text-faint">{clock(m.at)}</span>
          </span>
          <span className="mt-0.5 block">
            <AssignBody m={m} />
          </span>
          <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
            <span className="flex -space-x-1.5">
              {t.people.slice(0, 4).map((p) => (
                <span key={p} className="rounded-[8px] ring-2 ring-white">
                  <Avatar name={p} kind="agent" size={20} />
                </span>
              ))}
            </span>
            <span className="font-semibold text-ink-2 group-hover:underline">{t.replies ? plural(t.replies, "reply", "replies") : "No replies yet"}</span>
            {t.lastKind === "posted" ? <PostedBadge channel={t.lastTo} small /> : <Pill tone={status.tone}>{status.text}</Pill>}
            <span className="min-w-0 max-w-[52ch] truncate text-muted">
              {t.last} <span className="text-faint">· {ago(t.lastAt, now)}</span>
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}

function StandaloneEntry({ entry, fresh }: { entry: Entry; fresh: boolean }) {
  const m = entry.message;
  if (m.kind === "digest") return <li className={`rounded-lg px-4 ${fresh ? "arrive" : ""}`}><Digest m={m} /></li>;
  if (m.request) return <li className={`py-2 ${fresh ? "arrive" : ""}`}><RequestCard request={m.request} at={m.at} /></li>;
  if (m.kind === "radar") return <li className={`rounded-[14px] px-4 ${fresh ? "arrive" : ""}`}><RadarLine m={m} /></li>;
  return (
    <li className={`flex gap-3 rounded-[14px] px-4 py-2.5 ${fresh ? "arrive" : ""}`}>
      <Avatar name="Dispatcher" kind="system" size={24} />
      <p className="text-[14px] text-muted">
        {m.headline} <span className="text-[12px] text-faint">{clock(m.at)}</span>
      </p>
    </li>
  );
}

export function EntryList({ entries, onOpen, selected, empty }: { entries: Entry[]; onOpen: (t: Id<"tasks">) => void; selected: Id<"tasks"> | null; empty: string }) {
  const now = useNow();
  const fresh = useFresh(entries.map((e) => e.message._id));
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [entries.length]);
  if (!entries.length) return <p className="mx-8 mt-10 max-w-[52ch] text-[15px] text-muted">{empty}</p>;
  return (
    <ol className="space-y-1 px-4 py-4">
      {entries.map((e) =>
        e.kind === "thread" ? (
          <ThreadEntry key={e.message._id} entry={e} onOpen={onOpen} selected={selected === e.thread!.root} fresh={fresh.has(e.message._id)} now={now} />
        ) : (
          <StandaloneEntry key={e.message._id} entry={e} fresh={fresh.has(e.message._id)} />
        ),
      )}
      <div ref={end} />
    </ol>
  );
}

export function ChannelView({ roomId, overview, onOpen, selected }: { roomId: Id<"rooms">; overview: Overview; onOpen: (t: Id<"tasks">) => void; selected: Id<"tasks"> | null }) {
  const data = useQuery(api.feed.channel, { roomId });
  const meta = overview.channels.find((c) => c._id === roomId);
  const members = overview.agents.filter((a) => meta?.members.includes(a.name));
  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <ChannelHeader name={meta?.name ?? "Channel"} purpose={PURPOSE[meta?.name ?? ""] ?? ""} members={members} />
      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
        {data === undefined ? (
          <p className="px-8 py-6 text-muted">Loading…</p>
        ) : (
          <EntryList entries={data.entries} onOpen={onOpen} selected={selected} empty="Nothing has happened here yet. Start the demo story, or wait for the next event routed to this channel." />
        )}
      </div>
    </section>
  );
}
