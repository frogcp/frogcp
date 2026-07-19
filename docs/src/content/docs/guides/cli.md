---
title: CLI
description: "Every frogcp command and its flags: create, generate, schema, run, dev, deploy, and resources."
sidebar:
  order: 8
---

`frogcp` is the framework's CLI, shipped as the `frogcp` bin of the `frogcp`
package and also importable as `frogcp/cli`.

```bash
npx frogcp --help
```

Flags may appear anywhere in the arguments. An unknown flag is an error rather
than being ignored, and a flag that takes a value requires a real value after
it.

Most commands read your `frogcp.config.ts`. It is loaded at runtime through
jiti, so there is no build step, and it must default-export the result of
`defineBackend({ ... })`.

## create

```bash
frogcp create <name> [--template basic-node|cloudflare]
```

Scaffolds a new project directory under the current directory.

`--template` defaults to `basic-node`. That template writes a
`frogcp.config.ts`, a `server.ts` booting the backend on `node:sqlite` with
auth and the admin UI wired, a `package.json`, a `tsconfig.json`, and a README.
The `cloudflare` template writes a `wrangler.jsonc` with D1, R2, and KV
bindings, and a `src/worker.ts` using `createWorkerHandler`.

`<name>` has to be a simple directory name. Separators, `.`, and `..` are
rejected, so it cannot scaffold outside the current directory. An existing
non-empty directory is refused; an empty one is fine.

## generate

```bash
frogcp generate [--config <path>] [--apply] [--db <path>]
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--config <path>` | `./frogcp.config.ts` | Path to the config. |
| `--apply` | off | Apply the migration instead of printing a dry run. |
| `--db <path>` | none | SQLite database file to migrate. Required with `--apply`. |

It always writes `frogcp.gen.d.ts` next to the config: a `Row`, `Insert`, and
`Patch` interface per entity, plus the `ClientBackend` type the
[typed client](/guides/client/) takes as its type argument.

Then it does one of two things. By default it prints the pending migration as
a dry run. With `--apply` and `--db` it opens that SQLite file and migrates it.
See [Migrations](/guides/migrations/) for what each of those really diffs
against.

`--apply` is a boolean flag, so `frogcp generate --apply data.sqlite` is an
error rather than quietly treating `data.sqlite` as the flag's value and doing
a dry run.

## schema

```bash
frogcp schema [--config <path>] [--dialect sqlite|postgres]
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--config <path>` | `./frogcp.config.ts` | Path to the config. |
| `--dialect <name>` | `sqlite` | `sqlite` (which covers D1) or `postgres`. |

Prints the full `CREATE` DDL for a **fresh** database, one semicolon-terminated
statement per line, and nothing else. That is what makes it pipeable, and it is
the answer for a runtime that cannot migrate itself because drizzle-kit is not
available there, D1 above all:

```bash
frogcp schema > schema.sql
wrangler d1 execute my-db --remote --file schema.sql
```

This is not an incremental migration: every statement is diffed against an
empty baseline, so applying it to a database that already has tables fails. The
`__frogcp_migrations` bookkeeping table is not part of the output either;
`migrateToConfig` creates it on demand.

Plugins contribute entities, and those tables are in the output too, as long as
the config default-exports an App (`defineApp({ config, plugins })`) rather than
a bare `defineBackend({ ... })`. It has to be: with auth wired, `users` comes
from the plugin, and a `ref("users")` in your own entity is a foreign key into
a table a config-only dump would never emit.

## run

```bash
frogcp run [--config <path>] [--db <path>] [--port <n>] [--managed]
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--config <path>` | `./frogcp.config.ts` | Path to the config. |
| `--db <path>` | `./data.sqlite` | SQLite file. `:memory:` for an ephemeral database. |
| `--port <n>` | `3000` | Port to listen on. `0` lets the OS assign one. |
| `--managed` | off | Boot in managed mode instead of code mode. |

Boots the config against a `node:sqlite` database and serves it with
`@hono/node-server`, printing the URL, the database path, the mode, and the
core routes. Ctrl-C shuts it down.

`run` loads no plugins. A `frogcp.config.ts` is only ever a `BackendConfig`, so
the CLI has no way to know which plugins your app wants. What you get is the
entity CRUD and permissions core, which is the fastest way to try a schema. An
app that needs auth, media, or the admin UI wires and runs its own entry point;
see [Deploying](/guides/deploying/).

With no `frogcp.config.ts` present and no explicit `--config`, it boots an
empty schema in managed mode, so `npx frogcp run` in an empty directory gives
you a backend you shape at runtime through `POST /api/system/schema`. An
explicit `--config` pointing at a missing file is still an error.

## dev

```bash
frogcp dev [--config <path>] [--db <path>] [--port <n>] [--managed]
```

The same as `run` with two differences: it defaults to `./dev.sqlite`, so a dev
run never touches your `run` database, and it prints a dev banner.

There is no file watcher. Edit the config, stop with Ctrl-C, and re-run. This
is a known limitation rather than a broken watcher.

## deploy

```bash
frogcp deploy [dir] [--static|--worker] [--spa] [--config <path>] [--entry <path>]
              [--slug <slug>] [--api-key <key>] [--control-plane <url>]
```

Deploys to a frogCP control plane, either as a Worker bundle or as a static
site.

| Flag | Default | Meaning |
| --- | --- | --- |
| `[dir]` | `.` | Directory to upload for a static deploy. |
| `--static` / `--worker` | guessed | Force the deploy kind. |
| `--spa` | off | Static only: serve `index.html` for unmatched routes. |
| `--config <path>` | `./frogcp.config.ts` | Validated when present, and its `resources` block is sent as the deploy manifest. |
| `--entry <path>` | `./src/worker.ts` | Worker entry file to bundle. |
| `--slug <slug>` | server-generated | Requested subdomain. |
| `--api-key <key>` | `$FROGCP_API_KEY` | Authorizes an owned deploy. |
| `--control-plane <url>` | `$FROGCP_CONTROL_PLANE`, then `https://api.frogcp.app` | Control-plane base URL. |

The kind is resolved in order: an explicit flag wins; otherwise, when `dir` is
a directory with no backend markers (`package.json`, `wrangler.*`,
`node_modules`, `deno.json*`, or a `src/worker.ts`), the CLI asks on an
interactive terminal and refuses to guess without one, so a CI run needs the
flag; otherwise it is a worker deploy.

A worker deploy bundles `--entry` into a single ESM module with esbuild, with
no Node built-ins polyfilled, so an entry pulling in a `node:` import fails at
bundle time rather than at runtime. A static deploy walks `dir` and uploads
every file.

With no API key the deploy is anonymous, and the control plane answers with a
one-time claim token; the CLI prints the claim link. That also happens on a
failed anonymous deploy, so a stranded slug stays recoverable.

## resources

```bash
frogcp resources ls --slug <slug> [--api-key <key>] [--control-plane <url>]
frogcp resources rm <binding> --slug <slug> [--api-key <key>] [--control-plane <url>]
```

Manages the resources a control plane provisioned for a project. `--slug` is
required, and an API key is required too, from the flag or
`FROGCP_API_KEY`, since these endpoints are owner-only. The slug is resolved to
a project id through the control plane's own entity API.

`ls` lists every tracked resource with its binding, type, and status, which is
`active` or `orphaned`.

`rm <binding>` tears down an orphaned resource and removes its record. The
control plane refuses to delete a resource that is still bound; remove it from
your config's `resources` block and redeploy first.
