import { createWorkerHandler, d1Adapter, kvSessionStore, r2Storage, type WorkerHandler } from "frogcp/adapter/cloudflare";
import { authPlugin } from "frogcp/auth";
import config from "../frogcp.config";

/** The bindings this Worker declares in `wrangler.jsonc`. */
export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  SESSIONS: KVNamespace;
  /** Session signing secret for `frogcp/auth`. Set it with `wrangler secret put AUTH_SECRET`. */
  AUTH_SECRET?: string;
  /** Set to `"1"` to allow the public dev placeholder secret. Only `.dev.vars` sets this. */
  FROGCP_ALLOW_DEV_SECRET?: string;
  /** Set to `"true"` to auto-migrate D1 on boot. Local dev only, see the README. */
  FROGCP_MIGRATE?: string;
}

/**
 * The dev-only secret committed in `.dev.vars`. It is public, so it must never
 * sign real sessions: `resolveAuthSecret` rejects it unless the caller also
 * opts in through `FROGCP_ALLOW_DEV_SECRET`, which nothing but `.dev.vars`
 * does. That turns "deployed without ever setting a secret" from a silent
 * forgeable-session bug into a loud error.
 */
const DEV_SECRET_LITERAL = "dev-secret-do-not-use-in-production-32chars!!";

function resolveAuthSecret(env: Env): string {
  const secret = env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "AUTH_SECRET is not set. Set it with `wrangler secret put AUTH_SECRET` (32 characters or more). " +
        "For local `wrangler dev`, this example's `.dev.vars` covers it automatically.",
    );
  }
  if (secret === DEV_SECRET_LITERAL && env.FROGCP_ALLOW_DEV_SECRET !== "1") {
    throw new Error(
      "AUTH_SECRET is set to this example's published dev-only placeholder value, which is public and " +
        "must never sign real sessions. Use `wrangler dev` (which loads .dev.vars) for local development, " +
        "or run `wrangler secret put AUTH_SECRET` with a private random value for a real deployment.",
    );
  }
  return secret;
}

// `authPlugin`'s secret comes from `env`, which the Workers runtime only hands
// over on the first request, never at module scope. So the handler is built
// lazily and cached per `env` object, the same way `createWorkerHandler` caches
// its own backend. A failed build is not cached, so the next request retries.
const handlerByEnv = new WeakMap<object, WorkerHandler<Env>>();

function getHandler(env: Env): WorkerHandler<Env> {
  let handler = handlerByEnv.get(env);
  if (!handler) {
    handler = createWorkerHandler<Env>({
      config,
      plugins: [authPlugin({ secret: resolveAuthSecret(env) })],
      // Off unless a local `.dev.vars` opts in. D1 has no multi-statement
      // transaction, so a migration that fails partway leaves the schema half
      // applied. Real deployments use `wrangler d1 migrations` instead.
      migrate: env.FROGCP_MIGRATE === "true",
      resolve: (e) => ({
        adapter: d1Adapter(e.DB),
        storage: r2Storage(e.BUCKET),
        // `createBackend` has no `sessions` slot yet. Wiring it now costs
        // nothing and means this example needs no change once it does.
        sessions: kvSessionStore(e.SESSIONS),
      }),
    });
    handlerByEnv.set(env, handler);
  }
  return handler;
}

export default {
  // `async` so that a synchronous throw from `getHandler` (a missing or
  // rejected AUTH_SECRET) surfaces as a rejected promise, matching the `fetch`
  // contract the rest of frogCP honors.
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return getHandler(env).fetch(request, env, ctx);
  },
};
