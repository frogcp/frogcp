---
title: Getting started
description: Build a small frogCP backend, from an entity definition to a running REST API.
---

This walks through a small backend end to end: define an entity, boot the
kernel, and hit the REST API. It runs on Node with the built-in
`node:sqlite` adapter, so there is nothing external to install or configure.

## Install

frogCP needs Node 24 or newer. Add the framework to your project:

```bash
pnpm add frogcp
```

## Define your data

An entity is a set of typed fields plus permissions. Fields come from the DSL
(`text`, `number`, `boolean`, `timestamp`, `select`, `ref`, and so on).
Permissions are rules that compile to SQL, so access is enforced in the
database rather than in application code.

```ts
// backend.config.ts
import { defineBackend, entity, text, timestamp, rule } from "frogcp";

export default defineBackend({
  entities: {
    notes: entity({
      title: text().required(),
      body: text(),
      owner: text().required(),
      createdAt: timestamp().auto(),
    }).permissions({
      // Anyone signed in can create a note.
      create: rule.authenticated(),
      // You can only read, update, or delete your own notes.
      read: rule.owner("owner"),
      update: rule.owner("owner"),
      delete: rule.owner("owner"),
    }),
  },
});
```

`rule.owner("owner")` compiles to `WHERE owner = :current_user_id`, so a list
query returns only the caller's rows. There is no per-row check in your
handler code to forget.

## Boot the backend

`createBackend` assembles the kernel from your config, a database adapter, and
any plugins. On Node, `nodeSqliteAdapter` gives you a file-backed SQLite
database, and `@hono/node-server` serves the backend's fetch handler.

```ts
// server.ts
import { serve } from "@hono/node-server";
import { createBackend } from "frogcp";
import { nodeSqliteAdapter } from "frogcp/adapter/node";
import config from "./backend.config";

const backend = await createBackend({
  config,
  adapter: nodeSqliteAdapter("data.sqlite"),
});

serve({ fetch: backend.fetch, port: 3000 });
console.log("frogCP on http://localhost:3000");
```

The backend runs migrations on boot by default, so the `notes` table exists
the first time you start the server.

## Talk to the API

Every entity gets REST routes under `/api/entity/<name>`. Create a note and list
it back:

```bash
curl -X POST http://localhost:3000/api/entity/notes \
  -H "content-type: application/json" \
  -d '{"title":"First note","body":"hello","owner":"me"}'

curl http://localhost:3000/api/entity/notes
```

## Where to go next

- [Writing a plugin](/guides/plugins/) shows how to add behavior with a
  plugin, swap the database or storage with an adapter, and send email through
  a transport, all grounded in the real interfaces.
- The kernel ships first-party plugins for auth, media, kv, mail, and
  activity. They are wired the same way you wire your own.
