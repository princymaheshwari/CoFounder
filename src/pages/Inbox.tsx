import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";

// Minimal founder inbox (spec 09): open items, the Cofounder's package, Approve / Deny with an optional reason.
// Spec 14 grows this into the full founder app.

const KIND_LABEL: Record<Doc<"founder_inbox">["kind"], string> = {
  package: "Decision package",
  action: "Action",
  rule: "Rule",
  objection: "Objection",
};

function InboxItem({ item }: { item: Doc<"founder_inbox"> }) {
  const decide = useMutation(api.inbox.decide);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decidable = item.kind === "package" || item.kind === "action" || item.kind === "rule";

  async function submit(choice: "approve" | "deny") {
    setBusy(true);
    setError(null);
    try {
      await decide({ inboxId: item._id, choice, reason: reason || undefined });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="font-semibold">{item.title}</h2>
        <span className="shrink-0 text-xs uppercase tracking-wide text-slate-500">{KIND_LABEL[item.kind]}</span>
      </div>
      <p className="mt-1 text-xs text-slate-400">
        {new Date(item.created_at).toLocaleString("en-US", { timeZone: "America/Los_Angeles" })}
      </p>
      {item.kind === "rule" ? (
        <pre className="mt-3 overflow-x-auto rounded bg-slate-50 p-3 font-mono text-xs leading-relaxed">
          {item.body.split("\n").map((line, i) => (
            <div key={i} className={line.startsWith("+") || line.startsWith("  +") ? "text-emerald-700" : line.startsWith("-") || line.startsWith("  -") ? "text-rose-700" : "text-slate-700"}>
              {line || " "}
            </div>
          ))}
        </pre>
      ) : (
        <pre className="mt-3 whitespace-pre-wrap font-sans text-sm text-slate-700">{item.body}</pre>
      )}
      {item.kind === "package" && item.options?.length ? (
        <p className="mt-2 text-sm text-slate-500">Options considered: {item.options.map((o) => o.label).join(" · ")}</p>
      ) : null}
      {decidable && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <input
            className="min-w-48 flex-1 rounded border border-slate-300 px-2 py-1 text-sm"
            placeholder="Reason (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={busy}
          />
          <button
            className="rounded bg-emerald-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
            onClick={() => void submit("approve")}
            disabled={busy}
          >
            Approve
          </button>
          <button
            className="rounded bg-rose-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
            onClick={() => void submit("deny")}
            disabled={busy}
          >
            {item.kind === "rule" ? "Reject" : "Deny"}
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
    </li>
  );
}

export default function Inbox() {
  const items = useQuery(api.inbox.listOpen);
  return (
    <section className="w-full max-w-3xl">
      <h1 className="mb-4 text-2xl font-bold">Founder inbox</h1>
      {items === undefined ? (
        <p className="text-slate-500">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-slate-500">Nothing needs you right now.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {items.map((item) => (
            <InboxItem key={item._id} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
}
