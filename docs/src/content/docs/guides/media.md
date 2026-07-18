---
title: Media
description: "The frogcp/media plugin: the upload and file-serving routes, the media_files entity, the media() field, storage adapters, and owner-scoped reads."
sidebar:
  order: 2
---

`frogcp/media` handles file uploads. It contributes a `media_files` entity that
records one row per uploaded object, an upload route, and a download route. The
bytes themselves live in a `StorageAdapter`, which you pass to `createBackend`.

```ts
import { createBackend } from "frogcp";
import { memoryStorage, nodeSqliteAdapter } from "frogcp/adapter/node";
import { mediaPlugin } from "frogcp/media";
import { authPlugin } from "frogcp/auth";
import config from "./frogcp.config";

const backend = await createBackend({
  config,
  adapter: nodeSqliteAdapter("data.sqlite"),
  storage: memoryStorage(),
  plugins: [authPlugin({ secret: process.env.AUTH_SECRET! }), mediaPlugin()],
});
```

The plugin's `onBoot` throws when `storage` is missing, so a backend wired
without one fails at `createBackend` rather than on the first upload.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `maxBytes` | `10485760` (10 MiB) | Uploads over this are rejected with `413 payload_too_large`. |
| `route` | `"/api/media"` | Base path the upload endpoint mounts under. |
| `ownerScoped` | `true` | Restrict read and delete on a file to its uploader. |

## Routes

`POST {route}/upload` takes a `multipart/form-data` body with a `file` field.
It answers `200` with:

```json
{ "data": { "key": "...", "filename": "...", "contentType": "...", "size": 1234 } }
```

Uploading always requires an authenticated caller. The permission check runs
before any body work, so an unauthorized request never buffers a multipart body
or writes a blob. When `Content-Length` is present and over `maxBytes`, the
request is rejected before parsing; the parsed file size is checked again
afterwards, which catches a missing or understated header.

The storage key is a fresh UUID plus a sanitized extension taken from the
uploaded filename. Only a short alphanumeric suffix counts as an extension, so
a hostile filename cannot inject a path separator into the key.

`GET /files/:key` serves the bytes. This path is fixed and is deliberately not
prefixed by `route`: it is the short, shareable download URL, independent of
where uploads are mounted.

A missing row, a row the caller may not read, and a key with no bytes behind it
all return the same `404`, so the route is not an existence oracle.

Every response carries `x-content-type-options: nosniff`. The declared content
type is whatever the uploading client sent and is reflected back verbatim, so
anything outside a small inline-safe allowlist (`image/*`, `video/*`, `audio/*`,
and `application/pdf`) is served with `content-disposition: attachment`.
`image/svg+xml` is excluded from that allowlist even though it matches
`image/*`, because an SVG can carry script.

## The media_files entity

The plugin registers one entity, named `media_files` and exported as
`FILES_ENTITY`:

```ts
entity({
  key: text().required().unique(),
  filename: text(),
  contentType: text(),
  size: number(),
  owner: text(),
  createdAt: timestamp().auto(),
}).permissions({
  create: rule.authenticated(),
  read: scopedRule,
  delete: scopedRule,
});
```

`owner` holds the uploader's `userId` and is populated on every upload
regardless of `ownerScoped`, so the uploader is always on record. It is a plain
`text()` field, not a `ref("users")`, because the media plugin has to work
without `frogcp/auth` in the plugin list, and a ref to an entity that does not
exist would fail config validation.

`create` is always `rule.authenticated()`. `read` and `delete` share one rule
picked by `ownerScoped`: `rule.owner("owner")` by default, so files are private
to their uploader, or `rule.public()` when you set `ownerScoped: false`, which
lets any caller including a guest fetch or remove any file by key. An admin
bypasses either rule, as with every entity.

Because `media_files` is a normal entity, it also has the usual REST surface at
`/api/entity/media_files` under those same rules, which is what the admin UI's
media screen lists through.

## The media() field

`media()` is a field type on your own entities. It stores a storage key, not the
bytes, so the column is plain text.

```ts
import { defineBackend, entity, media, text } from "frogcp";

export default defineBackend({
  entities: {
    posts: entity({
      title: text().required(),
      cover: media(),
    }),
  },
});
```

The flow is: upload the file, take the `key` from the response, and write that
key into the field. Read it back by pointing at `/files/<key>`.

Nothing enforces that a `media()` value refers to an existing `media_files`
row. The field is a key, and the plugin owns upload and serving by that key.

## Storage adapters

`StorageAdapter` is the blob-store contract. It is `Uint8Array` based with no
`Buffer` or stream requirement, so one implementation runs unchanged on Node
and on Workers.

```ts
interface StorageAdapter {
  put(key: string, data: Uint8Array, meta?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  url?(key: string): string | undefined;
}
```

Two ship:

- `memoryStorage()` from `frogcp/adapter/node`, a `Map`, for tests and local
  development. It does not survive a restart.
- `r2Storage(env.BUCKET)` from `frogcp/adapter/cloudflare`, backed by an R2
  bucket binding.

Writing your own is one object literal; see
[Writing a plugin](/guides/plugins/) for a worked example.

## Uploading from the client

The [typed client](/guides/client/) wraps both routes:

```ts
const { key } = await client.media.upload(file);
const src = client.media.url(key);
```

`upload` posts a multipart `file` field to `/api/media/upload`, so it assumes
the default `route`. `url(key)` just builds `<baseUrl>/files/<key>`; fetch it
directly, for instance as an `<img src>`.
