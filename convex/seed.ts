import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { AGENTS, COMPANY, ROOMS } from "./seed.config";

// Gate and ladder thresholds (spec 01). Missing keys are inserted; existing values are left as tuned.
export const CONFIG_DEFAULTS = {
  confidence_min: 0.8,
  money_hard_cap_cents: 50_000,
  novelty_multiplier: 1.5,
  induction_min: 3,
  absence_min_support: 5,
  level_timeout_ms: 5 * 60 * 1000, // demo: 5 min per ladder level
  // Spec 07: one budgets row per scope and period, created by the gate from these limits.
  budget_limits: {
    "company:refund": { limit_cents: 30_000, period: "day" },
    "company:marketing": { limit_cents: 50_000, period: "week" },
  },
} as const;

// Spec 07 seed rule R7 and the founder decisions it was learned from (flow A starts with one learned rule).
export const R7_TEXT =
  "R7: refunds up to $40 for a billing error or defect are allowed when the customer has been with us at least 90 days.";
const R7_SUPPORT = [
  { amount_cents: 3500, refund_reason: "billing_error", customer_tenure_days: 210 },
  { amount_cents: 2900, refund_reason: "defect", customer_tenure_days: 140 },
  { amount_cents: 4000, refund_reason: "billing_error", customer_tenure_days: 95 },
] as const;

export async function seedRules(ctx: MutationCtx): Promise<void> {
  const existing = await ctx.db
    .query("rules")
    .withIndex("by_type_status", (q) => q.eq("action_type", "refund"))
    .take(200);
  if (existing.some((r) => r.text === R7_TEXT)) return;
  const now = Date.now();
  const decisions = [];
  for (const features of R7_SUPPORT) {
    decisions.push(
      await ctx.db.insert("decisions", {
        subject_kind: "action",
        action_type: "refund",
        choice: "approve",
        reason: "Billing error for a long-standing customer.",
        features: { ...features },
        decided_by: "founder",
        created_at: now,
      }),
    );
  }
  await ctx.db.insert("rules", {
    scope: { level: "company" },
    action_type: "refund",
    conditions: [
      { field: "amount_cents", op: "<=", value: 4000 },
      { field: "refund_reason", op: "in", value: ["billing_error", "defect"] },
      { field: "customer_tenure_days", op: ">=", value: 90 },
    ],
    effect: "allow",
    status: "active",
    version: 1,
    supporting_decisions: decisions,
    agreement: { agree: decisions.length, total: decisions.length },
    text: R7_TEXT,
    created_at: now,
  });
}

// Upserts channels and agents from seed.config.ts, seeds config and the demo company profile. Idempotent.
export const config = internalMutation({
  args: {},
  returns: v.object({ rooms: v.number(), agents: v.number(), config: v.number(), rules: v.number(), company: v.boolean() }),
  handler: async (ctx) => {
    // Inserted only when missing, so founder edits from the Setup page survive reseeding.
    if (!(await ctx.db.query("company").first())) {
      await ctx.db.insert("company", { ...COMPANY, updated_at: Date.now() });
    }

    for (const room of ROOMS) {
      const existing = await ctx.db
        .query("rooms")
        .withIndex("by_name", (q) => q.eq("name", room.name))
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, { department: room.department });
      } else {
        await ctx.db.insert("rooms", { name: room.name, department: room.department, next_seq: 1 });
      }
    }

    for (const agent of AGENTS) {
      const fields = {
        role: agent.role,
        department: agent.department,
        manager_role: "manager_role" in agent ? agent.manager_role : undefined,
        kind: agent.kind,
        creao_app_id: agent.creao_app_id,
        input_field: agent.input_field,
        display_name: agent.display_name,
        rooms: [...agent.rooms],
      };
      const existing = await ctx.db
        .query("agents")
        .withIndex("by_role", (q) => q.eq("role", agent.role))
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, fields); // keeps a manual `enabled: false`
      } else {
        await ctx.db.insert("agents", { ...fields, enabled: true });
      }
    }

    for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) {
      const existing = await ctx.db
        .query("config")
        .withIndex("by_key", (q) => q.eq("key", key))
        .unique();
      if (!existing) {
        await ctx.db.insert("config", { key, value });
      }
    }

    await seedRules(ctx);

    await ctx.db.insert("audit_log", {
      actor: "system",
      kind: "seed_config",
      ref: "seed:config",
      detail: { rooms: ROOMS.length, agents: AGENTS.length },
      at: Date.now(),
    });

    return {
      rooms: (await ctx.db.query("rooms").collect()).length,
      agents: (await ctx.db.query("agents").collect()).length,
      config: (await ctx.db.query("config").collect()).length,
      rules: (await ctx.db.query("rules").collect()).length,
      company: (await ctx.db.query("company").first()) !== null,
    };
  },
});
