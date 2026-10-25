import rateLimiterTest from "@convex-dev/rate-limiter/test";
import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { Label } from "../convex/lib/gate";
import {
  candidateProblem,
  covers,
  diffText,
  inductionTarget,
  nextRuleLabel,
  overrides,
  replay,
  ruleForAssign,
  ruleToSentence,
  type DecisionRow,
  type RuleLike,
} from "../convex/lib/rules";
import type { Department, Role } from "../convex/lib/types";
import posted from "../convex/creao/__fixtures__/post-run-202.json";

// ---------------------------------------------------------------- pure

const DEPTS: Partial<Record<Role, Department>> = { content: "marketing", support: "customer", marketing_manager: "marketing" };
const deptOf = (r: Role) => DEPTS[r];

const post = (id: string, choice: "approve" | "deny", f: Record<string, unknown> = {}): DecisionRow => ({
  id,
  action_type: "publish_post",
  choice,
  features: { role: "content", department: "marketing", channel: "linkedin", grounded: true, mentions_pricing: false, mentions_competitor: false, ...f },
});

const R_POST: RuleLike = {
  scope: { level: "role", role: "content" },
  action_type: "publish_post",
  conditions: [
    { field: "grounded", op: "==", value: true },
    { field: "mentions_pricing", op: "==", value: false },
    { field: "mentions_competitor", op: "==", value: false },
  ],
  effect: "allow",
};

describe("replay", () => {
  test("agrees with every decision it covers; ignores what it does not cover", () => {
    const ds = [post("d1", "approve"), post("d2", "approve"), post("d3", "approve"), post("d4", "deny", { mentions_pricing: true })];
    expect(replay(R_POST, ds, deptOf)).toEqual({ agree: 3, total: 3, covered: ["d1", "d2", "d3"], counterexamples: [] });
  });

  test("a candidate contradicting one past decision has a counterexample", () => {
    const ds = [post("d1", "approve"), post("d2", "approve"), post("d3", "deny"), post("d4", "approve")];
    expect(replay(R_POST, ds, deptOf)).toMatchObject({ agree: 3, total: 4, counterexamples: ["d3"] });
  });

  test("scope: role and department rules only cover their own decisions", () => {
    const other = post("x", "approve", { role: "marketing_manager", department: "marketing" });
    expect(covers(R_POST, other, deptOf)).toBe(false);
    expect(covers({ ...R_POST, scope: { level: "department", department: "marketing" } }, other, deptOf)).toBe(true);
    // Department derived from the role when a decision predates the department feature.
    expect(covers({ ...R_POST, scope: { level: "department", department: "marketing" } }, post("y", "approve", { department: undefined }), deptOf)).toBe(true);
    expect(covers({ ...R_POST, scope: { level: "company" } }, other, deptOf)).toBe(true);
  });

  test("override: approving what a deny rule covers, or denying what an allow rule covers", () => {
    expect(overrides("allow", "deny")).toBe(true);
    expect(overrides("deny", "approve")).toBe(true);
    expect(overrides("allow", "approve")).toBe(false);
    expect(overrides("escalate", "deny")).toBe(false);
  });
});

describe("inductionTarget", () => {
  test("3 uncovered approvals in a row trigger; fewer do not", () => {
    const ds = [post("d3", "approve"), post("d2", "approve"), post("d1", "approve")];
    expect(inductionTarget(ds, [], deptOf, 3)).toMatchObject({ choice: "approve", decisions: [{ id: "d3" }, { id: "d2" }, { id: "d1" }] });
    expect(inductionTarget(ds.slice(0, 2), [], deptOf, 3)).toBeNull();
  });

  test("decisions an active rule already covers do not count", () => {
    const ds = [post("d3", "approve"), post("d2", "approve"), post("d1", "approve")];
    expect(inductionTarget(ds, [R_POST], deptOf, 3)).toBeNull();
  });

  test("the newest decision's direction is the one counted", () => {
    const ds = [post("d4", "deny", { mentions_pricing: true }), post("d3", "approve"), post("d2", "approve"), post("d1", "approve")];
    expect(inductionTarget(ds, [], deptOf, 3)).toBeNull();
  });
});

