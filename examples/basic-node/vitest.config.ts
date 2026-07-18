import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The suite imports `frogcp` and `@frogcp/admin` by name, which resolve to
    // dist, so make sure both are built before it runs.
    globalSetup: ["./scripts/ensure-deps-built.mjs"],
  },
});
