/// <reference types="node" />
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { createCommand, TEMPLATES, type Template } from "./commands/create";
import { deployCommand, detectStaticSite } from "./commands/deploy";
import { generateCommand } from "./commands/generate";
import { resourcesLsCommand, resourcesRmCommand, type ResourcesOptions } from "./commands/resources";
import { runCommand, devCommand, type RunOptions } from "./commands/run";
import { schemaCommand, SCHEMA_DIALECTS, type SchemaDialect, type SchemaOptions } from "./commands/schema";
import { CliError } from "./errors";

const USAGE = `frogcp: CLI for frogCP backends

Usage:
  frogcp create <name> [--template basic-node|cloudflare]
  frogcp generate [--config <path>] [--apply] [--db <path>]
  frogcp schema [--config <path>] [--dialect sqlite|postgres]
  frogcp run [--config <path>] [--db <path>] [--port <n>] [--managed]
  frogcp dev [--config <path>] [--db <path>] [--port <n>] [--managed]
  frogcp deploy [dir] [--static|--worker] [--spa] [--config <path>] [--entry <path>] [--slug <slug>] [--api-key <key>] [--control-plane <url>]
  frogcp resources ls --slug <slug> [--api-key <key>] [--control-plane <url>]
  frogcp resources rm <binding> --slug <slug> [--api-key <key>] [--control-plane <url>]

Commands:
  create <name>   Scaffold a new frogCP project directory
  generate        Write frogcp.gen.d.ts and show/apply the pending migration
  schema          Print the full CREATE DDL for a fresh database to stdout,
                  for runtimes that cannot migrate themselves (e.g. D1):
                    frogcp schema > schema.sql
                    wrangler d1 execute <db> --remote --file schema.sql
  run           Boot frogcp.config.ts as a standalone server (production/staging)
  dev             Like run, but against a separate dev database; restart to
                  apply config changes (no file-watch yet, see the README)
  deploy [dir]    Deploy to a frogCP control plane: a Worker bundle, or a
                  static site (a folder with no backend, auto-detected)
  resources       Manage a project's provisioned resources:
                    resources ls               List active + orphaned resources
                    resources rm <binding>     Delete an ORPHANED resource

Options for "create":
  --template <basic-node|cloudflare>   Template to scaffold (default: basic-node)

Options for "generate":
  --config <path>   Path to frogcp.config.ts (default: ./frogcp.config.ts)
  --apply           Apply the migration instead of printing a dry run
  --db <path>       SQLite database file to migrate (required with --apply)

Options for "schema":
  --config <path>    Path to frogcp.config.ts (default: ./frogcp.config.ts).
                     A config exporting an App (defineApp) also includes every
                     plugin-contributed table, like auth's users
  --dialect <name>   sqlite (default, covers D1) or postgres

Options for "run" / "dev":
  --config <path>   Path to frogcp.config.ts (default: ./frogcp.config.ts)
  --db <path>       SQLite database file (default: ./data.sqlite for run,
                    ./dev.sqlite for dev; ":memory:" for an ephemeral db)
  --port <n>        Port to listen on (default: 3000)
  --managed         Boot in managed mode (schema stored in the database,
                    editable at runtime) instead of code mode

Options for "deploy":
  [dir]                   Directory to deploy as a static site (default: .);
                          guessed static when it has no backend markers
  --static / --worker     Force the deploy kind instead of guessing
  --spa                   Static: serve index.html for unmatched routes (SPA)
  --config <path>         Path to frogcp.config.ts, validated if present (default: ./frogcp.config.ts)
  --entry <path>          Worker entry file to bundle (default: ./src/worker.ts)
  --slug <slug>           Requested subdomain slug (server-generated if omitted)
  --api-key <key>         API key for an owned deploy (default: $FROGCP_API_KEY;
                          omit entirely for an anonymous deploy, which prints a claim link)
  --control-plane <url>   Control-plane base URL (default: $FROGCP_CONTROL_PLANE,
                          falling back to https://api.frogcp.app)

Other:
  -h, --help        Show this help message
`;

/**
 * Flags that take NO value: their presence alone sets `true`. `--apply` MUST be
 * here. Without an explicit boolean spec the parser would treat
 * `frogcp generate --apply data.sqlite` as `apply="data.sqlite"`, so
 * `apply === true` would be false and the whole `--apply` path (and its guard)
 * would silently no-op into a dry run while still exiting 0, and a CI script
 * checking the exit code would believe the migration applied.
 */
const BOOLEAN_FLAGS = new Set(["apply", "managed", "static", "worker", "spa"]);

