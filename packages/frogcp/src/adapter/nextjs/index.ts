/**
 * `frogcp/adapter/nextjs`: embed a frogCP backend in a Next.js app with one
 * call, no hand-rolled runtime glue.
 *
 * ```ts
 * // app/api/[[...frog]]/route.ts
 * import { serve } from "frogcp/adapter/nextjs";
 * import { app } from "@/lib/app";           // your App descriptor
 * export const { GET, POST, PUT, PATCH, DELETE } = serve(app);
 * ```
 *
 * A thin wrapper over the shared serve core (`buildBackend` /
 * `createServeHandler` in `frogcp`). It owns only the Next.js-specific glue:
 * detecting the runtime (plain Node vs Cloudflare Workers via
 * `@opennextjs/cloudflare`) to build the `RuntimeContext`, the default
 * D1-vs-node:sqlite connection selection, and mapping Next.js Route Handlers to
 * `backend.fetch`. Everything generic (connection resolution, plugin building,
 * memoization) lives in the shared core.
 *
 * The heavy runtime deps (`@opennextjs/cloudflare`, `next`) are optional peers,
 * imported dynamically, so this module doesn't drag them (or node:sqlite) into
 * a Worker bundle.
 */

import {
  createServeHandler,
  type App,
  type Backend,
  type Connection,
  type DatabaseAdapter,
  type OrResolver,
  type RuntimeContext,
  type StorageAdapter,
} from "frogcp";

export type { RuntimeContext } from "frogcp";

/**
 * A Next.js app descriptor. It is the shared `App` descriptor, plus a few
 * Next.js-specific convenience fields for the default connection selection.
 * Prefer `App.connection` for new code; `adapter`/`dbPath`/`d1Binding` remain
 * for the "just point me at a DB" default path.
 */
export interface NextjsApp extends App {
  /**
   * DB adapter (legacy convenience, prefer `App.connection`). When neither
   * `connection` nor `adapter` is set, the default is Cloudflare D1 from
   * `env[d1Binding]` on Workers, else node:sqlite at `dbPath`.
   * @deprecated prefer `connection`
   */
  adapter?: OrResolver<DatabaseAdapter>;
  /** Local node:sqlite path when not on Workers (default path). Default `"data.sqlite"`. */
  dbPath?: string;
  /** Cloudflare D1 binding name for the default connection. Default `"DB"`. */
  d1Binding?: string;
}

async function resolveRuntime(): Promise<RuntimeContext> {
  let cloudflareEnv: Record<string, unknown> | undefined;
  try {
    // Keep this a literal specifier. `@opennextjs/cloudflare` is an optional
    // peer (present in the consuming Next.js app, declared as a frogCP
    // devDependency so this module typechecks) and externalized by tsup. A
    // non-literal specifier (`const s = "…"; import(s)`) can't be resolved by
    // the consuming app's bundler (webpack/opennext), so it isn't bundled and
    // the dynamic import throws at runtime on Workers. The catch then swallows
    // it, `onCloudflare` is false, and the default connection falls back to
    // `file:` and node:sqlite, fatal on Workers ("[unenv]
    // sqlite.DatabaseSync is not implemented yet").
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    // The synchronous form: in production Workers it reads the CF context
    // opennext sets on `globalThis` for the in-flight request, populated
    // whenever this runs inside a request (it always does: the backend is built
    // lazily on the first request, see `createServeHandler`). The `{ async: true
    // }` form needs an AsyncLocalStorage only `initOpenNextCloudflareForDev`
    // wires up (dev), so it rejects in production. Resolving this once per
    // isolate (build-once) keeps the sync read in request scope.
    cloudflareEnv = getCloudflareContext().env as unknown as Record<string, unknown>;
  } catch {
    // Not on Workers (plain `next dev`/`next start`), no CF context.
  }
  const onCloudflare = cloudflareEnv !== undefined;
  return {
    onCloudflare,
    cloudflareEnv,
    env: cloudflareEnv ?? (process.env as unknown as Record<string, unknown>),
  };
}

/** A no-op blob store for the Workers path (no node:sqlite-backed storage). */
const noopStorage: StorageAdapter = {
  async put() {},
  async get() {
    return null;
  },
  async delete() {},
};

