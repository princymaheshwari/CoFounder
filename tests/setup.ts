import { vi } from "vitest";

// convex-test has no service-token syscall: the AI Gateway token (spec 11) is a fixed string in tests.
vi.mock("convex/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("convex/server")>()),
  getServiceToken: async () => "test-gateway-token",
}));
