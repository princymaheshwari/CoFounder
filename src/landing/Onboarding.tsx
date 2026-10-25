import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useState, type DragEvent, type FormEvent } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import "./landing.css";
import "./onboarding.css";

// Onboarding (#start): the founder describes the company, Cofounder plans the recurring work for each
// department (Claude, via onboarding.plan), and confirming opens one thread per task with a first live run.

type Doc = { name: string; excerpt: string };
type Task = { role: string; room: string; title: string; brief: string; trigger: "interval" | "event"; every_ms?: number; event_type?: string; cadence_label: string };
type Created = { recurringId: Id<"recurring">; taskId: Id<"tasks">; roomId: Id<"rooms">; room: string; title: string };
type Step = "form" | "planning" | "plan" | "creating" | "done";

// The demo company, ready to edit.
const EXAMPLE = {
  name: "Lumen Notes",
  what: "AI meeting notes for product teams. Lumen records calls, writes the summary and action items, and syncs them to calendars and task tools. One $35/month Pro plan, mostly self-serve teams of 5–50.",
  priorities: "Answer every support ticket within an hour. Catch billing problems before customers do. Keep monthly churn under 3%.",
  goals: "Grow Pro from 1,200 to 2,000 paying teams by March. Keep vendor spend under $4k a month. Post one product update a week on LinkedIn and Instagram.",
  links: ["https://lumennotes.example/pricing", "https://lumennotes.example/changelog"],
  docs: [
    {
      name: "Q4 priorities.md",
      excerpt: "Q4: reduce support load (billing tickets are 40% of volume), launch calendar sync, test Instagram reels for top-of-funnel. Watch competitor pricing; two rivals cut prices in September.",
    },
  ] as Doc[],
};

const COLUMNS = [
  { room: "#customer", dept: "customer", label: "Customer" },
  { room: "#finance", dept: "finance", label: "Finance" },
  { room: "#marketing", dept: "marketing", label: "Marketing" },
  { room: "#leadership", dept: "leadership", label: "Leadership" },
] as const;

const PLANNING_LINES = ["Reading what you do…", "Finding the work you repeat every week…", "Matching it to your departments…", "Setting how often each one runs…"];
const TEXT_FILE = /\.(txt|md|markdown|csv|json)$/i;
const humanRole = (role: string) => role.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

function Steps({ step }: { step: Step }) {
  const at = step === "form" ? 0 : step === "done" ? 2 : 1;
  return (
    <ol className="ob-steps" aria-label="Onboarding steps">
      {["Your company", "Your team's routine", "Ready"].map((s, i) => (
        <li key={s} className={i === at ? "on" : i < at ? "done" : ""} aria-current={i === at ? "step" : undefined}>
          <span>{i + 1}</span>
          {s}
        </li>
      ))}
    </ol>
  );
}

