import { Hono, type MiddlewareHandler } from "hono";
import type { DatabaseAdapter, StorageAdapter, KvStore } from "./adapter";
import { apiErrorResponse, apiNotFoundResponse, buildApiRoutes, type ApiVariables } from "./api/routes";
import { compileTables, type CompiledTables } from "./compile/drizzle";
import { ApiError, DataEngine } from "./data/engine";
import { EventBus } from "./events";
import { readStoredSchema, writeStoredSchema } from "./managed/store";
import { migrateToConfig } from "./migrate/index";
import { consoleLoggerWithTee, type Logger, type LogLevel } from "./observability/logger";
import { ObservabilityRegistry } from "./observability/registry";
import type { AuditSink, LogSink, MetricSink, SpanSink } from "./observability/sinks";
import type { MetricPoint } from "./observability/types";
import type { Ctx } from "./permissions/engine";
import { validateConfig } from "./schema/validate-config";
import type { BackendConfig, EntityDef } from "./schema/types";

/**
 * The public plugin API: a composable unit of backend behavior (entities,
 * identity, middleware, routes, boot work) merged into a backend via
 * `createBackend`'s `plugins` array, in order. Every hook is optional, so a
 * plugin can be as small as "just some entities". Treat every member as a
 * stable contract.
 *
 * Self-skipping factories: a plugin that is inert without an optional
 * dependency (a store, a transport, a binding that may be absent) should make
 * that dependency optional and return `false` when it is missing. The kernel
 * skips falsy `plugins` entries, so callers wire every optional plugin the same
 * flat way (`kvPlugin(maybeStore)`) with no `...(x ? [x] : [])` guard.
 */
export interface FrogPlugin {
  name: string;
  /** Resolved entity defs (build with `resolveEntities`) merged into the backend's config at boot. */
  entities?: Record<string, EntityDef>;
  /** Resolves the caller's identity from the raw request. Only the first plugin in the array providing this is used. */
  identify?: (req: Request) => Promise<Ctx> | Ctx;
  /**
   * Onion request middleware wrapping every route (plugin and core). Registered
   * after the kernel's correlation-id + identity middleware (so it can read
   * `c.get("ctx")`/`c.get("logger")`/`c.get("requestId")`) and before all
   * routes. Runs in `plugins` array order inbound, unwinds in reverse outbound
   * (standard Hono onion semantics). A middleware may skip `next()` and return
   * a `Response` to short-circuit routing (outer middlewares still unwind). A
   * middleware that throws propagates to the kernel's `app.onError` handler;
   * unlike event handlers, middleware is not swallowed, so post-`next()` work
   * that must never fail the request (e.g. a sink flush) is responsible for its
   * own try/catch. To defer post-response work without delaying the response,
   * `c.executionCtx?.waitUntil(...)` is available on Workers (guarded with `?.`
   * since the Node adapter's context has no `executionCtx`).
   */
  middleware?: FrogMiddleware;
  /** Registers routes on the kernel's Hono app, before the core `/api` routes, so it can claim specific paths like `/api/auth/*`. */
  routes?: (app: Hono<{ Variables: ApiVariables }>, ctx: KernelContext) => void;
  /** Runs once at boot, in array order, before any plugin's routes are registered. */
  onBoot?: (ctx: KernelContext) => void | Promise<void>;
}

/** A plugin's onion request middleware (see `FrogPlugin.middleware` for the
 * full ordering/short-circuit/error contract). Re-exported (as
 * `FrogMiddleware`) from `index.ts` so plugin authors don't hand-roll the
 * `{ Variables: ApiVariables }` generic or import `Hono` internals. */
export type FrogMiddleware = MiddlewareHandler<{ Variables: ApiVariables }>;

