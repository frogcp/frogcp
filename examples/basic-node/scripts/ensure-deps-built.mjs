import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// This example imports `frogcp` and `@frogcp/admin` by package name, the same
// way an app outside the repo would, so both resolve through their package
// exports to dist. Build whichever one is missing so the example typechecks and
// tests from a clean checkout with no separate build step.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const workspaceDeps = [
  { name: "frogcp", entry: join(repoRoot, "packages", "frogcp", "dist", "index.js") },
  { name: "@frogcp/admin", entry: join(repoRoot, "packages", "admin", "dist", "index.js") },
];

export default function ensureDepsBuilt() {
  for (const dep of workspaceDeps) {
    if (existsSync(dep.entry)) continue;
    execFileSync("pnpm", ["--filter", dep.name, "build"], { cwd: repoRoot, stdio: "inherit" });
  }
}

// Runs as a vitest globalSetup (default export) and as a plain script from the
// typecheck npm script.
if (process.argv[1] === fileURLToPath(import.meta.url)) ensureDepsBuilt();
