import type { StorageAdapter } from "../adapter";
import { createBackend, type Backend, type CreateBackendOptions, type FrogPlugin } from "../kernel";
import type { BackendConfig } from "../schema/types";
import { resolveConnection, type Connection } from "./connection";

/**
 * The resolved runtime an App descriptor's builders (`plugins`, `connection`,
 * `storage`) see. The one runtime shape every `frogcp/adapter/*` funnels
 * through, so an app's builders read config and secrets the same way
 * everywhere. `env` is the effective env: the Cloudflare `env` (bindings, vars,
 * secrets) on Workers, `process.env` on Node, so an app never juggles the two.
 */
export interface RuntimeContext {
  /** True when running on Cloudflare Workers (a CF context was resolvable). */
  onCloudflare: boolean;
  /** The raw Cloudflare Workers `env` (bindings) when on Workers, else undefined. */
  cloudflareEnv: Record<string, unknown> | undefined;
  /** Effective env to read from: `cloudflareEnv` on Workers, else `process.env`. */
  env: Record<string, unknown>;
}

/** A value, or a (possibly async) function of the resolved runtime. */
export type OrResolver<T> = T | ((ctx: RuntimeContext) => T | Promise<T>);

/**
 * A runtime-agnostic description of a frogCP app: the `config` plus the common
 * options every runtime adapter (`frogcp/adapter/{nextjs,cloudflare,node}`)
 * needs to boot a backend, each optionally a function of the resolved
 * `RuntimeContext` so an app can wire itself from Cloudflare bindings or
 * `process.env` without hand-rolling per-runtime glue.
 *
 * This is a thin layer over `CreateBackendOptions`; `createBackend` stays the
 * low-level escape hatch. `defineApp` is the ergonomic factory, and
 * `buildBackend` is the single place an `App` plus a `RuntimeContext` become a
 * live `Backend`.
 *
 * An `App` does not force auth or media always-on: frogCP keeps its
 * explicit-plugins philosophy. `defineApp` only removes ceremony (connection
 * resolution plus one place for the common options).
 */
export interface App {
  /** The backend schema/config (`defineBackend(...)`). */
  config: BackendConfig;
  /**
   * The database connection: a URL string (`"file:./data.db"`, `"libsql://…"`,
   * `"postgres://…"`), a resolved `DatabaseAdapter`, a Cloudflare D1 binding, or
   * a `() => DatabaseAdapter`. Resolved via `resolveConnection`. Defaults to
   * `"file:./data.sqlite"` (node:sqlite).
   */
  connection?: OrResolver<Connection>;
  /** Plugins to compose in: a list, or a function of the runtime (so a plugin can be wired from bindings). Falsy entries are skipped. */
  plugins?: OrResolver<(FrogPlugin | false | null | undefined)[]>;
  /** Blob storage for media handling. */
  storage?: OrResolver<StorageAdapter>;
  /** Observability sinks. */
  sinks?: OrResolver<CreateBackendOptions["sinks"]>;
  /** Run migrations on boot. Defaults to `createBackend`'s default (`true`). */
  migrate?: OrResolver<boolean>;
  /** `"code"` (default) or `"managed"` (schema stored in the DB, editable at runtime). */
  mode?: OrResolver<"code" | "managed">;
  /** Explicit identity resolver (see `CreateBackendOptions.identify`). */
  identify?: CreateBackendOptions["identify"];
  /** Honor the `x-frogcp-debug-identity` header (dev tooling only). */
  debugIdentity?: boolean;
  /** The backend's own logger (see `CreateBackendOptions.logger`). */
  logger?: CreateBackendOptions["logger"];
  /** Default logger level when `logger` isn't given. */
  logLevel?: CreateBackendOptions["logLevel"];
}

/**
 * The ergonomic App factory: a thin facade that returns a runtime-agnostic
 * `App` descriptor (like `defineBackend` for the whole app). It adds no
 * behavior beyond typing the shape precisely; `createBackend` stays the
 * low-level escape hatch and `buildBackend` turns the descriptor into a live
 * `Backend`. Kept identity-simple so the descriptor is a plain, inspectable
 * object every runtime adapter can consume.
 */
export function defineApp(app: App): App {
  return app;
}

async function resolveValue<T>(
  value: OrResolver<T> | undefined,
  ctx: RuntimeContext,
  fallback: () => T | Promise<T>,
): Promise<T> {
  if (value === undefined) return fallback();
  return typeof value === "function" ? (value as (c: RuntimeContext) => T | Promise<T>)(ctx) : value;
}