/** The assembled pieces of a backend, handed to every plugin hook. */
export interface KernelContext {
  config: BackendConfig;
  engine: DataEngine;
  adapter: DatabaseAdapter;
  tables: CompiledTables;
  events: EventBus;
  /**
   * The blob store for media handling, when `createBackend` was given one (see
   * `CreateBackendOptions.storage`). Optional; this is just the slot.
   */
  storage?: StorageAdapter;
  /**
   * A general-purpose key/value store, when a `kvPlugin` (`frogcp/kv`) is in the
   * plugin array (it sets this slot in its `onBoot`). Optional: features that
   * need KV check for it and degrade explicitly when absent, like `storage`.
   */
  kv?: KvStore;
  /**
   * The set of entity names contributed by `plugins` (never the user/stored
   * config). Stable for the lifetime of a `Backend`. Threaded through to
   * `buildApiRoutes` so the schema API can flag each entity `pluginOwned` and
   * strip plugin-owned entities from a posted config.
   */
  pluginEntityNames: ReadonlySet<string>;
  /**
   * The backend's own (non-request-scoped) logger. Plugins get this via
   * `ctx.logger` for boot-time logging; per-request logging should prefer the
   * request-scoped logger the correlation-id middleware sets (`c.get("logger")`),
   * so log lines carry the request's correlation id.
   */
  logger: Logger;
  /**
   * The pluggable-observability fan-out hub, seeded at boot from
   * `CreateBackendOptions.sinks`, so a plugin's `onBoot` can register its own
   * sinks (`ctx.observability.addMetricSink(...)`). The backend's own logger
   * tees every emitted `LogRecord` here too (see `consoleLoggerWithTee`).
   */
  observability: ObservabilityRegistry;
}

/** The assembled frogCP backend: a standalone fetch handler plus the pieces it was built from. */
export interface Backend {
  /** The whole backend as a fetch handler, usable standalone (`const { fetch } = backend`). */
  fetch: (req: Request) => Promise<Response>;
  engine: DataEngine;
  /** Plugin mount point for later phases. */
  hono: Hono<{ Variables: ApiVariables }>;
  events: EventBus;
  /** The current compiled tables, reflecting any `applySchema` hot-swap since boot. */
  tables: CompiledTables;
  /**
   * Hot-swaps the live user schema (managed mode only): merges `newUserConfig`
   * with this backend's plugin entities, validates the result, runs
   * `migrateToConfig` as an atomic online migration, and only once that
   * succeeds persists `newUserConfig` to the `__frogcp_schema` store and swaps
   * the live `DataEngine`'s tables plus `KernelContext.config`/`tables`, so the
   * next `fetch()` already sees the new schema.
   *
   * `newUserConfig` is the user-entity portion only; do not include plugin
   * entities (they are re-merged from this backend's own `plugins`, as at boot).
   *
   * A failed migration (invalid config, or a rejected statement) throws and
   * leaves the database and the live schema unchanged (`migrateToConfig` is
   * atomic). The one narrow exception is a failure of the store write that runs
   * after a committed migration: the database would then be migrated while the
   * store still holds the previous schema (surfaced loudly, self-corrected on
   * next boot; see the inline comment on the write).
   *
   * Concurrent calls on the same `Backend` are serialized (one migration at a
   * time; a second call waits for the first to settle).
   *
   * Single-instance caveat (v1): the serialization is an in-process
   * promise-chain mutex; it only coordinates calls through this `Backend` object
   * in this process, with no cross-process locking. Running more than one server
   * instance against the same managed-mode database means two instances can each
   * start a migration concurrently. The database's own transaction protects
   * against a torn schema on any one migration, but instance B keeps serving its
   * old in-memory schema until it reboots (which re-reads `__frogcp_schema`).
   * So managed mode is single-instance for v1. Code mode has no such constraint.
   * A cross-process lock is tracked as post-v1 work.
   *
   * Throws in code mode (`mode !== "managed"`): code mode's schema is the
   * `config` passed to `createBackend`, not editable at runtime.
   *
   * `ctx` is accepted (but unused here) so callers driving this from an
   * authenticated admin route can thread the caller's identity through for
   * logging/auditing.
   */
  applySchema: (newUserConfig: BackendConfig, ctx?: Ctx) => Promise<void>;
}

