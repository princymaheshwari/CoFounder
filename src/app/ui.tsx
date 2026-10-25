import type { FunctionReturnType } from "convex/server";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { api } from "../../convex/_generated/api";

export type Overview = FunctionReturnType<typeof api.feed.overview>;
export type ChannelData = FunctionReturnType<typeof api.feed.channel>;
export type Entry = ChannelData["entries"][number];
export type Message = Entry["message"];
export type Request = NonNullable<Message["request"]>;
export type ThreadData = FunctionReturnType<typeof api.feed.thread>;

// Who sits in which department, by display name and by role, for avatar colours.
type Roster = { deptOfName: Map<string, string>; deptOfRole: Map<string, string> };
const RosterContext = createContext<Roster>({ deptOfName: new Map(), deptOfRole: new Map() });
export const RosterProvider = ({ agents, children }: { agents: Overview["agents"]; children: ReactNode }) => (
  <RosterContext.Provider value={{ deptOfName: new Map(agents.map((a) => [a.name, a.department])), deptOfRole: new Map(agents.map((a) => [a.role, a.department])) }}>
    {children}
  </RosterContext.Provider>
);
export const useRoster = () => useContext(RosterContext);

const DEPT_BG: Record<string, string> = {
  customer: "bg-dept-customer",
  finance: "bg-dept-finance",
  marketing: "bg-dept-marketing",
  leadership: "bg-dept-leadership",
};

const initials = (name: string) =>
  name
    .replace(/^the /i, "")
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

// Agents are coloured by department; the Dispatcher is an outline (it is code, not an agent); the founder is the highlighter.
export function Avatar({ name, kind, size = 32 }: { name: string; kind: string; size?: number }) {
  const { deptOfName } = useRoster();
  const style = { width: size, height: size, fontSize: size * 0.38 };
  if (kind === "system")
    return (
      <span style={style} className="grid shrink-0 place-items-center rounded-[7px] border border-line-2 bg-surface font-semibold text-muted" aria-hidden>
        <svg viewBox="0 0 16 16" width={size * 0.5} height={size * 0.5} fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M2 8h8M7 4l4 4-4 4M13 3v10" />
        </svg>
      </span>
    );
  if (kind === "founder")
    return (
      <span style={style} className="grid shrink-0 place-items-center rounded-[7px] bg-you font-bold text-you-ink" aria-hidden>
        You
      </span>
    );
  return (
    <span style={style} className={`grid shrink-0 place-items-center rounded-[7px] font-semibold text-white ${DEPT_BG[deptOfName.get(name) ?? ""] ?? "bg-ink-2"}`} aria-hidden>
      {initials(name)}
    </span>
  );
}

// Who decided an action, in the two signal colours.
export function Outcome({ status, effect, reason, rule }: { status: string; effect: string | null; reason: string | null; rule: string | null }) {
  const label = rule ? /^(R\d+)/.exec(rule)?.[1] : null;
  if (status === "executed" && effect === "allow" && label) return <Pill tone="rule">Allowed by {label} · done</Pill>;
  if (effect === "allow" && label) return <Pill tone="rule">Allowed by {label}</Pill>;
  if (effect === "deny") return <Pill tone="stop">Denied by {label ?? "a rule"}</Pill>;
  if (status === "escalated") return <Pill tone="you">Waiting for you</Pill>;
  if (status === "approved" || (status === "executed" && effect === "escalate")) return <Pill tone="ink">Approved by you{status === "executed" ? " · done" : ""}</Pill>;
  if (status === "denied") return <Pill tone="stop">Declined by you</Pill>;
  if (status === "proposed" || status === "labeled") return <Pill tone="quiet">Checking…</Pill>;
  return <Pill tone="quiet">{reason ?? status}</Pill>;
}

const TONE: Record<string, string> = {
  you: "bg-you text-you-ink",
  rule: "bg-rule-soft text-rule",
  stop: "bg-stop-soft text-stop",
  ink: "bg-ink text-paper",
  quiet: "bg-sunk text-muted",
};
export const Pill = ({ tone, children }: { tone: keyof typeof TONE; children: ReactNode }) => (
  <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[12px] font-semibold leading-5 ${TONE[tone]}`}>{children}</span>
);

// A clock that re-renders relative times.
export function useNow(every = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(id);
  }, [every]);
  return now;
}

// Marks rows that arrived after first render, so they get the arrival highlight once.
export function useFresh(ids: string[]): Set<string> {
  const [seen] = useState(() => new Set(ids));
  const fresh = new Set(ids.filter((id) => !seen.has(id)));
  useEffect(() => {
    for (const id of ids) seen.add(id);
  });
  return fresh;
}

export const REPLY_TYPE: Record<string, string> = {
  REPORT: "Report",
  ISSUE: "Raised an issue",
  HANDOFF: "Handed off",
  ESCALATE: "Escalated",
  OBJECT: "Objected",
  DECISION: "Decision",
};
