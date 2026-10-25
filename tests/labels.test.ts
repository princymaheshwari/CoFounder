import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { jevState, questionsFor, requiredLabels, toLabels, type JevQuestions } from "../convex/lib/labelSpecs";
import type { ActionType } from "../convex/lib/types";
import { FakeJev, isJev } from "./fakes/jev";

const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- pure

describe("questionsFor", () => {
  test("the spec 11 question set per action type", () => {
    expect(Object.keys(questionsFor("refund", false))).toEqual(["refund_reason"]);
    expect(Object.keys(questionsFor("refund_batch", false))).toEqual(["refund_reason"]);
    expect(Object.keys(questionsFor("publish_post", false))).toEqual(["mentions_pricing", "mentions_competitor"]);
    expect(Object.keys(questionsFor("reply_customer", false))).toEqual(["makes_commitment"]);
    expect(questionsFor("file_bug", false)).toEqual({});
    expect(questionsFor("refund", false).refund_reason).toMatchObject({ type: "choice", criteria: { defect: expect.any(String), billing_error: expect.any(String), changed_mind: expect.any(String), abuse: expect.any(String) } });
  });

  test("grounded is asked of any action whose envelope had findings", () => {
    expect(Object.keys(questionsFor("file_bug", true))).toEqual(["grounded"]);
    expect(Object.keys(questionsFor("refund", true))).toEqual(["refund_reason", "grounded"]);
  });

  test("required labels exclude grounded", () => {
    expect(requiredLabels("publish_post")).toEqual(["mentions_pricing", "mentions_competitor"]);
    expect(requiredLabels("pay_bill")).toEqual([]);
  });
});

describe("toLabels", () => {
  const q: JevQuestions = { ...questionsFor("refund", false), ...questionsFor("publish_post", true) };

  test("choice → {value, confidence}; noul → {value: noul >= 0.5, confidence: max(noul, 1 - noul)}", () => {
    const out = toLabels(q, {
      refund_reason: { type: "choice", choice: "billing_error", confidence: 0.93, probabilities: { billing_error: 0.93 } },
      mentions_pricing: { type: "noul", noul: 0.99 },
      mentions_competitor: { type: "noul", noul: 0.1 },
      grounded: { type: "noul", noul: 0.5 },
    });
    expect(out.missing).toEqual([]);
    expect(out.labels.refund_reason).toEqual({ value: "billing_error", confidence: 0.93 });
    expect(out.labels.mentions_pricing).toEqual({ value: true, confidence: 0.99 });
    expect(out.labels.mentions_competitor).toEqual({ value: false, confidence: 0.9 });
    expect(out.labels.grounded).toEqual({ value: true, confidence: 0.5 });
  });

  test("a choice without confidence uses the chosen option's probability", () => {
    expect(toLabels(q, { refund_reason: { type: "choice", choice: "defect", probabilities: { defect: 0.82, abuse: 0.18 } } }).labels.refund_reason).toEqual({ value: "defect", confidence: 0.82 });
  });

  test("absent, mistyped or out-of-criteria answers are missing", () => {
    const out = toLabels(q, { refund_reason: { type: "choice", choice: "fraud", confidence: 0.99 }, mentions_pricing: { type: "noul", noul: "yes" } });
    expect(out.missing).toEqual(["refund_reason", "mentions_pricing", "mentions_competitor", "grounded"]);
    expect(toLabels(q, null).missing).toHaveLength(4);
  });
});

describe("jevState", () => {
  test("params, rationale, tickets, customers and findings; long text is clipped", () => {
    const state = jevState({
      action: { type: "refund", role: "support", params: { amount_cents: 3500 }, rationale: "Charged twice." },
      tickets: [{ subject: "Charged twice", body: "x".repeat(5_000) }],
      customers: [{ plan: "Pro", tenure_days: 120 }],
    });
    expect(state).toMatchObject({ action: { type: "refund", proposed_by: "support", params: { amount_cents: 3500 }, rationale: "Charged twice." }, customers: [{ plan: "Pro", tenure_days: 120 }] });
    expect((state.tickets as { body: string }[])[0].body).toHaveLength(1_500);
    expect(state).not.toHaveProperty("findings");
  });
});

// ---------------------------------------------------------------- labelActions

function setup() {
  return convexTest(schema, import.meta.glob("../convex/**/*.ts"));
}
type T = ReturnType<typeof setup>;

