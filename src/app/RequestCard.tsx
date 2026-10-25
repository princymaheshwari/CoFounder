import { useMutation } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import { clock, humanCondition, humanRule } from "../lib/format";
import { Pill, type Request } from "./ui";

// One founder request in #founder-desk: what is being asked, what approving does, and the two answers.
// Open requests carry the highlighter band; once decided the band goes quiet and the answer is stamped on.

const FROM: Record<string, string> = { package: "From the Cofounder", action: "From the gate", rule: "New rule" };

export function RequestCard({ request, at, onOpenThread }: { request: Request; at: number; onOpenThread?: () => void }) {
  const decide = useMutation(api.inbox.decide);
  const [note, setNote] = useState("");
  const [noting, setNoting] = useState(false);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = request.status === "open";
  const isRule = request.kind === "rule";

  async function answer(choice: "approve" | "deny") {
    setBusy(choice);
    setError(null);
    try {
      await decide({ inboxId: request._id, choice, ...(note.trim() ? { reason: note.trim() } : {}) });
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^.*Uncaught Error:\s*/s, "").split("\n")[0] : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (!open) return <DecidedCard request={request} at={at} onOpenThread={onOpenThread} />;

  return (
    <article className={`relative overflow-hidden rounded-lg border bg-surface ${open ? "border-you shadow-[0_1px_0_var(--color-line)]" : "border-line"}`}>
      <div className={`absolute inset-y-0 left-0 w-1.5 ${open ? "bg-you" : request.decision?.choice === "approve" ? "bg-rule" : "bg-line-2"}`} aria-hidden />
      <div className="py-4 pl-6 pr-5">
        <header className="flex items-baseline justify-between gap-4">
          <p className="text-[13px] font-medium text-muted">
            {request.kind === "action" && request.actions[0] ? `From ${request.actions[0].by}` : (FROM[request.kind] ?? "Request")} <span className="text-faint">at {clock(at)}</span>
          </p>
          {open ? <Pill tone="you">Waiting for you</Pill> : null}
        </header>

        {isRule ? <RuleBody request={request} /> : <AskBody request={request} />}

        {open ? (
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <button
              className="rounded-md bg-ink px-4 py-2 text-[14px] font-semibold text-paper hover:bg-ink-2 disabled:opacity-60"
              onClick={() => void answer("approve")}
              disabled={busy !== null}
            >
              {busy === "approve" ? "Approving…" : isRule ? "Approve rule" : "Approve"}
            </button>
            <button
              className="rounded-md border border-line-2 bg-surface px-4 py-2 text-[14px] font-semibold text-ink hover:bg-sunk disabled:opacity-60"
              onClick={() => void answer("deny")}
              disabled={busy !== null}
            >
              {busy === "deny" ? "Sending…" : isRule ? "Reject rule" : "Decline"}
            </button>
            {noting ? (
              <input
                autoFocus
                className="min-w-56 flex-1 rounded-md border border-line-2 px-3 py-2 text-[14px] placeholder:text-faint"
                placeholder="Note for the agents (optional)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            ) : (
              <button className="px-2 py-2 text-[13px] font-medium text-muted underline-offset-4 hover:underline" onClick={() => setNoting(true)}>
                Add a note
              </button>
            )}
            {onOpenThread ? (
              <button className="ml-auto px-2 py-2 text-[13px] font-medium text-muted underline-offset-4 hover:underline" onClick={onOpenThread}>
                See how agents got here
              </button>
            ) : null}
          </div>
        ) : (
          <p className="mt-4 text-[14px] font-medium text-ink-2">
            {request.decision?.choice === "approve" ? (isRule ? "You approved this rule" : "You approved") : isRule ? "You rejected this rule" : "You declined"}
            {request.decision ? ` at ${clock(request.decision.at)}` : ""}
            {request.decision?.reason ? <span className="text-muted">: “{request.decision.reason}”</span> : "."}
            {request.decision?.choice === "approve" && isRule ? <span className="text-muted"> Agents follow it from their next task.</span> : null}
            {onOpenThread ? (
              <button className="ml-3 text-[13px] text-muted underline-offset-4 hover:underline" onClick={onOpenThread}>
                Thread
              </button>
            ) : null}
          </p>
        )}
        {error ? <p className="mt-2 text-[13px] font-medium text-stop">{error}</p> : null}
      </div>
    </article>
  );
}

function AskBody({ request }: { request: Request }) {
  return (
    <>
      <h3 className="mt-2 max-w-[62ch] font-serif text-[22px] leading-snug text-ink">{request.situation ?? request.title}</h3>
      {request.recommendation ? (
        <p className="mt-2 max-w-[70ch] text-[15px] text-ink-2">
          <span className="font-semibold">Recommended:</span> {request.recommendation}
        </p>
      ) : null}
      {request.actions.length ? (
        <div className="mt-4">
          <p className="text-[13px] font-medium text-muted">{request.status === "open" ? "Approving does this" : "This decided"}</p>
          <ul className="mt-1.5 divide-y divide-line rounded-md border border-line">
            {request.actions.map((a, i) => (
              <li key={i} className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 px-3 py-2.5">
                <span className="text-[15px] font-medium text-ink">{a.text}</span>
                <span className="text-[13px] text-muted">{a.by}</span>
                <span className="col-span-2 text-[13px] text-muted">Why it needs you: {a.gate}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function RuleBody({ request }: { request: Request }) {
  const added = request.diff.find((l) => l.startsWith("+ ")) ?? "";
  const replaced = request.diff.find((l) => l.startsWith("- "));
  const type = /for (\w+)\?$/.exec(request.title)?.[1] ?? "";
  const label = /(R\d+):/.exec(added)?.[1];
  const sentence = `${label ? `${label}. ` : ""}${humanRule(type, added.slice(2))}`;
  const conditions = request.diff.filter((l) => /^\s{2}[+-\s]\s/.test(l) && !/·/.test(l));
  const agreement = request.diff.find((l) => l.startsWith("Agrees with"));
  return (
    <>
      <h3 className="mt-2 max-w-[62ch] font-serif text-[22px] leading-snug text-ink">Claude drafted a rule from your recent decisions</h3>
      <p className="mt-1 max-w-[70ch] text-[15px] text-ink-2">{request.rationale}</p>
      <div className="mt-4 overflow-hidden rounded-md border border-line">
        {replaced ? <p className="border-b border-line px-3 py-2 text-[14px] text-stop line-through">Replaces: {humanRule(type, replaced.slice(2))}</p> : null}
        <p className="border-b border-line bg-sunk px-3 py-2 text-[14px] font-semibold text-ink">{sentence}</p>
        <ul className="px-3 py-2 font-mono text-[13px] leading-6">
          {conditions.map((l, i) => {
            const added = l.trim().startsWith("+");
            const removed = l.trim().startsWith("-");
            return (
              <li key={i} className={added ? "text-rule" : removed ? "text-stop line-through" : "text-muted"}>
                {added ? "+ " : removed ? "− " : "  "}
                {humanCondition(l.trim().replace(/^[+-]\s*/, ""))}
              </li>
            );
          })}
        </ul>
      </div>
      {agreement ? <p className="mt-2 text-[13px] text-muted">{agreement} Approving makes it decide these for you; it expires in 30 days.</p> : null}
    </>
  );
}

// A decided request, compact: what it was, what it did, and the founder's answer.
function DecidedCard({ request, at, onOpenThread }: { request: Request; at: number; onOpenThread?: () => void }) {
  const approved = request.decision?.choice === "approve";
  const isRule = request.kind === "rule";
  const type = /for (\w+)\?$/.exec(request.title)?.[1] ?? "";
  const headline = isRule && request.ruleText ? `${/^(R\d+)/.exec(request.ruleText)?.[1] ?? "Rule"}. ${humanRule(type, request.ruleText)}` : (request.situation ?? request.title);
  return (
    <article className="relative overflow-hidden rounded-lg border border-line bg-surface">
      <div className={`absolute inset-y-0 left-0 w-1.5 ${approved ? (isRule ? "bg-rule" : "bg-ink-2") : "bg-line-2"}`} aria-hidden />
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-6 py-3 pl-6 pr-5">
        <p className="min-w-0 font-serif text-[17px] leading-snug text-ink">{headline}</p>
        <p className="whitespace-nowrap text-[13px] font-medium text-ink-2">
          {approved ? "Approved" : isRule ? "Rejected" : "Declined"}
          <span className="text-faint"> {request.decision ? clock(request.decision.at) : clock(at)}</span>
        </p>
        {request.actions.length ? <p className="mt-1 min-w-0 truncate text-[13px] text-muted">{request.actions.map((a) => a.text).join("; ")}</p> : <span />}
        {onOpenThread ? (
          <button className="mt-1 justify-self-end text-[13px] text-muted underline-offset-4 hover:underline" onClick={onOpenThread}>
            Thread
          </button>
        ) : (
          <span />
        )}
        {request.decision?.reason ? <p className="col-span-2 mt-1 text-[13px] text-muted">Your note: “{request.decision.reason}”</p> : null}
      </div>
    </article>
  );
}
