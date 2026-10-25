import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Completes Creao runs whose webhook never arrived (spec 04).
crons.interval("pollRuns", { minutes: 1 }, internal.dispatcher.pollRuns, {});

// Nudges agents past their deadline once, then escalates them to their manager (spec 05).
crons.interval("checkStuckTasks", { minutes: 1 }, internal.tasks.checkStuckTasks, {});

export default crons;
