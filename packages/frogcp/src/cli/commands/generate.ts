import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createJiti } from "jiti";
import {
  compileTables,
  generateSqliteMigration,
  migrateToConfig,
  type BackendConfig,
} from "frogcp";
import { generateTypes } from "frogcp/codegen";
import { nodeSqliteAdapter } from "frogcp/adapter/node";
import { CliError } from "../errors";

export interface GenerateOptions {
  /** Path to the user's `frogcp.config.ts`, resolved against `process.cwd()`. Defaults to `./frogcp.config.ts`. */
  config?: string;
  /** Apply the migration to `db` instead of printing a dry-run diff. */
  apply?: boolean;
  /** SQLite database file to migrate. Required when `apply` is set. */
  db?: string;
}

export interface GenerateResult {
  /** Resolved absolute path to the config file that was loaded. */
  configPath: string;
  /** Resolved absolute path `frogcp.gen.d.ts` was written to. */
  typesPath: string;
  /** The generated `.d.ts` source (same bytes written to `typesPath`). */
  typesContent: string;
  /** `true` when `--apply` ran a real migration; `false` for a dry run. */
  applied: boolean;
  /**
   * The pending migration DDL. In dry-run mode these are the CREATE statements
   * to go from an empty database to the current config. In `--apply` mode this
   * is empty: `migrateToConfig` diffs against the target db's own recorded
   * snapshot and applies directly, it does not hand back the statements it ran.
   */
  migrationSql: string[];
  /** Absolute path to the database that was migrated, only set when `applied` is true. */
  dbPath?: string;
}

/**
 * Loads a user's `frogcp.config.ts` at runtime via `jiti`, no build step
 * required. `jiti.import(path, { default: true })` transpiles the TS file on
 * the fly and unwraps its `default` export, which is what `defineBackend(...)`'s
 * `export default` produces.
 */
export async function loadBackendConfig(configPath: string): Promise<BackendConfig> {
  const jiti = createJiti(import.meta.url);
  let config: unknown;
  try {
    config = await jiti.import<BackendConfig>(configPath, { default: true });
  } catch (error) {
    throw new CliError(
      `Failed to load config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!config || typeof config !== "object" || !("entities" in config)) {
    throw new CliError(
      `${configPath} must default-export a BackendConfig (the result of defineBackend({ ... })).`,
    );
  }
  // `"entities" in config` alone is satisfied by `{ entities: null }` or
  // `{ entities: [] }`, either of which would then crash deep inside
  // compileTables/generateTypes. Require a real, non-array object so a
  // malformed config fails here with a clear message.
  const entities = (config as { entities: unknown }).entities;
  if (!entities || typeof entities !== "object" || Array.isArray(entities)) {
    throw new CliError(
      `${configPath}: config.entities must be an object (got ${
        entities === null ? "null" : Array.isArray(entities) ? "an array" : typeof entities
      }). Use defineBackend({ entities: { ... } }).`,
    );
  }
  return config as BackendConfig;
}

/**
 * `frogcp generate` writes the typed-client `.d.ts` next to the config, then
 * either prints the pending migration SQL (dry run, the default) or applies it
 * to a real sqlite database (`--apply` + `--db`).
 *
 * Dry run diffs the compiled schema against an empty baseline (there is no
 * `--db` to read a prior snapshot from), so the printed statements are always
 * the full set of `CREATE TABLE`/`CREATE INDEX` statements for the current
 * config, not an incremental diff against a real database. It answers "what
 * does this schema compile to as DDL", and is labelled so it is not mistaken
 * for the latter.
 *
 * Apply opens `--db` with `nodeSqliteAdapter` and calls `migrateToConfig`,
 * which reads that database's own previously-applied snapshot and runs a real
 * incremental, atomic diff.
 */
export async function generateCommand(options: GenerateOptions = {}): Promise<GenerateResult> {
  const configPath = resolve(process.cwd(), options.config ?? "./frogcp.config.ts");
  const config = await loadBackendConfig(configPath);

  const typesContent = generateTypes(config);
  const typesPath = join(dirname(configPath), "frogcp.gen.d.ts");
  await writeFile(typesPath, typesContent, "utf8");
  console.log(`Wrote types: ${typesPath}`);

  if (options.apply) {
    if (!options.db) {
      throw new CliError("--apply requires --db <path> (the sqlite database file to migrate).");
    }
    const dbPath = resolve(process.cwd(), options.db);
    const adapter = nodeSqliteAdapter(dbPath);
    await migrateToConfig(adapter, config);
    console.log(`Applied migration to ${dbPath}`);
    return { configPath, typesPath, typesContent, applied: true, migrationSql: [], dbPath };
  }

  const tables = compileTables(config);
  const { statements } = await generateSqliteMigration(tables);
  console.log("Pending migration (dry run). Pass --apply with --db to apply:");
  for (const statement of statements) console.log(statement);
  return { configPath, typesPath, typesContent, applied: false, migrationSql: statements };
}
