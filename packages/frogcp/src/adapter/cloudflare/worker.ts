import {
  buildBackend,
  createBackendMemo,
  type App,
  type BackendConfig,
  type CreateBackendOptions,
  type DatabaseAdapter,
  type FrogPlugin,
  type RuntimeContext,
  type SessionStore,
  type StorageAdapter,
} from "frogcp";

/**
 * The bindings a `resolve` callback pulls off `env` for one Worker deployment:
 * the required `DatabaseAdapter` (typically `d1Adapter(env.DB)`), plus the
 * optional `StorageAdapter`/`SessionStore` slots.
 *
 * `sessions` is accepted here for forward compatibility with the `SessionStore`
 * contract (`kvSessionStore(env.KV)` is the expected pairing) but is not yet
 * wired anywhere: `createBackend`'s `CreateBackendOptions` has no `sessions`
 * slot yet (only `storage` graduated from "just a contract" to "actually
 * wired", see `KernelContext.storage` in `kernel.ts`). A future phase that adds
 * a session-consuming plugin (`frogcp/auth`'s revocable-session support, OAuth
 * flow state) is expected to thread a `sessions` option through `createBackend`
 * the same way `storage` was. Until then this field is captured on
 * `WorkerBindings` so callers can start wiring `kvSessionStore(env.KV)` today
 * without a breaking signature change later, but `createWorkerHandler` itself
 * does not pass it to `createBackend`: there is nothing there to receive it.
 */
export interface WorkerBindings {
  adapter: DatabaseAdapter;
  storage?: StorageAdapter;
  sessions?: SessionStore;
}

export interface CreateWorkerHandlerOptions<Env> {
  config: BackendConfig;
  plugins?: FrogPlugin[];
  /** Pulls the concrete bindings (`d1Adapter(env.DB)`, `r2Storage(env.BUCKET)`) off the Workers `env` object for this deployment. */
  resolve: (env: Env) => WorkerBindings;
  identify?: CreateBackendOptions["identify"];
  debugIdentity?: boolean;
  /** Run `migrateToConfig` on first boot in each isolate. Defaults to `true`, see `d1Adapter`'s doc comment for the D1 migration-atomicity caveat this implies. */
  migrate?: boolean;
}

/** The Workers `fetch` handler shape `createWorkerHandler` returns, assignable directly to a module's `export default`. */
export interface WorkerHandler<Env> {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
}

/**
 * Builds a Workers-runtime `{ fetch(request, env, ctx) }` handler wrapping a
 * frogCP `Backend`, matching the shape a `export default { fetch }` module
 * Worker needs.
 *
 * The backend can only be assembled once `env` (the bindings object) is
 * available, which the Workers runtime hands over only inside `fetch`, never at
 * module-eval time, so construction is necessarily lazy: the first request in
 * an isolate builds the backend (running `options.resolve(env)` then
 * `createBackend`), and every subsequent request in that same isolate reuses
 * it. The cache key is `env` itself (by object identity, via `WeakMap`) rather
 * than a single fixed slot: the Workers runtime hands every request in an
 * isolate the same `env` object for that isolate's lifetime, so keying on it is
 * equivalent to "build once per isolate" while staying correct if this handler
 * is ever invoked with a genuinely different `env` (e.g. a test harness
 * constructing a fresh mock env per test).
 *
 * A boot failure (bad `resolve()`, a `migrateToConfig` error) evicts the cache
 * entry for that `env` rather than pinning it to a permanently-rejected
 * promise, so the next request against the same `env` gets a fresh attempt
 * instead of an unconditional 500 for the rest of the isolate's life.
 *
 * `ctx` (the `ExecutionContext`, e.g. for `ctx.waitUntil`) is accepted to match
 * the Workers `fetch` signature but is not used by `Backend.fetch`, which only
 * takes the raw `Request`.
 */
export function createWorkerHandler<Env extends object>(
  options: CreateWorkerHandlerOptions<Env>,
): WorkerHandler<Env> {
  // The shared per-env memo owns the "build once per isolate plus evict a
  // failed boot" semantics this handler has always had, see `createBackendMemo`.
  // The cache key is `env` itself (by object identity): the Workers runtime
  // hands every request in an isolate the same `env`, so keying on it is
  // equivalent to "build once per isolate" while staying correct if a genuinely
  // different `env` ever shows up (e.g. a test harness's per-test mock env).
  const memo = createBackendMemo();

  return {
    async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
      const backend = await memo.resolve(env, () => {
        // `resolve(env)` runs exactly once per env (inside the memo's build),
        // pulling the D1/R2 bindings off `env` for this deployment.
        const bindings = options.resolve(env);
        const ctx: RuntimeContext = {
          onCloudflare: true,
          cloudflareEnv: env as Record<string, unknown>,
          env: env as Record<string, unknown>,
        };
        const app: App = {
          config: options.config,
          // The resolved adapter is passed straight through `resolveConnection`.
          connection: bindings.adapter,
          plugins: options.plugins ?? [],
          ...(bindings.storage ? { storage: bindings.storage } : {}),
          ...(options.identify ? { identify: options.identify } : {}),
          ...(options.debugIdentity !== undefined ? { debugIdentity: options.debugIdentity } : {}),
          ...(options.migrate !== undefined ? { migrate: options.migrate } : {}),
        };
        return buildBackend(app, ctx);
      });
      return backend.fetch(request);
    },
  };
}
