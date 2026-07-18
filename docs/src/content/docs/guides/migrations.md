---
title: Migrations
description: How frogcp generate and migrateToConfig bring a database in line with your config, on SQLite and Postgres, and why D1 is different.
sidebar:
  order: 9
---

frogCP has no migration files. Your config is the schema, and a migration is
the diff between the last schema a database recorded and the one your config
compiles to now.

That diff is computed by drizzle-kit's schema-diffing API over two in-memory
snapshots. The last-applied snapshot is stored as JSON in a
`__frogcp_migrations` table, created on first use.

## The two entry points

`migrateToConfig(adapter, config, logger?)` is the function. It reads the
stored snapshot, compiles your config to Drizzle tables, diffs the two, runs
the resulting statements, and records the new snapshot. An empty diff writes no
row, so re-running it is a no-op.

`createBackend` calls it on boot unless you pass `migrate: false`. That is why
the getting-started example works with no migration step: the table exists the
first time the server starts.

```ts
const backend = await createBackend({
  config,
  adapter: nodeSqliteAdapter("data.sqlite"),
  migrate: false, // bring your own migration process
});
```

## frogcp generate

```bash
frogcp generate                          # write types, print the DDL
frogcp generate --apply --db data.sqlite # write types, migrate that database
```

Both forms write `frogcp.gen.d.ts` next to the config for the
[typed client](/guides/client/). What differs is the second half, and the
difference matters.

The dry run has no database to read a prior snapshot from, so it diffs against
an empty baseline. The statements it prints are the full set of `CREATE TABLE`
and `CREATE INDEX` statements for the current config, not an incremental diff
against anything real. It answers "what does this schema compile to as DDL".

`--apply` opens the `--db` file and calls `migrateToConfig`, which reads that
database's own recorded snapshot and applies a real incremental diff. `--apply`
requires `--db`.

The CLI's migration path is SQLite only: it opens the file with
`nodeSqliteAdapter`. For Postgres, migrate at boot through `createBackend`, or
call `migrateToConfig` yourself with a Postgres adapter.

## SQLite and Postgres

`migrateToConfig` dispatches on `adapter.dialect`. Both dialects use the same
`__frogcp_migrations` bookkeeping and both are atomic: every statement plus the
bookkeeping insert runs inside one transaction, issued as `BEGIN IMMEDIATE` and
`COMMIT` on SQLite and `BEGIN` and `COMMIT` on Postgres. A failure rolls the
whole migration back, so a later run retries cleanly against an untouched
schema.

That atomicity is why an adapter's `exec` and `db` must share one connection.
Transaction control goes through `exec` while the bookkeeping insert goes
through `db`; split across pooled connections, the transaction would silently
do nothing. This is why `postgresAdapter` always runs on a single dedicated
`Client`, even when you hand it a `Pool`.

Two things to know about the diff itself:

- **Destructive statements are not blocked.** When a batch contains a
  `DROP TABLE` or `DROP COLUMN`, a single warning lists every statement, so a
  destructive change is never applied silently. There is no opt-in guard yet.
- **Renames are not supported.** drizzle-kit's default resolvers prompt
  interactively when a diff contains both a created and a deleted table or
  column, which is what a rename looks like. Non-interactive rename support
  needs custom resolvers.

## D1

Cloudflare D1 is the exception. It has no client-visible multi-statement
transaction: every statement auto-commits, and `BEGIN`, `COMMIT`, and
`ROLLBACK` are rejected outright.

`d1Adapter` treats transaction control as a no-op so `migrateToConfig` can run
against D1 at all, and warns the first time it swallows one. The consequence is
real: **migrations are not atomic on D1.** A migration that fails partway
leaves the earlier statements committed with no rollback.

So for a D1 deployment, run migrations out of band with
`wrangler d1 migrations` and pass `migrate: false`:

```ts
export default createWorkerHandler<Env>({
  config,
  resolve: (env) => ({ adapter: d1Adapter(env.DB) }),
  migrate: false,
});
```

`migrate` defaults to `true` there, so this is an explicit choice.

## Managed mode

In [managed mode](/concepts/managed-mode/) the user schema lives in the
database rather than in your source, and `Backend.applySchema` migrates it at
runtime. It runs the same `migrateToConfig`, and only persists the new schema
once the migration has committed, so a rejected migration leaves both the
database and the live schema unchanged.
