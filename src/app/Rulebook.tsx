import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import { clock, day, humanRule, plural } from "../lib/format";
import { Pill } from "./ui";

// The rulebook: what decides for the founder, where each rule came from, and how it was learned.
// Rules are never written by hand: they are drafted from the founder's own decisions and start working
// only after the founder approves them in Founder desk.

const STATUS: Record<string, { tone: "rule" | "you" | "quiet" | "stop"; text: string }> = {
  active: { tone: "rule", text: "Active" },
  proposed: { tone: "you", text: "Waiting for you in Founder desk" },
  suspended: { tone: "stop", text: "Suspended" },
  revoked: { tone: "quiet", text: "Replaced" },
  expired: { tone: "quiet", text: "Expired" },
};

export function Rulebook({ onDesk }: { onDesk: () => void }) {
  const data = useQuery(api.feed.rulebook);
  const suspend = useMutation(api.rules.suspendRule);
  const [busy, setBusy] = useState<string | null>(null);
  const rules = data?.rules ?? [];
  const order = (s: string) => ["proposed", "active", "suspended"].indexOf(s);
  const sorted = [...rules].sort((a, b) => order(a.status) - order(b.status) || b.createdAt - a.createdAt);
  const decided = rules.reduce((n, r) => n + r.decided, 0);

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-line px-8 pb-4 pt-6">
        <h1 className="text-[24px] font-bold leading-tight tracking-[-0.01em]">Rulebook</h1>
        <p className="mt-1 max-w-[72ch] text-[14px] text-muted">
          Rules make decisions so you don't have to. Each one is drafted from your own past decisions, checked against every one of them, and only works after you approve it.
          {decided ? ` So far they have decided ${plural(decided, "action")} for you.` : ""}
        </p>
      </header>
      <div className="scroll-quiet grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_340px] gap-10 overflow-y-auto px-8 py-6">
        <ol className="space-y-5">
          {data === undefined ? <p className="text-muted">Loading…</p> : null}
          {sorted.map((r) => {
            const st = STATUS[r.status] ?? { tone: "quiet" as const, text: r.status };
            return (
              <li key={r._id} className={`grid grid-cols-[72px_minmax(0,1fr)] gap-x-5 rounded-lg border bg-surface px-5 py-5 ${r.status === "proposed" ? "border-you" : "border-line"} ${r.status === "suspended" ? "opacity-70" : ""}`}>
                <p className={`text-[30px] font-extrabold leading-none tracking-[-0.03em] ${r.status === "active" ? "text-rule" : r.status === "proposed" ? "text-you-ink" : "text-faint"}`}>{r.label}</p>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {r.status === "proposed" ? (
                      <button onClick={onDesk} className="focus-visible:outline-offset-1">
                        <Pill tone="you">{st.text}</Pill>
                      </button>
                    ) : (
                      <Pill tone={st.tone}>{st.text}</Pill>
                    )}
                    {r.version > 0 ? <span className="text-[13px] text-faint">Version {r.version}</span> : null}
                  </div>
                  <p className="mt-2 max-w-[60ch] font-serif text-[21px] leading-snug text-ink">{humanRule(r.actionType, r.text)}</p>
                  <dl className="mt-4 grid grid-cols-3 gap-4 text-[13px]">
                    <div>
                      <dt className="text-muted">Learned from</dt>
                      <dd className="mt-0.5 font-semibold text-ink">{plural(r.supporting, "decision")}</dd>
                    </div>
                    <div>
                      <dt className="text-muted">Agrees with your past calls</dt>
                      <dd className="mt-0.5 font-semibold text-ink">
                        {r.agree} of {r.total}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted">Decided for you</dt>
                      <dd className={`mt-0.5 font-semibold ${r.decided ? "text-rule" : "text-ink"}`}>{plural(r.decided, "action")}</dd>
                    </div>
                  </dl>
                  <div className="mt-4 flex items-center justify-between gap-4 text-[13px] text-faint">
                    <span>
                      Drafted {day(r.createdAt)}
                      {r.expiresAt && r.status === "active" ? `. Expires ${day(r.expiresAt)} unless renewed.` : "."}
                    </span>
                    {r.status === "active" ? (
                      <button
                        className="font-medium text-muted underline-offset-4 hover:text-stop hover:underline disabled:opacity-50"
                        disabled={busy === r._id}
                        onClick={() => {
                          setBusy(r._id);
                          void suspend({ ruleId: r._id, reason: "Suspended from the rulebook" }).finally(() => setBusy(null));
                        }}
                      >
                        Suspend
                      </button>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
        <aside>
          <h2 className="text-[15px] font-semibold text-ink">How rules get learned</h2>
          <p className="mt-1 text-[13px] text-muted">
            After three of your decisions point the same way, Claude drafts the narrowest rule that fits them all. Convex replays it against every past decision; one disagreement and it is thrown out.
          </p>
          <ol className="mt-4 border-l border-line">
            {(data?.timeline ?? []).map((t, i) => (
              <li key={i} className="relative pb-4 pl-5">
                <span
                  className={`absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full ${t.kind === "rule_approved" ? "bg-rule" : t.kind === "rule_proposed" ? "bg-you" : t.kind === "rule_suspended" || t.kind.includes("reject") || t.kind === "rule_dropped" ? "bg-stop" : "bg-line-2"}`}
                />
                <p className="text-[12px] text-faint">{clock(t.at)}</p>
                <p className="text-[14px] text-ink-2">{t.text}</p>
              </li>
            ))}
            {data && !data.timeline.length ? <li className="pl-5 text-[14px] text-muted">No rules learned yet. Approve a few similar requests in Founder desk and watch this fill in.</li> : null}
          </ol>
        </aside>
      </div>
    </section>
  );
}
