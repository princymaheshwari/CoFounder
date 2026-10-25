import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Completes Creao runs whose webhook never arrived (spec 04).
crons.interval("pollRuns", { minutes: 1 }, internal.dispatcher.pollRuns, {});

// Nudges agents past their deadline once, then escalates them to their manager (spec 05).
crons.interval("checkStuckTasks", { minutes: 1 }, internal.tasks.checkStuckTasks, {});

// Mirrors the Nessie sandbox into ledger_mirror (spec 08); seed and execution also mirror immediately.
crons.interval("syncLedger", { minutes: 10 }, internal.nessie.syncLedger, {});

// Starts the next run of each due recurring task from onboarding, in its existing thread.
crons.interval("runRecurring", { minutes: 1 }, internal.onboarding.runDue, {});

export default crons;
