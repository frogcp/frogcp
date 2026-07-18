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
    alias: [
      // Same alias as `vite.config.ts`: the jsdom suite imports the screens
      // directly rather than through the Vite build.
      { find: "@", replacement: fileURLToPath(new URL("./spa", import.meta.url)) },
      // Resolve the framework from source, so the suite does not depend on a
      // prior build of the sibling package. Mirrors tsconfig paths.
      {
        find: /^frogcp\/(.+)$/,
        replacement: `${fileURLToPath(new URL("../frogcp/src/", import.meta.url))}$1/index.ts`,
      },
      {
        find: /^frogcp$/,
        replacement: fileURLToPath(new URL("../frogcp/src/index.ts", import.meta.url)),
      },
    ],
  },
  test: {
    environment: "node",
    setupFiles: ["./test/spa/setup.ts"],
  },
});
