import { useQuery } from "convex/react";
import { useEffect, useRef } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { ThreadMessage } from "./Messages";
import { Outcome, useFresh } from "./ui";

// One task thread end to end: who was assigned, what each agent said, and how every proposal was decided.

const LABEL_NAME: Record<string, string> = {
  refund_reason: "refund reason",
  mentions_pricing: "mentions pricing",
  mentions_competitor: "mentions a competitor",
  makes_commitment: "makes a commitment",
  grounded: "backed by evidence",
};

export function ThreadPane({ taskId, onClose }: { taskId: Id<"tasks">; onClose: () => void }) {
  const data = useQuery(api.feed.thread, { taskId });
  const fresh = useFresh((data?.messages ?? []).map((m) => m._id));
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [data?.messages.length]);

  return (
    <aside className="flex w-[460px] shrink-0 flex-col border-l border-line bg-surface" aria-label="Thread">
      <header className="flex items-start justify-between gap-4 border-b border-line px-6 pb-4 pt-6">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-muted">Thread in {data?.room ?? "…"}</p>
          <h2 className="mt-0.5 text-[16px] font-semibold leading-snug text-ink">{data?.title ?? ""}</h2>
        </div>
        <button onClick={onClose} className="-mr-2 rounded-md px-2 py-1 text-[13px] font-medium text-muted hover:bg-sunk" aria-label="Close thread">
          Close
        </button>
      </header>
      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-6 py-3">
        {data === undefined ? <p className="text-muted">Loading…</p> : null}
        {data?.messages.map((m) => (
          <div key={m._id} className={fresh.has(m._id) ? "arrive -mx-2 rounded-md px-2" : ""}>
            <ThreadMessage m={m} />
          </div>
        ))}
        {data?.actions.length ? (
          <section className="mt-4 border-t border-line pt-4">
            <h3 className="text-[14px] font-semibold text-ink">Who decided</h3>
            <ul className="mt-2 space-y-2">
              {data.actions.map((a) => (
                <li key={a._id} className="rounded-md border border-line px-3 py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-[14px] font-medium text-ink">{a.text}</p>
                    <Outcome status={a.status} effect={a.effect} reason={a.reason} rule={a.rule} />
                  </div>
                  <p className="mt-1 text-[13px] text-muted">
                    Proposed by {a.by}.{" "}
                    {a.effect === "escalate" ? `Sent to you: ${a.reason?.toLowerCase()}.` : a.rule ? `The gate matched ${/^(R\d+)/.exec(a.rule)?.[1] ?? "a rule"}.` : ""}
                  </p>
                  {a.labels.length ? (
                    <p className="mt-1 text-[12px] text-faint">
                      Jev read it as{" "}
                      {a.labels.map((l, i) => (
                        <span key={l.name}>
                          {i ? ", " : ""}
                          {LABEL_NAME[l.name] ?? l.name}: {l.value.replace(/_/g, " ")} ({Math.round(l.confidence * 100)}%)
                        </span>
                      ))}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <div ref={end} />
      </div>
    </aside>
  );
}
