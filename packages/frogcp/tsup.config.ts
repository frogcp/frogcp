import { defineConfig } from "tsup";
import { chmod, readFile, writeFile } from "node:fs/promises";

const CLI_BIN = "dist/cli/index.js";

// One package, many subpath entries. Each module builds to dist/<module>/index.js
// and ships as a subpath export (frogcp/auth, frogcp/adapter/node, and so on).
// Entries get added here as modules are migrated in.
export default defineConfig({
  entry: [
    "src/index.ts",
    "src/auth/index.ts",
    "src/media/index.ts",
    "src/kv/index.ts",
    "src/mail/index.ts",
    "src/activity/index.ts",
    "src/client/index.ts",
    "src/cli/index.ts",
    "src/codegen/index.ts",
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
  // `node:sqlite` (adapter/node) and the CLI's `node:` builtins only resolve
  // under the prefixed name; tsup strips the prefix by default, so keep it.
  removeNodeProtocol: false,
  // The `frogcp` bin needs a shebang, but a global `banner` would wrongly
  // prefix every entry, and a shebang in `src/cli/index.ts` desyncs the .d.ts
  // parser (TS2591 across the file). So prepend it to just the built bin here,
  // and mark it executable for npm's bin-linking.
  async onSuccess() {
    const src = await readFile(CLI_BIN, "utf8");
    if (!src.startsWith("#!")) await writeFile(CLI_BIN, `#!/usr/bin/env node\n${src}`);
    await chmod(CLI_BIN, 0o755);
  },
});
