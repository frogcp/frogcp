import { createClient, type InArgs, type Row } from "@libsql/client";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import type { SqliteDatabaseAdapter } from "frogcp";

// SQLite extended result codes the data engine recognizes (see
// isForeignKeyViolation / isUniqueViolation in frogcp). @libsql/client always
// reports the generic SQLITE_CONSTRAINT on error.code and keeps the specific
// kind on error.extendedCode, so remap the extended code onto code, mirroring
// the node:sqlite adapter's numeric errcode remap.
const LIBSQL_EXTENDED_CODES = new Set([
  "SQLITE_CONSTRAINT_FOREIGNKEY",
  "SQLITE_CONSTRAINT_TRIGGER",
  "SQLITE_CONSTRAINT_UNIQUE",
]);

// True when url targets a remote libSQL/Turso server rather than a local SQLite
// file. Remote schemes (libsql:, https:, wss:, and their insecure http:/ws:
// variants) route each execute() through a per-request transport; file: is
// local.
function isRemoteUrl(url: string): boolean {
  return /^(libsql|https?|wss?):\/\//i.test(url);
}

function translateError(error: unknown): unknown {
  if (error instanceof Error) {
    const carrier = error as { code?: string; extendedCode?: string };
    if (carrier.extendedCode !== undefined && LIBSQL_EXTENDED_CODES.has(carrier.extendedCode)) {
      carrier.code = carrier.extendedCode;
    }
  }
  return error;
}

// A row that satisfies both consumers of the sqlite-proxy callback: drizzle's
// mapResultRow indexes rows positionally (join-safe with duplicate column
// names), while raw db.all/db.get expect named access. @libsql/client's Row
// supports both but is not a real Array (no map/spread/iterator), which breaks
// drizzle's values() path that returns rows through unmodified. Rebuilding a
// genuine array with the column names grafted on as extra properties serves
// every consumer. Numeric names and length are skipped so an alias can never
// corrupt the array.
function hybridRow(row: Row, names: string[]): unknown[] {
  const values: unknown[] = names.map((_, i) => row[i] as unknown);
  const result = values as unknown[] & Record<string, unknown>;
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    if (name === "length" || /^\d+$/.test(name)) continue;
    result[name] = values[i];
  }
  return result;
}

/**
 * Builds a frogCP `DatabaseAdapter` backed by `@libsql/client`, against a local
 * `file:` database (including `file::memory:`) or a remote Turso `libsql://`
 * database, surfaced to drizzle through its `sqlite-proxy` async driver
 * (`@libsql/client` is async-native, unlike node:sqlite's synchronous
 * `DatabaseSync`). `exec` and `db` share the single `Client` created here.
 *
 * The connection model differs by URL scheme:
 *
 * - Local `file:` mode: sequential `client.execute()` calls share one
 *   underlying SQLite connection, so the DatabaseAdapter invariant holds.
 *   Transaction control through `exec` (BEGIN IMMEDIATE/COMMIT/ROLLBACK)
 *   governs the statements drizzle runs through `db`, and the one-shot
 *   `PRAGMA foreign_keys = ON` below stays in effect. This is the mode the
 *   conformance suite exercises.
 *
 * - Turso / remote mode: the HTTP/WS transport treats each `execute()` as its
 *   own logical connection. A BEGIN/COMMIT/ROLLBACK sequence spread across
 *   separate calls (how `migrateToConfig` runs migrations) is not guaranteed to
 *   land on one connection, and a connection-scoped `PRAGMA foreign_keys = ON`
 *   is not guaranteed to persist. So against a live Turso server, migration
 *   atomicity and persistent FK enforcement through this adapter are unverified;
 *   single-statement reads and writes are unaffected. The constructor warns once
 *   when handed a remote URL.
 *
 * `foreign_keys` is enabled via an explicit `PRAGMA` (libSQL has no config-level
 * equivalent to node:sqlite's `enableForeignKeyConstraints`) issued once up
 * front; every operation awaits that promise first so no statement races ahead
 * of it onto the connection.
 */
export function libsqlAdapter(config: { url: string; authToken?: string }): SqliteDatabaseAdapter {
  if (isRemoteUrl(config.url)) {
    console.warn(
      "[adapter-libsql] Schema migration against a Turso/remote database " +
        `(${config.url.split("?")[0]}) is not transaction-safe through this adapter: the remote ` +
        "transport treats each statement as its own logical connection, so migrateToConfig's " +
        "BEGIN/COMMIT/ROLLBACK sequence and the connection-scoped PRAGMA foreign_keys=ON are not " +
        "guaranteed to hold. Run migrations against a local file: replica (or via Turso's own " +
        "migration tooling) and apply them, then use this adapter for data operations. Local " +
        "file: databases are fully supported and conformance-tested.",
    );
  }

  const client = createClient(config.authToken !== undefined
    ? { url: config.url, authToken: config.authToken }
    : { url: config.url });

  // Every operation below awaits this first so nothing runs on the connection
  // before foreign key enforcement is turned on.
  const ready = client.execute("PRAGMA foreign_keys = ON").then(() => undefined);

  const db = drizzle(async (sqlText, params, method) => {
    await ready;
    try {
      const rs = await client.execute({ sql: sqlText, args: params as InArgs });
      if (method === "run") return { rows: [] };
      const rows = rs.rows.map((row) => hybridRow(row, rs.columns));
      // sqlite-proxy's get contract: rows is the single row itself (empty array
      // when there is no row), not an array of rows.
      if (method === "get") return { rows: rows[0] ?? [] };
      return { rows };
    } catch (error) {
      throw translateError(error);
    }
  });

  return {
    dialect: "sqlite",
    db,
    async exec(ddl: string): Promise<void> {
      await ready;
      try {
        await client.execute(ddl);
      } catch (error) {
        throw translateError(error);
      }
    },
  };
}
