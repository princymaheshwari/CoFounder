import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { plural } from "../lib/format";
import { DEPT_GRAD, ROOM_DEPT, type Overview } from "./ui";

export type View = { kind: "desk" } | { kind: "channel"; roomId: Id<"rooms"> } | { kind: "rules" };

function NavItem({ active, onClick, children, badge }: { active: boolean; onClick: () => void; children: React.ReactNode; badge?: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex w-full items-center justify-between gap-2 rounded-full px-3.5 py-1.5 text-left text-[15px] transition-colors ${active ? "bg-ink font-medium text-white" : "text-ink-2 hover:bg-white/60"}`}
    >
      <span className="min-w-0 truncate">{children}</span>
      {badge}
    </button>
  );
}

// The decision tape: one mark per decision, in order. Green = a rule decided, highlighter = you decided,
// hollow = waiting for you. As rules are learned the tape turns green.
function Tape({ tally }: { tally: Overview["tally"] }) {
  const total = tally.byRules + tally.byFounder;
  return (
    <section aria-labelledby="tape-title">
      <h2 id="tape-title" className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-muted">
        Who decided
      </h2>
      <div className="mt-2 flex min-h-[14px] flex-wrap gap-[3px]" role="img" aria-label={`${tally.byRules} decided by rules, ${tally.byFounder} by you, ${tally.waiting} waiting`}>
        {tally.marks.map((m, i) => (
          <span
            key={i}
            title={`${m.who === "rule" ? `Decided by ${m.rule ?? "a rule"}` : m.who === "founder" ? "Decided by you" : "Waiting for you"}: ${m.text}`}
            className={`h-3.5 w-2.5 rounded-[2px] ${m.who === "rule" ? "bg-rule" : m.who === "founder" ? "bg-you" : "border border-you-ink/40 bg-transparent"}`}
          />
        ))}
        {!tally.marks.length ? <span className="text-[13px] text-faint">No decisions yet.</span> : null}
      </div>
      <p className="mt-2 text-[13px] leading-snug text-muted">
        {total ? (
          <>
            <span className="font-semibold text-rule">{plural(tally.byRules, "decision")}</span> by rules, <span className="font-semibold text-you-ink">{tally.byFounder}</span> by you
            {tally.waiting ? `, ${tally.waiting} waiting` : ""}.
          </>
        ) : (
          "Every decision the company makes lands here."
        )}
      </p>
    </section>
  );
}

const ACTS = [
  { act: "double_charge", title: "Charged twice", cue: "Watch #customer, then #finance. Support refunds its own ticket under R7 without asking you; the pattern climbs to one package on your desk. Answer with “Approve and make it a rule”." },
  { act: "double_charge_again", title: "Charged twice, next morning", cue: "Approve the refund rule first. The same bug hits three more customers: the agents climb the same ladder, the gate decides under your rule, and Nessie pays. Nothing reaches you." },
  { act: "posts", title: "Three LinkedIn posts", cue: "Approve all three in Founder desk. After the third, Claude drafts a rule from your decisions and asks you to approve it." },
  { act: "after_rule", title: "A post after the rule", cue: "Approve the rule first. This post is decided by the rule and never reaches you." },
] as const;

function Story() {
  const status = useQuery(api.story.status);
  const start = useMutation(api.story.start);
  const reset = useMutation(api.story.reset);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^.*Uncaught Error:\s*/s, "").split("\n")[0] : String(e));
    } finally {
      setBusy(null);
    }
  };
  if (status && !status.enabled) {
    return <p className="text-[13px] text-muted">Story mode is off. Run `npx convex env set DEMO_TOOLS on` to use it.</p>;
  }
  return (
    <section aria-labelledby="story-title">
      <h2 id="story-title" className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-muted">
        Demo story
      </h2>
      <ol className="mt-2 space-y-2">
        {ACTS.map((a, i) => {
          const done = status?.started.includes(a.act);
          const next = ACTS.find((x) => !status?.started.includes(x.act))?.act === a.act;
          return (
            <li key={a.act} className="rounded-[12px] border border-white/70 bg-white/55 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <p className="min-w-0 text-[13px] font-semibold leading-snug text-ink">
                  <span className="mr-1.5 text-faint">{i + 1}</span>
                  {a.title}
                </p>
                <button
                  onClick={() => void run(a.act, () => start({ act: a.act }))}
                  disabled={busy !== null}
                  className={`shrink-0 rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${done ? "text-muted hover:bg-white/70" : "bg-ink text-white hover:bg-ink-2"} disabled:opacity-50`}
                >
                  {busy === a.act ? "Starting…" : done ? "Run again" : "Run"}
                </button>
              </div>
              {next ? <p className="mt-1 text-[12px] leading-snug text-muted">{a.cue}</p> : null}
            </li>
          );
        })}
      </ol>
      <div className="mt-2 flex items-center gap-3 text-[12px]">
        {confirm ? (
          <>
            <span className="text-stop">Clear every conversation and decision?</span>
            <button className="font-semibold text-stop underline" onClick={() => void run("reset", () => reset({})).then(() => setConfirm(false))}>
              {busy === "reset" ? "Clearing…" : "Clear"}
            </button>
            <button className="text-muted underline" onClick={() => setConfirm(false)}>
              Keep
            </button>
          </>
        ) : (
          <button className="text-muted underline-offset-4 hover:underline" onClick={() => setConfirm(true)}>
            Reset demo
          </button>
        )}
      </div>
      {error ? <p className="mt-1 text-[12px] text-stop">{error}</p> : null}
    </section>
  );
}

export function Sidebar({ overview, view, go }: { overview: Overview; view: View; go: (v: View) => void }) {
  const desk = overview.channels.find((c) => c.name === "#founder-desk");
  const channels = overview.channels.filter((c) => c.name !== "#founder-desk");
  const rules = useQuery(api.feed.rulebook);
  const active = (rules?.rules ?? []).filter((r) => r.status === "active").length;
  const working = new Set(overview.agents.filter((a) => a.state === "working").flatMap((a) => a.rooms));
  return (
    <nav className="glass scroll-quiet flex w-[288px] shrink-0 flex-col gap-6 overflow-y-auto rounded-[17px] px-4 pb-5 pt-6" aria-label="Company">
      <div className="px-3">
        <a href="#home" className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-muted hover:text-ink">
          CoFounder workspace
        </a>
        <p className="mt-1.5 text-[28px] font-medium leading-[1.05] tracking-[-0.045em] text-ink">{overview.company.name}</p>
        <p className="mt-2 text-[13px] leading-snug text-muted">
          {plural(overview.agents.length, "agent")} run the company. You decide only what they can't.
        </p>
      </div>

      <div className="space-y-0.5">
        <NavItem
          active={view.kind === "desk"}
          onClick={() => go({ kind: "desk" })}
          badge={desk?.waiting ? <span className="rounded-full bg-accent px-2 text-[12px] font-bold leading-5 text-white">{desk.waiting}</span> : null}
        >
          Founder desk
        </NavItem>
        <NavItem active={view.kind === "rules"} onClick={() => go({ kind: "rules" })} badge={<span className={`text-[12px] ${view.kind === "rules" ? "text-white/70" : "text-faint"}`}>{plural(active, "rule")}</span>}>
          Rulebook
        </NavItem>
      </div>

      <div>
        <p className="px-3 font-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-muted">Rooms</p>
        <div className="mt-1 space-y-0.5">
          {channels.map((c) => (
            <NavItem
              key={c._id}
              active={view.kind === "channel" && view.roomId === c._id}
              onClick={() => go({ kind: "channel", roomId: c._id })}
              badge={working.has(c.name) ? <span className="working h-2 w-2 rounded-full bg-rule" title="An agent is working here" /> : null}
            >
              <span className="flex items-center gap-2.5">
                <span className={`h-3 w-3 shrink-0 rounded-[4px] ${DEPT_GRAD[ROOM_DEPT[c.name] ?? ""] ?? "grad-none"}`} aria-hidden />
                <span>
                  <span className={view.kind === "channel" && view.roomId === c._id ? "text-white/60" : "text-faint"}>#</span>
                  {c.name.slice(1)}
                </span>
              </span>
            </NavItem>
          ))}
        </div>
      </div>

      <div className="px-3">
        <Tape tally={overview.tally} />
      </div>

      <div className="mt-auto px-3">
        <Story />
        <p className="mt-5 text-[12px] leading-snug text-faint">
          Agents are Creao saved agents; Convex runs the gate, the rules and every channel. Refunds settle in Capital One's Nessie sandbox, and Apify watches competitors.
        </p>
      </div>
    </nav>
  );
}
