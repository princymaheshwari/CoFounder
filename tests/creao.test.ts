import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { CreaoError, RateLimitedError, creaoFetch, parseRetryAfter } from "../convex/creao/http";
import { getRun, parseRun, replyText, startRun, webhookUrl } from "../convex/creao/runs";
import completed from "../convex/creao/__fixtures__/get-run-completed.json";
import continuation from "../convex/creao/__fixtures__/get-run-continuation.json";
import posted from "../convex/creao/__fixtures__/post-run-202.json";
import webhook from "../convex/creao/__fixtures__/webhook-completed.json";

const modules = import.meta.glob("../convex/**/*.ts");

type FetchArgs = [string, RequestInit];
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

beforeEach(() => {
  vi.stubEnv("CREAO_API_KEY", "capi_test");
  vi.stubEnv("CREAO_WEBHOOK_TOKEN", "hook_secret");
  vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("creaoFetch", () => {
  test("sends the bearer key, an explicit User-Agent and the base URL", async () => {
    const fetchMock = vi.fn(async () => json(posted, 202));
    vi.stubGlobal("fetch", fetchMock);
    const res = await creaoFetch("/api/v1/runs", { method: "POST", body: { appId: "a" } });
    expect(res).toEqual({ status: 202, json: posted });
    const [url, init] = fetchMock.mock.calls[0] as unknown as FetchArgs;
    expect(url).toBe("https://agent.creao.ai/api/v1/runs");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer capi_test");
    expect(headers["User-Agent"]).toBe("cofounder/1.0");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test("times out with code TIMEOUT", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener("abort", () => reject(init.signal!.reason as Error));
          }),
      ),
    );
    await expect(creaoFetch("/api/v1/runs/x", { timeoutMs: 20 })).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  test("maps 429 to RateLimitedError with retryAfterMs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "RATE_LIMITED" }, 429, { "Retry-After": "30" })));
    const err = await creaoFetch("/api/v1/runs").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterMs).toBe(30_000);
  });

  test("maps the {error} envelope to CreaoError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "APP_NOT_FOUND" }, 404)));
    await expect(creaoFetch("/api/v1/runs")).rejects.toMatchObject({ code: "APP_NOT_FOUND", status: 404 });
  });

  test("maps a non-JSON error body (Cloudflare) to HTTP_<status>", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("error code: 1010", { status: 403 })));
    await expect(creaoFetch("/api/v1/runs")).rejects.toMatchObject({ code: "HTTP_403", status: 403 });
  });

  test("retries a GET once on a network error, never a POST", async () => {
    const flaky = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValue(json(completed));
    vi.stubGlobal("fetch", flaky);
    await expect(creaoFetch("/api/v1/runs/x")).resolves.toMatchObject({ status: 200 });
    expect(flaky).toHaveBeenCalledTimes(2);

    const down = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", down);
    await expect(creaoFetch("/api/v1/runs", { method: "POST", body: {} })).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
    expect(down).toHaveBeenCalledTimes(1);
  });

  test("fails clearly without a key", async () => {
    vi.stubEnv("CREAO_API_KEY", "");
    await expect(creaoFetch("/api/v1/runs")).rejects.toBeInstanceOf(CreaoError);
  });

  test("parseRetryAfter handles seconds, HTTP dates and garbage", () => {
    expect(parseRetryAfter("5")).toBe(5_000);
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:01:00 GMT", Date.parse("2026-01-01T00:00:00Z"))).toBe(60_000);
    expect(parseRetryAfter(null)).toBe(60_000);
    expect(parseRetryAfter("soon")).toBe(60_000);
  });
});

describe("runs client", () => {
  test("startRun posts the API Trigger body and returns the run id", async () => {
    const fetchMock = vi.fn(async () => json(posted, 202));
    vi.stubGlobal("fetch", fetchMock);
    const out = await startRun({
      appId: posted.appId,
      inputs: { message: "[Dispatcher] @Support …" },
      webhookUrl: webhookUrl(),
      idempotencyKey: "t_1:assign:1",
      threadId: "thread-1",
    });
    expect(out).toEqual({ runId: posted.id, status: "pending" });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as FetchArgs)[1].body as string) as Record<string, unknown>;
    expect(body).toEqual({
      appId: posted.appId,
      inputs: { message: "[Dispatcher] @Support …" },
      webhookUrl: "https://example.convex.site/creao-callback?token=hook_secret",
      idempotencyKey: "t_1:assign:1",
      threadId: "thread-1",
    });
  });

  test("startRun rejects idempotency keys outside 8–128 chars", async () => {
    await expect(
      startRun({ appId: "a", inputs: {}, webhookUrl: "u", idempotencyKey: "short" }),
    ).rejects.toMatchObject({ code: "BAD_IDEMPOTENCY_KEY" });
  });

  test("getRun parses the real completed run", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(completed)));
    const run = await getRun(completed.id);
    expect(run).toMatchObject({ id: completed.id, status: "completed", threadId: completed.threadId });
    expect(run.errorCode).toBeUndefined(); // null in the API
    expect(run.chatText).toContain("```cofounder");
  });

  test("parseRun rejects an unknown status", () => {
    expect(() => parseRun({ id: "x", status: "weird" })).toThrow(CreaoError);
  });
});

describe("replyText", () => {
  test("uses chatText, which carries the envelope (real run)", () => {
    const run = parseRun(completed);
    expect(replyText(run)).toBe(completed.result.chatText);
    expect(run.text).not.toContain("```cofounder");
  });

  test("continuation reply remembers the first turn's task", () => {
    expect(replyText(parseRun(continuation))).toContain("t_verify_");
  });

  test("falls back to text when only text has the block, else whatever exists", () => {
    expect(replyText({ text: "x\n```cofounder\n{}\n```", chatText: "no block" })).toContain("```cofounder");
    expect(replyText({ chatText: "plain" })).toBe("plain");
    expect(replyText({ text: "only text" })).toBe("only text");
    expect(replyText({})).toBe("");
  });
});

describe("/creao-callback", () => {
  const url = "/creao-callback?token=hook_secret";
  const deliver = (t: ReturnType<typeof convexTest>, path = url) =>
    t.fetch(path, {
      method: "POST",
      headers: { "X-Creao-Delivery-Id": webhook.headers["X-Creao-Delivery-Id"] },
      body: JSON.stringify(webhook.body),
    });

  test("rejects a wrong token", async () => {
    const t = convexTest(schema, modules);
    expect((await deliver(t, "/creao-callback?token=nope")).status).toBe(401);
  });

  test("accepts a delivery for a run we did not start and only audits it", async () => {
    const t = convexTest(schema, modules);
    expect((await deliver(t)).status).toBe(200);
    const rows = await t.run((ctx) => ctx.db.query("audit_log").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "webhook_unknown_run", ref: webhook.body.runId });
  });

  test("rejects a body without runId", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch(url, { method: "POST", body: JSON.stringify({ status: "completed" }) });
    expect(res.status).toBe(400);
  });
});