export function Onboarding() {
  const overview = useQuery(api.feed.overview);
  const planFn = useAction(api.onboarding.plan);
  const confirmFn = useMutation(api.onboarding.confirm);

  const [form, setForm] = useState({ name: EXAMPLE.name, what: EXAMPLE.what, priorities: EXAMPLE.priorities, goals: EXAMPLE.goals });
  const [links, setLinks] = useState<string[]>(EXAMPLE.links);
  const [link, setLink] = useState("");
  const [docs, setDocs] = useState<Doc[]>(EXAMPLE.docs);
  const [dragging, setDragging] = useState(false);
  const [step, setStep] = useState<Step>("form");
  const [line, setLine] = useState(0);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [source, setSource] = useState<"claude" | "fallback">("claude");
  const [off, setOff] = useState<Set<number>>(new Set());
  const [created, setCreated] = useState<Created[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (step !== "planning") return;
    const t = setInterval(() => setLine((l) => (l + 1) % PLANNING_LINES.length), 1600);
    return () => clearInterval(t);
  }, [step]);

  const agentName = (role: string) => overview?.agents.find((a) => a.role === role)?.name ?? humanRole(role);
  const input = () => ({ ...form, links, docs });

  const addLink = () => {
    const l = link.trim();
    if (l && !links.includes(l)) setLinks([...links, l]);
    setLink("");
  };
  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    const read = await Promise.all(
      [...files].slice(0, 5).map(async (f) => ({ name: f.name, excerpt: TEXT_FILE.test(f.name) ? (await f.text()).slice(0, 4000) : "" })),
    );
    setDocs((d) => [...d, ...read.filter((r) => !d.some((x) => x.name === r.name))].slice(0, 5));
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void addFiles(e.dataTransfer.files);
  };

  const build = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLine(0);
    setStep("planning");
    try {
      const res = await planFn({ input: input() });
      setTasks(res.tasks);
      setSource(res.source);
      setOff(new Set());
      setStep("plan");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep("form");
    }
  };
  const create = async () => {
    setError(null);
    setStep("creating");
    try {
      setCreated(await confirmFn({ input: input(), tasks: tasks.filter((_, i) => !off.has(i)) }));
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep("plan");
    }
  };
  const toggle = (i: number) => {
    const next = new Set(off);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setOff(next);
  };

  return (
    <main className="lp ob">
      <header className="ob-top">
        <a className="ob-brand" href="#home">
          CoFounder
        </a>
        <Steps step={step} />
      </header>

      {step === "form" ? (
        <form className="ob-card ob-form" onSubmit={(e) => void build(e)}>
          <div className="ob-intro">
            <h1>Tell your team about the company.</h1>
            <p>Cofounder reads this, finds the work you repeat, and gives every department its own recurring threads. You only hear about what no rule covers.</p>
          </div>
          <div className="ob-cols">
            <div className="ob-col">
              <label className="ob-field">
                <span>Company name</span>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </label>
              <label className="ob-field">
                <span>What do you do?</span>
                <textarea rows={3} value={form.what} onChange={(e) => setForm({ ...form, what: e.target.value })} required />
              </label>
              <label className="ob-field">
                <span>Priorities this quarter</span>
                <textarea rows={2} value={form.priorities} onChange={(e) => setForm({ ...form, priorities: e.target.value })} />
              </label>
              <label className="ob-field">
                <span>Goals</span>
                <textarea rows={2} value={form.goals} onChange={(e) => setForm({ ...form, goals: e.target.value })} />
              </label>
            </div>
            <div className="ob-col">
              <div className="ob-field">
                <span>Links</span>
                <div className="ob-linkrow">
                  <input
                    type="url"
                    placeholder="https://"
                    value={link}
                    onChange={(e) => setLink(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addLink();
                      }
                    }}
                  />
                  <button type="button" className="lp-btn" onClick={addLink}>
                    Add
                  </button>
                </div>
                <div className="ob-chips">
                  {links.map((l) => (
                    <span key={l} className="ob-chip">
                      {l.replace(/^https?:\/\//, "")}
                      <button type="button" aria-label={`Remove ${l}`} onClick={() => setLinks(links.filter((x) => x !== l))}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              </div>
              <div className="ob-field">
                <span>Documents</span>
                <label
                  className={`ob-drop${dragging ? " is-over" : ""}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={onDrop}
                >
                  <input type="file" multiple onChange={(e) => void addFiles(e.target.files)} />
                  <b>Drop a plan, a handbook or a pricing sheet</b>
                  <small>or click to choose · text files are read, others are attached by name</small>
                </label>
                <div className="ob-chips">
                  {docs.map((d) => (
                    <span key={d.name} className="ob-chip ob-chip--doc">
                      {d.name}
                      <button type="button" aria-label={`Remove ${d.name}`} onClick={() => setDocs(docs.filter((x) => x.name !== d.name))}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              </div>
              <div className="ob-submit">
                {error ? <p className="ob-error">{error}</p> : null}
                <button type="submit" className="lp-btn lp-btn--primary lp-btn--start">
                  Build my team <span aria-hidden="true">→</span>
                </button>
              </div>
            </div>
          </div>
        </form>
      ) : (
        <section className="ob-card ob-plan" aria-live="polite">
          <div className="ob-plan__head">
            <div>
              <h1>{step === "done" ? "Your team is running." : step === "planning" ? "Cofounder is planning your team…" : "Here is your team's routine."}</h1>
              <p>
                {step === "planning"
                  ? PLANNING_LINES[line]
                  : step === "done"
                    ? "Each recurring task has a thread in its channel. The Dispatcher just started the first run of each one on a live agent."
                    : source === "claude"
                      ? "The main cofounder agent finds the recurring tasks to automate and assigns them to relevant employees. UNSELECT any task you don't want to get automated."
                      : "Cofounder couldn't reach the planner, so this is the starter plan. Untick anything you don't want."}
              </p>
            </div>
            {step === "plan" || step === "creating" ? (
              <div className="ob-plan__actions">
                <button type="button" className="lp-btn" onClick={() => setStep("form")}>
                  Back
                </button>
                <button type="button" className="lp-btn lp-btn--primary lp-btn--start" disabled={step === "creating" || off.size === tasks.length} onClick={() => void create()}>
                  {step === "creating" ? "Opening threads…" : "Create recurring threads"} <span aria-hidden="true">→</span>
                </button>
              </div>
            ) : step === "done" ? (
              <div className="ob-plan__actions">
                <a className="lp-btn lp-btn--primary lp-btn--start" href="#desk">
                  Open the founder desk <span aria-hidden="true">→</span>
                </a>
              </div>
            ) : null}
          </div>
          {error ? <p className="ob-error">{error}</p> : null}

          <div className="ob-board">
            {COLUMNS.map((c) => {
              const items = tasks.map((t, i) => ({ t, i })).filter(({ t }) => t.room === c.room);
              return (
                <div key={c.room} className={`ob-dept ob-dept--${c.dept}`}>
                  <div className="ob-dept__head">
                    <span>{c.label.toUpperCase()}</span>
                    <span>{c.room}</span>
                  </div>
                  {step === "planning" ? (
                    <>
                      <div className="ob-task ob-task--ghost" />
                      <div className="ob-task ob-task--ghost" />
                    </>
                  ) : items.length ? (
                    items.map(({ t, i }) => {
                      const done = created.find((x) => x.title === t.title && x.room === t.room);
                      const skipped = off.has(i);
                      return (
                        <article key={i} className={`ob-task${skipped ? " is-off" : ""}`} style={{ animationDelay: `${i * 0.08}s` }}>
                          <div className="ob-task__top">
                            <span className="ob-owner">{agentName(t.role)}</span>
                            <span className="ob-cadence">{t.cadence_label}</span>
                          </div>
                          <h3>{t.title}</h3>
                          <p>{t.brief}</p>
                          {step === "done" ? (
                            done ? (
                              <a className="ob-open" href={`#c/${done.roomId}/t/${done.taskId}`}>
                                <i className="ob-live" aria-hidden="true" /> First run started · open thread →
                              </a>
                            ) : (
                              <span className="ob-open is-muted">Skipped</span>
                            )
                          ) : (
                            <label className="ob-keep">
                              <input type="checkbox" checked={!skipped} onChange={() => toggle(i)} disabled={step === "creating"} /> Keep
                            </label>
                          )}
                        </article>
                      );
                    })
                  ) : (
                    <p className="ob-empty">Nothing recurring here yet.</p>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </main>
  );
}
