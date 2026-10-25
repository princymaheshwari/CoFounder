import { useEffect, useRef, useState } from "react";
import { NODE_IDS, STORIES, node, type NodeId, type OrgNode, type Step } from "./org";

// The landing-page org chart. Static org lines, plus a story that plays on a loop: each message between agents
// is drawn as a moving arrow with a packet travelling along it, and the last few stay on screen as a trail.

const STEP_MS = 2600;
const HOLD_MS = 1800; // pause on the last step before the next story starts
const TRAIL = 3;

const reduceMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const PANELS = [
  { x: 30, y: 246, w: 260, h: 259, fill: "url(#lp-g-mkt)", name: "MARKETING", ch: "#marketing", light: true },
  { x: 315, y: 246, w: 260, h: 259, fill: "url(#lp-g-cus)", name: "CUSTOMER", ch: "#customer", light: true },
  { x: 600, y: 246, w: 260, h: 259, fill: "url(#lp-g-fin)", name: "FINANCE", ch: "#finance", light: true },
  { x: 885, y: 20, w: 205, h: 485, fill: "rgba(255,255,255,.42)", name: "CONTROL PLANE", ch: "no channel", light: false },
];

const KIND_LABEL = { agent: "Creao agent", code: "Convex code", human: "Human", ext: "External service" } as const;

// Point on the node's border (plus a little air) in the direction of (tx, ty).
function clip(n: OrgNode, tx: number, ty: number): [number, number] {
  const dx = tx - n.x;
  const dy = ty - n.y;
  const hw = n.w / 2 + 6;
  const hh = n.h / 2 + 6;
  const k = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return [n.x + dx * k, n.y + dy * k];
}

// The headline numbers in the top-right corner; arrows route around them too.
const STATS_BOX = { x0: 672, x1: 878, y0: 46, y1: 176 };