export interface CreateBackendOptions {
  config: BackendConfig;
  adapter: DatabaseAdapter;
  /**
   * `"code"` (default): `config` is the schema, fixed for the process lifetime.
   *
   * `"managed"`: the schema for user entities lives in the database's
   * `__frogcp_schema` table, editable at runtime via `Backend.applySchema`. On
   * boot, if a schema is stored, it is the live user schema and `config` is
   * ignored beyond seeding a fresh database. If none is stored (a fresh
   * database), `config` seeds the store, so every later boot loads from the
   * store instead. Plugin entities are re-merged on top on every boot; they are
   * code-defined, never read from or written to the store.
   *
   * Single-instance (v1): managed mode's migration mutex is in-process only.
   * Run exactly one server instance against a given managed-mode database.
   */
  mode?: "code" | "managed";
  /** Auth plugin hook resolving the caller's identity from the raw request; defaults to always-guest. */
  identify?: (req: Request) => Promise<Ctx>;
  /**
   * When `true`, honors the `x-frogcp-debug-identity: userId:role` header as a
   * shortcut identity source (tests/dev tooling only). Ignored when `identify`
   * is provided. Defaults to `false`.
   */
  debugIdentity?: boolean;
  /** Run `migrateToConfig` on boot. Defaults to `true`. */
  migrate?: boolean;
  /**
   * Plugins to merge into this backend, applied in array order. Falsy entries
   * are skipped, so an optional plugin can be wired inline as `flag && plugin()`
   * or `kvPlugin(maybeStore)` without a `...(x ? [x] : [])` spread.
   */
  plugins?: Array<FrogPlugin | false | null | undefined>;
  /** Blob store for media handling; populates `KernelContext.storage`. Just the slot for now. */
  storage?: StorageAdapter;
  /**
   * The backend's own (non-request-scoped) `Logger`, defaulting to
   * `consoleLogger({ level: logLevel })`. Exposed on `KernelContext.logger` and
   * is the parent every per-request logger is `child()`ed from.
   */
  logger?: Logger;
  /**
   * Shortcut for the default logger's level when `logger` isn't given.
   * Ignored (no error) if `logger` is also provided.
   */
  logLevel?: LogLevel;
  /**
   * Sinks to register on `KernelContext.observability` at boot, a convenience
   * for wiring observability without writing a plugin. Each array's sinks are
   * added in order. Defaults to no sinks (console logging only; metrics/spans/
   * audit are silent no-ops).
   */
  sinks?: {
    log?: LogSink[];
    metric?: MetricSink[];
    span?: SpanSink[];
    audit?: AuditSink[];
  };
}

/**
 * Sanitizes an incoming `X-Request-Id` header for safe inclusion in our logs as
 * `clientRequestId`. This value is client-controlled and must never be used as
 * our correlation id or response header (log injection / spoofing). Only
 * alphanumeric characters and dashes are accepted (capped to 128 chars before
 * validation); anything else rejects the whole value (returns `undefined`)
 * rather than silently stripping bad characters.
 */
function sanitizeClientRequestId(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const capped = raw.slice(0, 128);
  return /^[A-Za-z0-9-]+$/.test(capped) ? capped : undefined;
}

/** Parses the `x-frogcp-debug-identity: userId:role` header; any malformed value resolves to guest. */
function parseDebugIdentityHeader(req: Request): Ctx {
  const header = req.headers.get("x-frogcp-debug-identity");
  if (!header) return null;
  const sepIndex = header.indexOf(":");
  if (sepIndex <= 0 || sepIndex === header.length - 1) return null;
  const userId = header.slice(0, sepIndex);
  const role = header.slice(sepIndex + 1);
  return { userId, role };
}

/**
 * Merges every plugin's `entities` into `config.entities`, in array order.
 * Throws on the first name collision (against a config entity or an earlier
 * plugin's), naming the plugin that lost, so a misconfigured plugin set fails
 * loudly at boot rather than silently shadowing an entity.
 *
 * Every plugin-contributed entity is frozen here, matching the leaf-level freeze
 * `defineBackend` applies to user entities, so the combined config is immutable
 * like a `defineBackend` result.
 */
function mergeEntities(config: BackendConfig, plugins: FrogPlugin[]): Record<string, EntityDef> {
  const entities: Record<string, EntityDef> = { ...config.entities };
  for (const plugin of plugins) {
    if (!plugin.entities) continue;
    for (const [entityName, def] of Object.entries(plugin.entities)) {
      if (entityName in entities) {
        throw new Error(`Entity "${entityName}" already defined (plugin "${plugin.name}")`);
      }
      entities[entityName] = Object.freeze(def);
    }
  }
  return entities;
}

/** The set of entity names every plugin contributes, independent of the
 * collision check (`mergeEntities` does that). Used to flag/strip plugin-owned
 * entities in the schema-editing API (see `KernelContext.pluginEntityNames`). */
function collectPluginEntityNames(plugins: FrogPlugin[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const plugin of plugins) {
    if (!plugin.entities) continue;
    for (const entityName of Object.keys(plugin.entities)) {
      names.add(entityName);
    }
  }
  return names;
}

/**
 * Resolves the caller's `Ctx` for one request, by precedence: explicit
 * `options.identify` > the debug-identity header (when enabled, dev-tooling
 * only) > the first plugin providing `identify` > guest.
 *
 * A throwing plugin `identify` is caught, logged via `logger.warn`, and
 * resolves to guest; it must never 500 the request. A `warn`, not an `error`: a
 * misbehaving identity plugin degrading its caller to guest is handled
 * gracefully, not a server fault. `options.identify` is not caught here (it is
 * the caller's own explicit hook, so its errors surface normally).
 */
