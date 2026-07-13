import { defineConfig } from "tsup";

// One package, many subpath entries. Each module builds to dist/<module>/index.js
// and ships as a subpath export (frogcp/auth, frogcp/adapter/node, and so on).
// Entries get added here as modules are migrated in.
export default defineConfig({
  entry: [
    "src/index.ts",
    "src/adapter/node/index.ts",
    "src/adapter/libsql/index.ts",
    "src/adapter/postgres/index.ts",
    "src/adapter/postgres/testing/ephemeral-postgres.ts",
    "src/adapter/cloudflare/index.ts",
    "src/adapter/nextjs/index.ts",
  ],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  outDir: "dist",
  // A subpath module that imports core (frogcp) or a sibling
  // (frogcp/adapter/node) must reference it as the package at runtime, not
  // inline a second copy, so mark every frogcp* specifier external.
  external: [/^frogcp(\/.*)?$/],
});
