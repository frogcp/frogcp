import { sql } from "drizzle-orm";
import type { DrizzleSQLiteSnapshotJSON } from "drizzle-kit/api";
import type { DatabaseAdapter } from "../adapter";
import { consoleLogger, type Logger } from "../observability/logger";
import type { BackendConfig } from "../schema/types";
import { compileTables } from "../compile/drizzle";
import { drizzleKitUnavailable } from "./drizzle-kit";

const MIGRATIONS_TABLE = "__frogcp_migrations";

const DESTRUCTIVE_STATEMENT = /DROP TABLE|DROP COLUMN/i;

/**
 * `drizzle-kit/api`'s specifier is held in a `const` so `import()` receives a
 * bare identifier rather than a literal. A lazy `await import` of a literal
 * still lets esbuild (and wrangler) statically resolve and inline the module at
 * build time, which pulls in every DB driver drizzle-kit can import and breaks
 * `wrangler deploy`. Passing a `const` defeats that static analysis, so
 * drizzle-kit stays out of the bundle entirely. The type-only import above is
 * erased at compile time and carries no runtime or bundling cost.
 */
const DRIZZLE_KIT_API_SPECIFIER = "drizzle-kit/api";

/**
 * Diffs `tables` (a frogCP-compiled set of drizzle sqlite tables) against an
 * optional previous snapshot using drizzle-kit's schema-diffing API. Returns
 * the DDL statements to migrate from `previousSnapshot` to the current schema,
 * plus the new snapshot to persist for the next diff. The import goes through
 * `DRIZZLE_KIT_API_SPECIFIER` to keep drizzle-kit out of bundles (see above).
 */
export async function generateSqliteMigration(
  tables: Record<string, unknown>,
  previousSnapshot?: object,
): Promise<{ statements: string[]; snapshot: object }> {
  // Only the import is guarded: an error thrown from inside drizzle-kit after
  // it loads is a real migration failure and propagates untouched.
  let drizzleKit: typeof import("drizzle-kit/api");
  try {
    drizzleKit = (await import(DRIZZLE_KIT_API_SPECIFIER)) as typeof import("drizzle-kit/api");
  } catch (error) {
    throw drizzleKitUnavailable(error);
  }
  const { generateSQLiteDrizzleJson, generateSQLiteMigration: diffSqliteSnapshots } = drizzleKit;

  // `previousSnapshot` round-trips through __frogcp_migrations as JSON; it is
  // always a DrizzleSQLiteSnapshotJSON produced by generateSQLiteDrizzleJson
  // below, so the assertion recovers that type.
  const prev = previousSnapshot as DrizzleSQLiteSnapshotJSON | undefined;
  const curSnapshot = await generateSQLiteDrizzleJson(tables, prev?.id);
  const prevSnapshot = prev ?? (await generateSQLiteDrizzleJson({}));
  // TODO(renames): drizzle-kit's default resolvers prompt interactively when a
  // diff contains both created and deleted tables/columns (a potential
  // rename). Non-interactive rename support needs custom resolvers via a
  // lower-level drizzle-kit API.
  const statements = await diffSqliteSnapshots(prevSnapshot, curSnapshot);
  return { statements, snapshot: curSnapshot };
}

/**
 * Brings the database behind `adapter` up to date with `config`'s compiled
 * schema. The last-applied snapshot is stored as JSON in `__frogcp_migrations`,
 * created on first use. An empty diff writes no new row (idempotent re-migrate).
 *
 * All migration statements and the bookkeeping insert run in one transaction
 * (SQLite DDL is transactional), so any failure rolls the whole migration back
 * and a later `migrateToConfig` can retry cleanly.
 *
 * There is no gate blocking a `DROP TABLE`/`DROP COLUMN` (an opt-in
 * `allowDestructive` guard is a follow-up). Whenever the batch contains one, a
 * single `warn` lists every statement so a destructive change is never silently
 * applied.
 *
 * `logger` defaults to `consoleLogger()`; `createBackend` passes the configured
 * backend logger at boot and from `Backend.applySchema`.
 */
export async function migrateToConfig(
  adapter: DatabaseAdapter,
  config: BackendConfig,
  logger: Logger = consoleLogger(),
): Promise<void> {
  if (adapter.dialect !== "sqlite") {
    throw new Error(`migrate/sqlite: expected a "sqlite"-dialect adapter, got "${adapter.dialect}"`);
  }

  await adapter.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);

  const rows = await adapter.db.all<{ snapshot: string }>(
    sql`SELECT snapshot FROM ${sql.raw(MIGRATIONS_TABLE)} ORDER BY id DESC LIMIT 1`,
  );
  const previousSnapshot = rows[0] ? (JSON.parse(rows[0].snapshot) as object) : undefined;

  const tables = compileTables(config);
  const { statements, snapshot } = await generateSqliteMigration(tables, previousSnapshot);

  if (statements.length === 0) return;

  if (statements.some((statement) => DESTRUCTIVE_STATEMENT.test(statement))) {
    logger.warn("destructive migration statements about to run", { statements });
  }

  await adapter.exec("BEGIN IMMEDIATE");
  try {
    for (const statement of statements) {
      await adapter.exec(statement);
    }
    await adapter.db.run(
      sql`INSERT INTO ${sql.raw(MIGRATIONS_TABLE)} (snapshot, applied_at) VALUES (${JSON.stringify(snapshot)}, ${Date.now()})`,
    );
    await adapter.exec("COMMIT");
  } catch (error) {
    try {
      await adapter.exec("ROLLBACK");
    } catch {
      // A rollback failure (e.g. connection already closed) must not mask the
      // original migration error.
    }
    throw error;
  }
}
