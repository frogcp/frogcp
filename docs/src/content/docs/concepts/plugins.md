---
title: Plugins
description: What a FrogPlugin is, how the kernel composes plugins at boot, and why the first-party features are plugins themselves.
sidebar:
  order: 3
---

frogCP is a small kernel plus plugins. The kernel owns the entity DSL, the
permission engine, the data engine, and the REST routes. Everything past that
is a plugin, including auth, media, kv, mail, and activity.

For a hands-on walkthrough of writing one, see
[Writing a plugin](/guides/plugins/). This page is about the model.

## The FrogPlugin interface

A plugin is a plain object. Every hook past `name` is optional, so a plugin can
be as small as a bag of entities.

```ts
interface FrogPlugin {
  name: string;
  entities?: Record<string, EntityDef>;
  identify?: (req: Request) => Promise<Ctx> | Ctx;
  middleware?: FrogMiddleware;
  routes?: (app: Hono<{ Variables: ApiVariables }>, ctx: KernelContext) => void;
  onBoot?: (ctx: KernelContext) => void | Promise<void>;
}
```

- **`entities`** are resolved `EntityDef`s, built with `resolveEntities`. They
  merge into the backend's config at boot.
- **`identify`** resolves the caller's identity from the raw request. Only the
  first plugin in the array that provides it is used.
- **`middleware`** is onion request middleware wrapping every route, plugin and
  core alike. `FrogMiddleware` is exported so you do not have to hand-roll the
  `MiddlewareHandler<{ Variables: ApiVariables }>` generic.
- **`routes`** registers routes on the kernel's Hono app, before the core
  `/api` routes.
- **`onBoot`** runs once at boot, in array order, before any routes are
  registered.

## The kernel context

Every hook that receives a context gets a `KernelContext`, the assembled pieces
of the backend:

```ts
interface KernelContext {
  config: BackendConfig;
  engine: DataEngine;
  adapter: DatabaseAdapter;
  tables: CompiledTables;
  events: EventBus;
  storage?: StorageAdapter;
  kv?: KvStore;
  pluginEntityNames: ReadonlySet<string>;
  logger: Logger;
  observability: ObservabilityRegistry;
}
```

`storage` and `kv` are slots, not guarantees. `storage` is set when
`createBackend` was given one; `kv` is set by `frogcp/kv`'s `kvPlugin` in its
`onBoot`. A feature that needs either checks for it and degrades explicitly.

`logger` is the backend's own, non-request-scoped logger, right for boot-time
logging. Per-request logging should use the request-scoped logger the kernel's
correlation-id middleware sets, reachable as `c.get("logger")`, so lines carry
the request id.

## How the kernel composes plugins

`createBackend` assembles a backend in a fixed order:

1. Falsy entries in `plugins` are dropped, so an optional plugin can be wired
   inline as `flag && plugin()` or `kvPlugin(maybeStore)` with no spread guard.
2. The observability registry is built and seeded from `options.sinks`, then
   the logger, so every sink is registered before anything can emit.
3. The live user entities are resolved. In code mode that is `config.entities`;
   in [managed mode](/concepts/managed-mode/) it is the stored schema.
4. Plugin `entities` are merged on top, in array order, with a collision check.
   The merged config is validated with `validateConfig`.
5. The Drizzle tables are compiled and, unless `migrate: false`, the database is
   migrated to match.
6. The `DataEngine` and `EventBus` are wired over the tables.
7. Every plugin's `onBoot` runs, in array order.
8. Every plugin's `middleware` is mounted, in array order.
9. Every plugin's `routes` is mounted, in array order, then the core
   `/api/entity/*` and `/api/system/*` routes.

Plugins register routes before the core routes, so a plugin can claim a
specific path such as `/api/auth/*` ahead of the entity wildcard.

## Middleware ordering

Plugin middleware is mounted after the kernel's own correlation-id and identity
middleware, so it can read `c.get("ctx")`, `c.get("logger")`, and
`c.get("requestId")`. It is mounted before every route, so it wraps all of
them.

Ordering is standard Hono onion: inbound in plugin array order, with
`plugins[0]` outermost, unwinding in reverse on the way out. A middleware may
skip `next()` and return a `Response` to short-circuit routing; outer
middleware still unwinds.

A middleware that throws propagates to the kernel's error handler. Unlike event
handlers, it is not swallowed, so post-`next()` work that must never fail the
request is responsible for its own `try`/`catch`. To defer work past the
response without delaying it, `c.executionCtx?.waitUntil(...)` is available on
Workers; guard it, since the Node adapter's context has no `executionCtx`.

## Wiring plugins in

Plugins go in the `plugins` array of `createBackend`, or of an `App`
descriptor:

```ts
import { createBackend } from "frogcp";
import { nodeSqliteAdapter } from "frogcp/adapter/node";
import config from "./backend.config";

const backend = await createBackend({
  config,
  adapter: nodeSqliteAdapter("data.sqlite"),
  plugins: [healthPlugin()],
});
```

## First-party features are plugins

Auth, media, kv, mail, and activity ship as `frogcp/auth`, `frogcp/media`,
`frogcp/kv`, `frogcp/mail`, and `frogcp/activity`. They use exactly the hooks
above and get no kernel privileges. The admin UI is a plugin too, in its own
`@frogcp/admin` package.

This has two practical consequences. Nothing is on by default: a backend has
the capabilities you wired, and no more. And anything a first-party plugin can
do, yours can too, including shipping as its own npm package that depends on
`frogcp`.

The kernel does track which entities came from plugins, in
`KernelContext.pluginEntityNames`. Plugin entities are code-defined, so the
schema API flags them as plugin-owned and strips them from a posted schema
edit.
