import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Tests import the package by name (frogcp, frogcp/adapter/node). Resolve those
// to source so the suite runs against src, not a built dist. Mirrors tsconfig paths.
const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    // The CLI tests load configs through jiti that import the `frogcp` package,
    // which resolves to dist, so make sure a build exists before they run.
    globalSetup: ["./test/support/ensure-build.ts"],
  },
  resolve: {
    alias: [
      { find: /^frogcp\/(.+)$/, replacement: `${root}src/$1/index.ts` },
      { find: /^frogcp$/, replacement: `${root}src/index.ts` },
    ],
  },
});
