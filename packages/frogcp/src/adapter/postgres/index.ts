/// <reference types="node" />
import { Client, type Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PostgresDatabaseAdapter } from "frogcp";

export type PostgresAdapterConfig = { connectionString: string } | { pool: Pool };

/**
 * Builds a frogCP DatabaseAdapter backed by pg (node-postgres), surfaced to
 * drizzle through drizzle-orm/node-postgres.
 *
 * The adapter always runs on a single long-lived pg.Client, never a Pool.
 * migrateToConfig wraps its DDL in BEGIN/COMMIT/ROLLBACK issued through exec(),
 * with the bookkeeping snapshot INSERT going through db in between, so exec and
 * db have to share one physical connection for the migration to be atomic. A
 * Pool hands out a (potentially) different connection per query, which would
 * split that sequence across connections and break the rollback guarantee.
 *
 * Both config shapes end up on one dedicated Client:
 * - { connectionString }: opens a Client from the connection string.
 * - { pool }: reads pool.options to open frogCP's own Client with the same
 *   connection parameters, for callers already managing a Pool elsewhere. The
 *   supplied Pool is never queried, so the caller's other uses of it are
 *   unaffected.
 */
export function postgresAdapter(config: PostgresAdapterConfig): PostgresDatabaseAdapter {
  const client = "pool" in config ? new Client(config.pool.options) : new Client(config.connectionString);

  // pg.Client is an EventEmitter that emits "error" on an unexpected
  // connection loss, separately from any in-flight query's own rejection. With
  // no listener Node treats that as uncaught and exits, so log it and stay up;
  // in-flight db/exec calls still reject normally.
  client.on("error", (err: Error) => {
    console.error("[adapter-postgres] connection error:", err);
  });

  const ready = client.connect();
  // A caller that only ever touches db never awaits ready, so a rejected
  // connect would surface as an unhandled rejection. exec awaits this same
  // promise, so this only silences the duplicate warning.
  ready.catch(() => {});

  const db = drizzle(client);

  return {
    dialect: "postgres",
    db,
    async exec(ddl: string): Promise<void> {
      // db does not gate its queries on ready, but node-postgres queues any
      // query issued before the connection is up and flushes them in order
      // once it is, so drizzle's queries are safe. exec awaits ready itself.
      await ready;
      await client.query(ddl);
    },
  };
}
