---
title: Audit log
description: The frogcp/activity plugin, the audit_log entity, how data events become audit rows, admin-only reads, and the flush durability seam.
sidebar:
  order: 5
---

`frogcp/activity` turns the kernel's data events into durable audit rows. It
contributes an `audit_log` entity, registers an `AuditSink` that writes to it,
and subscribes to the event bus so every create, update, and delete lands as a
row.

```ts
import { createBackend } from "frogcp";
import { nodeSqliteAdapter } from "frogcp/adapter/node";
import { activityPlugin } from "frogcp/activity";
import config from "./frogcp.config";

const backend = await createBackend({
  config,
  adapter: nodeSqliteAdapter("data.sqlite"),
  plugins: [activityPlugin()],
});
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `entityName` | `"audit_log"` | The entity name audit rows are stored under. |
| `adminRole` | `"admin"` | The role permitted to read and list audit rows. |
| `events` | all three | Which `DataEvent`s to bridge onto the sink. |

`adminRole` only matters when you want some role other than `"admin"` to read
the trail. The permission engine always allows an admin regardless of what you
set here.

`events` accepts any subset of `"record.created"`, `"record.updated"`, and
`"record.deleted"`.

## The audit_log entity

```ts
entity({
  action: text().required(),
  entity: text(),
  recordId: text(),
  actorUserId: text(),
  actorRole: text(),
  before: text(),
  after: text(),
  requestId: text(),
  createdAt: timestamp().auto(),
}).permissions({
  read: role(adminRole),
  list: role(adminRole),
});
```

`create`, `update`, and `delete` declare no rule on purpose. With no rule for
an action the permission engine default-denies every non-admin caller, which is
right for rows nothing should write over REST. The sink writes them directly
through the adapter, bypassing the API and this entity's rules entirely.

`read` and `list` are restricted because an audit trail is sensitive: it can
carry before and after snapshots of entities with much tighter read rules of
their own, and must not leak out through the generic `/api/entity/:name`
surface.

`before` and `after` are plain `text()` columns holding a JSON string, not
`json()`, because the sink writes them as a string built with `JSON.stringify`.
That keeps the column type portable across dialects.

## How an event becomes a row

For each event in `events`, the plugin subscribes to the bus and maps the
payload onto an `AuditEvent`:

- `action` is the event's verb: `"create"`, `"update"`, or `"delete"`.
- `entity` and `recordId` come from the payload's entity name and `row.id`.
- `actor` is `{ userId, role }` from the payload's `ctx`, omitted for a
  guest-triggered write.
- `after` carries the row for a create or update; `before` carries it for a
  delete. Never both, since the bus hands the plugin one side.
- `requestId` is set when the write came from an HTTP request, so the audit row
  ties back to the request that caused it.

Any event whose entity is the plugin's own audit entity is ignored, so a write
loop is impossible even if something later writes to that entity through the
data engine.

The sink writes immediately, one row per event, with no buffering. Buffering
would save round trips, but an unflushed batch in memory when a process exits
or an isolate is recycled is exactly the data this plugin exists to make
durable. A high-volume deployment that wants batching can wrap the same table
write in its own buffering `AuditSink` and register that instead.

## The flush seam

The sink implements `flush()`, and on serverless runtimes that is what makes it
work at all.

`emitAudit` fans out without awaiting: it returns `void` and never waits on a
sink. On Cloudflare Workers the isolate can suspend as soon as the response is
sent, so an un-awaited async insert is abandoned and the row never reaches D1.
The kernel defers `observability.flushAll()` through
`c.executionCtx.waitUntil(...)` after every request, and this sink's `flush()`
awaits every write still in flight, which keeps the isolate alive until they
persist.

On Node with `node:sqlite` the insert runs synchronously, so this only ever bit
on D1. It is worth knowing anyway: any sink you write that defers work needs a
`flush`, or it will silently drop writes on Workers. See
[Observability](/concepts/observability/) for the registry and the rest of the
sink contracts.
