import { query } from "./_generated/server";

// Placeholder read so the founder app can confirm it is connected to Convex.
// Spec 00 adds health:check (Creao) and health:gateway (AI Gateway) actions here.
export const ping = query({
  args: {},
  handler: async () => {
    return { ok: true, at: Date.now() };
  },
});