async function resolveCtx(
  req: Request,
  opts: CreateBackendOptions,
  plugins: FrogPlugin[],
  logger: Logger,
): Promise<Ctx> {
  if (opts.identify) {
    return await opts.identify(req);
  }
  if (opts.debugIdentity === true) {
    return parseDebugIdentityHeader(req);
  }
  for (const plugin of plugins) {
    if (!plugin.identify) continue;
    try {
      return await plugin.identify(req);
    } catch (error) {
      logger.warn("plugin identify threw", { plugin: plugin.name, error });
      return null;
    }
  }
  return null;
}

/**
 * Assembles a complete frogCP backend:
 *
 * 1. Resolves the live user entities: in code mode, `opts.config.entities`. In
 *    managed mode, whatever's in the `__frogcp_schema` store, or on a fresh
 *    database `opts.config.entities`, which is then written to the store (the
 *    one-time seed). See `CreateBackendOptions.mode`.
 * 2. Merges plugin entities on top (collision check) and validates the combined
 *    config, in both modes; plugin entities are always code-defined and
 *    re-merged fresh on every boot.
 * 3. Compiles the drizzle tables and (unless `migrate: false`) migrates the
 *    database to match, both dispatched on `opts.adapter.dialect`.
 * 4. Wires a dialect-generic `DataEngine` and an `EventBus` over the tables.
 * 5. Runs every plugin's `onBoot`, in array order.
 * 6. Mounts every plugin's `middleware`, in array order (plugin[0] outermost),
 *    after the correlation-id + identity middleware (so it can read the ctx/
 *    logger/requestId) and before any routes (so it wraps every route).
 * 7. Mounts every plugin's `routes`, in array order, then the core
 *    `/api/entity/*` / `/api/system/*` routes; plugins register first so they
 *    can claim specific paths ahead of the entity wildcard. Core routes read
 *    the live config through a closure, so a later `applySchema` hot-swap is
 *    visible immediately.
 * 8. Wires `Backend.applySchema` (managed mode's online hot-swap) guarded by an
 *    in-process promise-chain mutex so concurrent calls serialize.
 *
 * `fetch` is a plain closure over the assembled Hono app, so it can be
 * destructured and handed off standalone without losing its binding.
 */
