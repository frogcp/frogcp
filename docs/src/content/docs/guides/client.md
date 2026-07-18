---
title: Typed client
description: createClient, entity CRUD, list filters and sorting, the auth and media helpers, error handling with FrogClientError, and typing the client against your config.
sidebar:
  order: 7
---

`frogcp/client` is a typed HTTP client for a frogCP backend. It is fetch-only
with no `node:` imports, so the same code runs in the browser, on Node, on
Workers, and in React Native.

```ts
import { createClient } from "frogcp/client";

const client = createClient("https://api.example.com");

const { data, meta } = await client.entity("posts").list({ limit: 20 });
```

## createClient

```ts
createClient<TBackend>(baseUrl: string, opts?: CreateClientOptions)
```

| Option | Default | Meaning |
| --- | --- | --- |
| `fetch` | `globalThis.fetch` | The fetch implementation. |
| `headers` | `{}` | Merged into every request. |
| `credentials` | `"include"` | Sends and receives cookies, which is the session flow `frogcp/auth` issues. |

A trailing slash on `baseUrl` is stripped. Pass `""` for same-origin, which is
what the admin UI does.

The `fetch` option is typed narrowly as `(request: Request) => Promise<Response>`,
because the client always builds a full `Request` itself. That is exactly a
backend's own `fetch`, so you can drive a real backend in process with no
network at all:

```ts
const backend = await createBackend({ config, adapter });
const client = createClient("http://localhost", { fetch: backend.fetch });
```

For a caller that cannot rely on cookies, pass a bearer token instead:

```ts
const client = createClient(base, {
  headers: { Authorization: `Bearer ${token}` },
});
```

## Entity CRUD

`client.entity(name)` returns the CRUD surface for one entity, mapping onto the
core `/api/entity/:name` routes:

```ts
const posts = client.entity("posts");

const { data, meta } = await posts.list({ limit: 20 });
const post = await posts.get(id);
const created = await posts.create({ title: "Hello" });
const updated = await posts.update(id, { title: "Hello again" });
await posts.delete(id);
```

`list` resolves to `{ data, meta }`, where `meta` is
`{ total, limit, offset }`. The other methods unwrap the response envelope and
resolve to the row itself. `delete` resolves to `void`.

`get` takes an optional `{ with: [...] }` to embed related rows, the same as
the `with` list query below.

## List queries

`list` takes a `ListQueryInput` and encodes it into the REST query grammar the
server parses:

```ts
await client.entity("posts").list({
  filter: {
    status: "published",
    createdAt: { gte: new Date("2026-01-01") },
    authorId: { in: ["u_1", "u_2"] },
  },
  sort: ["-createdAt", "title"],
  limit: 20,
  offset: 40,
  with: ["author"],
});
```

- **`filter`** maps a field to a bare scalar, which is shorthand for `eq`, or
  to an operator object. The operators are `eq`, `ne`, `gt`, `gte`, `lt`,
  `lte`, `like`, and `in`. `in` takes an array; everything else takes a single
  scalar. Multiple operators on one field are combined with AND server-side.
- **`sort`** is field names in priority order, each optionally prefixed with
  `-` for descending.
- **`limit`** and **`offset`** page the result.
- **`with`** names `ref` fields to embed on each row, reachable as
  `row.expand[name]`.

A `Date` value serializes to its ISO string; everything else goes through
`String()`. Filtering or sorting by a `.hidden()` field is rejected by the
server with the same "unknown field" `422` as an undeclared one.

The encoder is exported as `encodeListQuery` if you want the query string
without the client.

## Auth

`client.auth` wraps the email and password routes:

```ts
const { user } = await client.auth.register({
  email: "a@example.com",
  password: "correct horse battery",
  name: "Ada",
});

await client.auth.login({ email: "a@example.com", password: "..." });
const { user: me } = await client.auth.me();
await client.auth.logout();
```

Each resolves to the unwrapped payload: `{ user }` for register, login, and me,
and `{ ok }` for logout. The user shape is
`{ id, email, name?, role, createdAt }`, and `passwordHash` never reaches the
wire.

Sessions ride on the cookie the backend sets, which is why `credentials`
defaults to `"include"`. The client does not touch localStorage and holds no
session state of its own; a reload re-derives it from `me()`.

## Media and schema

`client.media.upload(file, opts?)` posts a multipart `file` field to
`/api/media/upload` and resolves to `{ key, filename, contentType, size }`. It
takes a `File` or a `Blob`; `opts.filename` supplies the name for a bare
`Blob`, which has none of its own. `client.media.url(key)` builds the download
URL, `<baseUrl>/files/<key>`, for you to use directly, for instance as an
`<img src>`.

`client.schema.get()` and `client.schema.update(config)` wrap
`GET` and `POST /api/system/schema`. Both are admin-only, and `update` works
only in [managed mode](/concepts/managed-mode/); in code mode it rejects with a
`409`. The response is typed loosely, since the client has no runtime
dependency on the server, with `mode` being the field worth branching on.

## Error handling

Every non-2xx response rejects with a `FrogClientError`:

```ts
import { FrogClientError } from "frogcp/client";

try {
  await client.entity("posts").create({ title: "" });
} catch (error) {
  if (error instanceof FrogClientError) {
    console.error(error.status, error.code, error.message);
  }
}
```

`status` is the HTTP status. `code` and `message` are parsed out of frogCP's
error envelope, `{ error: { code, message } }`. A response that is not that
shape, such as a proxy error or a non-JSON body, falls back to `"unknown"` for
the code and the status text for the message, so a caller always gets a
well-formed error.

Nothing else throws a bespoke error type, so `FrogClientError` plus a network
failure from `fetch` is the whole surface.

## Typing the client

Without a type argument, entity names are unconstrained and every row, insert,
and patch is `unknown`. Everything still works; you just get no help.

`frogcp generate` writes a `frogcp.gen.d.ts` next to your config with a `Row`,
`Insert`, and `Patch` interface per entity, plus a `ClientBackend` type that
maps each entity name to `{ row, insert, patch }`. Pass it as the type
argument:

```ts
import { createClient } from "frogcp/client";
import type { ClientBackend } from "./frogcp.gen";

const client = createClient<ClientBackend>("https://api.example.com");

const posts = client.entity("posts"); // "posts" is checked
const post = await posts.get(id); // typed as Posts
await posts.create({ title: "Hello" }); // checked against InsertPosts
```

The generated types follow the engine's own rules. Hidden fields are absent
from every shape. Auto fields are absent from `Insert` and `Patch`, since the
engine populates them. A field that is not `.required()` is optional and
nullable on the row. `date` and `timestamp` read back as a string, because a
response is plain JSON with no reviver, but accept `string | Date` on a write.
`select` compiles to a union of its options.

`createClient` is generic over the structural shape, not over the server's own
type, so a hand-written `TBackend` works just as well. See the
[CLI guide](/guides/cli/) for regenerating the file.
