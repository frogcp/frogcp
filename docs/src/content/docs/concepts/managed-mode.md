---
title: Managed mode
description: Code mode versus managed mode, where the schema lives, how applySchema hot-swaps it, and the constraints that come with it.
sidebar:
  order: 6
---

A frogCP backend boots in one of two modes, set by `CreateBackendOptions.mode`
(or `App.mode`).

- **`"code"`** is the default. The `config` you pass to `createBackend` is the
  schema, fixed for the process lifetime. Changing it means editing your config
  file and restarting.
- **`"managed"`** stores the user-entity schema in the database, in a
  `__frogcp_schema` table, and lets it be edited at runtime.

```ts
const backend = await createBackend({
  config,
  adapter,
  mode: "managed",
});
```

Managed mode is what an admin UI edits against. Code mode is what you want for
an app whose schema lives in version control.

## Where the schema lives

`__frogcp_schema` is a framework bookkeeping table, created with raw SQL like
`__frogcp_migrations` rather than declared as an entity, so it sidesteps the
reserved `__frogcp` prefix check. It holds a single row, `id = "current"`, with
the serialized live config. It is dialect-aware: SQLite stores the JSON as
`TEXT` with an integer `updated_at` in epoch milliseconds, Postgres as `JSONB`
with a `TIMESTAMPTZ`.

Three functions in `frogcp` operate on it:

```ts
import { ensureSchemaTable, readStoredSchema, writeStoredSchema } from "frogcp";

await ensureSchemaTable(adapter);
const stored = await readStoredSchema(adapter); // BackendConfig | null
await writeStoredSchema(adapter, config);       // upserts the single row
```

`readStoredSchema` returns `null` when nothing has been written yet, and
ensures the table exists first, so it is safe to call on a fresh database.
`writeStoredSchema` overwrites the one row rather than appending, unlike the
append-only migration history.

## Serialization

The stored value is JSON produced by `serializeConfig` and read back by
`deserializeConfig`, both exported from `frogcp`.

```ts
import { deserializeConfig, serializeConfig } from "frogcp";

const json = serializeConfig(config);
const roundTripped = deserializeConfig(json);
```

`deserializeConfig` is a parser, not a cast. It validates field types against
the known set, rebuilds each permission rule from its `RuleExpr` into a real
`Rule`, checks ref targets, and runs `validateConfig` over the result. It never
touches the database, so a rejection carries a descriptive message with nothing
driver-specific in it.

## Boot

On boot in managed mode, `createBackend` reads the store first:

- If a schema is stored, that is the live user schema and the `config` argument
  is ignored.
- If nothing is stored, this is a fresh database: `config` seeds the store, so
  every later boot loads from the store instead. The seed is written after the
  merged config validates, so a bad seed never persists.

Plugin entities are never read from or written to the store. They are
code-defined and re-merged on top on every boot, in both modes.

## Editing the schema at runtime

`Backend.applySchema(newUserConfig, ctx?)` is the hot-swap:

```ts
await backend.applySchema(newUserConfig);
```

It merges the new user config with this backend's plugin entities, validates
the result, runs `migrateToConfig` as an atomic online migration, and only once
that succeeds persists the user-entity portion to `__frogcp_schema` and swaps
the live `DataEngine`'s tables plus `KernelContext.config` and `tables`. The
next `fetch()` already sees the new schema. `newUserConfig` is the user-entity
portion only; do not include plugin entities.

A failed migration throws and leaves both the database and the live schema
unchanged. In code mode, `applySchema` throws an `ApiError(409, "not_managed")`.

There is one narrow exception to the atomicity. If the store write fails after
the migration has committed, the database is migrated while the store still
holds the previous schema. That is a single-row upsert so it is very unlikely,
and it surfaces loudly and self-corrects on the next boot, since the store is
authoritative and a reboot re-migrates toward it. The migrate, then store, then
swap order is deliberate: the live engine is never swapped to a schema the
store does not yet reflect.

## Over HTTP

The core routes expose the schema under `/api/system`, both admin-only:

- `GET /api/system/schema` returns the live schema summary and the current
  `mode`. Each entity is flagged as plugin-owned or not.
- `POST /api/system/schema` applies a new user-entity config, in the shape
  `serializeConfig` emits.

A non-admin caller, including a guest, gets a 403 before anything else is
inspected. Malformed JSON or a structurally invalid config gets a 422 with
`deserializeConfig`'s own message. Any posted entity whose name is plugin-owned
is stripped before `applySchema` runs, since plugin entities are re-merged from
the backend's own plugins regardless. A valid config that fails to apply gets a
422 `migration_failed` with a curated, driver-agnostic message; the raw error
carries driver text and is logged server-side rather than returned.

## Constraints

Concurrent `applySchema` calls on the same `Backend` are serialized: one
migration at a time, with a second call waiting for the first to settle.

That serialization is an in-process promise-chain mutex. It coordinates calls
through one `Backend` object in one process, with no cross-process locking.
Running more than one server instance against the same managed-mode database
means two instances can each start a migration concurrently. The database's own
transaction protects against a torn schema on any single migration, but
instance B keeps serving its old in-memory schema until it reboots and re-reads
`__frogcp_schema`.

So managed mode is single-instance for now. Code mode has no such constraint.
