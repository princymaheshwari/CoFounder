import { clock, humanRule, typeOfRule } from "../lib/format";
import { Avatar, Mention, REPLY_TYPE, type Message } from "./ui";

// How one message reads. Agents speak in replies; the Dispatcher (code) only assigns, routes and records,
// so its lines are quieter than anything an agent says.

const ruleLabel = (r: string) => /^(R\d+)/.exec(r)?.[1] ?? r;

export function RulesInScope({ rules }: { rules: string[] }) {
  if (!rules.length) return null;
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-middle" title={rules.join("\n")}>
      {rules.map((r) => (
        <span key={r} className="rounded bg-rule-soft px-1.5 text-[12px] font-semibold text-rule">
          {ruleLabel(r)}
        </span>
      ))}
    </span>
  );
}

// The work in an ASSIGN, Slack style: the agent tagged, then the task. Recurring work (onboarding) leads
// with its title and shows how often it runs.
export function AssignBody({ m }: { m: Message }) {
  return (
    <>
      <p className="max-w-[72ch] text-[15px] leading-relaxed text-ink">
        {m.to ? <Mention name={m.to} /> : null} {m.kind === "handoff" ? <span className="text-muted">picked up a handoff: </span> : null}
        {m.recurring ? <span className="font-semibold">{m.recurring.title}. </span> : null}
        {m.headline}
      </p>
      {m.recurring ? (
        <p className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="rounded-full bg-ink px-2 py-0.5 font-mono text-[10.5px] font-semibold text-white">Recurring · {m.recurring.cadence}</span>
          <span className="text-[12px] text-faint">Set up at onboarding</span>
        </p>
      ) : null}
    </>
  );
}

// An ASSIGN or handoff inside a thread: a Dispatcher message tagging the agent it starts.
function AssignMessage({ m }: { m: Message }) {
  return (
    <div className="flex gap-3 py-3">
      <Avatar name="Dispatcher" kind="system" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold text-ink">Dispatcher</span>
          <span className="text-[13px] font-medium text-muted">{m.kind === "handoff" ? "handed off" : "assigned"}</span>
          <span className="text-[12px] text-faint">{clock(m.at)}</span>
          {m.rules.length ? (
            <span className="text-[12px] text-faint">
              with rules
              <RulesInScope rules={m.rules} />
            </span>
          ) : null}
        </p>
        <div className="mt-0.5">
          <AssignBody m={m} />
        </div>
      </div>
    </div>
  );
}

// Any other Dispatcher line inside a thread (repair, nudge, decision, request): small, never a bubble.
function SystemLine({ m }: { m: Message }) {
  const verb: Record<string, string> = {
    repair: "Asked for a corrected reply",
    nudge: "Nudged for a reply",
    decision: "Decision recorded",
    request: "Sent to your desk",
  };
  return (
    <div className="flex gap-3 py-1.5 pl-11 text-[13px] text-muted">
      <p className="min-w-0 flex-1">
        <span className="font-semibold text-ink-2">{verb[m.kind] ?? "Dispatcher"}</span>
        <span>: {m.headline}</span>
        <span className="ml-2 text-[12px] text-faint">{clock(m.at)}</span>
      </p>
    </div>
  );
}

export function AgentReply({ m }: { m: Message }) {
  const e = m.envelope;
  return (
    <div className="flex gap-3 py-3">
      <Avatar name={m.sender} kind={m.senderKind} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold text-ink">{m.sender}</span>
          {e ? <span className="text-[13px] font-medium text-muted">{REPLY_TYPE[e.type] ?? e.type}{e.to ? ` to ${e.to}` : ""}</span> : null}
          <span className="text-[12px] text-faint">{clock(m.at)}</span>
          {m.run ? <span className="text-[12px] text-faint">Creao run {m.run.slice(0, 8)}</span> : null}
        </p>
        {m.kind === "invalid" ? (
          <p className="mt-1 rounded-md bg-stop-soft px-3 py-2 text-[14px] text-stop">{m.headline}</p>
        ) : (
          <p className="mt-0.5 max-w-[68ch] text-[15px] text-ink">{m.headline}</p>
        )}
        {e?.findings.length ? (
          <ul className="mt-2 space-y-1 border-l-2 border-line pl-3 text-[14px] text-ink-2">
            {e.findings.map((f, i) => (
              <li key={i}>
                {f.claim} <span className="text-faint">({f.evidence})</span>
              </li>
            ))}
          </ul>
        ) : null}
        {e?.actions.length ? (
          <ul className="mt-2 space-y-1.5">
            {e.actions.map((a, i) => (
              <li key={i} className="rounded-[10px] border border-white/70 bg-white/60 px-3 py-2">
                <p className="text-[14px] font-semibold text-ink">Proposes: {a.text}</p>
                {a.rationale ? <p className="text-[13px] text-muted">{a.rationale}</p> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {e?.issue ? <p className="mt-2 text-[14px] text-ink-2">Also flagged: {e.issue}</p> : null}
        {e?.package ? (
          <div className="mt-2 rounded-[10px] border border-white/70 bg-white/60 px-3 py-2">
            <p className="font-serif text-[17px] text-ink">{e.package.situation}</p>
            <p className="mt-1 text-[13px] text-muted">Recommends: {e.package.recommendation}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ThreadMessage({ m }: { m: Message }) {
  if (m.senderKind === "agent") return <AgentReply m={m} />;
  if (m.kind === "assign" || m.kind === "handoff") return <AssignMessage m={m} />;
  return <SystemLine m={m} />;
}

// A digest posted when a rule changes: the channel's rules, as the agents now see them.
export function Digest({ m }: { m: Message }) {
  return (
    <div className="flex gap-3 py-3">
      <Avatar name="Dispatcher" kind="system" />
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-2">
          <span className="font-semibold text-ink">Rules for this channel</span>
          <span className="text-[12px] text-faint">{clock(m.at)}</span>
        </p>
        <ul className="mt-1.5 space-y-1">
          {m.rules.map((r) => (
            <li key={r} className="flex gap-2 text-[14px] text-ink-2">
              <span className="font-semibold text-rule">{ruleLabel(r)}</span>
              <span>{humanRule(typeOfRule(r), r)}</span>
            </li>
          ))}
          {!m.rules.length ? <li className="text-[14px] text-muted">No active rules. Everything here needs you.</li> : null}
        </ul>
      </div>
    </div>
  );
}