/** The default connection: Cloudflare D1 from the binding on Workers, else `file:<dbPath>` (node:sqlite). */
function defaultConnection(ctx: RuntimeContext, app: NextjsApp): Connection {
  const binding = ctx.cloudflareEnv?.[app.d1Binding ?? "DB"];
  if (binding) return binding as Connection; // resolveConnection detects the D1 shape
  return `file:${app.dbPath ?? "data.sqlite"}`;
}

async function defaultStorage(ctx: RuntimeContext): Promise<StorageAdapter> {
  if (ctx.onCloudflare) return noopStorage; // don't pull node:sqlite into the Worker bundle
  const { memoryStorage } = await import("frogcp/adapter/node");
  return memoryStorage();
}

/**
 * Lowers a `NextjsApp` to the shared `App` descriptor, filling in the
 * Next.js-specific defaults (connection/storage/migrate) as resolvers of the
 * runtime ctx so the shared core resolves them per build.
 */
function toApp(app: NextjsApp): App {
  return {
    config: app.config,
    connection: app.connection ?? app.adapter ?? ((ctx) => defaultConnection(ctx, app)),
    storage: app.storage ?? ((ctx) => defaultStorage(ctx)),
    plugins: app.plugins ?? [],
    // Preserve the historical default: migrate on Node, not on Workers.
    migrate: app.migrate ?? ((ctx) => !ctx.onCloudflare),
    ...(app.sinks !== undefined ? { sinks: app.sinks } : {}),
    ...(app.mode !== undefined ? { mode: app.mode } : {}),
    ...(app.identify ? { identify: app.identify } : {}),
    ...(app.debugIdentity !== undefined ? { debugIdentity: app.debugIdentity } : {}),
    ...(app.logger ? { logger: app.logger } : {}),
    ...(app.logLevel !== undefined ? { logLevel: app.logLevel } : {}),
  };
}

/** One memoized serve handler per `app` object, so `getApp`/`serve`/`fetchBackend`
 * for the same app all share the one (per-env memoized) backend. */
const handlers = new WeakMap<NextjsApp, ReturnType<typeof createServeHandler>>();

function handlerFor(app: NextjsApp): ReturnType<typeof createServeHandler> {
  let handler = handlers.get(app);
  if (!handler) {
    handler = createServeHandler(toApp(app), resolveRuntime);
    handlers.set(app, handler);
  }
  return handler;
}

/** The memoized `Backend` for this app, for Server Components / Actions calling
 * it in-process (e.g. via a `fetchBackend` helper). */
export function getApp(app: NextjsApp): Promise<Backend> {
  return handlerFor(app).getBackend();
}

type Handler = (req: Request) => Promise<Response>;

/** Returns Next.js Route Handlers (`GET`/`POST`/…) that dispatch every request
 * to the (memoized) backend. Spread into a `route.ts`:
 * `export const { GET, POST, PUT, PATCH, DELETE } = serve(app)`. */
export function serve(app: NextjsApp): {
  GET: Handler;
  POST: Handler;
  PUT: Handler;
  PATCH: Handler;
  DELETE: Handler;
  OPTIONS: Handler;
  HEAD: Handler;
} {
  const handle: Handler = (req) => handlerFor(app).fetch(req);
  return { GET: handle, POST: handle, PUT: handle, PATCH: handle, DELETE: handle, OPTIONS: handle, HEAD: handle };
}

/** Call the embedded backend in-process from a Server Component / Action,
 * forwarding the caller's cookies so the backend resolves the same identity the
 * page is authenticated as. No network hop. `path` is an absolute `/api/...`. */
export async function fetchBackend(app: NextjsApp, path: string, init: RequestInit = {}): Promise<Response> {
  const backend = await getApp(app);
  const headers = new Headers(init.headers);
  try {
    // Keep this a literal specifier (same reasoning as the opennext import in
    // `resolveRuntime`): `next` is an optional peer plus a frogCP devDependency
    // so this typechecks and is externalized, and the literal lets the
    // consuming app's bundler resolve `next/headers`. A non-literal would fail
    // to bundle and throw at runtime, silently dropping cookie forwarding.
    const { cookies } = await import("next/headers");
    const cookieHeader = (await cookies()).toString();
    if (cookieHeader) headers.set("cookie", cookieHeader);
  } catch {
    // Outside a Next request scope (e.g. a test), no cookies to forward.
  }
  // Same-process: any absolute origin works; the request never leaves the isolate.
  return backend.fetch(new Request(`http://frogcp.internal${path}`, { ...init, headers }));
}
