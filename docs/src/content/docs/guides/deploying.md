---
title: Deploying
description: Running a frogCP backend on Node, embedded in Next.js, and on Cloudflare Workers.
sidebar:
  order: 10
---

A backend is a fetch handler. `createBackend` returns `{ fetch, ... }`, so
deploying it is mostly a question of what hands requests to that function.
Three runtimes are covered here.

The runtime-agnostic path is the `App` descriptor: `config` plus the common
options, each of which may be a function of the resolved runtime, so one
descriptor boots on Node or on Workers without per-runtime glue. `buildBackend`
turns an `App` plus a `RuntimeContext` into a live `Backend`, and every
`frogcp/adapter/*` funnels through it. `createBackend` stays the low-level
escape hatch.

## Node

Boot the backend and serve it with `@hono/node-server`. This is what
`frogcp run` does internally.

```ts
// server.ts
import { serve } from "@hono/node-server";
import { createBackend } from "frogcp";
import { memoryStorage, nodeSqliteAdapter } from "frogcp/adapter/node";
import { authPlugin } from "frogcp/auth";
import { mediaPlugin } from "frogcp/media";
import config from "./frogcp.config";

const backend = await createBackend({
  config,
  adapter: nodeSqliteAdapter("data.sqlite"),
  storage: memoryStorage(),
  plugins: [
    authPlugin({ secret: process.env.AUTH_SECRET!, secureCookies: true }),
    mediaPlugin(),
  ],
});

serve({ fetch: backend.fetch, port: Number(process.env.PORT ?? 3000) });
```

Migrations run on boot by default. Node 24 or newer is required, since
`nodeSqliteAdapter` uses the built-in `node:sqlite`.

`frogcp run` is the zero-wiring version of the same thing, and is genuinely
useful for trying a schema, but it loads no plugins. Once you need auth, media,
or the admin UI, write your own entry point as above. See the
[CLI guide](/guides/cli/).

For a different database, swap the adapter: `libsqlAdapter({ url, authToken })`
from `frogcp/adapter/libsql`, or `postgresAdapter({ connectionString })` from
`frogcp/adapter/postgres`. Both drivers are optional peer dependencies, so you
install only the one you use. Note that `frogcp/auth` currently requires a
SQLite-dialect adapter.

Swap `memoryStorage()` for something persistent before you deploy; it does not
survive a restart.

## Next.js

`frogcp/adapter/nextjs` embeds a backend in a Next.js app through one catch-all
route handler.

```ts
// lib/app.ts
import { defineApp } from "frogcp";
import { authPlugin } from "frogcp/auth";
import config from "./frogcp.config";

export const app = defineApp({
  config,
  plugins: (ctx) => [authPlugin({ secret: ctx.env.AUTH_SECRET as string })],
});
```

```ts
// app/api/[[...frog]]/route.ts
import { serve } from "frogcp/adapter/nextjs";
import { app } from "@/lib/app";

export const { GET, POST, PUT, PATCH, DELETE } = serve(app);
```

`serve` also returns `OPTIONS` and `HEAD` if you need them. Every handler
dispatches to the same memoized backend.

The adapter owns the Next.js-specific parts. It detects whether it is running
on plain Node or on Workers through `@opennextjs/cloudflare`, and builds the
`RuntimeContext` from that. `ctx.env` is the effective environment: the
Cloudflare bindings object on Workers, `process.env` otherwise, so an app reads
config the same way in both.

The default connection follows from the same detection: the D1 binding named by
`d1Binding` (default `"DB"`) on Workers, otherwise `node:sqlite` at `dbPath`
(default `"data.sqlite"`). Setting `App.connection` overrides it. `migrate`
defaults to true on Node and false on Workers.

Two more exports are useful from Server Components and Actions:

```ts
import { fetchBackend, getApp } from "frogcp/adapter/nextjs";

const res = await fetchBackend(app, "/api/entity/posts?limit=5");
const backend = await getApp(app);
```

