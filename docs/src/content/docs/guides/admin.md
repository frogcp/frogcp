---
title: Admin UI
description: The @frogcp/admin plugin, the screens it ships, how the SPA is served, and the admin-role requirement.
sidebar:
  order: 6
---

`@frogcp/admin` is the admin UI: a React SPA served by a plugin. It lives in
its own package because it has its own build (Vite, React, Tailwind), but it is
an ordinary `FrogPlugin` and gets no kernel privileges.

```bash
pnpm add @frogcp/admin
```

```ts
import { createBackend } from "frogcp";
import { adminPlugin } from "@frogcp/admin";
import { memoryStorage, nodeSqliteAdapter } from "frogcp/adapter/node";
import { authPlugin } from "frogcp/auth";
import { mediaPlugin } from "frogcp/media";
import config from "./frogcp.config";

const backend = await createBackend({
  config,
  adapter: nodeSqliteAdapter("data.sqlite"),
  storage: memoryStorage(),
  plugins: [
    authPlugin({ secret: process.env.AUTH_SECRET! }),
    mediaPlugin(),
    adminPlugin(),
  ],
});
```

Then open `http://localhost:3000/admin`.

`frogcp` and `hono` are peer dependencies of the package, which you already
have.

## Wire auth first

The admin UI is a client of your own API. It logs in through
`POST /api/auth/login` and reads everything through `/api/*`, so it does
nothing useful without [`frogcp/auth`](/guides/auth/) in the plugin list.

## The screens

The sidebar has three sections.

**Overview** is a dashboard built from the schema: per-entity record counts, a
breakdown by the first `select` field where an entity has one, recent records
across entities with an auto timestamp, and a short creation trend.

**Entities** lists every entity in the live schema. Selecting one opens a
schema-driven record table with pagination, an equality filter bar, sorting by
clicking a column header, a create and edit dialog built from the entity's
fields, and per-row delete.

**System** holds four screens, two of which appear conditionally:

- *Users*, when a `users` entity exists, so when `frogcp/auth` is wired. It
  lists users and lets an admin change a user's `role` per row. `role` is
  declared `.readonly()`, but the engine applies that strip only to non-admin
  callers, so an admin session's update genuinely writes it.
- *Media*, when a `media_files` entity exists, so when `frogcp/media` is wired.
  It lists uploads with a thumbnail for images, and supports upload and
  per-item delete.
- *Schema*, the entities and their fields.
- *Permissions*, a matrix of every entity against the five actions.

Schema and Permissions are read-only views in code mode, where the schema lives
in your source rather than the database. In [managed mode](/concepts/managed-mode/)
both become editable and post back to `POST /api/system/schema`. Entities
contributed by plugins stay read-only in either mode, since they are
code-defined.

## The admin role

The plugin registers no `identify` hook and puts no auth gate on the shell
itself. The HTML and its assets are public. Every read and write the SPA
performs goes through the normal `/api/*` routes, which the permission engine
already gates, so there is nothing to protect at the shell.

In practice the UI needs an admin session. On boot the SPA calls
`GET /api/auth/me`, and shows a login screen if that fails. Once signed in it
fetches `GET /api/system/schema`, which is admin-only; a non-admin session gets
a `403` and the UI says an admin role is required rather than pretending the
backend has no entities.

Since the first user a backend ever registers becomes `"admin"`, the usual
first run is: start the server, open `/admin`, register, and you are in.

## How the SPA is served

The built SPA is embedded in the plugin as string constants, so there is no
static directory to ship or configure, and the same plugin runs on Node and on
Workers. Asset bodies are decoded with `atob` rather than `Buffer` for that
reason.

The routes are `/admin` and `/admin/` for the shell, `/admin/assets/*` for the
embedded assets, and any other path under `/admin` falling back to the shell so
the SPA's own router owns routing within it. An unmatched request under
`assets/` is a real `404`, typically a cached shell asking for a chunk this
build no longer emits; serving the HTML there would surface as a confusing MIME
error instead. Every asset response carries
`x-content-type-options: nosniff`.

`adminPlugin` accepts a `route` option, but it must be `"/admin"` today. The
SPA is built with a hardcoded Vite `base`, so its asset URLs are absolute and
would 404 anywhere else. Passing anything else throws at construction rather
than serving a shell that cannot load its own chunks.
