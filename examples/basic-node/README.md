# basic-node

A small frogCP app on Node: one `notes` entity, email and password auth, file
uploads, and the admin UI. It stores data in a local SQLite file through
`node:sqlite`, so there is nothing to install or configure beyond the workspace
itself.

## Run it

From the repo root:

```bash
pnpm install
pnpm --filter example-basic-node dev
```

The server listens on http://localhost:3000. Set `PORT` to change that, and
`FROGCP_SECRET` to supply your own session signing secret.

## Try it

Check the server is up:

```bash
curl http://localhost:3000/api/system/health
```

Register a user. The first account on a fresh database becomes `admin`, and
everyone after is a `member`. Keep the session cookie in a jar so the following
requests are authenticated:

```bash
curl -c jar.txt -X POST http://localhost:3000/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"a-good-password"}'
```

Create a note and list your notes:

```bash
curl -b jar.txt -X POST http://localhost:3000/api/entity/notes \
  -H 'content-type: application/json' \
  -d '{"title":"my first note","body":"hello"}'

curl -b jar.txt http://localhost:3000/api/entity/notes
```

Then open http://localhost:3000/admin and sign in with the same account to
browse the data, users, permissions, and schema.

## What it shows

`frogcp.config.ts` defines the `notes` entity and its permissions. The rules mix
row-level ownership with roles:

```ts
read: rule.owner("owner"),
list: rule.owner("owner").or(role("admin")),
create: rule.authenticated(),
```

Because `read` is owner scoped, one member cannot read another member's note,
and the API answers `404` rather than `403` so it never confirms the row exists.
An admin bypasses the rule and can read any of them.

`server.ts` wires it together: `createBackend` with the `node:sqlite` adapter,
plus `authPlugin` for `/api/auth/*`, `mediaPlugin` for uploads at
`/api/media/upload` and downloads at `/files/:key`, and `adminPlugin` for
`/admin`. Entity CRUD lives at `/api/entity/notes`.

`test/e2e.test.ts` drives all of it against a real in-memory backend, over both
raw `fetch` and the typed client from `frogcp/client`.

```bash
pnpm --filter example-basic-node test
```
