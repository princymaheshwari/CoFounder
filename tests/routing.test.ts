import { describe, expect, test } from "vitest";
import { checkHandoff, deadlineAction, routeEvent } from "../convex/lib/routing";

describe("routeEvent", () => {
  test.each([
    ["support_ticket", "support", "#customer"],
    ["ledger_check", "ledger", "#finance"],
    ["signal.marketing", "market_intel", "#marketing"],
    ["signal.vendor_price", "spend", "#finance"],
    ["signal.reviews", "retention", "#customer"],
    ["signal.leadership", "cofounder", "#leadership"],
    ["weekly_review", "cofounder", "#leadership"],
  ])("%s → %s in %s", (type, role, room) => {
    expect(routeEvent(type)).toEqual({ role, room });
  });

  test.each(["something_new", "constructor", "__proto__", ""])("unknown %j → Cofounder in #leadership", (type) => {
    expect(routeEvent(type)).toEqual({ role: "cofounder", room: "#leadership" });
  });
});

describe("checkHandoff", () => {
  const support = { role: "support" as const, hop: 0 };

  test("child hop is parent hop + 1, up to hop 3", () => {
    expect(checkHandoff(support, "customer_manager", 0)).toEqual({ ok: true, hop: 1 });
    expect(checkHandoff({ role: "ledger", hop: 2 }, "finance_manager", 0)).toEqual({ ok: true, hop: 3 });
  });

  test("a 4th hop is rejected", () => {
    expect(checkHandoff({ role: "ledger", hop: 3 }, "finance_manager", 0)).toEqual({ ok: false, reason: "hop_limit" });
  });

  test("no child for the parent's own role", () => {
    expect(checkHandoff(support, "support", 0)).toEqual({ ok: false, reason: "self_role" });
  });

  test("at most 3 children per task", () => {
    expect(checkHandoff(support, "ledger", 2)).toMatchObject({ ok: true });
    expect(checkHandoff(support, "ledger", 3)).toEqual({ ok: false, reason: "max_children" });
  });

  test("never hands off to the Executor", () => {
    expect(checkHandoff(support, "executor", 0)).toEqual({ ok: false, reason: "executor_target" });
  });
});

describe("deadlineAction", () => {
  const now = 10_000;
  test.each([
    [{ status: "assigned", deadline: now + 1 }, null],
    [{ status: "assigned", deadline: now }, "nudge"],
    [{ status: "assigned", deadline: now - 1, nudged: true }, "escalate"],
    [{ status: "repairing", deadline: now - 1 }, "escalate"],
    [{ status: "queued", deadline: now - 1 }, null],
    [{ status: "done", deadline: now - 1 }, null],
  ] as const)("%j → %s", (task, expected) => {
    expect(deadlineAction(task, now)).toBe(expected);
  });
});
