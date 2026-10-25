import "./landing.css";
import { OrgDiagram } from "./OrgDiagram";

// The landing page: the name, one line, and the company itself, with agents talking to each other on a loop.

// 7-row LED bitmap glyphs, one string per row.
const GLYPHS: Record<string, string[]> = {
  r: ["00000", "00000", "10110", "11001", "10000", "10000", "10000"],
  e: ["00000", "00000", "01110", "10001", "11111", "10000", "01110"],
  a: ["00000", "00000", "01110", "00001", "01111", "10001", "01111"],
  d: ["00001", "00001", "01111", "10001", "10001", "10001", "01111"],
  y: ["00000", "00000", "10001", "10001", "01111", "00001", "01110"],
  ".": ["0", "0", "0", "0", "0", "0", "1"],
};

function DotWord({ text }: { text: string }) {
  const pitch = 4;
  const r = 1.8;
  const dots: { x: number; y: number }[] = [];
  let x = 0;
  for (const ch of text) {
    const g = GLYPHS[ch];
    if (!g) continue;
    g.forEach((row, y) => [...row].forEach((bit, col) => bit === "1" && dots.push({ x: x + col * pitch + 1.55, y: y * pitch + 1.55 })));
    x += (g[0].length + 1) * pitch;
  }
  const w = x - pitch;
  return (
    <span className="lp-dotword" aria-label={text} style={{ width: `${(w / 28) * 0.8}em` }}>
      <svg viewBox={`0 0 ${w} 28`} aria-hidden="true">
        {dots.map((d, i) => (
          <circle key={i} cx={d.x} cy={d.y} r={r} />
        ))}
      </svg>
    </span>
  );
}

const POSTER_WIDE = "https://d2ol7oe51mr4n9.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/5c3ec08f-2dbf-4c0a-8588-f6106a789443.webp";
const VIDEO_WIDE = "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260826_125226_45cb4f38-aa7e-47e1-885d-ae0b69745369.mp4";
const POSTER_NARROW = "https://d2ol7oe51mr4n9.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/0f4926a4-e660-4df2-9195-2bfb3e341bdd.webp";
const VIDEO_NARROW = "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260826_125242_daae1570-386d-4bd5-8896-80499e2371e0.mp4";

export function Landing() {
  return (
    <main className="lp">
      <video className="lp-motion lp-motion--wide" autoPlay muted loop playsInline preload="auto" aria-hidden="true" poster={POSTER_WIDE} src={VIDEO_WIDE} />
      <video className="lp-motion lp-motion--narrow" autoPlay muted loop playsInline preload="none" aria-hidden="true" poster={POSTER_NARROW} src={VIDEO_NARROW} />

      {/* Stacked and centred on narrow screens; on a laptop the name sits left and Get started top-right, like the design's masthead. */}
      <header className="lp-hero">
        <div className="lp-hero__name">
          <h1 className="lp-title">CoFounder</h1>
          <p className="lp-slogan">
            Your team is <DotWord text="ready." />
          </p>
        </div>
        <div className="lp-hero__pitch">
          <a className="lp-btn lp-btn--primary lp-btn--start" href="#start">
            Get started <span aria-hidden="true">→</span>
          </a>
        </div>
      </header>

      <section className="lp-stage" aria-label="The company inside CoFounder">
        <OrgDiagram />
      </section>
    </main>
  );
}
