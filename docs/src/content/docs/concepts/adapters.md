---
title: Adapters
description: The DatabaseAdapter, StorageAdapter, and KvStore contracts, the adapters and runtimes that ship, and how defineApp resolves a connection.
sidebar:
  order: 4
---

An adapter is how frogCP reaches something outside itself: a database, a blob
store, a key/value store. Each is a small interface, so a new backing service
is usually one function that returns the interface.

## DatabaseAdapter

A `DatabaseAdapter` is a runtime-agnostic handle to a database that frogCP runs
migrations and queries against. It is a discriminated union on `dialect`,
because SQLite's and Postgres's Drizzle database types are genuinely different
shapes; a caller that narrows on `adapter.dialect` gets a correctly typed
`adapter.db`.

```ts
interface SqliteDatabaseAdapter {
  dialect: "sqlite";
  db: BaseSQLiteDatabase<"sync" | "async", unknown, Record<string, never>>;
  exec(sql: string): Promise<void>;
}

interface PostgresDatabaseAdapter {
  dialect: "postgres";
  db: PgDatabase<PgQueryResultHKT, Record<string, never>>;
  exec(sql: string): Promise<void>;
}

type DatabaseAdapter = SqliteDatabaseAdapter | PostgresDatabaseAdapter;
```

`exec` and `db` must operate against the same single connection. Migration
atomicity relies on `exec("BEGIN IMMEDIATE")` and `exec("COMMIT")` wrapping
statements that run through `db`, so if they were backed by different pooled
connections the transaction would silently do nothing. The same holds for any
per-connection pragma the adapter sets.

`d1Adapter` is the one shipped exception. Cloudflare D1 has no interactive
multi-statement transactions, so its `exec` no-ops transaction control and
migrations against D1 are not atomic. D1 deployments should use CLI migrations
and pass `migrate: false`.

### The database adapters that ship

| Adapter | Module | Signature |
| --- | --- | --- |
| `node:sqlite` | `frogcp/adapter/node` | `nodeSqliteAdapter(path)` |
| libSQL / Turso | `frogcp/adapter/libsql` | `libsqlAdapter({ url, authToken? })` |
| Postgres | `frogcp/adapter/postgres` | `postgresAdapter({ connectionString })` or `postgresAdapter({ pool })` |
| Cloudflare D1 | `frogcp/adapter/cloudflare` | `d1Adapter(env.DB)` |

`nodeSqliteAdapter` takes a filesystem path, or `":memory:"` for an ephemeral
database. Drivers such as `pg` and `@libsql/client` are optional peer
dependencies, so you only install the one you use.

## StorageAdapter

A `StorageAdapter` is a blob store: local disk, R2, S3. It is `Uint8Array`
based, with no `node:Buffer` or `ReadableStream` requirement, so one
implementation runs unchanged on Node and on Workers.

```ts
interface StorageAdapter {
  put(key: string, data: Uint8Array, meta?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  url?(key: string): string | undefined;
}
```

`url` is optional, for a store that can produce a servable address without a
round trip through frogCP. `frogcp/adapter/node` ships `memoryStorage()` and
`frogcp/adapter/cloudflare` ships `r2Storage(bucket)`. A storage adapter is
passed as `createBackend`'s `storage` option and lands on
`KernelContext.storage`.

## KvStore

A `KvStore` is a general-purpose key/value store with optional per-key TTL.
Values are strings; encode structured values as JSON.

```ts
interface KvPutOptions {
  expirationTtl?: number;
}

interface KvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: KvPutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  list?(prefix: string): Promise<string[]>;
}
```

`list` is optional and best-effort, and may be eventually consistent on some
backends such as Cloudflare KV. Use it for admin and reconciliation work, not
for routing. `frogcp/kv`'s `kvPlugin` surfaces a `KvStore` as
`KernelContext.kv`, but a `KvStore` also works standalone over a bare binding.
`frogcp/adapter/node` ships `nodeKv()` and `frogcp/adapter/cloudflare` ships
`cloudflareKv(namespace)`.

A related but distinct contract is `SessionStore`, which is session-shaped: TTL
is always required and there is no listing. `frogcp/adapter/node` ships
`memorySessionStore()` and `frogcp/adapter/cloudflare` ships
`kvSessionStore(namespace)`.

