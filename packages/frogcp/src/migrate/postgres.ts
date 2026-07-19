import { sql } from "drizzle-orm";
import type { DrizzleSnapshotJSON } from "drizzle-kit/api";
import type { DatabaseAdapter } from "../adapter";
import { consoleLogger, type Logger } from "../observability/logger";
import type { BackendConfig } from "../schema/types";
import { compileTables } from "../compile/drizzle";
import { drizzleKitUnavailable } from "./drizzle-kit";

const MIGRATIONS_TABLE = "__frogcp_migrations";

const DESTRUCTIVE_STATEMENT = /DROP TABLE|DROP COLUMN/i;

/**
 * Same constant and reason as `migrate/sqlite.ts`: routing `drizzle-kit/api`'s
 * specifier through a `const` (rather than a literal) defeats esbuild/wrangler's
 * eager dynamic-import bundling, which would otherwise pull in every DB driver
 * drizzle-kit can import.
 */
const DRIZZLE_KIT_API_SPECIFIER = "drizzle-kit/api";

/**
 * Diffs `tables` (a frogCP-compiled set of drizzle pg-core tables) against an
 * optional previous snapshot using drizzle-kit's schema-diffing API for the
 * `postgresql` dialect.
 *
 * drizzle-kit's Postgres JSON-diff functions are the generically-named ones
 * (`generateDrizzleJson`/`generateMigration`) because Postgres was its original
 * dialect; SQLite/MySQL/SingleStore get dialect-prefixed pairs. There is no
 * `generatePgDrizzleJson`/`generatePgMigration` export.
 *
 * Both functions only work on in-memory snapshots and open no database
 * connection, so this function (and its tests) need no live Postgres server.
 *
 * The import goes through `DRIZZLE_KIT_API_SPECIFIER` to keep drizzle-kit out
 * of bundles; see that constant's comment in `migrate/sqlite.ts`. It is also
 * imported lazily so Workers/managed deployments (which run migrations
 * out-of-band and never reach this path) never load its Node-only ~2.9MB
 * bundle.
 */
export async function generatePostgresMigration(
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
  const { generateDrizzleJson, generateMigration: diffPgSnapshots } = drizzleKit;

  // `previousSnapshot` round-trips through __frogcp_migrations as JSON; it is
  // always a DrizzleSnapshotJSON produced by generateDrizzleJson below, so the
  // assertion recovers that type.
  const prev = previousSnapshot as DrizzleSnapshotJSON | undefined;
  const curSnapshot = generateDrizzleJson(tables, prev?.id);
  const prevSnapshot = prev ?? generateDrizzleJson({});
  // TODO(renames): same caveat as migrate/sqlite.ts. drizzle-kit's default
  // resolvers prompt interactively on a created+deleted diff (potential
  // rename); non-interactive rename support needs custom resolvers via a
  // lower-level drizzle-kit API.
  const statements = await diffPgSnapshots(prevSnapshot, curSnapshot);
  return { statements, snapshot: curSnapshot };
}

/**
 * Postgres drivers' `db.execute()` resolves differently by driver:
 * node-postgres-style drivers resolve to `{ rows: T[] }`, others to `T[]`
 * directly. This core package depends on no concrete Postgres driver (see
 * `PostgresDatabaseAdapter` in `adapter.ts`), so normalize both shapes here.
 * Exported so `test/conformance.ts`'s Postgres introspection assertions can
 * normalize `adapter.db.execute()` results the same way.
 */
export function extractRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result !== null && typeof result === "object" && "rows" in result) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

/**
 * Brings the database behind `adapter` up to date with `config`'s compiled
 * Postgres schema, the counterpart to `migrate/sqlite.ts`'s `migrateToConfig`.
 * Same `__frogcp_migrations` bookkeeping (last snapshot as JSON, one row per
 * applied migration, no-op on an empty diff) and the same atomicity: every
 * statement and the bookkeeping insert run in one `BEGIN`/`COMMIT` (Postgres
 * DDL is transactional), rolling everything back on any failure.
 *
 * Code-complete but untested against a live server: no `frogcp/adapter/postgres`
 * exists yet, so there is no real `PostgresDatabaseAdapter` to run this against.
 * `test/migrate-postgres.test.ts` proves the pure diff-generation half
 * (`generatePostgresMigration`); the apply path below awaits a live-Postgres
 * conformance run.
 *
 * `logger` defaults to `consoleLogger()`; same reasoning as `migrate/sqlite.ts`.
 */
export async function migrateToConfig(
  adapter: DatabaseAdapter,
  config: BackendConfig,
  logger: Logger = consoleLogger(),
): Promise<void> {
  if (adapter.dialect !== "postgres") {
    throw new Error(`migrate/postgres: expected a "postgres"-dialect adapter, got "${adapter.dialect}"`);
  }

  await adapter.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
    id BIGSERIAL PRIMARY KEY,
    snapshot JSONB NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const rows = extractRows<{ snapshot: unknown }>(
    await adapter.db.execute(sql`SELECT snapshot FROM ${sql.raw(MIGRATIONS_TABLE)} ORDER BY id DESC LIMIT 1`),
  );
  const previousRow = rows[0];
  const previousSnapshot =
    previousRow === undefined
      ? undefined
      : ((typeof previousRow.snapshot === "string" ? JSON.parse(previousRow.snapshot) : previousRow.snapshot) as object);

  const tables = compileTables(config, "postgres");
  const { statements, snapshot } = await generatePostgresMigration(tables, previousSnapshot);

  if (statements.length === 0) return;

  if (statements.some((statement) => DESTRUCTIVE_STATEMENT.test(statement))) {
    logger.warn("destructive migration statements about to run", { statements });
  }

  await adapter.exec("BEGIN");
  try {
    for (const statement of statements) {
      await adapter.exec(statement);
    }
    await adapter.db.execute(
      sql`INSERT INTO ${sql.raw(MIGRATIONS_TABLE)} (snapshot) VALUES (${JSON.stringify(snapshot)})`,
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
