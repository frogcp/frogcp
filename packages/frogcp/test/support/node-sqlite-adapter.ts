/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import type { SqliteDatabaseAdapter } from "frogcp";

// Test-only sqlite adapter. The real `frogcp/adapter/node` lands in a later PR;
// the core suite needs a working DatabaseAdapter to run against, so this is a
// faithful copy of that adapter's sqlite arm, scoped to the test tree. Once the
// node adapter is migrated, these tests should import `nodeSqliteAdapter` from
// it and this fixture can be deleted.

// SQLite extended result codes the data engine recognizes. node:sqlite reports
// every failure with `code: "ERR_SQLITE_ERROR"` and the extended code in a
// numeric `errcode`; better-sqlite3 exposed it as a string `code`. Remap the
// constraint codes the engine cares about so its detection keeps working.
const SQLITE_ERRCODE_TO_CODE: Record<number, string> = {
  787: "SQLITE_CONSTRAINT_FOREIGNKEY", // dangling reference on INSERT/UPDATE
  1811: "SQLITE_CONSTRAINT_TRIGGER", // ON DELETE RESTRICT (raised via FK trigger)
  2067: "SQLITE_CONSTRAINT_UNIQUE", // duplicate value on a unique column/index
};

function translateError(error: unknown): unknown {
  if (error instanceof Error) {
    const carrier = error as { code?: string; errcode?: number };
    const mapped = carrier.errcode !== undefined ? SQLITE_ERRCODE_TO_CODE[carrier.errcode] : undefined;
    if (mapped) carrier.code = mapped;
  }
  return error;
}

// A row that satisfies both consumers of the sqlite-proxy callback: drizzle's
// `mapResultRow` indexes rows positionally (join-safe with duplicate column
// names), while raw `db.all`/`db.get` expect named access. Returning the
// positional array with the column names grafted on as extra properties serves
// both. Numeric names and `length` are skipped so an alias can never corrupt
// the array itself.
function hybridRow(values: unknown[], names: string[]): unknown[] {
  const row = values as unknown[] & Record<string, unknown>;
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    if (name === "length" || /^\d+$/.test(name)) continue;
    row[name] = values[i];
  }
  return row;
}

/**
 * Builds a frogCP `DatabaseAdapter` backed by Node's builtin `node:sqlite`,
 * surfaced to drizzle through its `sqlite-proxy` driver. `path` passes straight
 * through to `DatabaseSync` (use `:memory:` for an ephemeral database). `exec`
 * and `db` share the single connection, preserving the DatabaseAdapter
 * invariant that transaction control through `exec` governs the statements
 * drizzle runs through `db`.
 */
export function nodeSqliteAdapter(path: string | ":memory:"): SqliteDatabaseAdapter {
  const client = new DatabaseSync(path);
  // Explicit even though DatabaseSync defaults to on, so per-connection FK
  // enforcement never hinges on a constructor default.
  client.exec("PRAGMA foreign_keys = ON");

  const db = drizzle(async (sqlText, params, method) => {
    try {
      const stmt = client.prepare(sqlText);
      const args = params as SQLInputValue[];
      if (method === "run") {
        stmt.run(...args);
        return { rows: [] };
      }
      const names = stmt.columns().map((c) => c.name);
      stmt.setReturnArrays(true);
      const rows = (stmt.all(...args) as unknown as unknown[][]).map((values) =>
        hybridRow(values, names),
      );
      // sqlite-proxy's `get` contract: `rows` is the single row itself (empty
      // array when there is no row), not an array of rows.
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
      try {
        client.exec(ddl);
      } catch (error) {
        throw translateError(error);
      }
    },
  };
}
