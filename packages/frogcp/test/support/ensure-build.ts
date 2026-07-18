import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The CLI loads a user's config through jiti, and that config imports the
// `frogcp` package, which resolves to dist. Build once when dist is absent so
// the suite passes from a clean checkout without a separate build step.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export default function ensureBuild(): void {
  if (existsSync(join(packageRoot, "dist", "index.js"))) return;
  execFileSync("pnpm", ["exec", "tsup"], { cwd: packageRoot, stdio: "inherit" });
}
