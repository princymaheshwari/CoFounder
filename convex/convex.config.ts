import { defineApp } from "convex/server";
import { v } from "convex/values";
import workflow from "@convex-dev/workflow/convex.config.js";
import workpool from "@convex-dev/workpool/convex.config.js";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";
import aggregate from "@convex-dev/aggregate/convex.config.js";

// Secrets live only here (Convex env), never in Creao Secrets or the frontend.
// Set with `npx convex env set NAME value` or scripts/set-env.sh.
const app = defineApp({
  env: {
    CREAO_DISPATCHER_KEY: v.optional(v.string()),
    CREAO_OWNER_KEY: v.optional(v.string()),
    CREAO_WEBHOOK_TOKEN: v.optional(v.string()),
    NESSIE_API_KEY: v.optional(v.string()),
    APIFY_TOKEN: v.optional(v.string()),
    APIFY_WEBHOOK_TOKEN: v.optional(v.string()),
    CO_TOKEN_SECRET: v.optional(v.string()),
  },
});

app.use(workflow);

// One pool per department: per-department concurrency + retries for outbound posts.
app.use(workpool, { name: "marketingPool" });
app.use(workpool, { name: "customerPool" });
app.use(workpool, { name: "financePool" });
app.use(workpool, { name: "leadershipPool" });

app.use(rateLimiter);
app.use(aggregate);

export default app;
