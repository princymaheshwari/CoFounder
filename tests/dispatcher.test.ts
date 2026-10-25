import rateLimiterTest from "@convex-dev/rate-limiter/test";
import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { appendMessage } from "../convex/channels";
import { TOKEN_PLACEHOLDER } from "../convex/dispatcher";
import { extractEnvelopeBlock } from "../convex/lib/envelope";
import { hashToken, signTaskToken, verifyTaskToken } from "../convex/lib/tokens";
import completed from "../convex/creao/__fixtures__/get-run-completed.json";
import posted from "../convex/creao/__fixtures__/post-run-202.json";

const modules = import.meta.glob("../convex/**/*.ts");
const SECRET = "test-secret";
const SUPPORT_APP_ID = "edea5cf5-b3fb-47f0-994c-b40ff2a2e9ec";

function setup() {
  const t = convexTest(schema, modules);
  for (const name of ["marketingPool", "customerPool", "financePool", "leadershipPool"]) workpoolTest.register(t, name);
  rateLimiterTest.register(t, "rateLimiter");
  return t;
}
type T = ReturnType<typeof setup>;

beforeEach(() => {
  // Scheduled and Workpool jobs only run when a test drains them, never in the background.
  vi.useFakeTimers();
  vi.stubEnv("CREAO_API_KEY", "capi_test");
  vi.stubEnv("CREAO_WEBHOOK_TOKEN", "hook_secret");
  vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
  vi.stubEnv("CO_TOKEN_SECRET", SECRET);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

// A Creao stand-in: POST /runs returns the real 202 body, GET /runs/:id returns `run`.
function stubCreao(run: unknown = completed) {
  const calls: { method: string; url: string; body?: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? "GET";
      calls.push({ method, url, body: init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined });
      return new Response(JSON.stringify(method === "POST" ? posted : run), { status: method === "POST" ? 202 : 200 });
    }),
  );
  return calls;
}

// The real completed run, re-addressed to our task (its text names the verify task id).
function completedFor(taskId: string, overrides: Record<string, unknown> = {}) {
  return {
    ...completed,
    result: { ...completed.result, chatText: completed.result.chatText.replace("t_verify_1792895078195", taskId) },
    ...overrides,
  };
}

async function seedTicket(t: T) {
  await t.mutation(internal.seed.config, {});
  return await t.mutation(internal.dev.seedSupportTicket, { subject: "Charged twice", body: "I was charged $35 twice." });
}

async function startAssign(t: T, taskId: Id<"tasks">, messageId: Id<"messages">) {
  await t.action(internal.dispatcher.startRunForTask, { taskId, messageId, purpose: "assign", attempt: 1 });
}

const scheduledNames = (t: T) =>
  t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).map((f) => f.name));

