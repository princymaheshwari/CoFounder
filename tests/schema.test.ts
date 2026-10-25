import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import { CONFIG_DEFAULTS } from "../convex/seed";
import {
  ACTION_TYPES,
  DEPARTMENTS,
  EFFECTS,
  ISSUE_KINDS,
  MESSAGE_TYPES,
  ROLES,
  vActionType,
  vDepartment,
  vEffect,
  vIssueKind,
  vMessageType,
  vRole,
} from "../convex/lib/types";

const modules = import.meta.glob("../convex/**/*.ts");

describe("shared literals", () => {
  test.each([
    ["Role", ROLES, vRole, 11],
    ["Department", DEPARTMENTS, vDepartment, 5],
    ["MessageType", MESSAGE_TYPES, vMessageType, 7],
    ["ActionType", ACTION_TYPES, vActionType, 10],
    ["IssueKind", ISSUE_KINDS, vIssueKind, 4],
    ["Effect", EFFECTS, vEffect, 3],
  ] as const)("%s validator matches its tuple", (_name, values, validator, count) => {
    expect(values).toHaveLength(count);
    expect(validator.kind).toBe("union");
    const literals = validator.members.map((m) => m.value);
    expect(literals).toEqual([...values]);
  });
});

describe("seed:config", () => {
  test("creates 5 channels, 11 agents and the config thresholds", async () => {
    const t = convexTest(schema, modules);
    const counts = await t.mutation(internal.seed.config, {});
    expect(counts).toEqual({ rooms: 5, agents: 11, config: 6, company: true });

    const config = await t.run((ctx) => ctx.db.query("config").collect());
    expect(Object.fromEntries(config.map((c) => [c.key, c.value]))).toEqual(CONFIG_DEFAULTS);

    const executor = await t.run((ctx) =>
      ctx.db
        .query("agents")
        .withIndex("by_role", (q) => q.eq("role", "executor"))
        .unique(),
    );
    expect(executor).toMatchObject({ kind: "executor", input_field: "action", enabled: true, display_name: "Executor" });
  });

  test("is idempotent and keeps channel counters and tuned config", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.config, {});
    await t.run(async (ctx) => {
      const customer = await ctx.db
        .query("rooms")
        .withIndex("by_name", (q) => q.eq("name", "#customer"))
        .unique();
      await ctx.db.patch(customer!._id, { next_seq: 42 });
      const timeout = await ctx.db
        .query("config")
        .withIndex("by_key", (q) => q.eq("key", "level_timeout_ms"))
        .unique();
      await ctx.db.patch(timeout!._id, { value: 60_000 });
    });

    const counts = await t.mutation(internal.seed.config, {});
    expect(counts).toEqual({ rooms: 5, agents: 11, config: 6, company: true });

    const { seq, timeout } = await t.run(async (ctx) => ({
      seq: (await ctx.db
        .query("rooms")
        .withIndex("by_name", (q) => q.eq("name", "#customer"))
        .unique())!.next_seq,
      timeout: (await ctx.db
        .query("config")
        .withIndex("by_key", (q) => q.eq("key", "level_timeout_ms"))
        .unique())!.value,
    }));
    expect(seq).toBe(42);
    expect(timeout).toBe(60_000);
  });
});

describe("schema validation", () => {
  test("rejects an agent with an unknown role", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.run((ctx) =>
        ctx.db.insert("agents", {
          // @ts-expect-error invalid role on purpose
          role: "engineer",
          department: "none",
          kind: "role",
          creao_app_id: "",
          input_field: "message",
          display_name: "Engineer",
          rooms: [],
          enabled: true,
        }),
      ),
    ).rejects.toThrow();
  });

  test("rejects a string where integer cents are expected", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.run((ctx) =>
        ctx.db.insert("budgets", {
          scope: "company:refund",
          period: "2026-10-24",
          // @ts-expect-error amounts are numbers (integer cents)
          limit_cents: "30000",
          spent_cents: 0,
        }),
      ),
    ).rejects.toThrow();
  });
});
