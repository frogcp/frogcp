import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

/**
 * Checks that this example really bundles for Workers, by running the exact
 * command a developer or CI pipeline would: the example's own `wrangler`
 * against its own `wrangler.jsonc` and `src/worker.ts`. `--dry-run` does the
 * full module resolution and esbuild bundle but stops before any call to
 * Cloudflare, so it needs no account or credentials.
 *
 * A source-level check cannot stand in for this. Whether frogCP's core drags a
 * Node-only dependency such as drizzle-kit into the bundle is a question about
 * bundler behavior, and only the bundler can answer it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const exampleDir = join(here, "..");
const wranglerBin = join(exampleDir, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");

const wranglerAvailable = existsSync(wranglerBin);
if (!wranglerAvailable) {
  console.log(
    `[example-cloudflare] Skipping the wrangler bundle test: no wrangler binary at ${wranglerBin}. ` +
      "Run `pnpm install` from the repo root so this example's `wrangler` devDependency is present.",
  );
}

describe.skipIf(!wranglerAvailable)("the example bundles for Cloudflare Workers", () => {
  it(
    "`wrangler deploy --dry-run` succeeds, bundling frogCP core and its migrate modules without pulling in drizzle-kit's driver imports",
    async () => {
      const { stdout, stderr } = await execFileAsync(wranglerBin, ["deploy", "--dry-run"], {
        cwd: exampleDir,
        timeout: 120_000,
        env: { ...process.env, CI: "true" },
      });
      const output = stdout + stderr;
      // Wrangler already exited 0 if we got here. These assertions pin down
      // that it succeeded by completing a real bundle rather than by
      // short-circuiting.
      expect(output).toMatch(/Total Upload:/);
      expect(output).toMatch(/--dry-run: exiting now\./);
      expect(output).not.toMatch(/Could not resolve/);
    },
    // Bundling the whole workspace can be slow on a cold cache.
    150_000,
  );
});