/** Flags that REQUIRE a following value token (`--config <path>`, etc.). */
const VALUE_FLAGS = new Set([
  "config",
  "db",
  "dialect",
  "template",
  "port",
  "entry",
  "slug",
  "api-key",
  "control-plane",
]);

interface ParsedArgs {
  // Not `command?: string`: `exactOptionalPropertyTypes` would then reject
  // assigning `argv[0]` (typed `string | undefined`) to it below, since an
  // optional property may be omitted but not explicitly set to `undefined`.
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** Prompts a yes/no question on an interactive TTY, defaulting to yes on a bare
 * Enter. Only called when both stdin and stdout are TTYs. */
async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/**
 * Resolves the deploy KIND for `frogcp deploy [target]`:
 * - `--static` / `--worker` win, explicitly.
 * - else if `target` is a directory with no backend markers: on an interactive
 *   TTY, ask; otherwise (CI) refuse to guess and require an explicit flag.
 * - else `undefined`, the worker default (`deployCommand` bundles `--entry`).
 */
async function resolveDeployType(args: {
  flags: Record<string, string | boolean>;
  target: string | undefined;
}): Promise<"static" | "worker" | undefined> {
  if (args.flags.static === true) return "static";
  if (args.flags.worker === true) return "worker";
  if (args.target === undefined) return undefined;

  const dir = resolve(process.cwd(), args.target);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return undefined;
  if (!detectStaticSite(dir)) return "worker";

  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!interactive) {
    throw new CliError(
      `deploy: "${args.target}" has no backend markers and looks like a static site, ` +
        "but there's no TTY to confirm. Pass --static or --worker explicitly.",
    );
  }
  const yes = await confirm(
    `No backend config found. This looks like a static website. Deploy "${args.target}" as a static site? [Y/n]`,
  );
  return yes ? "static" : "worker";
}

/**
 * A tiny hand-rolled parser, deliberately not a dependency, but explicitly
 * aware of which flags are BOOLEAN vs VALUE-taking rather than guessing from
 * whether the next token "looks like" a flag. Boolean flags consume no value;
 * value flags require a real following value (a clear error if missing or if it
 * is itself another flag); an unknown `--flag` is rejected outright. The first
 * non-flag token becomes `command`; every later non-flag token is `positional`.
 * Flags may appear anywhere, so `frogcp --help` works like `frogcp generate --help`.
 */
function parseArgs(argv: string[]): ParsedArgs {
  let command: string | undefined;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
      } else if (VALUE_FLAGS.has(key)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("-")) {
          throw new CliError(`--${key} requires a value.`);
        }
        flags[key] = next;
        i++;
      } else {
        throw new CliError(`Unknown flag: --${key}`);
      }
    } else if (command === undefined) {
      command = arg;
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}

/** Parses `--port`'s string value into a valid TCP port number (0 = OS-assigned), or throws a clear `CliError`. */
function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CliError(`--port must be an integer between 0 and 65535 (got "${value}").`);
  }
  return port;
}

/**
 * Runs the CLI for a given `argv` (excluding `node`/script path, pass
 * `process.argv.slice(2)`) and returns the process exit code. Kept separate
 * from the `import.meta.url` bin detection below so tests can call `main`
 * directly without spawning a subprocess.
 */