`fetchBackend` calls the embedded backend in process, with no network hop, and
forwards the caller's cookies so the backend resolves the same identity the
page is authenticated as.

The backend and the runtime context are resolved once per isolate and cached.
That is deliberate: on Workers, re-resolving the Cloudflare context per request
intermittently misses it, which would silently fall back to `node:sqlite` and
fail hard. A failed build is evicted, so a transient first-build error retries
rather than pinning a rejected promise.

## Cloudflare Workers

`createWorkerHandler` returns a `{ fetch(request, env, ctx) }` object you can
export directly from a module Worker.

```ts
// src/worker.ts
import {
  createWorkerHandler,
  d1Adapter,
  r2Storage,
} from "frogcp/adapter/cloudflare";
import config from "../frogcp.config";

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
}

export default createWorkerHandler<Env>({
  config,
  resolve: (env) => ({
    adapter: d1Adapter(env.DB),
    storage: r2Storage(env.BUCKET),
  }),
  migrate: false,
});
```

| Option | Meaning |
| --- | --- |
| `config` | The backend config. |
| `resolve` | Pulls the bindings off `env` for this deployment. Returns `{ adapter, storage?, sessions? }`. |
| `plugins` | Plugins to compose in. |
| `identify` | Explicit identity resolver, as on `createBackend`. |
| `debugIdentity` | Honor the debug identity header. Dev tooling only. |
| `migrate` | Run migrations on first boot in each isolate. Defaults to `true`. |

`resolve` may also return `sessions`, a `SessionStore` such as
`kvSessionStore(env.KV)`. The field exists so callers can wire it today without
a later breaking change, but nothing consumes it yet: `createBackend` has no
`sessions` slot, and `createWorkerHandler` does not forward it.

`resolve` exists because the Workers runtime hands over `env` only inside
`fetch`, never at module-eval time. So construction is necessarily lazy: the
first request in an isolate builds the backend, and every later request reuses
it. The cache is keyed on the `env` object itself, which is stable for an
isolate's lifetime. A failed boot evicts the entry, so the next request gets a
fresh attempt instead of a permanent 500.

A plugin that needs a value off `env`, such as `authPlugin`'s secret, cannot be
constructed in the static `plugins` array above. Build the handler lazily per
`env` instead, which is what the `cloudflare` scaffold template does:

```ts
const handlerByEnv = new WeakMap<object, WorkerHandler<Env>>();

function getHandler(env: Env): WorkerHandler<Env> {
  let handler = handlerByEnv.get(env);
  if (!handler) {
    handler = createWorkerHandler<Env>({
      config,
      plugins: [authPlugin({ secret: env.AUTH_SECRET })],
      resolve: (e) => ({ adapter: d1Adapter(e.DB) }),
    });
    handlerByEnv.set(env, handler);
  }
  return handler;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return getHandler(env).fetch(request, env, ctx);
  },
};
```

`frogcp create <name> --template cloudflare` scaffolds all of this, with the
`wrangler.jsonc` bindings and a README covering the `wrangler d1 create`,
`wrangler r2 bucket create`, and `wrangler secret put AUTH_SECRET` steps.

### migrate: false on D1

`migrate` defaults to `true`, but on D1 the honest posture is `false`. D1 has
no client-visible transaction, so `d1Adapter` no-ops transaction control and a
migration that fails partway leaves the schema partially applied with no
rollback. Apply schema changes out of band with `wrangler d1 migrations` and
keep the Worker from migrating on boot. See
[Migrations](/guides/migrations/).

`migrate: false` also keeps boot cheap: migrating on every cold start pays the
diff cost on the first request into each isolate.

### Deploying to a frogCP control plane

`frogcp deploy` bundles a Worker entry and ships it to a control plane instead
of to your own Cloudflare account, which is what the `resources` block in
`defineBackend` declares provisioning for. See the [CLI guide](/guides/cli/).
