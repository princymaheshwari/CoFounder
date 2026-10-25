import { useQuery } from "convex/react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { ChannelView } from "./app/ChannelView";
import { Landing } from "./landing/Landing";
import { Onboarding } from "./landing/Onboarding";
import { Desk } from "./app/Desk";
import { Rulebook } from "./app/Rulebook";
import { Sidebar, type View } from "./app/Sidebar";
import { ThreadPane } from "./app/ThreadPane";
import { RosterProvider } from "./app/ui";

// The founder app: channels where agents talk, one desk where the founder decides, and the rulebook.
// The view lives in the URL hash (#desk, #rules, #c/<room>, plus /t/<thread>) so a refresh keeps your place.

type Place = { view: View; thread: Id<"tasks"> | null };

// The landing page lives at the bare URL and at #home; onboarding at #start.
type Page = "home" | "start" | null;
const pageOf = (hash: string): Page => (hash === "" || hash === "#" || hash === "#home" ? "home" : hash === "#start" ? "start" : null);

// #desk · #desk/<thread> · #rules · #c/<room> · #c/<room>/t/<thread>
function parse(hash: string): Place {
  const [head, a, , c] = hash.replace(/^#\/?/, "").split("/");
  if (head === "c" && a) return { view: { kind: "channel", roomId: a as Id<"rooms"> }, thread: (c as Id<"tasks"> | undefined) ?? null };
  if (head === "rules") return { view: { kind: "rules" }, thread: null };
  return { view: { kind: "desk" }, thread: head === "desk" && a ? (a as Id<"tasks">) : null };
}

function format(p: Place): string {
  const base = p.view.kind === "channel" ? `#c/${p.view.roomId}` : p.view.kind === "rules" ? "#rules" : "#desk";
  return p.thread && p.view.kind !== "rules" ? `${base}${p.view.kind === "channel" ? "/t" : ""}/${p.thread}` : base;
}

export default function App() {
  const overview = useQuery(api.feed.overview);
  const [place, setPlace] = useState<Place>(() => parse(window.location.hash));
  const [page, setPage] = useState<Page>(() => pageOf(window.location.hash));
  useEffect(() => {
    const onHash = () => {
      setPlace(parse(window.location.hash));
      setPage(pageOf(window.location.hash));
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const navigate = useCallback((p: Place) => {
    window.location.hash = format(p);
    setPlace(p);
  }, []);

  if (page === "home") return <Landing />;
  if (page === "start") return <Onboarding />;
  if (overview === undefined) {
    return <main className="grid h-full place-items-center text-muted">Connecting to the company…</main>;
  }
  const desk = overview.channels.find((c) => c.name === "#founder-desk");
  const open = (thread: Id<"tasks">) => navigate({ view: place.view, thread });

  return (
    <RosterProvider agents={overview.agents}>
      <div className="flex h-full min-w-[1100px]">
        <Sidebar overview={overview} view={place.view} go={(view) => navigate({ view, thread: null })} />
        <main className="flex min-w-0 flex-1">
          {place.view.kind === "channel" ? (
            <ChannelView roomId={place.view.roomId} overview={overview} onOpen={open} selected={place.thread} />
          ) : place.view.kind === "rules" ? (
            <Rulebook onDesk={() => navigate({ view: { kind: "desk" }, thread: null })} />
          ) : desk ? (
            <Desk roomId={desk._id} overview={overview} onOpen={open} />
          ) : (
            <p className="p-8 text-muted">#founder-desk is not seeded. Run npx convex run seed:config.</p>
          )}
          {place.thread && place.view.kind !== "rules" ? <ThreadPane taskId={place.thread} onClose={() => navigate({ view: place.view, thread: null })} /> : null}
        </main>
      </div>
    </RosterProvider>
  );
}
