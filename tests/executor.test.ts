import rateLimiterTest from "@convex-dev/rate-limiter/test";
import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { executorInput, readExecutorReply } from "../convex/lib/executor";
import type { ActionType, Role } from "../convex/lib/types";
import posted from "../convex/creao/__fixtures__/post-run-202.json";

const modules = import.meta.glob("../convex/**/*.ts");
const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const t = convexTest(schema, modules);
  for (const name of ["marketingPool", "customerPool", "financePool", "leadershipPool"]) workpoolTest.register(t, name);
  rateLimiterTest.register(t, "rateLimiter");
  return t;
}
type T = ReturnType<typeof setup>;

// Creao stand-in: POST /runs → run-N (body kept); GET /runs/{id} → whatever the test put in `runResults`.
let starts: { url: string; body: Record<string, unknown> }[] = [];
let runResults: Record<string, unknown> = {};
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CREAO_API_KEY", "capi_test");
  vi.stubEnv("CREAO_WEBHOOK_TOKEN", "hook_secret");
  vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
  vi.stubEnv("CO_TOKEN_SECRET", "test-secret");
  starts = [];
  runResults = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if ((init?.method ?? "GET") === "POST") {
        starts.push({ url: u, body: JSON.parse(init!.body as string) as Record<string, unknown> });
        return new Response(JSON.stringify({ ...posted, id: `run-${starts.length}` }), { status: 202 });
      }
      const id = u.split("/runs/")[1];
      return new Response(JSON.stringify(runResults[id] ?? { id, status: "running" }), { status: 200 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);
const getAction = async (t: T, id: Id<"actions">): Promise<Doc<"actions">> => (await t.run((ctx) => ctx.db.get(id)))!;
const wrap = (env: unknown) => `Done.\n\n\`\`\`cofounder\n${JSON.stringify(env)}\n\`\`\``;
const executed = (actionId: string, evidence: string) => wrap({ type: "REPORT", task: actionId, from: "executor", summary: "executed", findings: [{ claim: "executed", evidence }] });

async function world(t: T) {
  await t.mutation(internal.seed.config, {});
  return await t.run(async (ctx) => {
    const room = (await ctx.db.query("rooms").withIndex("by_name", (q) => q.eq("name", "#customer")).unique())!;
    const now = Date.now();
    const taskId = await ctx.db.insert("tasks", {
      role: "support",
      room: room._id,
      kind: "work",
      brief: "Handle a ticket.",
      chain_id: "chain-x",
      hop: 0,
      attempt: 1,
      status: "gated",
      origin_refs: [],
      deadline: now + DAY,
      mode: "live",
      created_at: now,
      updated_at: now,
    });
    const ticketId = await ctx.db.insert("tickets", { from_email: "jonah.reyes@example.com", subject: "Billed twice for Pro", body: "b", status: "open", source: "seed", created_at: now });
    return { taskId, ticketId };
  });
}

async function action(
  t: T,
  taskId: Id<"tasks">,
  type: ActionType,
  params: Record<string, unknown>,
  status: Doc<"actions">["status"] = "allowed",
  role: Role = "support",
): Promise<Id<"actions">> {
  return t.run((ctx) =>
    ctx.db.insert("actions", {
      task: taskId,
      chain_id: "chain-x",
      role,
      type,
      params,
      rationale: "r",
      status,
      ...(status === "allowed" ? { gate: { effect: "allow" as const, reason: "rule:allow" } } : status === "escalated" ? { gate: { effect: "escalate" as const, reason: "novelty:new_type" } } : {}),
      created_at: Date.now(),
    }),
  );
}

const inputOf = (i: number) => JSON.parse(starts[i].body.inputs ? (starts[i].body.inputs as Record<string, string>).action : "{}") as Record<string, unknown>;

describe("lib/executor", () => {
  test("readExecutorReply: executed refs, not connected, failed, invalid", () => {
    expect(readExecutorReply(executed("a1", "https://linear.app/x/LUM-1"), "a1")).toEqual({ kind: "executed", refs: ["https://linear.app/x/LUM-1"] });
    expect(readExecutorReply(wrap({ type: "REPORT", task: "a1", from: "executor", summary: "failed: Gmail not connected" }), "a1")).toEqual({ kind: "not_connected", connector: "Gmail" });
    expect(readExecutorReply(wrap({ type: "REPORT", task: "a1", from: "executor", summary: "failed: Linear team not found" }), "a1")).toEqual({ kind: "failed", reason: "failed: Linear team not found" });
    expect(readExecutorReply(wrap({ type: "REPORT", task: "a1", from: "executor", summary: "executed" }), "a1")).toMatchObject({ kind: "failed", reason: expect.stringContaining("no executed_ref") });
    expect(readExecutorReply("no envelope", "a1")).toMatchObject({ kind: "failed", reason: expect.stringContaining("invalid envelope") });
    expect(readExecutorReply(executed("other", "x"), "a1")).toMatchObject({ kind: "failed" });
    // A URL mentioned only in the prose is kept next to the envelope's evidence.
    const prose = `Created https://linear.app/lumen/issue/ENG-12.

${executed("a1", "linear issue id e15")}`;
    expect(readExecutorReply(prose, "a1")).toEqual({ kind: "executed", refs: ["linear issue id e15", "https://linear.app/lumen/issue/ENG-12"] });
  });

  test("executorInput carries the action and the one-action instruction", () => {
    expect(JSON.parse(executorInput({ actionId: "a1", type: "file_bug", params: { title: "t" } }))).toEqual({
      action_id: "a1",
      action_type: "file_bug",
      params: { title: "t" },
      instructions: "Perform exactly this one action. Do nothing else. Reply with a cofounder REPORT envelope containing executed_ref.",
    });
  });
});

describe("runExecutor", () => {
  test("an approved file_bug starts one Executor run and its Linear URL lands on the action; a duplicate webhook changes nothing", async () => {
    const t = setup();
    const { taskId } = await world(t);
    const id = await action(t, taskId, "file_bug", { title: "Double renewal", body: "12 customers", severity: "high" }, "allowed", "finance_manager");
    expect(await t.action(internal.executor.runExecutor, { actionId: id })).toBe("run-1");
    expect(starts).toHaveLength(1);
    expect(starts[0].body).toMatchObject({ appId: "16083e9b-5cbc-42e9-bb5a-b5488b98ca81", idempotencyKey: `${id}:execute:1`, webhookUrl: "https://example.convex.site/creao-callback?token=hook_secret" });
    expect(inputOf(0)).toMatchObject({ action_id: id, action_type: "file_bug", params: { title: "Double renewal" } });
    expect(await getAction(t, id)).toMatchObject({ status: "executing" });

    // The webhook arrives twice with the same delivery id; ingestRun re-fetches the run.
    const url = "https://linear.app/lumen/issue/LUM-7";
    runResults["run-1"] = { id: "run-1", status: "completed", result: { chatText: executed(id, url) } };
    const deliver = () => t.fetch("/creao-callback?token=hook_secret", { method: "POST", headers: { "X-Creao-Delivery-Id": "d-1" }, body: JSON.stringify({ runId: "run-1", status: "completed" }) });
    expect((await deliver()).status).toBe(200);
    await drain(t);
    expect(await getAction(t, id)).toMatchObject({ status: "executed", executed_ref: [url] });
    const before = await t.run(async (ctx) => (await ctx.db.query("audit_log").collect()).length);
    expect((await deliver()).status).toBe(200);
    await drain(t);
    expect(await t.run(async (ctx) => (await ctx.db.query("audit_log").collect()).length)).toBe(before);
    expect((await t.run((ctx) => ctx.db.query("runs").collect()))[0]).toMatchObject({ purpose: "execute", status: "completed", delivery_ids: ["d-1"] });
  });

  test("a run whose webhook never arrives is completed by polling", async () => {
    const t = setup();
    const { taskId } = await world(t);
    const id = await action(t, taskId, "file_bug", { title: "t", body: "b", severity: "high" });
    await t.action(internal.executor.runExecutor, { actionId: id });
    runResults["run-1"] = { id: "run-1", status: "completed", result: { chatText: executed(id, "LUM-9") } };
    vi.setSystemTime(Date.now() + 4 * 60 * 1000);
    expect(await t.mutation(internal.dispatcher.pollRuns, {})).toBe(1);
    await drain(t);
    expect(await getAction(t, id)).toMatchObject({ status: "executed", executed_ref: ["LUM-9"] });
  });

  test("an undecided (escalated) action is refused and audited; no run starts", async () => {
    const t = setup();
    const { taskId } = await world(t);
    const id = await action(t, taskId, "file_bug", { title: "t", body: "b", severity: "high" }, "escalated");
    await expect(t.action(internal.executor.runExecutor, { actionId: id })).rejects.toThrow(/cannot execute: status:escalated/);
    expect(starts).toHaveLength(0);
    const kinds = await t.run(async (ctx) => (await ctx.db.query("audit_log").withIndex("by_ref", (q) => q.eq("ref", taskId)).collect()).map((a) => a.kind));
    expect(kinds).toEqual(["execution_refused"]);
  });

  test("reply_customer goes to the configured test inbox, names the real recipient, and handles the ticket", async () => {
    const t = setup();
    const { taskId, ticketId } = await world(t);
    await t.mutation(internal.executor.configure, { connectors: ["linear", "gmail", "calendar"], email_redirect_to: "founder.test@example.org" });
    const id = await action(t, taskId, "reply_customer", { ticket_id: ticketId, body: "Sorry about that." });
    await t.action(internal.executor.runExecutor, { actionId: id });
    expect(inputOf(0).params).toEqual({ ticket_id: ticketId, body: "Sorry about that.", to: "founder.test@example.org", subject: "Re: Billed twice for Pro [for jonah.reyes@example.com]" });
    await t.mutation(internal.dispatcher.recordReply, { runId: "run-1", status: "completed", text: executed(id, "gmail:18f2a") });
    expect(await getAction(t, id)).toMatchObject({ status: "executed", executed_ref: ["gmail:18f2a"] });
    expect((await t.run((ctx) => ctx.db.get(ticketId)))!.status).toBe("handled");
  });

  test("a connector that is not connected goes to the mock outbox without a run", async () => {
    const t = setup();
    const { taskId } = await world(t);
    const id = await action(t, taskId, "schedule_digest", { when_hint: "tomorrow 9am" }); // default config: Linear only
    await t.action(internal.executor.runExecutor, { actionId: id });
    expect(starts).toHaveLength(0);
    const a = await getAction(t, id);
    expect(a.status).toBe("executed");
    expect(a.executed_ref![0]).toMatch(/^outbox:/);
    const activity = await t.query(api.executor.activity, {});
    expect(activity.outbox).toMatchObject([{ action: id, connector: "calendar", reason: "calendar is not connected to the Executor" }]);
    expect(activity.actions.map((x) => x.id)).toContain(id);
  });

  test("the Executor reporting a connector not connected falls back to the outbox", async () => {
    const t = setup();
    const { taskId, ticketId } = await world(t);
    await t.mutation(internal.executor.configure, { connectors: ["linear", "gmail"] });
    const id = await action(t, taskId, "reply_customer", { ticket_id: ticketId, body: "Hi." });
    await t.action(internal.executor.runExecutor, { actionId: id });
    await t.mutation(internal.dispatcher.recordReply, { runId: "run-1", status: "completed", text: wrap({ type: "REPORT", task: id, from: "executor", summary: "failed: Gmail not connected" }) });
    expect((await getAction(t, id)).executed_ref![0]).toMatch(/^outbox:/);
    const [o] = (await t.query(api.executor.activity, {})).outbox;
    expect(o).toMatchObject({ connector: "gmail", reason: "the Executor reported Gmail not connected", payload: { to: "jonah.reyes@example.com", subject: "Re: Billed twice for Pro" } });
  });

  test("a failed Executor run fails the action and raises a capability ISSUE to the department manager", async () => {
    const t = setup();
    const { taskId } = await world(t);
    const id = await action(t, taskId, "file_bug", { title: "t", body: "b", severity: "high" });
    await t.action(internal.executor.runExecutor, { actionId: id });
    await t.mutation(internal.dispatcher.recordReply, { runId: "run-1", status: "failed", text: "", errorCode: "AGENT_ERROR" });
    expect(await getAction(t, id)).toMatchObject({ status: "failed" });
    const [issue] = await t.run((ctx) => ctx.db.query("issues").collect());
    expect(issue).toMatchObject({ kind: "capability", raised_by_role: "executor", to_role: "customer_manager", level: "manager" });
    expect(issue.summary).toContain("run failed (AGENT_ERROR)");
  });

  test("an approved publish_post goes to the mock post queue (no Executor)", async () => {
    const t = setup();
    const { taskId } = await world(t);
    const id = await action(t, taskId, "publish_post", { channel: "linkedin", text: "We fixed a billing bug." });
    await t.mutation(internal.executor.queuePost, { actionId: id });
    expect(starts).toHaveLength(0);
    const [post] = (await t.query(api.executor.activity, {})).posts;
    expect(post).toMatchObject({ channel: "linkedin", text: "We fixed a billing bug.", status: "queued" });
    expect((await getAction(t, id)).executed_ref![0]).toMatch(/^post_queue:/);
  });

  test("the gate's allow schedules the Executor for a connector action", async () => {
    const t = setup();
    const { taskId } = await world(t);
    await t.run(async (ctx) => {
      const d = await ctx.db.insert("decisions", { subject_kind: "action", action_type: "file_bug", choice: "approve", features: {}, decided_by: "founder", created_at: Date.now() });
      await ctx.db.insert("rules", { scope: { level: "company" }, action_type: "file_bug", conditions: [], effect: "allow", status: "active", version: 1, supporting_decisions: [d], agreement: { agree: 1, total: 1 }, text: "Bugs may be filed.", created_at: Date.now() });
    });
    const id = await action(t, taskId, "file_bug", { title: "t", body: "b", severity: "high" }, "proposed");
    expect(await t.mutation(internal.gate.evaluateGate, { actionId: id })).toMatchObject({ effect: "allow" });
    await drain(t);
    expect(starts).toHaveLength(1);
    expect(await getAction(t, id)).toMatchObject({ status: "executing" });
  });
});
