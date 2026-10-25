import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test", "@convex-dev/ai-sdk-provider"] } },
    include: ["tests/**/*.test.ts", "convex/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
  },
});
