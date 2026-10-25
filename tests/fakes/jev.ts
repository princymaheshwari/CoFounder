// ---------------------------------------------------------------- fake Jev
// Mirrors POST /alpha/decisions as verified on 2026-10-24: a choice answers {type, choice, confidence,
// probabilities}, a noul answers {type, noul}; usage carries the dollar cost.

type Question = { type: "choice" | "noul"; instructions: string; criteria?: Record<string, string> };
type Answer = { type: "choice"; choice: string; confidence?: number } | { type: "noul"; noul: number };

export const isJev = (url: string | URL | Request) => String(url).includes("ai-gateway");

export class FakeJev {
  calls: { state: Record<string, unknown>; questions: Record<string, Question> }[] = [];
  answers: Record<string, Answer> = {}; // per question name, over the defaults below
  status = 200; // anything else fails every call with that status

  private answer(name: string, q: Question): Answer {
    if (this.answers[name]) return this.answers[name];
    if (q.type === "choice") return { type: "choice", choice: name === "refund_reason" ? "billing_error" : Object.keys(q.criteria ?? {})[0], confidence: 0.95 };
    return { type: "noul", noul: name === "grounded" ? 0.95 : 0.05 };
  }

  fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { state: Record<string, unknown>; questions: Record<string, Question> };
    this.calls.push(body);
    if (this.status !== 200) return new Response(JSON.stringify({ error: "UPSTREAM" }), { status: this.status });
    const answers = Object.fromEntries(Object.entries(body.questions).map(([name, q]) => [name, this.answer(name, q)]));
    return new Response(JSON.stringify({ id: `dec_${this.calls.length}`, model: "typesafe/jev-1.13", answers, usage: { input_tokens: 100, output_tokens: 5, cost: 0.00002 } }), { status: 200 });
  };
}
