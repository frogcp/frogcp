# cloudflare

The same `notes` app as [`basic-node`](../basic-node), running as a Cloudflare
Worker: D1 for data, R2 for files, KV for sessions, with email and password auth
unchanged. `frogcp.config.ts` is identical to the node example's, so the only
difference between the two is the adapter wiring in `src/worker.ts`.

## Run it

From the repo root:

```bash
pnpm install

# Create the local D1 schema. `--local` targets the simulated database
# `wrangler dev` uses, so this needs no Cloudflare account.
cd examples/cloudflare
pnpm exec frogcp schema > schema.sql
pnpm exec wrangler d1 execute frogcp-example-notes --local --file schema.sql

pnpm dev
```

That runs `wrangler dev`, which serves the Worker on http://localhost:8787 with
locally simulated D1, R2, and KV bindings. It works before you create any real
Cloudflare resources. `.dev.vars` supplies a dev session secret.

Local dev gets its schema exactly the way production does. There is no
auto-migrate mode to fall out of, so nothing works here that would break on
deploy.

## Try it

```bash
curl -X POST http://localhost:8787/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"a-good-password"}' -i
```

Copy the `Set-Cookie` value from that response and use it to create a note:

```bash
curl -X POST http://localhost:8787/api/entity/notes \
  -H 'content-type: application/json' -H 'cookie: <paste>' \
  -d '{"title":"hello from wrangler dev"}'
```

## What it shows

`frogcp.config.ts` default-exports the whole app: `defineApp({ config, plugins })`,
with the `notes` entity, its permissions, and `authPlugin` for `/api/auth/*`.
`src/worker.ts` boots that app and `frogcp schema` reads it, so the DDL applied
to D1 cannot drift from what the Worker serves.

Bindings only exist once a request arrives, never at module scope. The app
handles that with two seams: `plugins` is a function of the runtime, so it can
reach `env` at all, and `authPlugin`'s `secret` is a resolver, so `frogcp schema`
can build the plugin list purely to collect entities with no secret set
anywhere. `createWorkerHandler` builds the backend on the first request and
caches it per `env` object.

`src/worker.ts` wires `d1Adapter` for the database, `r2Storage` for uploads, and
`kvSessionStore`, all from `frogcp/adapter/cloudflare`. Entity CRUD lives at
`/api/entity/notes`.

Because `read` is owner scoped, one member cannot read another member's note,
and the API answers `404` rather than `403` so it never confirms the row exists.
An admin bypasses the rule and can read any of them.

## Schema

The worker ships with `migrate: false` and there is no way to turn that on.
Automatic migration cannot work on a deployed Worker at all: drizzle-kit is
deliberately excluded from Workers bundles, so `migrate: true` would fail on
every request in production even though it appears to work under `wrangler dev`.

Schema is applied out of band instead. `frogcp schema` prints the full CREATE
DDL for a fresh database to stdout, and nothing else, so it pipes straight into
a file:

```bash
pnpm exec frogcp schema > schema.sql
pnpm exec wrangler d1 execute frogcp-example-notes --remote --file schema.sql
```

Drop `--remote` for the local `wrangler dev` database. The output includes the
`users` and `oauthAccounts` tables that `authPlugin` contributes, not just
`notes`, because the config exports a `defineApp` that carries the plugin list.
That is what makes `notes.owner`'s foreign key into `users` resolve.

For a schema change after the first deploy, `frogcp schema` still emits the
fresh-database DDL, so write the incremental `ALTER` yourself and apply it with
`wrangler d1 migrations`. Note that D1 has no client-visible multi-statement
transaction, so a migration that fails partway leaves the statements that
already ran permanently committed, with no rollback.

## Deploying

1. Create the resources:

   ```bash
   wrangler d1 create frogcp-example-notes
   wrangler r2 bucket create frogcp-example-notes
   wrangler kv namespace create frogcp-example-sessions
   ```

   D1 prints a `database_id` and KV prints an `id`. Paste them into
   `wrangler.jsonc` over the `REPLACE_WITH_YOUR_...` placeholders. R2 buckets
   are addressed by name and need no id.

2. Apply the schema:

   ```bash
   pnpm exec frogcp schema > schema.sql
   pnpm exec wrangler d1 execute frogcp-example-notes --remote --file schema.sql
   ```

3. Set the session secret:

   ```bash
   wrangler secret put AUTH_SECRET
   ```

   Use a private random string of at least 32 characters. Secrets are encrypted
   and take precedence over `vars` of the same name. Do not put `AUTH_SECRET` in
   `wrangler.jsonc`, whose `vars` are deployed verbatim. The worker rejects the
   public placeholder from `.dev.vars` outright unless
   `FROGCP_ALLOW_DEV_SECRET=1` is set alongside it, so a stray copy of that
   value fails loudly instead of signing forgeable sessions.

4. Deploy:

   ```bash
   wrangler deploy
   ```

## Sessions

The `SESSIONS` KV binding is wired through `kvSessionStore` and passed to
`resolve()`, but `createBackend` has no `sessions` slot to receive it yet. What
authenticates requests today is `frogcp/auth`'s HMAC-signed cookie, verified
statelessly. The binding is declared now so the example needs no change once
sessions are threaded through.

## Tests

```bash
pnpm --filter example-cloudflare test
```

`test/e2e.test.ts` boots this example's actual worker against real D1, R2, and
KV bindings from Miniflare, not mocks, and drives it the way a deployed Worker
would be. It creates the schema by running the real `frogcp schema` binary
against this example's config, so the tests exercise the same path the deploy
steps above document. The secret-handling tests need no bindings and always run;
the rest skip, loudly, if workerd cannot start.

`test/wrangler-bundle.test.ts` runs `wrangler deploy --dry-run` against this
example for real, checking that the whole app bundles for Workers. It skips only
if the `wrangler` binary is missing, which it is not in this workspace.

## Live verification

`scripts/live-verify.sh` checks the same ground against the real platform, which
Miniflare cannot: it deploys this example to Cloudflare and drives it over public
HTTPS. It verifies that forcing `migrate: true` on a deployed Worker fails with
the actionable error rather than a raw module-resolution failure, that
`frogcp schema` emits DDL that includes the auth plugin's tables, omits the
migrations bookkeeping table and applies to remote D1 in one shot, then makes
fourteen behavioural assertions (health, first user becomes admin, owner-scoped
list isolation, anonymous denial, cross-user 404s, login, delete), and finally
confirms the rows landed in D1 with passwords hashed at rest.

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
bash examples/cloudflare/scripts/live-verify.sh
```

It creates a throwaway Worker, D1 database and KV namespace, and deletes them
all through an exit trap. These are **real billable resources on your account**,
so run it deliberately. Set `LIVE_VERIFY_NAME` to something other than
`frogcp-livetest` if you need two runs at once.

It is a manual tool and deliberately not part of `pnpm test` or CI: it needs
credentials and touches a real account, so it cannot run on a pull request.
