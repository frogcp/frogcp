# `@frogcp/admin`

A React admin UI for [`frogcp`](../frogcp), shipped as an ordinary
`FrogPlugin`, with no core-framework changes required. It contributes **no
entities and no `identify`**: the SPA is served publicly at `/admin`, its own
login screen calls the normal `/api/auth/*` routes, and every piece of data it
reads or writes goes through the same `/api/*` REST API and permission engine
every other client uses. Admin has no backdoor. It is just a browser client
that happens to be schema-driven rather than hardcoded to one app's entities.

The SPA is pre-built with Vite and embedded as string constants in
`src/generated/assets.ts`, so consuming `@frogcp/admin` never requires a
browser toolchain downstream. Only this package's own build needs Vite.

## Quickstart

```ts
import { serve } from "@hono/node-server";
import { adminPlugin } from "@frogcp/admin";
import { createBackend } from "frogcp";
import { nodeSqliteAdapter, memoryStorage } from "frogcp/adapter/node";
import { authPlugin } from "frogcp/auth"; // admin needs a session and role to gate on
import { mediaPlugin } from "frogcp/media"; // optional, enables the Media screen
import config from "./frogcp.config";

const backend = await createBackend({
  config,
  adapter: nodeSqliteAdapter("data.sqlite"),
  storage: memoryStorage(), // needed if mediaPlugin is installed
  plugins: [
    authPlugin({ secret: process.env.FROGCP_SECRET!, emailPassword: true }),
    mediaPlugin(),
    adminPlugin(), // serves the SPA shell and assets at GET /admin
  ],
});

serve({ fetch: backend.fetch, port: 3000 });
```

Visit `http://localhost:3000/admin` and register or log in. **The first user
ever registered on a fresh backend becomes `admin`**, which is `frogcp/auth`'s
bootstrap rule rather than something `adminPlugin` adds; every subsequent
registration lands as a plain `member`. Only an `admin` session can read
anything useful here: `GET /api/system/schema`, which the shell needs to
discover entities at all, 403s for non-admins, and every entity's own
permission rules still apply on top of that.

`adminPlugin` needs `frogcp/auth`, or an equivalent `identify` source, to be
useful. Without an identity plugin every request is anonymous, the login
screen has nothing to authenticate against, and `/api/system/schema` never
returns anything but a 403. `frogcp/media` is optional: the Media screen only
appears in the sidebar when the fetched schema contains a `media_files` entity.

## Screens

Every screen is driven by `GET /api/system/schema`'s per-entity summary.
Nothing is hardcoded to a specific app's entity names.

| Screen | What it does |
| --- | --- |
| **Data browser** | One per discovered entity, in the sidebar nav. A schema-driven table (paginate, sort, filter) plus a create/edit drawer form generated from the entity's field types (`text`, `boolean`, `select`, `ref`, and so on), excluding `auto` and `hidden` fields. Full CRUD, gated by whatever that entity's own permission rules allow the logged-in admin. |
| **Users** | Lists the `users` entity, shown only if `frogcp/auth` or another plugin contributing `users` is installed, and lets an admin change a user's `role` inline. This screen does write: `role` is otherwise `.readonly()`, but the engine's readonly-strip only applies to non-admin callers. |
| **Permissions** | An entity by action matrix of each rule's human-readable summary, for example `owner(id) OR role(admin)`, straight from the schema endpoint. **Read-only in code mode**, where the schema lives in `frogcp.config.ts` and is not runtime-editable. **Editable in managed mode**: each cell opens a small rule builder (public, authenticated, `role(x)`, `owner(field)`, combinable with OR), and submitting calls `client.schema.update(...)`, which hits `POST /api/system/schema` and runs an atomic online migration before the new rule takes effect. |
| **Schema viewer** | Every entity's fields, with type, required/hidden/readonly/auto flags, `select` options, and `ref` targets. **Read-only in code mode.** **Editable in managed mode**: add an entity, add, edit, or remove a field. Submitting goes through the same `POST /api/system/schema` and online-migration path as the permission matrix, surfacing a 409 or 422 migration error inline on failure. |
| **Media library** | Lists `media_files`, shown only if `frogcp/media` is installed, renders image thumbnails, and supports upload and delete. Delete is owner-scoped server-side like everywhere else: a non-owning admin's delete still succeeds via admin bypass, but a non-owner's comes back as a **404** rather than a 403, because the permission engine has no existence oracle, so a row you cannot touch is reported as not found. |

## Known limitations

- **Schema and permission editing only work in managed mode.** In code mode,
  the default, `frogcp.config.ts` is authoritative and both screens stay
  read-only with an inline note. There is no way to rewrite a config *file*
  from the running server. See `createBackend({ mode: "managed" })`.
- **Custom routes are not supported yet.** `adminPlugin({ route: "..." })`
  throws at construction for anything other than the default `"/admin"`. The
  SPA is built with a hardcoded Vite `base`, so its emitted asset URLs would
  404 under any other mount point. Supporting a custom route means wiring a
  matching `--base` at build time.

## Building this package

```sh
pnpm --filter @frogcp/admin build
```

That runs, in order: `vite build` (the SPA into `dist-spa/`),
`scripts/embed.mjs` (`dist-spa/` into the committed `src/generated/assets.ts`),
then `tsup` for the plugin itself. `src/generated/assets.ts` is committed on
purpose so that consuming `@frogcp/admin`, CI included, needs only Node and no
browser toolchain. Any change under `spa/` needs a re-run of this build, and a
commit of the regenerated `assets.ts`, to take effect in the served shell.
`test/bundle-freshness.test.ts` fails if you forget.

## Testing

```sh
pnpm --filter @frogcp/admin test
```

The suite proves the shell and asset wiring is intact, by parsing the served
`index.html`'s `<script>` and `<link>` URLs and confirming each one resolves,
and exercises the composed React app under jsdom (login, shell, entity select,
data browser) while mocking only the client calls. jsdom never executes the
built Vite bundle in a real browser, so to see the real thing render, build the
package and point any app with `adminPlugin()` wired in at
`http://localhost:3000/admin`.
