---
title: Key/value storage
description: The frogcp/kv plugin, the KvStore contract, the getJSON and putJSON helpers, and the stores that ship.
sidebar:
  order: 3
---

`frogcp/kv` puts a key/value store on the kernel context so plugins and routes
can reach it as `ctx.kv`. It has no entities and no routes of its own; it is a
slot plus a small set of helpers.

```ts
import { createBackend } from "frogcp";
import { nodeKv, nodeSqliteAdapter } from "frogcp/adapter/node";
import { kvPlugin } from "frogcp/kv";
import config from "./frogcp.config";

const backend = await createBackend({
  config,
  adapter: nodeSqliteAdapter("data.sqlite"),
  plugins: [kvPlugin(nodeKv("kv.sqlite"))],
});
```

`kvPlugin` sets `ctx.kv` in its `onBoot`, which runs before any plugin's routes
are registered, so every route can rely on the slot being filled.

The store argument is optional. Given nothing, `kvPlugin` returns `false`, and
the kernel skips falsy entries in `plugins`. That means you can pass a store
that may or may not exist straight into the array with no guard:

```ts
plugins: [kvPlugin(env.CACHE ? cloudflareKv(env.CACHE) : undefined)];
```

The overloads keep `kvPlugin(realStore)` typed as a plain `FrogPlugin` for
callers that always have one.

## The KvStore contract

```ts
interface KvPutOptions {
  /** Seconds to live; omit for no expiry. */
  expirationTtl?: number;
}

interface KvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: KvPutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  /** Optional: the keys currently stored under `prefix`. Best effort. */
  list?(prefix: string): Promise<string[]>;
}
```

Values are strings. `get` returns `null` for a missing or expired key. `list`
is optional, and a store that implements it may return a partial answer, so
treat it as a convenience rather than an inventory.

A `KvStore` is an ordinary object with no kernel dependency, so it also works
standalone, outside a backend.

## JSON helpers

Most callers store structured values, so the module ships the two functions
that saves writing `JSON.parse` at every call site:

```ts
import { getJSON, putJSON } from "frogcp/kv";

await putJSON(ctx.kv, "prefs:u_1", { theme: "dark" }, { expirationTtl: 3600 });

const prefs = await getJSON<{ theme: string }>(ctx.kv, "prefs:u_1");
```

`putJSON` encodes the value and forwards any TTL options unchanged. `getJSON`
returns `null` for a missing key, and also for a stored value that does not
parse, so a corrupt or legacy entry degrades to "missing" instead of throwing
at the caller.

Both take the store as their first argument rather than hanging off it, so they
work with any `KvStore`, including one you never registered with `kvPlugin`.

## The stores that ship

| Store | Module | Signature |
| --- | --- | --- |
| `node:sqlite` | `frogcp/adapter/node` | `nodeKv(path, opts?)` |
| Cloudflare KV | `frogcp/adapter/cloudflare` | `cloudflareKv(env.NAMESPACE)` |

`nodeKv` keeps one `kv (key, value, expires_at)` table in a SQLite file, or in
memory with `":memory:"`. TTL is enforced on read, so an expired row reads as
absent and is deleted lazily, and expired rows are swept opportunistically on
every write, which avoids a background timer. Its options take a `now` clock so
TTL behavior is testable without real time. It is Node only.

`cloudflareKv` wraps a `KVNamespace` binding. A put with no `expirationTtl`
stores a persistent entry, and a TTL under 60 seconds is clamped up to KV's
60-second floor, since KV rejects anything shorter. `list` returns a single
page, so a prefix spanning more than one page is truncated; paginate through
the binding directly if you need every key. KV is eventually consistent across
locations, so use the database for anything needing strong consistency.
