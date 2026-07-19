import { createWorkerHandler, d1Adapter, kvSessionStore, r2Storage } from "frogcp/adapter/cloudflare";
import app from "../frogcp.config";
import type { Env } from "./env";

export type { Env } from "./env";

// `app.plugins` is a function of the runtime, so `createWorkerHandler` can
// build it once `env` arrives without this module knowing anything about auth.
const handler = createWorkerHandler<Env>({
  config: app.config,
  ...(app.plugins ? { plugins: app.plugins } : {}),
  // D1 cannot migrate itself: drizzle-kit is excluded from Workers bundles, so
  // `migrate: true` fails on every request in a deployed Worker. Schema is
  // applied out of band with `frogcp schema` and `wrangler d1 execute`, for
  // local dev and production alike. See the README's "Schema" section.
  migrate: false,
  resolve: (env) => ({
    adapter: d1Adapter(env.DB),
    storage: r2Storage(env.BUCKET),
    // `createBackend` has no `sessions` slot yet. Wiring it now costs nothing
    // and means this example needs no change once it does.
    sessions: kvSessionStore(env.SESSIONS),
  }),
});

export default handler;