describe("task tokens", () => {
  test("sign → verify round-trips, deterministically", async () => {
    const claims = { task: "t_1", role: "support", exp: 2_000 };
    const token = await signTaskToken(SECRET, claims);
    expect(await signTaskToken(SECRET, claims)).toBe(token);
    expect(await verifyTaskToken(SECRET, token, 1_000)).toEqual({ ok: true, claims });
  });

  test("rejects tampered, wrong-secret, expired and malformed tokens", async () => {
    const token = await signTaskToken(SECRET, { task: "t_1", role: "support", exp: 2_000 });
    const [, sig] = token.split(".");
    const forged = `${btoa(JSON.stringify({ task: "t_1", role: "ledger", exp: 2_000 })).replace(/=+$/, "")}.${sig}`;
    expect(await verifyTaskToken(SECRET, forged, 1_000)).toEqual({ ok: false, error: "bad_signature" });
    expect(await verifyTaskToken("other", token, 1_000)).toEqual({ ok: false, error: "bad_signature" });
    expect(await verifyTaskToken(SECRET, token, 2_000)).toEqual({ ok: false, error: "expired" });
    expect(await verifyTaskToken(SECRET, "not-a-token", 1_000)).toEqual({ ok: false, error: "malformed" });
  });

  test("hashToken is a sha256 hex digest", async () => {
    expect(await hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("channel messages", () => {
  test("seq is a per-channel counter", async () => {
    const t = setup();
    await t.mutation(internal.seed.config, {});
    const seqs = await t.run(async (ctx) => {
      const room = (name: string) =>
        ctx.db
          .query("rooms")
          .withIndex("by_name", (q) => q.eq("name", name))
          .unique();
      const customer = (await room("#customer"))!._id;
      const finance = (await room("#finance"))!._id;
      const msg = { sender_kind: "system" as const, sender_name: "Dispatcher", text: "x" };
      const ids = [
        await appendMessage(ctx, { ...msg, room: customer }),
        await appendMessage(ctx, { ...msg, room: customer }),
        await appendMessage(ctx, { ...msg, room: finance }),
      ];
      return Promise.all(ids.map(async (id) => (await ctx.db.get(id))!.seq));
    });
    expect(seqs).toEqual([1, 2, 1]);
  });
});

describe("assignTask", () => {
  test("a seeded support_ticket opens a #customer thread with an ASSIGN for Support", async () => {
    const t = setup();
    const { taskId, messageId } = await seedTicket(t);
    const { message, room, task } = await t.run(async (ctx) => {
      const message = (await ctx.db.get(messageId))!;
      return { message, room: (await ctx.db.get(message.room))!, task: (await ctx.db.get(taskId))! };
    });
    expect(room.name).toBe("#customer");
    expect(message).toMatchObject({ seq: 1, task: taskId, sender_kind: "system", sender_name: "Dispatcher" });
    expect(message.text.startsWith(`[Dispatcher] @Support New task ${taskId}: `)).toBe(true);
    const block = JSON.parse(extractEnvelopeBlock(message.text)!) as Record<string, unknown>;
    expect(block).toMatchObject({ type: "ASSIGN", task: taskId, to: "support", token: TOKEN_PLACEHOLDER });
    expect(block.company).toMatchObject({ name: "Lumen Notes", plans: [{ name: "Pro", price_cents: 3500, period: "month" }] });
    expect((block.data_hints as string[])[0]).toMatch(/^co data ticket --id /);
    expect(task.status).toBe("queued"); // assigned once the run starts
  });

  test("the department Workpool runs startRunForTask and the task becomes assigned", async () => {
    const t = setup();
    const calls = stubCreao();
    const { taskId } = await seedTicket(t);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect((await t.run(async (ctx) => (await ctx.db.get(taskId))!)).status).toBe("assigned");
  });

  test("refuses to assign a task twice", async () => {
    const t = setup();
    const { taskId } = await seedTicket(t);
    await expect(t.mutation(internal.dispatcher.assignTask, { taskId })).rejects.toThrow(/already assigned/);
    await t.run((ctx) => ctx.db.patch(taskId, { status: "done" }));
    await expect(t.mutation(internal.dispatcher.assignTask, { taskId })).rejects.toThrow(/not queued/);
  });
});

describe("startRunForTask", () => {
  test("starts the Support run with the real token and records it", async () => {
    const t = setup();
    const { taskId, messageId } = await seedTicket(t);
    const calls = stubCreao();
    await startAssign(t, taskId, messageId);

    expect(calls).toHaveLength(1);
    const body = calls[0].body!;
    expect(body).toMatchObject({
      appId: SUPPORT_APP_ID,
      webhookUrl: "https://example.convex.site/creao-callback?token=hook_secret",
      idempotencyKey: `${taskId}:assign:1`,
    });
    expect(body).not.toHaveProperty("threadId");
    const input = (body.inputs as { message: string }).message;
    expect(input).not.toContain(TOKEN_PLACEHOLDER);
    const token = (JSON.parse(extractEnvelopeBlock(input)!) as { token: string }).token;
    const verified = await verifyTaskToken(SECRET, token, Date.now());
    expect(verified).toMatchObject({ ok: true, claims: { task: taskId, role: "support" } });

    const { task, runs, message } = await t.run(async (ctx) => ({
      task: (await ctx.db.get(taskId))!,
      runs: await ctx.db.query("runs").collect(),
      message: (await ctx.db.get(messageId))!,
    }));
    expect(task).toMatchObject({ status: "assigned", creao_run_id: posted.id, token_hash: await hashToken(token) });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ purpose: "assign", role: "support", status: "pending", creao_run_id: posted.id });
    expect(message.creao_run_id).toBe(posted.id);
    expect(message.text).toContain(TOKEN_PLACEHOLDER); // the stored thread never holds the token
  });

  test("a retried start (same idempotencyKey → same run) records one run", async () => {
    const t = setup();
    const { taskId, messageId } = await seedTicket(t);
    const calls = stubCreao();
    await startAssign(t, taskId, messageId);
    await startAssign(t, taskId, messageId);
    expect(calls[0].body).toEqual(calls[1].body); // identical input, token included
    expect(await t.run((ctx) => ctx.db.query("runs").collect())).toHaveLength(1);
  });

  test("a repair continues the task's Creao thread", async () => {
    const t = setup();
    const { taskId, messageId } = await seedTicket(t);
    stubCreao();
    await startAssign(t, taskId, messageId);
    await t.run((ctx) => ctx.db.patch(taskId, { creao_thread_id: "thread-1" }));

    const repairId = await t.mutation(internal.dispatcher.sendRepair, { taskId, error: 'Field "kind" is required for ISSUE.' });
    const calls = stubCreao();
    await t.action(internal.dispatcher.startRunForTask, { taskId, messageId: repairId, purpose: "repair", attempt: 2 });

    expect(calls[0].body).toMatchObject({ threadId: "thread-1", idempotencyKey: `${taskId}:repair:2` });
    const block = JSON.parse(extractEnvelopeBlock((calls[0].body!.inputs as { message: string }).message)!) as Record<string, unknown>;
    expect(block).toMatchObject({ type: "ASSIGN", task: taskId, attempt: 2, repair: 'Field "kind" is required for ISSUE.' });
    const repair = await t.run(async (ctx) => (await ctx.db.get(repairId))!);
    expect(repair.seq).toBe(2);
  });

  test("an exhausted run budget requeues instead of calling Creao", async () => {
    const t = setup();
    const { taskId, messageId } = await seedTicket(t);
    for (let i = 0; i < 60; i++) await t.mutation(internal.dispatcher.consumeRunBudget, { role: "support" });
    const calls = stubCreao();
    await startAssign(t, taskId, messageId);
    expect(calls).toHaveLength(0);
    expect((await t.run(async (ctx) => (await ctx.db.get(taskId))!)).status).toBe("queued");
  });
});

describe("run budget", () => {
  test("60 runs per hour per role", async () => {
    const t = setup();
    for (let i = 0; i < 60; i++) {
      expect((await t.mutation(internal.dispatcher.consumeRunBudget, { role: "support" })).ok).toBe(true);
    }
    expect((await t.mutation(internal.dispatcher.consumeRunBudget, { role: "support" })).ok).toBe(false);
    expect((await t.mutation(internal.dispatcher.consumeRunBudget, { role: "ledger" })).ok).toBe(true);
  });
});

describe("receiving replies", () => {
  const deliver = (t: T, deliveryId: string) =>
    t.fetch("/creao-callback?token=hook_secret", {
      method: "POST",
      headers: { "X-Creao-Delivery-Id": deliveryId },
      body: JSON.stringify({ runId: posted.id, status: "completed" }),
    });

  async function started(t: T) {
    const { taskId, messageId } = await seedTicket(t);
    stubCreao();
    await startAssign(t, taskId, messageId);
    return taskId;
  }
  const threadOf = (t: T, taskId: Id<"tasks">) =>
    t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_task", (q) => q.eq("task", taskId))
        .collect(),
    );

  test("webhook → ingestRun records the reply in the same thread with a parsed envelope", async () => {
    const t = setup();
    const taskId = await started(t);

    expect((await deliver(t, "d-1")).status).toBe(200);
    expect(await scheduledNames(t)).toContain("dispatcher:ingestRun");

    stubCreao(completedFor(taskId));
    await t.action(internal.dispatcher.ingestRun, { runId: posted.id });

    const thread = await threadOf(t, taskId);
    expect(thread.map((m) => [m.seq, m.sender_kind])).toEqual([
      [1, "system"],
      [2, "agent"],
    ]);
    expect(thread[1]).toMatchObject({ sender_name: "Support", sender_role: "support", creao_run_id: posted.id });
    expect(thread[1].envelope).toMatchObject({ type: "REPORT", task: taskId, from: "support" });
    expect(thread[1].envelope_error).toBeUndefined();
    const { task, run } = await t.run(async (ctx) => ({
      task: (await ctx.db.get(taskId))!,
      run: (await ctx.db.query("runs").first())!,
    }));
    expect(task.creao_thread_id).toBe(completed.threadId);
    expect(run).toMatchObject({ status: "completed", delivery_ids: ["d-1"] });
  });

  test("duplicate deliveries and repeated ingests create no duplicate messages", async () => {
    const t = setup();
    const taskId = await started(t);
    await deliver(t, "d-1");
    await deliver(t, "d-1"); // Creao retry, same delivery id
    stubCreao(completedFor(taskId));
    await t.action(internal.dispatcher.ingestRun, { runId: posted.id });
    await t.action(internal.dispatcher.ingestRun, { runId: posted.id }); // poller races the webhook
    await deliver(t, "d-2"); // late delivery after the run is terminal
    expect(await threadOf(t, taskId)).toHaveLength(2);
    const run = await t.run(async (ctx) => (await ctx.db.query("runs").first())!);
    expect(run.delivery_ids).toEqual(["d-1"]);
  });

  test("an invalid envelope is stored with envelope_error", async () => {
    const t = setup();
    const taskId = await started(t);
    stubCreao(completedFor("t_someone_else"));
    await t.action(internal.dispatcher.ingestRun, { runId: posted.id });
    const reply = (await threadOf(t, taskId))[1];
    expect(reply.envelope).toBeUndefined();
    expect(reply.envelope_error).toMatch(/^Field "task" must be/);
  });

  test("a failed run leaves a system note in the thread", async () => {
    const t = setup();
    const taskId = await started(t);
    stubCreao({ id: posted.id, status: "failed", errorCode: "INSUFFICIENT_CREDITS", result: null });
    await t.action(internal.dispatcher.ingestRun, { runId: posted.id });
    const note = (await threadOf(t, taskId))[1];
    expect(note).toMatchObject({ sender_kind: "system" });
    expect(note.text).toContain("ended as failed (INSUFFICIENT_CREDITS)");
  });

  test("a run that is still going is left for the poller", async () => {
    const t = setup();
    const taskId = await started(t);
    stubCreao({ id: posted.id, status: "running" });
    await t.action(internal.dispatcher.ingestRun, { runId: posted.id });
    expect(await threadOf(t, taskId)).toHaveLength(1);
  });

  test("pollRuns picks up runs stuck for over 3 minutes", async () => {
    const t = setup();
    const taskId = await started(t);
    await t.run(async (ctx) => {
      const run = (await ctx.db.query("runs").first())!;
      await ctx.db.patch(run._id, { started_at: Date.now() - 4 * 60 * 1000 });
      await ctx.db.insert("runs", {
        purpose: "assign",
        role: "ledger",
        task: taskId,
        creao_run_id: "fresh-run",
        idempotency_key: "fresh:assign:1",
        status: "running",
        delivery_ids: [],
        started_at: Date.now(),
      });
    });
    expect(await t.mutation(internal.dispatcher.pollRuns, {})).toBe(1);
    const ingests = (await scheduledNames(t)).filter((n) => n === "dispatcher:ingestRun");
    expect(ingests).toHaveLength(1);
  });
});
