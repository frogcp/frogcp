import { drizzle } from "drizzle-orm/d1";
import type { SqliteDatabaseAdapter } from "frogcp";

// Transaction-control statements that migrate/sqlite.ts issues through exec().
// This must stay in sync with what that module emits (currently BEGIN
// IMMEDIATE / COMMIT / ROLLBACK). Anything not matched here falls through to
// d1.prepare(ddl).run(), and D1 rejects real transaction control outright.
const TRANSACTION_CONTROL = /^\s*(BEGIN(\s+IMMEDIATE)?|COMMIT|ROLLBACK)\s*;?\s*$/i;

const NON_ATOMIC_MIGRATION_WARNING =
  "[frogcp] D1 does not support atomic multi-statement migrations: transaction control " +
  "(BEGIN/COMMIT/ROLLBACK) is a no-op, so a failed migration can leave the schema partially " +
  "applied with no automatic rollback. For production, run migrations with `wrangler d1 migrations` " +
  "and pass migrate:false to createWorkerHandler/createBackend.";

/**
 * Builds a frogCP DatabaseAdapter backed by a Cloudflare D1Database binding,
 * via drizzle-orm/d1's native driver (no sqlite-proxy callback needed).
 *
 * D1 has no client-visible multi-statement transaction: every exec() and
 * prepare().run() auto-commits, and BEGIN/COMMIT/ROLLBACK throw. migrateToConfig
 * wraps its DDL in BEGIN IMMEDIATE / COMMIT for all-or-nothing migrations, which
 * every other sqlite adapter relies on. To let it run against D1 at all, exec()
 * treats transaction control as a no-op and forwards other statements. The
 * consequence: migrations are not atomic on D1. A migration that fails partway
 * leaves earlier statements committed, with no rollback. For production, prefer
 * `wrangler d1 migrations` and migrate:false. Verified against Miniflare's
 * workerd, which rejects BEGIN/ROLLBACK with D1's production error text.
 */
export function d1Adapter(d1: D1Database): SqliteDatabaseAdapter {
  const db = drizzle(d1);
  let warnedNonAtomic = false;

  return {
    dialect: "sqlite",
    db,
    async exec(ddl: string): Promise<void> {
      if (TRANSACTION_CONTROL.test(ddl)) {
        if (!warnedNonAtomic) {
          warnedNonAtomic = true;
          console.warn(NON_ATOMIC_MIGRATION_WARNING);
        }
        return;
      }
      // prepare(ddl).run(), not d1.exec(ddl): D1's exec() splits its input on
      // every newline and runs each line separately, which breaks our DDL
      // (a single statement is often formatted across several lines).
      // prepare().run() treats the whole string as one statement.
      await d1.prepare(ddl).run();
    },
  };
}