/**
 * The one place a frogCP backend is booted from an `App` descriptor plus a
 * resolved `RuntimeContext`: resolves the connection (to a `DatabaseAdapter`),
 * resolves every builder against `ctx`, and hands the assembled options to
 * `createBackend`. Every `frogcp/adapter/*` runtime funnels through here; they
 * differ only in how they resolve the `RuntimeContext` (Cloudflare `env`,
 * `process.env`, opennext detection) and how they memoize the result.
 */
export async function buildBackend(app: App, ctx: RuntimeContext): Promise<Backend> {
  const [connection, storage, plugins, sinks, mode] = await Promise.all([
    resolveValue<Connection>(app.connection, ctx, () => "file:./data.sqlite"),
    resolveValue<StorageAdapter | undefined>(app.storage, ctx, () => undefined),
    resolveValue<(FrogPlugin | false | null | undefined)[]>(app.plugins, ctx, () => []),
    resolveValue<CreateBackendOptions["sinks"] | undefined>(app.sinks, ctx, () => undefined),
    resolveValue<"code" | "managed" | undefined>(app.mode, ctx, () => undefined),
  ]);
  // Forward `migrate` only when the app sets it. Otherwise `createBackend`
  // applies its own default (`true`), which the worker/node paths rely on.
  const migrate = app.migrate === undefined ? undefined : await resolveValue<boolean>(app.migrate, ctx, () => true);

  const adapter = await resolveConnection(connection);

  const options: CreateBackendOptions = {
    config: app.config,
    adapter,
    plugins,
    ...(storage ? { storage } : {}),
    ...(sinks ? { sinks } : {}),
    ...(mode ? { mode } : {}),
    ...(migrate !== undefined ? { migrate } : {}),
    ...(app.identify ? { identify: app.identify } : {}),
    ...(app.debugIdentity !== undefined ? { debugIdentity: app.debugIdentity } : {}),
    ...(app.logger ? { logger: app.logger } : {}),
    ...(app.logLevel !== undefined ? { logLevel: app.logLevel } : {}),
  };
  return createBackend(options);
}

/**
 * A per-key backend cache with the Workers per-isolate build semantics: one
 * backend per key (by object identity, via `WeakMap`), concurrent cold-start
 * callers share the one in-flight build, and a failed build is evicted so a
 * later call gets a fresh attempt rather than a pinned, permanently-rejected
 * promise. Used by the cloudflare adapter, which is handed a fresh `env` per
 * request and so keys by it. (The nextjs adapter resolves its context once per
 * isolate, see `createServeHandler`, so it builds once instead.)
 */
export function createBackendMemo(): {
  resolve(key: object, build: () => Promise<Backend>): Promise<Backend>;
} {
  const byKey = new WeakMap<object, Promise<Backend>>();
  return {
    resolve(key, build) {
      const existing = byKey.get(key);
      if (existing) return existing;
      // A synchronous throw in `build` (e.g. a runtime's `resolve()` throwing)
      // propagates without caching anything, so the next call retries cleanly.
      const promise = build();
      byKey.set(key, promise);
      promise.catch(() => {
        if (byKey.get(key) === promise) byKey.delete(key);
      });
      return promise;
    },
  };
}

/**
 * A memoized fetch handler for a runtime that resolves its own
 * `RuntimeContext` (nextjs, node) rather than receiving one per request.
 *
 * The backend, and the `RuntimeContext` it's built from, is resolved exactly
 * once per isolate, then cached. This matters on Cloudflare Workers (via
 * `@opennextjs/cloudflare`): `getCloudflareContext` reliably yields the CF
 * `env` (bindings) on the first in-request resolution, but re-resolving it on
 * every request intermittently misses the CF context, which would make the
 * default connection fall back to `file:` and node:sqlite (fatal on Workers:
 * "[unenv] sqlite.DatabaseSync is not implemented yet"). Resolving once and
 * caching mirrors the historical single-`backendPromise` embedding that ran
 * reliably in production. A failed build is evicted so a transient first-build
 * error retries cleanly rather than pinning a permanently-rejected promise.
 * Used by `frogcp/adapter/nextjs`.
 */
export function createServeHandler(
  app: App,
  resolveContext: () => RuntimeContext | Promise<RuntimeContext>,
): {
  getBackend(): Promise<Backend>;
  fetch(req: Request): Promise<Response>;
} {
  let building: Promise<Backend> | undefined;
  function getBackend(): Promise<Backend> {
    let promise = building;
    if (!promise) {
      promise = (async () => buildBackend(app, await resolveContext()))();
      building = promise;
      promise.catch(() => {
        if (building === promise) building = undefined;
      });
    }
    return promise;
  }
  return {
    getBackend,
    fetch: async (req) => (await getBackend()).fetch(req),
  };
}
