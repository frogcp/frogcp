import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { basicNodeTemplate } from "../templates/basic-node";
import { cloudflareTemplate } from "../templates/cloudflare";
import { CliError } from "../errors";

/** The scaffold templates `frogcp create` accepts, as a value so the entrypoint can validate `--template` against it. */
export const TEMPLATES = ["basic-node", "cloudflare"] as const;

export type Template = (typeof TEMPLATES)[number];

export interface CreateOptions {
  /** @default "basic-node" */
  template?: Template;
}

export interface CreateResult {
  /** Absolute path to the created project directory. */
  dir: string;
  /** Project-relative paths written, e.g. `["package.json", "frogcp.config.ts", ...]`. */
  files: string[];
}

function templateFiles(name: string, template: Template): Record<string, string> {
  return template === "cloudflare" ? cloudflareTemplate(name) : basicNodeTemplate(name);
}

/**
 * `frogcp create <name>` scaffolds a new frogCP project from an embedded
 * template (see `src/templates/`). The templates are plain TS modules returning
 * `{ relativePath: fileContent }` records rather than files copied off disk, so
 * `create` works from the built CLI alone with no example directory shipped
 * alongside it.
 *
 * Refuses to scaffold into an existing non-empty directory (an empty one is fine).
 */
export async function createCommand(name: string, options: CreateOptions = {}): Promise<CreateResult> {
  if (!name || name.trim().length === 0) {
    throw new CliError("frogcp create: <name> is required.");
  }
  // The name must be a single, plain directory created under the cwd, never a
  // path that escapes it. Reject separators, `..`, and any name that resolves
  // elsewhere, so `frogcp create ../../foo` cannot scaffold outside cwd.
  if (name === "." || name === ".." || /[\\/]/.test(name)) {
    throw new CliError(
      `Invalid project name "${name}": must be a simple directory name (no "/", "\\", "." or "..").`,
    );
  }
  const cwd = process.cwd();
  const dir = resolve(cwd, name);
  // Belt and suspenders against anything the regex missed: the target's parent
  // must be exactly the cwd.
  if (dirname(dir) !== cwd) {
    throw new CliError(
      `Invalid project name "${name}": must resolve to a directory directly inside the current directory.`,
    );
  }
  const template = options.template ?? "basic-node";

  if (existsSync(dir)) {
    const entries = await readdir(dir);
    if (entries.length > 0) {
      throw new CliError(
        `Cannot scaffold into "${name}": directory already exists and is not empty. ` +
          "Choose a different name or remove/empty the existing directory first.",
      );
    }
  }

  const files = templateFiles(name, template);
  await mkdir(dir, { recursive: true });
  const written: string[] = [];
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(dir, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
    written.push(relativePath);
  }

  console.log(`Created ${name}/ from the "${template}" template.`);
  console.log("Next steps:");
  console.log(`  cd ${name}`);
  console.log("  npm install   (or pnpm install / yarn install)");
  console.log("  npm run dev");

  return { dir, files: written };
}
