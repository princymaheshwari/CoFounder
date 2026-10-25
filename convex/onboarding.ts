import { convexGateway } from "@convex-dev/ai-sdk-provider";
import { Output, generateText } from "ai";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { action, internalMutation, mutation, type MutationCtx } from "./_generated/server";
import { audit } from "./channels";
import { assign } from "./dispatcher";
import { DEFAULT_PLAN, MAX_RECURRING, PLAN_SYSTEM, ROLE_ROOM, nextRunAt, normalizePlan, planPrompt, planSchema, recurringBrief, type OnboardingInput, type PlanTask } from "./lib/recurring";
import { insertTask } from "./tasks";

// Onboarding (#start): the founder describes the company, Claude proposes recurring work per department,
// the founder confirms, and each recurring task gets a thread in its owner's channel with a first live run.
// Claude only proposes; the founder's confirm creates the rows, and only the Dispatcher (assign) starts runs.

const MODEL = "anthropic/claude-sonnet-5.5"; // same model as rule induction (rules.ts)
const PLAN_TIMEOUT_MS = 25_000;

const vOnboarding = v.object({
  name: v.string(),
  what: v.string(),
  priorities: v.string(),
  goals: v.string(),
  links: v.array(v.string()),
  docs: v.array(v.object({ name: v.string(), excerpt: v.string() })),
});

const vPlanTask = v.object({
  role: v.string(),
  room: v.string(),
  title: v.string(),
  brief: v.string(),
  trigger: v.union(v.literal("interval"), v.literal("event")),
  every_ms: v.optional(v.number()),
  event_type: v.optional(v.string()),
  cadence_label: v.string(),
});

// What the founder typed, bounded before it reaches a prompt or the database.
function bounded(o: OnboardingInput): OnboardingInput {
  return {
    name: o.name.slice(0, 120),
    what: o.what.slice(0, 2_000),
    priorities: o.priorities.slice(0, 2_000),
    goals: o.goals.slice(0, 2_000),
    links: o.links.slice(0, 10).map((l) => l.slice(0, 300)),
    docs: o.docs.slice(0, 5).map((d) => ({ name: d.name.slice(0, 120), excerpt: d.excerpt.slice(0, 4_000) })),
  };
}

// Proposals only: nothing is stored. Any gateway failure returns the fixed plan so onboarding never stalls.
export const plan = action({
  args: { input: vOnboarding },
  returns: v.object({ source: v.union(v.literal("claude"), v.literal("fallback")), tasks: v.array(vPlanTask) }),
  handler: async (_ctx, { input }) => {
    try {
      const result = await generateText({
        model: convexGateway(MODEL),
        system: PLAN_SYSTEM,
        prompt: planPrompt(bounded(input)),
        output: Output.object({ schema: planSchema, name: "plan" }),
        abortSignal: AbortSignal.timeout(PLAN_TIMEOUT_MS),
        maxRetries: 1,
      });
      return { source: "claude" as const, tasks: normalizePlan(result.output) };
    } catch (e) {
      console.warn(`onboarding.plan fell back to the default plan: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
      return { source: "fallback" as const, tasks: DEFAULT_PLAN };
    }
  },
});

async function roomId(ctx: MutationCtx, name: string): Promise<Id<"rooms">> {
  const room = await ctx.db
    .query("rooms")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
  if (!room) throw new Error(`channel ${name} not seeded (npx convex run seed:config)`);
  return room._id;
}

// One run of a recurring task: a live task the Dispatcher assigns. Later runs write into the first run's thread.
async function startRun(ctx: MutationCtx, t: { role: PlanTask["role"]; room: Id<"rooms">; brief: string; chain: string; thread?: Id<"tasks"> }): Promise<Id<"tasks">> {
  const taskId = await insertTask(ctx, {
    role: t.role,
    room: t.room,
    kind: "work",
    brief: t.brief,
    chain_id: t.chain,
    hop: 0,
    origin_refs: [],
    mode: "live",
    ...(t.thread ? { thread: t.thread } : {}),
  });
  await assign(ctx, taskId);
  return taskId;
}

const isRecurringRole = (role: string): role is PlanTask["role"] => role in ROLE_ROOM;

// The founder's one click: saves what they wrote, replaces any earlier recurring plan, and opens one thread
// per task with its first run.
export const confirm = mutation({
  args: { input: vOnboarding, tasks: v.array(vPlanTask) },
  returns: v.array(v.object({ recurringId: v.id("recurring"), taskId: v.id("tasks"), roomId: v.id("rooms"), room: v.string(), title: v.string() })),
  handler: async (ctx, { input, tasks }) => {
    const now = Date.now();
    const company = await ctx.db.query("company").first();
    if (company) {
      const { what, priorities, goals, links, docs } = bounded(input);
      await ctx.db.patch("company", company._id, { onboarding: { what, priorities, goals, links, docs, at: now }, updated_at: now });
    }

    const earlier = await ctx.db
      .query("recurring")
      .withIndex("by_active_and_next_run_at", (q) => q.eq("active", true))
      .take(100);
    for (const r of earlier) await ctx.db.patch("recurring", r._id, { active: false });

    const created = [];
    for (const [i, t] of tasks.slice(0, MAX_RECURRING).entries()) {
      if (!isRecurringRole(t.role)) continue;
      const roomName = ROLE_ROOM[t.role]; // the owner's home channel, whatever the client sent
      const room = await roomId(ctx, roomName);
      const brief = recurringBrief(t);
      const interval = t.trigger === "interval" && t.every_ms ? Math.max(t.every_ms, 60 * 60 * 1000) : undefined;
      const taskId = await startRun(ctx, { role: t.role, room, brief, chain: `rec_${now}_${i}` });
      const recurringId = await ctx.db.insert("recurring", {
        role: t.role,
        room,
        title: t.title,
        brief,
        cadence_label: t.cadence_label,
        trigger: interval ? "interval" : "event",
        ...(interval ? { every_ms: interval, next_run_at: nextRunAt(interval, now) } : { event_type: t.event_type ?? "support_ticket" }),
        thread: taskId,
        runs: 1,
        active: true,
        created_at: now,
      });
      await audit(ctx, { actor: "founder", kind: "recurring_created", ref: recurringId, detail: { role: t.role, title: t.title, cadence: t.cadence_label, task: taskId } });
      created.push({ recurringId, taskId, roomId: room, room: roomName, title: t.title });
    }
    return created;
  },
});

// Cron (every minute): starts the next run of each due interval task, in its existing thread.
export const runDue = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("recurring")
      .withIndex("by_active_and_next_run_at", (q) => q.eq("active", true).gte("next_run_at", 0).lte("next_run_at", now))
      .take(20);
    for (const r of due) {
      if (!isRecurringRole(r.role) || !r.every_ms) continue;
      await startRun(ctx, { role: r.role, room: r.room, brief: r.brief, chain: `rec_${r._id}_${r.runs + 1}`, thread: r.thread });
      await ctx.db.patch("recurring", r._id, { runs: r.runs + 1, next_run_at: nextRunAt(r.every_ms, now) });
    }
    return due.length;
  },
});
