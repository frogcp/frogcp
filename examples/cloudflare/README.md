# cloudflare

The same `notes` app as [`basic-node`](../basic-node), running as a Cloudflare
Worker: D1 for data, R2 for files, KV for sessions, with email and password auth
unchanged. `frogcp.config.ts` is identical to the node example's, so the only
difference between the two is the adapter wiring in `src/worker.ts`.

## Run it

From the repo root:

```bash
pnpm install
pnpm --filter example-cloudflare dev
```

That runs `wrangler dev`, which serves the Worker on http://localhost:8787 with
locally simulated D1, R2, and KV bindings. It works before you create any real
Cloudflare resources. `.dev.vars` supplies a dev session secret and turns on
automatic migration, so the schema is created on the first request.

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

`src/worker.ts` wires `createWorkerHandler` with `d1Adapter` for the database,
`r2Storage` for uploads, and `kvSessionStore`, all from
`frogcp/adapter/cloudflare`, plus `authPlugin` for `/api/auth/*`. Entity CRUD
lives at `/api/entity/notes`.

Bindings only exist once a request arrives, never at module scope, so the
handler is built lazily on the first request and cached per `env` object.

`frogcp.config.ts` defines the `notes` entity and its permissions. Because
`read` is owner scoped, one member cannot read another member's note, and the
API answers `404` rather than `403` so it never confirms the row exists. An
admin bypasses the rule and can read any of them.

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

2. Set the session secret:

   ```bash
   wrangler secret put AUTH_SECRET
   ```

   Use a private random string of at least 32 characters. Secrets are encrypted
   and take precedence over `vars` of the same name. Do not put `AUTH_SECRET` in
   `wrangler.jsonc`, whose `vars` are deployed verbatim. The worker rejects the
   public placeholder from `.dev.vars` outright unless
   `FROGCP_ALLOW_DEV_SECRET=1` is set alongside it, so a stray copy of that
   value fails loudly instead of signing forgeable sessions.

3. Deploy:

   ```bash
   pnpm --filter example-cloudflare deploy
   ```

## Migrations

The worker ships with `migrate: false`, so a deploy never migrates D1 on its
own. D1 has no client-visible multi-statement transaction, which means a
migration that fails partway leaves the statements that already ran permanently
committed, with no rollback. Manage schema with Cloudflare's own tooling:

```bash
wrangler d1 migrations create frogcp-example-notes <name>
# write the SQL for that migration, then:
wrangler d1 migrations apply frogcp-example-notes --remote
```

Local dev opts back in through `FROGCP_MIGRATE=true` in `.dev.vars`, which is
never deployed. Leave that variable out of `wrangler.jsonc`.

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
would be. The secret-handling tests need no bindings and always run; the rest
skip, loudly, if workerd cannot start.

`test/wrangler-bundle.test.ts` runs `wrangler deploy --dry-run` against this
example for real, checking that the whole app bundles for Workers. It skips only
if the `wrangler` binary is missing, which it is not in this workspace.
