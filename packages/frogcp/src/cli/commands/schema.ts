import { resolve } from "node:path";
import {
  compileTables,
  generatePostgresMigration,
  generateSqliteMigration,
  mergePluginEntities,
  type App,
  type BackendConfig,
  type FrogPlugin,
  type RuntimeContext,
} from "frogcp";
import { CliError } from "../errors";
import { assertBackendConfig, importConfigDefault } from "./generate";

export type SchemaDialect = "sqlite" | "postgres";

export const SCHEMA_DIALECTS: readonly SchemaDialect[] = ["sqlite", "postgres"];

export interface SchemaOptions {
  /** Path to the user's `frogcp.config.ts`, resolved against `process.cwd()`. Defaults to `./frogcp.config.ts`. */
  config?: string;
  /** SQL dialect to emit. Defaults to `"sqlite"` (which covers D1). */
  dialect?: SchemaDialect;
}

export interface SchemaResult {
  /** Resolved absolute path to the config file that was loaded. */
  configPath: string;
  dialect: SchemaDialect;
  /** The DDL statements, each terminated with a semicolon. */
  statements: string[];
  /** `statements` joined by newlines: exactly the bytes written to stdout. */
  sql: string;
}

/** A default export carrying a `config` is an App descriptor (`defineApp`), not a bare `BackendConfig`. */
function isApp(value: object): value is App {
  return "config" in value;
}

/**
 * Resolves an App's `plugins` (a list, or a function of the runtime) with the
 * same `RuntimeContext` shape the node adapter uses. A plugin factory that
 * reads a secret from `env` therefore sees the same `process.env` it would
 * under `frogcp run`.
 */
async function resolvePlugins(app: App): Promise<FrogPlugin[]> {
  const ctx: RuntimeContext = {
    onCloudflare: false,
    cloudflareEnv: undefined,
    env: process.env as unknown as Record<string, unknown>,
  };
  const resolved = typeof app.plugins === "function" ? await app.plugins(ctx) : (app.plugins ?? []);
  return resolved.filter((plugin): plugin is FrogPlugin => Boolean(plugin));
}

/**
 * Loads the config and returns the SAME merged entity set the kernel boots
 * with. That merge is the whole point: `authPlugin` contributes `users`, and a
 * config entity may hold a `ref("users")`, so DDL compiled from `config.entities`
 * alone is missing tables and fails to apply.
 *
 * Accepts either shape a `frogcp.config.ts` can default-export: a
 * `BackendConfig` (`defineBackend`), or an `App` (`defineApp`), which is the
 * only one that carries plugins.
 */
async function loadMergedConfig(configPath: string): Promise<{ config: BackendConfig; hasPlugins: boolean }> {
  const exported = await importConfigDefault(configPath);
  if (!exported || typeof exported !== "object") {
    throw new CliError(
      `${configPath} must default-export a BackendConfig (defineBackend({ ... })) or an App (defineApp({ ... })).`,
    );
  }
  if (!isApp(exported)) return { config: assertBackendConfig(exported, configPath), hasPlugins: false };

  const config = assertBackendConfig(exported.config, configPath);
  const plugins = await resolvePlugins(exported);
  return { config: { entities: mergePluginEntities(config, plugins) }, hasPlugins: true };
}

/**
 * Compiles the tables, and turns the one failure a config-only export makes
 * likely into an actionable message. A `ref` at a plugin's entity resolves fine
 * at boot but dangles here, because a `defineBackend` export carries no plugin
 * list for the CLI to merge.
 */
function compileWithPluginHint(
  config: BackendConfig,
  dialect: SchemaDialect,
  hasPlugins: boolean,
): ReturnType<typeof compileTables> {
  try {
    return compileTables(config, dialect);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!hasPlugins && /Unknown ref target/.test(message)) {
      throw new CliError(
        `${message}. The config default-exports a BackendConfig, so no plugin entities were merged. ` +
          "If a plugin owns that entity (auth owns `users`), export an App instead: " +
          "defineApp({ config, plugins: [authPlugin({ ... })] }).",
      );
    }
    throw error;
  }
}

/** drizzle-kit returns statements without a trailing `;`, which a `wrangler d1 execute --file` run needs. */
function terminate(statement: string): string {
  const trimmed = statement.trim();
  return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
}

/**
 * `frogcp schema` prints the full CREATE DDL for a config, and nothing else, so
 * it pipes straight into a file and applies to a bundled runtime that cannot
 * migrate itself:
 *
 *   frogcp schema > schema.sql
 *   wrangler d1 execute my-db --remote --file schema.sql
 *
 * The output is the schema for a FRESH database (every statement diffed against
 * an empty baseline), not an incremental migration. The `__frogcp_migrations`
 * bookkeeping table is deliberately absent: `migrateToConfig` creates it on
 * demand, and it is not part of the user's schema.
 */
export async function schemaCommand(options: SchemaOptions = {}): Promise<SchemaResult> {
  const configPath = resolve(process.cwd(), options.config ?? "./frogcp.config.ts");
  const dialect = options.dialect ?? "sqlite";
  const { config, hasPlugins } = await loadMergedConfig(configPath);

  const tables = compileWithPluginHint(config, dialect, hasPlugins);
  const { statements } =
    dialect === "postgres" ? await generatePostgresMigration(tables) : await generateSqliteMigration(tables);

  const terminated = statements.map(terminate);
  const sql = terminated.join("\n");
  console.log(sql);
  return { configPath, dialect, statements: terminated, sql };
}
