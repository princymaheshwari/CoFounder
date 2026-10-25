import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

// What the company actually did (spec 10): connector actions with their provider refs (Linear URL, Gmail id,
// Calendar event), the mock outbox for unconnected connectors, and the mock post queue. Spec 14 expands this.

const time = (ms: number) => new Date(ms).toLocaleString("en-US", { timeZone: "America/Los_Angeles" });

function Ref({ value }: { value: string }) {
  return /^https?:\/\//.test(value) ? (
    <a className="text-sky-700 underline" href={value} target="_blank" rel="noreferrer">
      {value}
    </a>
  ) : (
    <span className="font-mono text-xs">{value}</span>
  );
}

const STATUS_COLOR: Record<string, string> = {
  executed: "text-emerald-700",
  executing: "text-amber-700",
  failed: "text-rose-700",
};

export default function Activity() {
  const data = useQuery(api.executor.activity);
  if (data === undefined) return <p className="text-slate-500">Loading activity…</p>;
  return (
    <section className="w-full max-w-3xl">
      <h1 className="mb-4 text-2xl font-bold">Executed actions</h1>
      {data.actions.length === 0 ? (
        <p className="text-slate-500">Nothing executed yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {data.actions.map((a) => (
            <li key={a.id} className="rounded border border-slate-200 bg-white p-3 text-sm">
              <div className="flex justify-between gap-4">
                <span className="font-medium">
                  {a.type} <span className="text-slate-400">by {a.role}</span>
                </span>
                <span className={STATUS_COLOR[a.status] ?? "text-slate-500"}>{a.status}</span>
              </div>
              <div className="mt-1 flex flex-col gap-1">
                {a.refs.map((r) => (
                  <Ref key={r} value={r} />
                ))}
              </div>
              <p className="mt-1 text-xs text-slate-400">{time(a.created_at)}</p>
            </li>
          ))}
        </ul>
      )}

      {data.outbox.length > 0 && (
        <>
          <h2 className="mb-2 mt-6 text-lg font-semibold">Mock outbox</h2>
          <ul className="flex flex-col gap-2">
            {data.outbox.map((o) => (
              <li key={o.id} className="rounded border border-dashed border-slate-300 bg-white p-3 text-sm">
                <div className="font-medium">{o.connector}</div>
                <p className="text-xs text-slate-500">{o.reason}</p>
                <pre className="mt-1 whitespace-pre-wrap text-xs">{JSON.stringify(o.payload, null, 2)}</pre>
              </li>
            ))}
          </ul>
        </>
      )}

      {data.posts.length > 0 && (
        <>
          <h2 className="mb-2 mt-6 text-lg font-semibold">Post queue (mock)</h2>
          <ul className="flex flex-col gap-2">
            {data.posts.map((p) => (
              <li key={p.id} className="rounded border border-slate-200 bg-white p-3 text-sm">
                <span className="font-medium">{p.channel}</span> <span className="text-slate-400">({p.status})</span>
                <p className="mt-1">{p.text}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