describe("candidateProblem", () => {
  const ds = [post("d1", "approve"), post("d2", "approve"), post("d3", "approve")];
  const base = { scope: { level: "role" as const, role: "content" as const }, action_type: "publish_post" as const, conditions: R_POST.conditions, effect: "allow" as const };

  test("a well-formed candidate passes", () => expect(candidateProblem(base, "publish_post", "approve", ds)).toBeNull());
  test("fields must be in the data", () =>
    expect(candidateProblem({ ...base, conditions: [{ field: "sentiment", op: "==", value: "positive" }] }, "publish_post", "approve", ds)).toMatch(/not in the decisions/));
  test("bookkeeping fields are not conditions", () =>
    expect(candidateProblem({ ...base, conditions: [{ field: "role", op: "==", value: "content" }] }, "publish_post", "approve", ds)).toMatch(/not a rule condition/));
  test("effect follows the decisions' direction", () => expect(candidateProblem({ ...base, effect: "deny" }, "publish_post", "approve", ds)).toMatch(/does not follow/));
  test("op and value types fit", () =>
    expect(candidateProblem({ ...base, conditions: [{ field: "grounded", op: ">=", value: true }] }, "publish_post", "approve", ds)).toMatch(/does not fit/));
  test("a role scope needs a role", () => expect(candidateProblem({ ...base, scope: { level: "role" } }, "publish_post", "approve", ds)).toMatch(/needs a role/));
});

describe("text", () => {
  test("ruleToSentence reads amounts as dollars and labels plainly", () => {
    const r7: RuleLike = {
      scope: { level: "company" },
      action_type: "refund",
      conditions: [
        { field: "amount_cents", op: "<=", value: 4000 },
        { field: "refund_reason", op: "in", value: ["billing_error", "defect"] },
      ],
      effect: "allow",
    };
    expect(ruleToSentence(r7, "R7")).toBe("R7: refund company-wide is allowed when amount is at most $40.00 and refund reason is billing_error or defect.");
  });

  test("diffText shows removed and added conditions against the previous version", () => {
    const prev: RuleLike = { ...R_POST, conditions: [{ field: "grounded", op: "==", value: true }] };
    const text = diffText(R_POST, { label: "R9", previous: { ...prev, label: "R8" }, agreement: { agree: 3, total: 3 } });
    expect(text.split("\n")).toEqual([
      "- R8: publish_post by content is allowed when grounded is true.",
      "+ R9: publish_post by content is allowed when grounded is true and mentions pricing is false and mentions competitor is false.",
      "",
      "  publish_post · by content · effect allow",
      "    grounded is true",
      "  + mentions pricing is false",
      "  + mentions competitor is false",
      "",
      "Agrees with 3/3 past founder decisions it covers.",
    ]);
  });

  test("nextRuleLabel continues after the highest", () => expect(nextRuleLabel(["R7: x", "R12: y", "free text"])).toBe("R13"));

  test("ruleForAssign: in scope, unexpired, and of an action type the role proposes", () => {
    const r = { status: "active" as const, scope: { level: "company" as const }, action_type: "refund" as const };
    expect(ruleForAssign(r, "support", "customer", 0)).toBe(true);
    expect(ruleForAssign(r, "content", "marketing", 0)).toBe(false); // content never proposes refunds
    expect(ruleForAssign(r, "cofounder", "leadership", 0)).toBe(true); // the Cofounder sees every type
    expect(ruleForAssign({ ...r, expires_at: 10 }, "support", "customer", 20)).toBe(false);
    expect(ruleForAssign({ ...r, status: "suspended" }, "support", "customer", 0)).toBe(false);
  });
});

// ---------------------------------------------------------------- end to end

function setup() {
  const t = convexTest(schema, import.meta.glob("../convex/**/*.ts"));
  for (const name of ["marketingPool", "customerPool", "financePool", "leadershipPool"]) workpoolTest.register(t, name);
  rateLimiterTest.register(t, "rateLimiter");
  return t;
}
type T = ReturnType<typeof setup>;