export async function main(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    console.log(USAGE);
    return 0;
  }

  try {
    const { command, positional, flags } = parseArgs(argv);

    if (flags.help) {
      console.log(USAGE);
      return 0;
    }

    switch (command) {
      case "generate": {
        if (positional.length > 0) {
          throw new CliError(
            `generate takes no positional arguments (got "${positional[0]}"). ` +
              "Did you mean --db <path>? e.g. frogcp generate --apply --db data.sqlite",
          );
        }
        // Built incrementally rather than a single object literal, because
        // `exactOptionalPropertyTypes` forbids assigning `undefined` to an
        // optional property: an optional key must be a real value or absent.
        const generateOptions: Parameters<typeof generateCommand>[0] = { apply: flags.apply === true };
        if (typeof flags.config === "string") generateOptions.config = flags.config;
        if (typeof flags.db === "string") generateOptions.db = flags.db;
        await generateCommand(generateOptions);
        return 0;
      }
      case "schema": {
        if (positional.length > 0) {
          throw new CliError(
            `schema takes no positional arguments (got "${positional[0]}"). ` +
              "Redirect the output instead: frogcp schema > schema.sql",
          );
        }
        // Same incremental-build reasoning as "generate" above.
        const schemaOptions: SchemaOptions = {};
        if (typeof flags.config === "string") schemaOptions.config = flags.config;
        if (typeof flags.dialect === "string") {
          if (!(SCHEMA_DIALECTS as readonly string[]).includes(flags.dialect)) {
            throw new CliError(
              `Unknown dialect "${flags.dialect}". Valid dialects: ${SCHEMA_DIALECTS.join(", ")}.`,
            );
          }
          schemaOptions.dialect = flags.dialect as SchemaDialect;
        }
        await schemaCommand(schemaOptions);
        return 0;
      }
      case "create": {
        const name = positional[0];
        if (!name) {
          console.error(`frogcp create: missing <name>\n\n${USAGE}`);
          return 1;
        }
        let template: Template = "basic-node";
        if (typeof flags.template === "string") {
          if (!(TEMPLATES as readonly string[]).includes(flags.template)) {
            throw new CliError(
              `Unknown template "${flags.template}". Valid templates: ${TEMPLATES.join(", ")}.`,
            );
          }
          template = flags.template as Template;
        }
        await createCommand(name, { template });
        return 0;
      }
      case "run":
      case "dev": {
        if (positional.length > 0) {
          throw new CliError(
            `${command} takes no positional arguments (got "${positional[0]}"). ` +
              `Did you mean --config <path>? e.g. frogcp ${command} --config frogcp.config.ts`,
          );
        }
        // Same incremental-build reasoning as "generate" above.
        const runOptions: RunOptions = { managed: flags.managed === true };
        if (typeof flags.config === "string") runOptions.config = flags.config;
        if (typeof flags.db === "string") runOptions.db = flags.db;
        if (typeof flags.port === "string") runOptions.port = parsePort(flags.port);

        const result = command === "run" ? await runCommand(runOptions) : await devCommand(runOptions);

        // A fresh CLI invocation never has a prior SIGINT handler; clearing
        // first also keeps repeated in-process `main()` calls (as in this
        // package's own tests) from piling up listeners.
        process.removeAllListeners("SIGINT");
        process.once("SIGINT", () => {
          console.log("\nShutting down...");
          result.close().then(
            () => process.exit(0),
            (error: unknown) => {
              console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
              process.exit(1);
            },
          );
        });

        return 0;
      }
      case "deploy": {
        if (flags.static && flags.worker) {
          throw new CliError("deploy: pass at most one of --static / --worker.");
        }
        // Same incremental-build reasoning as "generate"/"run" above.
        const deployOptions: Parameters<typeof deployCommand>[0] = {};
        if (typeof flags.config === "string") deployOptions.config = flags.config;
        if (typeof flags.entry === "string") deployOptions.entry = flags.entry;
        if (typeof flags.slug === "string") deployOptions.slug = flags.slug;
        if (typeof flags["api-key"] === "string") deployOptions.apiKey = flags["api-key"];
        if (typeof flags["control-plane"] === "string") deployOptions.controlPlane = flags["control-plane"];

        const target = positional[0];
        if (target !== undefined) deployOptions.path = target;

        // Resolve the deploy KIND: explicit flag wins; otherwise, if the target
        // is a directory with no backend markers, guess static and confirm
        // (interactive) or require an explicit flag (non-interactive).
        const type = await resolveDeployType({ flags, target });
        if (type !== undefined) deployOptions.type = type;
        if (type === "static" && flags.spa === true) deployOptions.spa = true;

        await deployCommand(deployOptions);
        return 0;
      }
      case "resources": {
        const sub = positional[0];
        if (sub !== "ls" && sub !== "rm") {
          throw new CliError(
            `resources: unknown subcommand "${String(sub)}". Use "resources ls" or "resources rm <binding>".`,
          );
        }
        if (typeof flags.slug !== "string") {
          throw new CliError("resources: --slug <slug> is required (which project to manage resources for).");
        }
        // Same incremental-build reasoning as the other commands.
        const resourcesOptions: ResourcesOptions = { slug: flags.slug };
        if (typeof flags["api-key"] === "string") resourcesOptions.apiKey = flags["api-key"];
        if (typeof flags["control-plane"] === "string") resourcesOptions.controlPlane = flags["control-plane"];

        if (sub === "ls") {
          await resourcesLsCommand(resourcesOptions);
        } else {
          const binding = positional[1];
          if (!binding) {
            throw new CliError("resources rm: missing <binding> (the resource's binding name, e.g. CACHE).");
          }
          await resourcesRmCommand({ ...resourcesOptions, binding });
        }
        return 0;
      }
      default: {
        console.error(`Unknown command: ${String(command)}\n\n${USAGE}`);
        return 1;
      }
    }
  } catch (error) {
    if (error instanceof CliError) {
      console.error(error.message);
    } else {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    }
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
