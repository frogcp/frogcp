import { defineConfig } from "tsup";

// One package, many subpath entries. Each module builds to dist/<module>/index.js
// and ships as a subpath export (frogcp/auth, frogcp/adapter/node, and so on).
// Entries get added here as modules are migrated in.
export default defineConfig({
  entry: ["src/index.ts", "src/adapter/node/index.ts", "src/adapter/libsql/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  outDir: "dist",
});