// A Claude stand-in on the AI Gateway's chat completions endpoint (OpenAI shape, as the provider sends it).
let candidate: unknown;
let claudeStatus = 200;
let claudeCalls: { messages: { role: string; content: unknown }[] }[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-24T19:00:00Z"));
  vi.stubEnv("CREAO_API_KEY", "capi_test");
  vi.stubEnv("CREAO_WEBHOOK_TOKEN", "hook_secret");
  vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
  vi.stubEnv("CO_TOKEN_SECRET", "test-secret");
  candidate = { scope: { level: "role", role: "content" }, action_type: "publish_post", conditions: R_POST.conditions, effect: "allow", rationale: "Grounded posts without prices or competitors." };
  claudeStatus = 200;
  claudeCalls = [];
  let runs = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/chat/completions")) {
        claudeCalls.push(JSON.parse(String(init?.body)));
        if (claudeStatus !== 200) return new Response(JSON.stringify({ error: { message: "upstream" } }), { status: claudeStatus });
        return new Response(
          JSON.stringify({
            id: "cmpl-1",
            object: "chat.completion",
            created: 1,
            model: "anthropic/claude-sonnet-5.5",
            choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(candidate) }, finish_reason: "stop" }],
            usage: { prompt_tokens: 400, completion_tokens: 80, total_tokens: 480, cost: 0.005 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ...posted, id: `run-${++runs}` }), { status: 202 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);
const GOOD: Record<string, Label> = {
  grounded: { value: true, confidence: 0.95 },
  mentions_pricing: { value: false, confidence: 0.97 },
  mentions_competitor: { value: false, confidence: 0.97 },
};

async function contentTask(t: T, status: Doc<"tasks">["status"] = "gated"): Promise<Id<"tasks">> {
  return await t.run(async (ctx) => {
    const room = (await ctx.db.query("rooms").withIndex("by_name", (q) => q.eq("name", "#marketing")).unique())!;
    const now = Date.now();
    return await ctx.db.insert("tasks", {
      role: "content",
      room: room._id,
      kind: "work",
      brief: "Write a post.",
      chain_id: `chain-${now}-${Math.random()}`,
      hop: 0,
      attempt: 1,
      status,
      origin_refs: [],
      deadline: now + 60 * 60 * 1000,
      mode: "live",
      created_at: now,
      updated_at: now,
    });
  });
}

// A post through the real gate; returns the action and its gate outcome.
async function propose(t: T, taskId: Id<"tasks">, labels: Record<string, Label> = GOOD) {
  const actionId = await t.run((ctx) =>
    ctx.db.insert("actions", {
      task: taskId,
      chain_id: "c",
      role: "content",
      type: "publish_post",
      params: { channel: "linkedin", text: "Our summary view highlights decisions." },
      rationale: "Product post.",
      labels,
      status: "labeled",
      created_at: Date.now(),
    }),
  );
  const outcome = await t.mutation(internal.gate.evaluateGate, { actionId });
  return { actionId, outcome };
}

const inboxFor = (t: T, ref: string) => t.run(async (ctx) => (await ctx.db.query("founder_inbox").collect()).find((i) => i.ref === ref && i.status === "open"));
const decide = async (t: T, ref: string, choice: "approve" | "deny") => t.mutation(api.inbox.decide, { inboxId: (await inboxFor(t, ref))!._id, choice });
const rulesOf = (t: T) => t.run((ctx) => ctx.db.query("rules").withIndex("by_type_status", (q) => q.eq("action_type", "publish_post")).collect());
const auditKinds = (t: T) => t.run(async (ctx) => (await ctx.db.query("audit_log").collect()).filter((r) => r.kind.startsWith("rule") || r.kind.startsWith("induction")));

// Three founder approvals of grounded, non-pricing, non-competitor posts.
async function threeApprovals(t: T) {
  await t.mutation(internal.seed.config, {});
  const taskId = await contentTask(t);
  for (let i = 0; i < 3; i++) {
    const { actionId, outcome } = await propose(t, taskId);
    expect(outcome?.effect).toBe("escalate");
    await decide(t, actionId, "approve");
  }
  await drain(t);
  return taskId;
}