export async function createBackend(opts: CreateBackendOptions): Promise<Backend> {
  // Drop falsy entries up front so the rest of the kernel only sees real
  // plugins; callers wire optional plugins inline and absent ones fall out here.
  const plugins = (opts.plugins ?? []).filter((plugin): plugin is FrogPlugin => Boolean(plugin));
  const mode = opts.mode ?? "code";

  // The observability hub, constructed first (ahead of the logger below, which
  // tees to it) and seeded from `opts.sinks`, so every sink is registered before
  // any boot-time logging/migration could emit a signal.
  const observability = new ObservabilityRegistry();
  for (const sink of opts.sinks?.log ?? []) observability.addLogSink(sink);
  for (const sink of opts.sinks?.metric ?? []) observability.addMetricSink(sink);
  for (const sink of opts.sinks?.span ?? []) observability.addSpanSink(sink);
  for (const sink of opts.sinks?.audit ?? []) observability.addAuditSink(sink);

  // The backend's own (non-request-scoped) logger, constructed next since the
  // multi-identify warning below and the boot-time `migrateToConfig` need it
  // before `kernelCtx` (which also exposes it) exists.
  //
  // A caller-supplied `opts.logger` is used as-is: it is an opaque `Logger`, so
  // there is no generic way to retrofit an observability tee onto it. Only the
  // default console logger is built via `consoleLoggerWithTee`, so every record
  // it emits (including through every per-request `child()`) is also forwarded
  // to `observability.emitLog`.
  const logger =
    opts.logger ??
    consoleLoggerWithTee(opts.logLevel !== undefined ? { level: opts.logLevel } : {}, (record) =>
      observability.emitLog(record),
    );

  // Only the first plugin providing `identify` is consulted (see `resolveCtx`),
  // which is easy to misconfigure (both `authPlugin` and `jwtVerifyPlugin` in
  // the same array, expecting both), so warn loudly at boot. A warning, not a
  // throw: the combination is unusual but not necessarily wrong.
  const identifyingPlugins = plugins.filter((plugin) => plugin.identify).map((plugin) => plugin.name);
  if (identifyingPlugins.length > 1) {
    logger.warn(
      `multiple plugins provide "identify": only the first is ever used to resolve a caller's identity; the rest are ignored.`,
      { plugins: identifyingPlugins, using: identifyingPlugins[0] },
    );
  }

  // Managed mode: the `__frogcp_schema` store is authoritative for user entities
  // once something has been written. A fresh database seeds from `opts.config`
  // below, after validating the merged config, so a bad seed never persists.
  let userEntities = opts.config.entities;
  let needsSeed = false;
  if (mode === "managed") {
    const stored = await readStoredSchema(opts.adapter);
    if (stored !== null) {
      userEntities = stored.entities;
    } else {
      needsSeed = true;
    }
  }

  const pluginEntityNames = collectPluginEntityNames(plugins);
  const entities = mergeEntities({ entities: userEntities }, plugins);
  const config: BackendConfig = Object.freeze({ entities: Object.freeze(entities) });
  validateConfig(config);

  if (needsSeed) {
    // Persist only the user-entity portion (`opts.config`, before the plugin
    // merge); plugin entities are re-merged fresh on every boot.
    await writeStoredSchema(opts.adapter, opts.config);
  }

  const tables = compileTables(config, opts.adapter.dialect);
  if (opts.migrate !== false) {
    await migrateToConfig(opts.adapter, config, logger);
  }

  const events = new EventBus(logger);
  const engine = new DataEngine(opts.adapter, config, tables, events);

  const kernelCtx: KernelContext = {
    config,
    engine,
    adapter: opts.adapter,
    tables,
    events,
    pluginEntityNames,
    logger,
    observability,
    ...(opts.storage ? { storage: opts.storage } : {}),
  };

  const app = new Hono<{ Variables: ApiVariables }>();

  // Correlation-id + request-scoped logger middleware, registered first so every
  // later middleware/route can rely on `c.get("logger")`/`c.get("requestId")`.
  //
  // An incoming `X-Request-Id` header is never trusted as our correlation id
  // (that would let a caller spoof ids into our logs); a fresh id is always
  // generated with `crypto.randomUUID()` (WebCrypto, so it works on Workers).
  // If the caller sent one, a sanitized copy is recorded as a separate
  // `clientRequestId` field on the request logger only, never used as the
  // response header or our own id.
  app.use("*", async (c, next) => {
    const requestId = crypto.randomUUID();
    const clientRequestId = sanitizeClientRequestId(c.req.raw.headers.get("x-request-id"));
    const reqLogger = logger.child(
      clientRequestId ? { requestId, clientRequestId } : { requestId },
    );
    c.set("logger", reqLogger);
    c.set("requestId", requestId);
    c.header("X-Request-Id", requestId);
    await next();
  });

  app.use("*", async (c, next) => {
    const ctx = await resolveCtx(c.req.raw, opts, plugins, c.get("logger"));
    c.set("ctx", ctx);
    await next();
  });

  // Built-in request-metric + flush middleware, registered after the
  // correlation-id + identity middleware and before the plugin-middleware loop,
  // so its post-`next()` half (record the metric, then flush) runs after the
  // entire onion has unwound, with the real final `c.res.status`. This is the
  // framework's own use of the `waitUntil` flush seam documented for plugins.
  app.use("*", async (c, next) => {
    // Use `performance.now()`, not `Date.now()`; some runtimes lack
    // `performance` entirely, in which case duration is omitted (the metric
    // still fires, `value` falls back to `1`).
    const hasPerf = typeof performance !== "undefined";
    const start = hasPerf ? performance.now() : undefined;

    await next();

    const durationMs = hasPerf && start !== undefined ? performance.now() - start : undefined;
    const point: MetricPoint = {
      name: "http.request",
      kind: "counter",
      value: durationMs ?? 1,
      attributes: { method: c.req.method, path: c.req.path, status: c.res.status },
      time: new Date().toISOString(),
    };
    observability.recordMetric(point);

    // `c.executionCtx` is a Hono getter that throws (not just returns
    // `undefined`) when the runtime has no `ExecutionContext` (the Node
    // adapter), so a bare `c.executionCtx?.waitUntil(...)` would throw before
    // `?.` could short-circuit. Feature-detect with try/catch: on Workers,
    // defer the flush via `waitUntil` so it never delays the response;
    // everywhere else, await it inline.
    let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
    try {
      waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
    } catch {
      waitUntil = undefined;
    }
    if (waitUntil) {
      waitUntil(observability.flushAll());
    } else {
      await observability.flushAll();
    }
  });

  for (const plugin of plugins) {
    if (plugin.onBoot) await plugin.onBoot(kernelCtx);
  }

  // Plugin onion middleware, registered after the correlation-id + identity
  // middleware (so it can read ctx/logger/requestId) and before any routes (so
  // it wraps every route). `app.use("*", plugin.middleware)` in array order
  // gives onion semantics from Hono's nested dispatch: inbound is array order
  // (plugins[0] outermost), outbound unwinds in reverse.
  for (const plugin of plugins) {
    if (plugin.middleware) app.use("*", plugin.middleware);
  }

  for (const plugin of plugins) {
    if (plugin.routes) plugin.routes(app, kernelCtx);
  }

  // `() => kernelCtx.config`, not `config` itself: `kernelCtx.config` is
  // reassigned in place by `applySchema` on a successful hot-swap, so routes
  // registered here at boot still see the live schema on every later request.
  //
  // `applySchema` is safe to close over even though its declaration appears
  // later: it is a `function` declaration, so name and body are hoisted.
  // `buildApiRoutes` only calls it per-request, after `createBackend` finishes.
  app.route("/api", buildApiRoutes(engine, () => kernelCtx.config, mode, applySchema, pluginEntityNames));

  app.onError((err, c) => apiErrorResponse(err, c));
  app.notFound((c) => apiNotFoundResponse(c));

  // `Backend.tables` is a live getter for the same reason: it should reflect
  // `applySchema`'s most recent recompile, not whatever was compiled at boot.
  let liveTables = tables;

  // In-process mutex: `mutex` always chains onto whatever's pending via
  // `.then(run, run)` (runs `run` regardless of the previous outcome), so a
  // second concurrent call waits for the first to settle. `mutex` is reassigned
  // to a promise that never rejects, so one failed call never wedges the lock.
  let mutex: Promise<void> = Promise.resolve();

  async function applySchema(newUserConfig: BackendConfig, _ctx?: Ctx): Promise<void> {
    if (mode !== "managed") {
      throw new ApiError(409, "not_managed", "applySchema is only available in managed mode");
    }

    const run = async (): Promise<void> => {
      const mergedEntities = mergeEntities(newUserConfig, plugins);
      const fullConfig: BackendConfig = Object.freeze({ entities: Object.freeze(mergedEntities) });
      validateConfig(fullConfig);

      // Atomic online migration: throws (leaving the database and the live
      // schema untouched) on any migration failure. Nothing below runs until
      // this resolves successfully.
      await migrateToConfig(opts.adapter, fullConfig, logger);

      // Persist the user-entity portion only (never `fullConfig`, which includes
      // plugin entities); mirrors the boot-time seed.
      //
      // Atomicity caveat: a migration failure above is fully atomic. This store
      // write is the one exception: if it throws after the migration committed,
      // the database is migrated while the store still holds the old schema.
      // It is a single-row upsert, so this is very unlikely, but if it happens
      // it is surfaced loudly (the throw below) and self-corrects on next boot
      // (the store is authoritative, so a reboot re-migrates toward it). The
      // migrate->store->swap order is deliberate: never swap the live engine to
      // a schema the store doesn't yet reflect.
      try {
        await writeStoredSchema(opts.adapter, newUserConfig);
      } catch (error) {
        throw new Error(
          "applySchema: migration applied but schema store update failed; the database is " +
            "migrated while __frogcp_schema still holds the previous schema; it will re-migrate " +
            "toward the stored schema on the next boot. Underlying error: " +
            (error instanceof Error ? error.message : String(error)),
          { cause: error },
        );
      }

      // The actual hot-swap, fully synchronous from here (no `await` below) so
      // it can't interleave with an in-flight request; see
      // `DataEngine.replaceSchema` for why that's safe.
      const newTables = compileTables(fullConfig, opts.adapter.dialect);
      engine.replaceSchema(fullConfig, newTables);
      kernelCtx.config = fullConfig;
      kernelCtx.tables = newTables;
      liveTables = newTables;
    };

    const settled = mutex.then(run, run);
    mutex = settled.then(
      () => undefined,
      () => undefined,
    );
    return settled;
  }

  return {
    fetch: async (req: Request) => app.fetch(req),
    engine,
    hono: app,
    events,
    get tables() {
      return liveTables;
    },
    applySchema,
  };
}
