import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Two test populations live here. `test/serving.test.ts` drives a real frogcp
 * backend and wants the plain node environment, with no jsdom globals
 * shadowing `Request` and `Response`. The suites under `test/spa/` render
 * React and need jsdom, which each of those files opts into with its own
 * `@vitest-environment jsdom` docblock.
 */
export default defineConfig({
  resolve: {
    // Same alias as `vite.config.ts`: the jsdom suite imports the screens
    // directly rather than through the Vite build.
    alias: {
      "@": fileURLToPath(new URL("./spa", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./test/spa/setup.ts"],
  },
});
