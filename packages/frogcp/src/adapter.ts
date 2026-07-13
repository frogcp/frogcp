import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

/**
 * A runtime-agnostic handle to a database connection frogCP runs migrations
 * and queries against. Concrete adapters (e.g. `frogcp/adapter/node`)
 * construct this from a driver-specific drizzle instance.
 *
 * `exec` and `db` must operate against the same single connection. Migration
 * atomicity relies on `exec("BEGIN IMMEDIATE")`/`exec("COMMIT")`/
 * `exec("ROLLBACK")` wrapping statements run through `db` (see
 * `migrate/sqlite.ts`, `migrate/postgres.ts`); if they were backed by
 * different pooled connections the transaction would silently do nothing. Same
 * goes for any per-connection PRAGMA the adapter sets (e.g. `foreign_keys = ON`).
 *
 * One shipped exception: `frogcp/adapter/cloudflare`'s `d1Adapter` cannot honor
 * this. D1 has no interactive multi-statement transactions, so its `exec`
 * no-ops transaction control and migrations against D1 are not atomic. D1
 * deployments should use CLI migrations and pass `migrate:false`.
 *
 * `DatabaseAdapter` is a discriminated union on `dialect` because SQLite's and
 * Postgres's drizzle database types are genuinely different shapes, so a caller
 * that narrows on `adapter.dialect` gets a correctly-typed `adapter.db` back.
 * Dialect-specific code narrows explicitly; `data/engine.ts`'s `DataEngine`
 * accepts the whole union and erases `db`/tables/columns internally (see the
 * `AnyDb` note there).
 */
export interface SqliteDatabaseAdapter {
  dialect: "sqlite";
  db: BaseSQLiteDatabase<"sync" | "async", unknown, Record<string, never>>;
  exec(sql: string): Promise<void>; // run raw DDL
}

/**
 * The Postgres arm of `DatabaseAdapter`. `db`'s query-result generic stays at
 * the base `PgQueryResultHKT` so core adds no dependency on any Postgres driver
 * (`pg`, `postgres`, ...); that is `frogcp/adapter/postgres`'s job. A concrete
 * adapter's `PgDatabase<TDriverHKT, ...>` narrows this at construction time.
 */
export interface PostgresDatabaseAdapter {
  dialect: "postgres";
  db: PgDatabase<PgQueryResultHKT, Record<string, never>>;
  exec(sql: string): Promise<void>; // run raw DDL
}

export type DatabaseAdapter = SqliteDatabaseAdapter | PostgresDatabaseAdapter;

/**
 * A runtime-agnostic handle to a blob store (local disk, R2, S3, ...) media
 * handling can put/get/delete objects against. Kept minimal and
 * `Uint8Array`-based so one implementation works in both Node and Workers.
 * `KernelContext.storage` wires this in (see `kernel.ts`).
 */
export interface StorageAdapter {
  /** Writes `data` under `key`, overwriting any existing object there. */
  put(key: string, data: Uint8Array, meta?: { contentType?: string }): Promise<void>;
  /** Returns the object's bytes, or `null` if `key` does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  /** Removes the object at `key`; a no-op if it does not exist. */
  delete(key: string): Promise<void>;
  /** A public/servable URL for `key`, when the store can produce one without a round trip through frogCP. */
  url?(key: string): string | undefined;
}

/**
 * A runtime-agnostic key/value store with per-key TTL expiry (Cloudflare KV, an
 * in-memory Map, Redis, ...) for server-side session data. Distinct from
 * `frogcp/auth`'s stateless JWT sessions: this is the slot for session state
 * that genuinely needs server-side storage (OAuth flow state, revocable sessions).
 */
export interface SessionStore {
  /** Returns the stored value for `key`, or `null` if absent or expired. */
  get(key: string): Promise<string | null>;
  /** Stores `value` under `key`, expiring it after `ttlSeconds`. */
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Removes `key`; a no-op if it does not exist (or already expired). */
  delete(key: string): Promise<void>;
}

/** Options for `KvStore.put`. */
export interface KvPutOptions {
  /** Seconds-to-live; the entry self-expires after this. Omitted means no TTL
   * (the entry persists until explicitly deleted or overwritten). */
  expirationTtl?: number;
}

/**
 * A runtime-agnostic, general-purpose key/value store (Cloudflare KV, a
 * node:sqlite table, an in-memory Map), surfaced through `KernelContext.kv` by
 * `frogcp/kv`'s `kvPlugin` and usable standalone over a bare Worker binding.
 *
 * Distinct from `SessionStore`: this is plain KV with optional TTL and an
 * optional `list`, whereas `SessionStore` is session-shaped (TTL always
 * required, no listing). Values are strings; encode structured values as JSON.
 */
export interface KvStore {
  /** Returns the stored value for `key`, or `null` if absent or expired. */
  get(key: string): Promise<string | null>;
  /** Stores `value` under `key`; with `opts.expirationTtl`, expires it after that many seconds. */
  put(key: string, value: string, opts?: KvPutOptions): Promise<void>;
  /** Removes `key`; a no-op if it does not exist (or already expired). */
  delete(key: string): Promise<void>;
  /**
   * Optional: the keys currently stored under `prefix`. Best-effort and
   * possibly eventually-consistent on some backends (Cloudflare KV). Use it for
   * admin/reconciliation, not routing.
   */
  list?(prefix: string): Promise<string[]>;
}
