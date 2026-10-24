import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.ts");

test("health.ping returns ok", async () => {
  const t = convexTest(schema, modules);
  const result = await t.query(api.health.ping, {});
  expect(result.ok).toBe(true);
});
