import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.ts");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("health.ping returns ok", async () => {
  const t = convexTest(schema, modules);
  const result = await t.query(api.health.ping, {});
  expect(result.ok).toBe(true);
});

test("health.check calls the API Trigger with key and User-Agent", async () => {
  vi.stubEnv("CREAO_API_KEY", "capi_test");
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  const t = convexTest(schema, modules);
  const result = await t.action(internal.health.check, {});

  expect(result).toEqual({ status: 200, ok: true, error: null });
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://agent.creao.ai/api/v1/runs?limit=1");
  const headers = init.headers as Record<string, string>;
  expect(headers.Authorization).toBe("Bearer capi_test");
  expect(headers["User-Agent"]).toBe("cofounder/1.0");
});

test("health.check reports the Creao error code on failure", async () => {
  vi.stubEnv("CREAO_API_KEY", "capi_bad");
  vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"UNAUTHORIZED"}', { status: 401 })));

  const t = convexTest(schema, modules);
  const result = await t.action(internal.health.check, {});

  expect(result).toEqual({ status: 401, ok: false, error: "UNAUTHORIZED" });
});

test("health.check fails clearly without a key", async () => {
  vi.stubEnv("CREAO_API_KEY", "");
  const t = convexTest(schema, modules);
  await expect(t.action(internal.health.check, {})).rejects.toThrow("CREAO_API_KEY is not set");
});
