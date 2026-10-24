import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

// Placeholder until the founder app pages land (docs/specs/14-founder-app.md).
export default function App() {
  const health = useQuery(api.health.ping);

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-4xl font-bold">Cofounder</h1>
      <p className="text-slate-500">Lumen Notes, run by agents.</p>
      <p className="text-sm font-mono">
        Convex:{" "}
        {health === undefined
          ? "connecting…"
          : health.ok
            ? "connected"
            : "error"}
      </p>
    </main>
  );
}
