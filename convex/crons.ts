import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Completes Creao runs whose webhook never arrived (spec 04).
crons.interval("pollRuns", { minutes: 1 }, internal.dispatcher.pollRuns, {});

export default crons;