## Runtimes

Separate from the storage contracts, a runtime adapter handles the glue for
where the backend runs.

- **Node.** `createBackend` returns a `Backend` with a `fetch` you hand to
  `@hono/node-server`. The `frogcp` CLI's `run` and `dev` commands do this for
  you.
- **Next.js.** `frogcp/adapter/nextjs` exports `serve(app)`, which returns
  Next.js Route Handlers:

  ```ts
  // app/api/[[...frog]]/route.ts
  import { serve } from "frogcp/adapter/nextjs";
  import { app } from "@/lib/app";

  export const { GET, POST, PUT, PATCH, DELETE } = serve(app);
  ```

  It also exports `getApp(app)` for the memoized `Backend` and
  `fetchBackend(app, path, init?)` for calling the backend in-process from a
  Server Component or Action, forwarding the caller's cookies so the backend
  resolves the same identity the page is authenticated as.

- **Cloudflare Workers.** `frogcp/adapter/cloudflare` exports
  `createWorkerHandler`, which returns a `{ fetch(request, env, ctx) }` handler
  you can export as the module's default. The backend can only be assembled
  once `env` is available, which the runtime provides only inside `fetch`, so
  construction is lazy: the first request in an isolate builds the backend and
  the rest reuse it.

  ```ts
  import { createWorkerHandler, d1Adapter, r2Storage } from "frogcp/adapter/cloudflare";
  import config from "./backend.config";

  export default createWorkerHandler<Env>({
    config,
    resolve: (env) => ({ adapter: d1Adapter(env.DB), storage: r2Storage(env.BUCKET) }),
    migrate: false,
  });
  ```

## defineApp and connection resolution

`createBackend` is the low-level escape hatch and stays that way. `defineApp`
sits on top: it returns a runtime-agnostic `App` descriptor, the config plus the
options every runtime adapter needs to boot a backend.

```ts
import { defineApp } from "frogcp";
import { authPlugin } from "frogcp/auth";
import config from "./backend.config";

export const app = defineApp({
  config,
  connection: "file:./data.sqlite",
  plugins: (ctx) => [authPlugin({ secret: ctx.env.AUTH_SECRET as string })],
});
```

Most fields accept either a value or a function of the resolved
`RuntimeContext`, so an app can wire itself from Cloudflare bindings or
`process.env` without per-runtime glue:

```ts
interface RuntimeContext {
  onCloudflare: boolean;
  cloudflareEnv: Record<string, unknown> | undefined;
  env: Record<string, unknown>;
}
```

`env` is the effective environment: the Cloudflare `env` on Workers,
`process.env` otherwise, so an app never juggles the two.

`buildBackend(app, ctx)` is the single place an `App` plus a `RuntimeContext`
become a live `Backend`. Every runtime adapter funnels through it and they
differ only in how they resolve the context and how they memoize the result.
`createBackendMemo()` gives the Workers per-isolate semantics (one backend per
`env` object, shared in-flight builds, failed builds evicted), and
`createServeHandler(app, resolveContext)` resolves the context once per isolate
for runtimes that resolve their own.

### resolveConnection

`App.connection` is a `Connection`, and `resolveConnection` turns any of its
forms into a concrete `DatabaseAdapter`:

```ts
type Connection = string | DatabaseAdapter | D1Binding | ConnectionResolver;
```

- A **URL string**. `postgres://` or `postgresql://` picks the Postgres
  adapter. `libsql://`, `http(s)://`, or `ws(s)://` picks the libSQL adapter.
  Anything else, including `file:./data.db`, a bare path, and `:memory:`, picks
  `node:sqlite`.
- A resolved **`DatabaseAdapter`**, passed straight through.
- A **Cloudflare D1 binding**, detected structurally and wrapped with
  `d1Adapter`.
- A **`() => DatabaseAdapter` resolver**, invoked and its result resolved.

The default when `connection` is omitted is `"file:./data.sqlite"`.

The matching adapter module is imported dynamically, through a variable rather
than a literal specifier, so an app that only uses `node:sqlite` never bundles
`pg` or `@libsql/client`, and a D1-only Worker never pulls `node:sqlite` into
its bundle.