let jev: FakeJev;
let other: string[];
beforeEach(() => {
  vi.useFakeTimers(); // keeps the gate's scheduled executions from running
  jev = new FakeJev();
  other = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (isJev(url)) return jev.fetch(url, init);
      other.push(String(url));
      throw new TypeError(`error sending request for url (${String(url)})`);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function world(t: T) {
  await t.mutation(internal.seed.config, {});
  return await t.run(async (ctx) => {
    const room = (await ctx.db.query("rooms").withIndex("by_name", (q) => q.eq("name", "#customer")).unique())!;
    const now = Date.now();
    const taskId = await ctx.db.insert("tasks", {
      role: "support",
      room: room._id,
      kind: "work",
      brief: "Handle a refund ticket.",
      chain_id: "chain-1",
      hop: 0,
      attempt: 1,
      status: "gated",
      origin_refs: [],
      deadline: now + DAY,
      mode: "live",
      created_at: now,
      updated_at: now,
    });
    const customer = await ctx.db.insert("customers", { name: "Loyal", email: "loyal@example.com", nessie_customer_id: "n-1", nessie_account_id: "a-1", signup_at: now - 120 * DAY, plan: "Pro" });
    const ticket = await ctx.db.insert("tickets", {
      customer,
      from_email: "loyal@example.com",
      subject: "Charged twice",
      body: "My card was charged $35 twice on October 1st.",
      amount_cents: 3500,
      status: "open",
      source: "seed",
      created_at: now,
    });
    return { taskId, room: room._id, customer, ticket };
  });
}

async function propose(t: T, taskId: Id<"tasks">, type: ActionType, params: Record<string, unknown>): Promise<Id<"actions">> {
  return t.run((ctx) =>
    ctx.db.insert("actions", { task: taskId, chain_id: "chain-1", role: "support", type, params, rationale: "Customer was double charged.", status: "proposed", created_at: Date.now() }),
  );
}

const getAction = (t: T, id: Id<"actions">) => t.run(async (ctx) => (await ctx.db.get(id))!);
const labelAudit = (t: T) => t.run(async (ctx) => (await ctx.db.query("audit_log").collect()).filter((r) => r.kind === "labels"));
const label = (t: T, actionIds: Id<"actions">[]) => t.action(internal.labels.labelActions, { actionIds, then: { kind: "gate" } });

describe("labelActions", () => {
  test("a double-charge refund: Jev sees the ticket and customer, labels are stored, R7 allows it", async () => {
    const t = setup();
    const w = await world(t);
    const id = await propose(t, w.taskId, "refund", { customer_id: w.customer, ticket_id: w.ticket, amount_cents: 3500, reason: "billing_error" });
    await label(t, [id]);

    expect(jev.calls).toHaveLength(1);
    const { state, questions } = jev.calls[0];
    expect(Object.keys(questions)).toEqual(["refund_reason"]);
    expect(state).toMatchObject({
      action: { type: "refund", rationale: "Customer was double charged." },
      tickets: [{ subject: "Charged twice", body: "My card was charged $35 twice on October 1st.", amount_cents: 3500 }],
      customers: [{ plan: "Pro", tenure_days: 120 }],
    });
    expect(JSON.stringify(state)).not.toContain("loyal@example.com"); // no emails go to Jev

    const action = await getAction(t, id);
    expect(action.labels).toEqual({ refund_reason: { value: "billing_error", confidence: 0.95 } });
    expect(action.label_error).toBeUndefined();
    expect(action).toMatchObject({ status: "allowed", gate: { effect: "allow", reason: "rule:allow" } });
    expect((await labelAudit(t))[0].detail).toMatchObject({ actionId: id, model: "typesafe/jev-1.13", cost_usd: 0.00002, error: null });
  });

  test("a label below 0.8 confidence escalates labels:low_confidence", async () => {
    const t = setup();
    const w = await world(t);
    jev.answers.refund_reason = { type: "choice", choice: "billing_error", confidence: 0.6 };
    const id = await propose(t, w.taskId, "refund", { customer_id: w.customer, amount_cents: 3500 });
    await label(t, [id]);
    expect(await getAction(t, id)).toMatchObject({ status: "escalated", gate: { reason: "labels:low_confidence" } });
  });

  test("a gateway 5xx is retried once, then label_error escalates; nothing throws", async () => {
    const t = setup();
    const w = await world(t);
    jev.status = 502;
    const id = await propose(t, w.taskId, "publish_post", { channel: "linkedin", text: "Pro is $35/month." });
    await label(t, [id]);
    expect(jev.calls).toHaveLength(2);
    const action = await getAction(t, id);
    expect(action.label_error).toContain("jev: http 502");
    expect(action.label_error).not.toContain("test-gateway-token");
    expect(action).toMatchObject({ status: "escalated", gate: { effect: "escalate", reason: "labels:low_confidence" } });
    expect((await labelAudit(t))[0].detail).toMatchObject({ error: expect.stringContaining("502"), cost_usd: null });
  });

  test("a 4xx is not retried", async () => {
    const t = setup();
    const w = await world(t);
    jev.status = 400;
    const id = await propose(t, w.taskId, "reply_customer", { ticket_id: w.ticket, body: "Refund on the way." });
    await label(t, [id]);
    expect(jev.calls).toHaveLength(1);
    expect(await getAction(t, id)).toMatchObject({ status: "escalated", gate: { reason: "labels:low_confidence" } });
  });

  test("a broken gateway URL escalates every action", async () => {
    const t = setup();
    const w = await world(t);
    vi.stubEnv("AI_GATEWAY_URL", "https://broken.invalid");
    const id = await propose(t, w.taskId, "publish_post", { channel: "linkedin", text: "Hello" });
    await label(t, [id]);
    expect(jev.calls).toHaveLength(0);
    expect(other).toEqual(["https://broken.invalid/alpha/decisions", "https://broken.invalid/alpha/decisions"]);
    expect(await getAction(t, id)).toMatchObject({ status: "escalated", gate: { reason: "labels:low_confidence" } });
  });

  test("a missing answer sets label_error", async () => {
    const t = setup();
    const w = await world(t);
    jev.answers.mentions_competitor = { type: "choice", choice: "maybe" };
    const id = await propose(t, w.taskId, "publish_post", { channel: "linkedin", text: "Hello" });
    await label(t, [id]);
    const action = await getAction(t, id);
    expect(action.label_error).toBe("jev: no usable answer for mentions_competitor");
    expect(action.labels).toEqual({ mentions_pricing: { value: false, confidence: 0.95 } });
    expect(action.gate?.reason).toBe("labels:low_confidence");
  });

  test("an action Jev asks nothing about is gated without a call", async () => {
    const t = setup();
    const w = await world(t);
    const id = await propose(t, w.taskId, "file_bug", { title: "Double charge", body: "x", severity: "high" });
    await label(t, [id]);
    expect(jev.calls).toHaveLength(0);
    expect(await getAction(t, id)).toMatchObject({ status: "escalated", gate: { reason: "novelty:new_type" } });
  });

  test("findings in the carrying reply add grounded, with the cited message's text as evidence", async () => {
    const t = setup();
    const w = await world(t);
    await t.run(async (ctx) => {
      const base = { room: w.room, created_at: Date.now() };
      await ctx.db.insert("messages", { ...base, seq: 7, sender_kind: "agent", sender_name: "Ledger", text: "Two $35 renewals on Oct 1 for a-1." });
      await ctx.db.insert("messages", {
        ...base,
        seq: 8,
        task: w.taskId,
        sender_kind: "agent",
        sender_name: "Support",
        text: "REPORT",
        envelope: { type: "REPORT", findings: [{ claim: "The customer was charged twice", evidence: "#customer/7" }] },
      });
    });
    const id = await propose(t, w.taskId, "file_bug", { title: "Double charge", body: "x", severity: "high" });
    await label(t, [id]);
    expect(Object.keys(jev.calls[0].questions)).toEqual(["grounded"]);
    expect(jev.calls[0].state.findings).toEqual([{ claim: "The customer was charged twice", evidence: "#customer/7", evidence_text: "Ledger: Two $35 renewals on Oct 1 for a-1." }]);
    expect((await getAction(t, id)).labels).toEqual({ grounded: { value: true, confidence: 0.95 } });
  });

  test("an action already gated is left alone", async () => {
    const t = setup();
    const w = await world(t);
    const id = await propose(t, w.taskId, "publish_post", { channel: "linkedin", text: "Hello" });
    await t.run((ctx) => ctx.db.patch(id, { status: "escalated" }));
    await label(t, [id]);
    expect(jev.calls).toHaveLength(0);
    expect((await getAction(t, id)).labels).toBeUndefined();
  });
});