// Does the quadratic curve pass through any node other than its two ends?
function crossesOthers(from: NodeId, to: NodeId, x1: number, y1: number, cx: number, cy: number, x2: number, y2: number) {
  for (let i = 2; i <= 18; i++) {
    const t = i / 20;
    const x = (1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * cx + t * t * x2;
    const y = (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * cy + t * t * y2;
    if (x > STATS_BOX.x0 && x < STATS_BOX.x1 && y > STATS_BOX.y0 && y < STATS_BOX.y1) return true;
    for (const id of NODE_IDS) {
      if (id === from || id === to) continue;
      const n = node(id);
      if (Math.abs(x - n.x) < n.w / 2 + 4 && Math.abs(y - n.y) < n.h / 2 + 4) return true;
    }
  }
  return false;
}

// A gently bent arrow between two nodes, and where its label chip sits. Bends further to go around nodes in its way.
function arrow(from: NodeId, to: NodeId) {
  const a = node(from);
  const b = node(to);
  const [x1, y1] = clip(a, b.x, b.y);
  const [x2, y2] = clip(b, a.x, a.y);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const base = Math.min(36, len * 0.14);
  const control = (bend: number) => [(x1 + x2) / 2 - (dy / len) * bend, (y1 + y2) / 2 + (dx / len) * bend];
  let [cx, cy] = control(base);
  for (const bend of [base, -base, 90, -90, 150, -150, 210, -210]) {
    const [bx, by] = control(bend);
    if (!crossesOthers(from, to, x1, y1, bx, by, x2, y2)) {
      [cx, cy] = [bx, by];
      break;
    }
  }
  return { d: `M${x1} ${y1} Q${cx} ${cy} ${x2} ${y2}`, mx: 0.25 * x1 + 0.5 * cx + 0.25 * x2, my: 0.25 * y1 + 0.5 * cy + 0.25 * y2, len };
}

const touchesFounder = (s: Step) => s.from === "founder" || s.to === "founder";

function Arrow({ step, age }: { step: Step; age: number }) {
  const pathRef = useRef<SVGPathElement>(null);
  const dotRef = useRef<SVGCircleElement>(null);
  const a = step.from && step.to ? arrow(step.from, step.to) : null;

  // The packet loops along the path for as long as the arrow is on screen.
  useEffect(() => {
    const p = pathRef.current;
    const c = dotRef.current;
    if (!p || !c || reduceMotion()) return;
    const total = p.getTotalLength();
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = ((now - t0) % 1400) / 1400;
      const pt = p.getPointAtLength((1 - Math.pow(1 - t, 2)) * total);
      c.setAttribute("cx", String(pt.x));
      c.setAttribute("cy", String(pt.y));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [a?.d]);

  if (!a) return null;
  const hot = touchesFounder(step);
  return (
    <g className={`lp-msg${hot ? " lp-msg--founder" : ""}`} style={{ opacity: age === 0 ? 1 : age === 1 ? 0.5 : 0.22 }}>
      <path d={a.d} className="lp-msg__halo" />
      <path ref={pathRef} d={a.d} className="lp-msg__line" markerEnd={hot ? "url(#lp-arr-hot)" : "url(#lp-arr)"} />
      <circle ref={dotRef} r={age === 0 ? 4.6 : 3.4} className="lp-msg__packet" cx={-20} cy={-20} />
    </g>
  );
}

function Chip({ step }: { step: Step }) {
  let cx: number;
  let cy: number;
  if (step.at) {
    const n = node(step.at);
    cx = n.x;
    cy = n.y - n.h / 2 - 15;
  } else if (step.from && step.to) {
    const a = arrow(step.from, step.to);
    cx = a.mx;
    cy = a.my;
    // Short arrows: move the label beside the line so it doesn't cover the arrowhead.
    if (a.len < 80) cx += step.tag.length * 3.5 + 24;
  } else return null;
  const w = step.tag.length * 7 + 18;
  return (
    <g className={`lp-chip${touchesFounder(step) ? " lp-chip--founder" : ""}`}>
      <rect x={cx - w / 2} y={cy - 11.5} width={w} height={23} rx={6} />
      <text x={cx} y={cy + 4} textAnchor="middle">
        {step.tag}
      </text>
    </g>
  );
}

function Node({ id, hot, selected, onPick }: { id: NodeId; hot: boolean; selected: boolean; onPick: (id: NodeId) => void }) {
  const n = node(id);
  const cls = ["lp-node", `k-${n.kind}`, n.dept ? `d-${n.dept}` : "", n.mgr ? "mgr" : "", hot ? "hot" : "", selected ? "sel" : ""].join(" ");
  return (
    <g
      className={cls}
      tabIndex={0}
      role="button"
      aria-label={`${n.label}: ${n.sub}`}
      onClick={() => onPick(id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick(id);
        }
      }}
    >
      <rect x={n.x - n.w / 2} y={n.y - n.h / 2} width={n.w} height={n.h} rx={10} />
      <text x={n.x} y={n.y - 4} className="t" textAnchor="middle">
        {n.label}
      </text>
      <text x={n.x} y={n.y + 13} className="s" textAnchor="middle">
        {n.sub}
      </text>
    </g>
  );
}

export function OrgDiagram() {
  // seq bumps on every step so a new arrow mounts while the trail arrows keep their packets running.
  const [at, setAt] = useState({ story: 0, step: 0, seq: 0 });
  const [playing, setPlaying] = useState(() => !reduceMotion());
  const [selected, setSelected] = useState<NodeId | null>(null);
  const { story, step, seq } = at;

  const steps = STORIES[story].steps;
  const last = step === steps.length - 1;
  const go = (nextStory: number, nextStep: number) => setAt((p) => ({ story: nextStory, step: nextStep, seq: p.seq + 1 }));
  const next = () => (last ? go((story + 1) % STORIES.length, 0) : go(story, step + 1));

  useEffect(() => {
    if (!playing || selected) return;
    const t = setTimeout(() => setAt((p) => {
      const n = STORIES[p.story].steps.length;
      return p.step < n - 1 ? { ...p, step: p.step + 1, seq: p.seq + 1 } : { story: (p.story + 1) % STORIES.length, step: 0, seq: p.seq + 1 };
    }), last ? STEP_MS + HOLD_MS : STEP_MS);
    return () => clearTimeout(t);
  }, [playing, selected, seq, last]);

  const current = steps[step];
  const trail = steps.slice(Math.max(0, step - TRAIL + 1), step + 1).reverse(); // newest first
  const hotIds = new Set<NodeId>(current.at ? [current.at] : [current.from!, current.to!]);
  const done = steps.slice(0, step + 1);
  const agentMessages = done.filter((s) => s.from && s.to && !touchesFounder(s)).length;
  const founderAsks = done.filter((s) => s.to === "founder").length;

  const pickStory = (i: number) => {
    setSelected(null);
    go(i, 0);
    setPlaying(true);
  };
  const advance = () => {
    setSelected(null);
    next();
  };
  const sel = selected ? node(selected) : null;

  return (
    <div className="lp-org">
      <div className="lp-org__scroll">
        <svg className="lp-svg" viewBox="0 0 1100 515" role="img" aria-labelledby="lp-svg-title lp-svg-desc">
          <title id="lp-svg-title">Cofounder agent org chart</title>
          <desc id="lp-svg-desc">
            The founder sits above the Cofounder agent, which leads Marketing, Customer and Finance departments, each with a manager and two employee agents. On the right, Convex code (the
            Dispatcher and the Authority gate) routes every run and decides every action; the Executor agent and Capital One Nessie carry out approved actions; Apify feeds signals in.
          </desc>
          <defs>
            <linearGradient id="lp-g-mkt" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#bd4468" />
              <stop offset=".38" stopColor="#ad355b" />
              <stop offset=".72" stopColor="#a63b50" />
              <stop offset="1" stopColor="#8c1320" />
            </linearGradient>
            <linearGradient id="lp-g-cus" x1=".2" y1="0" x2=".8" y2="1">
              <stop offset="0" stopColor="#c9b5e1" />
              <stop offset=".29" stopColor="#ad80ca" />
              <stop offset=".64" stopColor="#9d4f72" />
              <stop offset="1" stopColor="#793246" />
            </linearGradient>
            <linearGradient id="lp-g-fin" x1="0" y1="0" x2=".1" y2="1">
              <stop offset="0" stopColor="#d84736" />
              <stop offset=".24" stopColor="#dd523c" />
              <stop offset=".52" stopColor="#e8703d" />
              <stop offset=".78" stopColor="#de5641" />
              <stop offset="1" stopColor="#d34239" />
            </linearGradient>
            <linearGradient id="lp-g-lead" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#c0436a" />
              <stop offset=".55" stopColor="#ad314d" />
              <stop offset="1" stopColor="#6e1639" />
            </linearGradient>
            <radialGradient id="lp-g-sheen" cx=".5" cy="0" r=".9">
              <stop offset="0" stopColor="#fff" stopOpacity=".34" />
              <stop offset=".6" stopColor="#fff" stopOpacity="0" />
            </radialGradient>
            <filter id="lp-noise" x="0" y="0" width="100%" height="100%">
              <feTurbulence type="fractalNoise" baseFrequency=".54" numOctaves="3" seed="27" stitchTiles="stitch" />
              <feColorMatrix type="saturate" values="0" />
              <feComponentTransfer>
                <feFuncR type="linear" slope="1.8" intercept="-.25" />
                <feFuncG type="linear" slope="1.8" intercept="-.25" />
                <feFuncB type="linear" slope="1.8" intercept="-.25" />
                <feFuncA type="table" tableValues="0 .52" />
              </feComponentTransfer>
            </filter>
            {PANELS.slice(0, 3).map((p) => (
              <clipPath id={`lp-clip-${p.name}`} key={p.name}>
                <rect x={p.x} y={p.y} width={p.w} height={p.h} rx={16} />
              </clipPath>
            ))}
            <marker id="lp-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M1.5 1.5L8 5L1.5 8.5" fill="none" stroke="#202020" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </marker>
            <marker id="lp-arr-hot" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M1.5 1.5L8 5L1.5 8.5" fill="none" stroke="#ad314d" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </marker>
            <marker id="lp-arr-edge" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M1.5 1.5L8 5L1.5 8.5" fill="none" stroke="rgba(34,34,34,.4)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </marker>
          </defs>

          {/* Department and control-plane panels: the three department colours are the glass cards' gradients. */}
          {PANELS.map((p) => (
            <g key={p.name} className={p.light ? "lp-panel lp-panel--dept" : "lp-panel lp-panel--code"}>
              <rect x={p.x} y={p.y} width={p.w} height={p.h} rx={16} style={{ fill: p.fill }} className="lp-panel__bg" />
              {p.light ? (
                <g clipPath={`url(#lp-clip-${p.name})`}>
                  <rect x={p.x} y={p.y} width={p.w} height={p.h} fill="url(#lp-g-sheen)" />
                  <rect x={p.x} y={p.y} width={p.w} height={p.h} filter="url(#lp-noise)" className="lp-grain" />
                </g>
              ) : null}
              <text x={p.x + 16} y={p.y + 23} className="lp-panel__name">
                {p.name}
              </text>
              <text x={p.x + p.w - 16} y={p.y + 23} className="lp-panel__ch" textAnchor="end">
                {p.ch}
              </text>
            </g>
          ))}

          {/* Legend and headline numbers fill the open corners above the departments. */}
          <g className="lp-legend" transform="translate(40 44)">
            <text className="lp-legend__head">READING THE ORG</text>
            {[
              { y: 26, swatch: <rect width="18" height="12" rx="3" fill="url(#lp-g-mkt)" stroke="rgba(255,255,255,.6)" />, label: "Creao agent, by department" },
              { y: 50, swatch: <rect width="18" height="12" rx="3" fill="rgba(255,255,255,.8)" stroke="#4a4a4a" strokeDasharray="3 2" />, label: "Convex code (not an LLM)" },
              { y: 74, swatch: <rect width="18" height="12" rx="3" fill="#202020" />, label: "Human" },
              { y: 98, swatch: <rect width="18" height="12" rx="3" fill="rgba(236,236,234,.9)" stroke="rgba(34,34,34,.3)" />, label: "External service" },
              { y: 122, swatch: <path d="M0 6H16" stroke="#ad314d" strokeWidth="2" strokeDasharray="4 3" />, label: "Needs the founder" },
            ].map((r) => (
              <g key={r.label} transform={`translate(0 ${r.y})`}>
                {r.swatch}
                <text x="28" y="10">
                  {r.label}
                </text>
              </g>
            ))}
          </g>
          <g className="lp-stats">
            {[
              { x: 680, y: 74, n: "11", l: "Creao agents" },
              { x: 800, y: 74, n: "3", l: "departments" },
              { x: 680, y: 148, n: "7", l: "message kinds" },
              { x: 800, y: 148, n: "1", l: "founder" },
            ].map((s) => (
              <g key={s.l}>
                <text x={s.x} y={s.y} className="lp-stats__n">
                  {s.n}
                </text>
                <text x={s.x} y={s.y + 20} className="lp-stats__l">
                  {s.l}
                </text>
              </g>
            ))}
          </g>

          {/* Static org lines. */}
          <g className="lp-edges">
            <path d="M445 75 V131" />
            <path d="M445 189 V228 M160 228 H730 M160 228 V291 M445 228 V291 M730 228 V291" />
            <path d="M987 112 V151" markerEnd="url(#lp-arr-edge)" />
            <path d="M987 207 V246" markerEnd="url(#lp-arr-edge)" />
            <path d="M987 302 V341" markerEnd="url(#lp-arr-edge)" />
            <path d="M1067 275 H1078 V465 H1070" markerEnd="url(#lp-arr-edge)" />
            <path d="M907 180 H872 V490" className="dash" />
            <text x="454" y="107">
              #founder-desk
            </text>
            <text x="454" y="221">
              #leadership
            </text>
            <text x="879" y="340" textAnchor="middle" transform="rotate(-90 879 340)">
              ASSIGN / reply
            </text>
          </g>
          <g className="lp-edges lp-edges--team">
            {[160, 445, 730].map((c) => (
              <path key={c} d={`M${c} 345 V378 M${c - 63} 378 H${c + 63} M${c - 63} 378 V402 M${c + 63} 378 V402`} />
            ))}
          </g>

          {/* Messages in flight sit under the nodes; their chips sit on top. */}
          <g>
            {trail.map((s, i) => (
              <Arrow key={seq - i} step={s} age={i} />
            ))}
          </g>
          {current.at ? (
            <rect
              key={`pulse${seq}`}
              className="lp-pulse"
              x={node(current.at).x - node(current.at).w / 2 - 4}
              y={node(current.at).y - node(current.at).h / 2 - 4}
              width={node(current.at).w + 8}
              height={node(current.at).h + 8}
              rx={13}
            />
          ) : null}
          <g>
            {NODE_IDS.map((id) => (
              <Node key={id} id={id} hot={hotIds.has(id)} selected={selected === id} onPick={(n) => setSelected(n === selected ? null : n)} />
            ))}
          </g>
          <Chip key={seq} step={current} />
        </svg>
      </div>

      <div className="lp-bar" aria-live="polite">
        {sel ? (
          <div className="lp-detail">
            <div className="lp-detail__head">
              <span className={`lp-kind lp-kind--${sel.kind}`}>{KIND_LABEL[sel.kind]}</span>
              <b>{sel.label}</b>
              <span className="lp-detail__sub">{sel.sub}</span>
              <button type="button" className="lp-iconbtn" aria-label="Close and resume the story" onClick={() => setSelected(null)}>
                ×
              </button>
            </div>
            <p>{sel.job}</p>
            <div className="lp-detail__chips">
              {sel.channels !== undefined ? (
                sel.channels.length ? (
                  sel.channels.map((c) => (
                    <span key={c} className="lp-mono">
                      {c}
                    </span>
                  ))
                ) : (
                  <span className="lp-mono">no channel · API only</span>
                )
              ) : null}
              {sel.emits.map((e) => (
                <span key={e} className="lp-mono lp-mono--emit">
                  {e}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div className="lp-stories" role="group" aria-label="Stories">
              {STORIES.map((s, i) => (
                <button key={s.id} type="button" className="lp-pill" aria-pressed={i === story} onClick={() => pickStory(i)}>
                  {s.name}
                </button>
              ))}
            </div>
            <div className="lp-narr">
              <div className="lp-narr__meta">
                <span>
                  {STORIES[story].title} · step {step + 1} of {steps.length}
                </span>
                <span className="lp-progress" aria-hidden="true">
                  {steps.map((_, i) => (
                    <i key={i} className={i === step ? "on" : i < step ? "done" : ""} />
                  ))}
                </span>
              </div>
              <p>
                <span className={`lp-tag${touchesFounder(current) ? " lp-tag--founder" : ""}`}>{current.tag}</span>
                {current.text}
              </p>
            </div>
            <div className="lp-count">
              <div>
                <b>{agentMessages}</b>
                <span>agent messages</span>
              </div>
              <div className={founderAsks ? "is-asked" : ""}>
                <b>{founderAsks}</b>
                <span>asked of you</span>
              </div>
              <div className="lp-ctrls">
                <button type="button" className="lp-iconbtn" aria-label={playing ? "Pause" : "Play"} onClick={() => setPlaying(!playing)}>
                  {playing ? "❚❚" : "▶"}
                </button>
                <button type="button" className="lp-iconbtn" aria-label="Next step" onClick={advance}>
                  →
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