describe("rule learning end to end", () => {
  test("3 approvals → Claude proposes the rule → 3/3 → founder inbox shows the diff", async () => {
    const t = setup();
    await threeApprovals(t);
    expect(claudeCalls).toHaveLength(1);
    const prompt = JSON.stringify(claudeCalls[0].messages);
    expect(prompt).toContain("NARROWEST");
    expect(prompt).toContain("mentions_pricing");

    const [rule] = await rulesOf(t);
    expect(rule).toMatchObject({ status: "proposed", agreement: { agree: 3, total: 3 }, scope: { level: "role", role: "content" }, effect: "allow" });
    expect(rule.supporting_decisions).toHaveLength(3);
    expect(rule.text).toMatch(/^R8: publish_post by content is allowed when grounded is true/);
    const item = (await inboxFor(t, rule._id))!;
    expect(item).toMatchObject({ kind: "rule", title: "Approve rule R8 for publish_post?" });
    expect(item.body).toContain("+ R8: publish_post by content");
    expect(item.body).toContain("Agrees with 3/3 past founder decisions it covers.");
    expect((await auditKinds(t)).map((r) => r.kind)).toEqual(["induction_started", "rule_proposed"]);
  });

  test("approving the rule turns the next matching post from escalate into allow, and digests #marketing", async () => {
    const t = setup();
    const taskId = await threeApprovals(t);
    expect((await propose(t, taskId)).outcome).toMatchObject({ effect: "escalate", reason: "default:no_rule" });

    const [rule] = (await rulesOf(t)).filter((r) => r.status === "proposed");
    await decide(t, rule._id, "approve");
    expect((await rulesOf(t)).find((r) => r._id === rule._id)).toMatchObject({ status: "active", version: 1 });

    const next = await propose(t, taskId);
    expect(next.outcome).toEqual({ effect: "allow", reason: "rule:allow", rule_id: rule._id });

    const digests = await t.run(async (ctx) => (await ctx.db.query("messages").collect()).filter((m) => m.text.startsWith("[Dispatcher] Rules digest")));
    const rooms = await t.run(async (ctx) => Promise.all(digests.map(async (m) => (await ctx.db.get(m.room))!.name)));
    expect(rooms).toEqual(["#marketing"]);
    expect(digests[0].text).toContain(rule.text);
  });

  test("the next ASSIGN to Content lists the new rule in rules_in_scope; Support's does not", async () => {
    const t = setup();
    await threeApprovals(t);
    const [rule] = await rulesOf(t);
    await decide(t, rule._id, "approve");
    const contentAssign = await t.mutation(internal.dispatcher.assignTask, { taskId: await contentTask(t, "queued") });
    const text = await t.run(async (ctx) => (await ctx.db.get(contentAssign))!.text);
    const block = JSON.parse(/```cofounder\n(.*)\n```/s.exec(text)![1]) as { rules_in_scope: string[] };
    expect(block.rules_in_scope).toEqual([rule.text]); // R7 (refunds) is not a type Content proposes

    const supportTask = await contentTask(t, "queued");
    await t.run((ctx) => ctx.db.patch(supportTask, { role: "support" }));
    const supportAssign = await t.mutation(internal.dispatcher.assignTask, { taskId: supportTask });
    const supportText = await t.run(async (ctx) => (await ctx.db.get(supportAssign))!.text);
    expect(supportText).not.toContain("R8");
    expect(supportText).toContain("R7");
  });

  test("the founder denying a post the active rule covers suspends it in the same mutation", async () => {
    const t = setup();
    const taskId = await threeApprovals(t);
    const [rule] = await rulesOf(t);
    await decide(t, rule._id, "approve");
    // Escalated for a shaky label, yet still covered by the rule: the founder's deny overrides it.
    const { actionId, outcome } = await propose(t, taskId, { ...GOOD, mentions_pricing: { value: false, confidence: 0.7 } });
    expect(outcome?.reason).toBe("labels:low_confidence");
    await decide(t, actionId, "deny");
    expect((await t.run((ctx) => ctx.db.get(rule._id)))!.status).toBe("suspended"); // no drain needed
    expect((await propose(t, taskId)).outcome?.effect).toBe("escalate");
  });

  test("overrideAllowed: disagreeing with an action the rule allowed suspends the rule", async () => {
    const t = setup();
    const taskId = await threeApprovals(t);
    const [rule] = await rulesOf(t);
    await decide(t, rule._id, "approve");
    const { actionId } = await propose(t, taskId);
    expect(await t.mutation(api.rules.overrideAllowed, { actionId, reason: "Too salesy." })).toEqual({ suspended: 1 });
    expect((await t.run((ctx) => ctx.db.get(rule._id)))!.status).toBe("suspended");
    await expect(t.mutation(api.rules.overrideAllowed, { actionId: (await propose(t, taskId)).actionId })).rejects.toThrow(/not allowed by a rule/);
  });

  test("rejecting the proposed rule revokes it and records the decision", async () => {
    const t = setup();
    await threeApprovals(t);
    const [rule] = await rulesOf(t);
    await decide(t, rule._id, "deny");
    expect((await t.run((ctx) => ctx.db.get(rule._id)))!.status).toBe("revoked");
    const d = await t.run(async (ctx) => (await ctx.db.query("decisions").collect()).find((x) => x.subject_kind === "rule"));
    expect(d).toMatchObject({ rule: rule._id, choice: "deny", decided_by: "founder" });
  });
});

