import type { DatabaseAdapter } from "../adapter";

/**
 * A lazy resolver that constructs a `DatabaseAdapter` on demand. The escape
 * hatch arm of `Connection` for a caller who wants full control over how the
 * adapter is built (custom pool, wrapped driver) while still flowing through
 * the same `resolveConnection` seam every runtime uses.
 */
export type ConnectionResolver = () => DatabaseAdapter | Promise<DatabaseAdapter>;

/**
 * The minimal structural shape of a Cloudflare `D1Database` binding. `prepare`
 * plus `batch` are enough to tell a D1 binding apart from a `DatabaseAdapter`
 * (which has `dialect`) without pulling `@cloudflare/workers-types` into core.
 * The real binding is passed straight through to `d1Adapter`, which types it.
 */
export interface D1Binding {
  prepare: (query: string) => unknown;
  batch: (statements: unknown[]) => unknown;
}

/**
 * Everything `resolveConnection` accepts, layered on top of frogCP's explicit
 * `DatabaseAdapter` contract (which stays the escape hatch, never replaced):
 *
 * - a URL string: `postgres://`/`postgresql://` picks the Postgres adapter,
 *   `libsql://`/`http(s)://`/`ws(s)://` picks the libSQL (Turso) adapter, and
 *   anything else (`file:`, a bare path, `:memory:`) picks `node:sqlite`. This
 *   is the default family; `"file:./data.db"` is the zero-config default.
 * - a resolved `DatabaseAdapter`: passed straight through.
 * - a Cloudflare D1 binding object: wrapped with `d1Adapter`.
 * - a `() => DatabaseAdapter` resolver: invoked, its result resolved.
 *
 * The matching adapter module is imported dynamically so an app that only uses
 * (say) node:sqlite never bundles `pg`/`@libsql/client`.
 */
export type Connection = string | DatabaseAdapter | D1Binding | ConnectionResolver;

/** A resolved `DatabaseAdapter` is a discriminated union on `dialect`. */
function isDatabaseAdapter(value: object): value is DatabaseAdapter {
  return "dialect" in value && "db" in value && "exec" in value;
}

/** A D1 binding exposes `prepare` plus `batch`; a `DatabaseAdapter` does not. */
function isD1Binding(value: object): value is D1Binding {
  return "prepare" in value && "batch" in value;
}

// Import through a variable, not a literal. esbuild (which wrangler uses to
// bundle Workers) inlines whatever a literal dynamic import constant-folds to,
// which would pull pg/libsql/node:sqlite into every bundle that touches core
// (e.g. a D1-only Worker) and fail the build. A const defeats that static
// resolution while resolving normally at runtime. Same technique as
// migrate/sqlite.ts's `DRIZZLE_KIT_API_SPECIFIER`. The Cloudflare (d1) path
// stays a literal: it is Workers-native and already in any Worker's graph.
const POSTGRES_ADAPTER_SPECIFIER = "frogcp/adapter/postgres";
const LIBSQL_ADAPTER_SPECIFIER = "frogcp/adapter/libsql";
const NODE_ADAPTER_SPECIFIER = "frogcp/adapter/node";

async function fromUrl(url: string): Promise<DatabaseAdapter> {
  if (/^postgres(ql)?:\/\//i.test(url)) {
    const { postgresAdapter } = (await import(POSTGRES_ADAPTER_SPECIFIER)) as typeof import("frogcp/adapter/postgres");
    return postgresAdapter({ connectionString: url });
  }
  if (/^(libsql|wss?|https?):\/\//i.test(url)) {
    const { libsqlAdapter } = (await import(LIBSQL_ADAPTER_SPECIFIER)) as typeof import("frogcp/adapter/libsql");
    return libsqlAdapter({ url });
  }
  // Everything else is a local node:sqlite database: `:memory:`, a `file:` URL
  // (`file:./data.db`, `file::memory:`), or a bare filesystem path. node:sqlite
  // takes a plain path, so strip a leading `file:` scheme when present.
  const { nodeSqliteAdapter } = (await import(NODE_ADAPTER_SPECIFIER)) as typeof import("frogcp/adapter/node");
  const path = url === ":memory:" ? ":memory:" : url.replace(/^file:/, "");
  return nodeSqliteAdapter(path);
}

/**
 * Resolves any `Connection` spec to a concrete `DatabaseAdapter`, importing
 * only the adapter it actually needs so unused drivers never bundle. See
 * `Connection` for the full acceptance matrix. This is a convenience resolver
 * over the first-party adapters; it does not change the `DatabaseAdapter`
 * contract, which stays the explicit escape hatch a caller can construct by
 * hand and pass straight through here.
 */
export async function resolveConnection(connection: Connection): Promise<DatabaseAdapter> {
  if (typeof connection === "function") {
    return connection();
  }
  if (typeof connection === "string") {
    return fromUrl(connection);
  }
  if (typeof connection === "object" && connection !== null) {
    if (isDatabaseAdapter(connection)) return connection;
    if (isD1Binding(connection)) {
      const { d1Adapter } = await import("frogcp/adapter/cloudflare");
      return d1Adapter(connection as Parameters<typeof d1Adapter>[0]);
    }
  }
  throw new Error(
    "resolveConnection: unrecognized connection, expected a URL string, a DatabaseAdapter, " +
      "a Cloudflare D1 binding, or a () => DatabaseAdapter resolver.",
  );
}
