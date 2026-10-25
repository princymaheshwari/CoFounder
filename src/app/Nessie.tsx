import { useAction, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../convex/_generated/api";
import { clock } from "../lib/format";
import type { Message } from "./ui";

// Proof that money really moves in Capital One's Nessie sandbox: both views read Nessie live through
// convex/bank.ts (the key stays in Convex), not our ledger mirror.

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const at = (iso: string) => (Number.isFinite(Date.parse(iso)) ? clock(Date.parse(iso)) : iso);
const payee = (description: string) => /refund to ([^[]+)/.exec(description)?.[1]?.trim() ?? description.replace(/\s*\[[^\]]*\]/g, "");

function Badge() {
  return (
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[8px] border border-ink/15 bg-white/80 font-mono text-[8.5px] font-bold tracking-tight text-ink" aria-hidden>
      NESSIE
    </span>
  );
}

type Verified = FunctionReturnType<typeof api.bank.verifyMessage>;

// A Dispatcher "Executed … in Nessie" line, with a button that fetches the objects from Nessie right now.
export function NessieLine({ m }: { m: Message }) {
  const verify = useAction(api.bank.verifyMessage);
  const [result, setResult] = useState<Verified | null>(null);
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      setResult(await verify({ messageId: m._id }));
    } catch (e) {
      setResult({ requests: [], ms: 0, objects: [], error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex gap-3 py-1.5">
      <Badge />
      <div className="min-w-0 flex-1">
        <p className="text-[14px] text-ink-2">
          {m.headline} <span className="ml-1 text-[12px] text-faint">{clock(m.at)}</span>
          <button className="ml-2 rounded-full border border-line-2 bg-white/70 px-2.5 py-0.5 text-[12px] font-semibold text-ink hover:bg-white disabled:opacity-60" onClick={() => void run()} disabled={busy}>
            {busy ? "Asking Nessie…" : result ? "Check again" : "Verify in Nessie"}
          </button>
        </p>
        {result ? <VerifyResult r={result} /> : null}
      </div>
    </div>
  );
}

function VerifyResult({ r }: { r: Verified }) {
  if (r.error && !r.objects.length) return <p className="mt-1.5 text-[13px] font-medium text-stop">{r.error}</p>;
  const matched = r.objects.filter((o) => o.transfer?.action_id === o.expected_action).length;
  return (
    <div className="mt-2 rounded-[10px] border border-line bg-white/70 px-3 py-2 text-[13px]">
      <p className="text-ink-2">
        <span className="font-semibold text-rule">Nessie answered</span> {r.objects.length} {r.objects.length === 1 ? "object" : "objects"} in {r.ms} ms
        {r.objects.some((o) => o.transfer) ? `; ${matched} of ${r.objects.length} carry the action id that authorized them.` : "."}
      </p>
      <p className="mt-1 break-all font-mono text-[11.5px] text-muted">{r.requests[0]}{r.requests.length > 1 ? `  (+${r.requests.length - 1} more)` : ""}</p>
      <ul className="mt-1.5 divide-y divide-line">
        {r.objects.map((o, i) =>
          o.transfer ? (
            <li key={i} className="grid grid-cols-[1fr_auto] gap-x-3 py-1">
              <span className="min-w-0 truncate text-ink">
                {payee(o.transfer.description)} <span className="font-mono text-[11.5px] text-faint">{o.transfer.id.slice(0, 8)}</span>
              </span>
              <span className="font-semibold text-ink">{dollars(o.transfer.amount_cents)}</span>
              <span className="col-span-2 text-[12px] text-muted">
                {o.transfer.status} at {at(o.transfer.date)} · {o.transfer.action_id === o.expected_action ? "tag matches the gate's action" : "tag does not match"}
              </span>
            </li>
          ) : (
            <li key={i} className="py-1 text-ink">Bill object</li>
          ),
        )}
      </ul>
      {r.objects[0] ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-[12px] font-medium text-muted">Raw response from Nessie</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-sunk p-2 font-mono text-[11.5px] text-ink-2">{r.objects[0].raw}</pre>
        </details>
      ) : null}
      {r.error ? <p className="mt-1 text-[12px] text-stop">{r.error}</p> : null}
    </div>
  );
}

type Refunds = FunctionReturnType<typeof api.bank.liveRefunds>;

// Sidebar panel: the newest refunds on the operating account, fetched from Nessie again after every execution.
export function BankPanel() {
  const fetchRefunds = useAction(api.bank.liveRefunds);
  const lastMove = useQuery(api.bank.lastMove);
  const [data, setData] = useState<Refunds | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    try {
      setData(await fetchRefunds({}));
    } catch (e) {
      setData({ request: "", ms: 0, transfers: [], total: 0, error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    } finally {
      setBusy(false);
    }
  }, [fetchRefunds]);
  useEffect(() => {
    if (lastMove !== undefined) void load();
  }, [lastMove, load]);

  return (
    <section aria-labelledby="bank-title">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="bank-title" className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-muted">
          Bank · live from Nessie
        </h2>
        <button className="text-[12px] text-muted underline-offset-4 hover:underline disabled:opacity-50" onClick={() => void load()} disabled={busy}>
          {busy ? "Fetching…" : "Refresh"}
        </button>
      </div>
      {data?.error ? <p className="mt-1.5 text-[12px] text-stop">{data.error}</p> : null}
      <ul className="mt-1.5 space-y-1">
        {(data?.transfers ?? []).slice(0, 6).map((t) => (
          <li key={t.id} className="flex items-baseline justify-between gap-2 text-[13px]" title={`Nessie transfer ${t.id}\n${t.description}`}>
            <span className="min-w-0 truncate text-ink-2">{payee(t.description)}</span>
            <span className="shrink-0 font-semibold text-ink">{dollars(t.amount_cents)}</span>
          </li>
        ))}
        {data && !data.error && !data.transfers.length ? <li className="text-[13px] text-faint">No refunds yet.</li> : null}
      </ul>
      {data && !data.error ? (
        <p className="mt-1.5 text-[12px] leading-snug text-faint">
          {data.total} refunds on the operating account, fetched from Nessie in {data.ms} ms.
        </p>
      ) : null}
    </section>
  );
}