describe("proposeRule validation", () => {
  async function decisions(t: T, choices: ("approve" | "deny")[]) {
    await t.mutation(internal.seed.config, {});
    await t.run(async (ctx) => {
      for (const choice of choices) {
        await ctx.db.insert("decisions", {
          subject_kind: "action",
          action_type: "publish_post",
          choice,
          features: { role: "content", department: "marketing", channel: "linkedin", grounded: true, mentions_pricing: false, mentions_competitor: false },
          decided_by: "founder",
          created_at: Date.now(),
        });
      }
    });
  }

  test("a candidate contradicting one past decision is rejected with the counterexample", async () => {
    const t = setup();
    await decisions(t, ["approve", "approve", "deny", "approve"]);
    const out = await t.mutation(internal.rules.proposeRule, { actionType: "publish_post", choice: "approve", candidate });
    expect(out).toMatchObject({ ok: false, why: "contradicts past founder decisions" });
    expect(out.ok === false && out.counterexamples).toHaveLength(1);
    expect(await rulesOf(t)).toHaveLength(0);
    expect((await auditKinds(t)).map((r) => r.kind)).toEqual(["rule_rejected"]);
  });

  test("invalid output is dropped (audit), never stored", async () => {
    const t = setup();
    await decisions(t, ["approve", "approve", "approve"]);
    expect(await t.mutation(internal.rules.proposeRule, { actionType: "publish_post", choice: "approve", candidate: { effect: "allow" } })).toMatchObject({ ok: false, why: expect.stringMatching(/^schema/) });
    expect(
      await t.mutation(internal.rules.proposeRule, {
        actionType: "publish_post",
        choice: "approve",
        candidate: { scope: { level: "company" }, action_type: "publish_post", conditions: [{ field: "vibe", op: "==", value: "good" }], effect: "allow" },
      }),
    ).toMatchObject({ ok: false, why: "field vibe is not in the decisions" });
    expect(await rulesOf(t)).toHaveLength(0);
  });

  test("a rule that covers fewer than induction_min decisions is rejected", async () => {
    const t = setup();
    await decisions(t, ["approve", "approve", "approve"]);
    const narrow = { scope: { level: "company" }, action_type: "publish_post", conditions: [{ field: "channel", op: "==", value: "x" }], effect: "allow" };
    expect(await t.mutation(internal.rules.proposeRule, { actionType: "publish_post", choice: "approve", candidate: narrow })).toMatchObject({ ok: false, why: "covers only 0 decisions (needs 3)" });
  });

  test("a Claude failure drops the induction with an audit row and nothing throws", async () => {
    const t = setup();
    claudeStatus = 500;
    await threeApprovals(t);
    expect(claudeCalls).toHaveLength(2); // one retry, then dropped
    expect(await rulesOf(t)).toHaveLength(0);
    expect((await auditKinds(t)).map((r) => r.kind)).toEqual(["induction_started", "rule_dropped"]);
  });

  test("no second induction while a rule awaits review", async () => {
    const t = setup();
    await threeApprovals(t);
    expect(await t.mutation(internal.rules.maybeInduce, { actionType: "publish_post" })).toBe(false);
  });

  test("decisions landing together start one induction, not one each", async () => {
    const t = setup();
    await t.mutation(internal.seed.config, {});
    const taskId = await contentTask(t);
    for (let i = 0; i < 4; i++) await decide(t, (await propose(t, taskId)).actionId, "approve");
    await drain(t); // four maybeInduce calls run here, after all four decisions exist
    expect(claudeCalls).toHaveLength(1);
    expect((await auditKinds(t)).map((r) => r.kind)).toEqual(["induction_started", "rule_proposed"]);
    expect(await t.run(async (ctx) => (await ctx.db.query("config").collect()).filter((c) => c.key.startsWith("induction_pending")))).toEqual([]);
  });
});
