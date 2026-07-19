import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The worker imports `frogcp` by name, which resolves to dist, and the
    // wrangler dry-run bundles that same resolution. Build it first.
    globalSetup: ["./scripts/ensure-deps-built.mjs"],
  },
});
