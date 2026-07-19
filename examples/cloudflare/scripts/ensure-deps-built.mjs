import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// This example imports `frogcp` by package name, the same way an app outside
// the repo would, so it resolves through the package exports to dist. Build it
// if it is missing so the example typechecks, tests, and bundles from a clean
// checkout with no separate build step.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const frogcpEntry = join(repoRoot, "packages", "frogcp", "dist", "index.js");

export default function ensureDepsBuilt() {
  if (existsSync(frogcpEntry)) return;
  execFileSync("pnpm", ["--filter", "frogcp", "build"], { cwd: repoRoot, stdio: "inherit" });
}

// Runs as a vitest globalSetup (default export) and as a plain script from the
// typecheck npm script.
if (process.argv[1] === fileURLToPath(import.meta.url)) ensureDepsBuilt();
