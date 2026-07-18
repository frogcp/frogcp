---
title: Entities and the schema DSL
description: How defineBackend, entity, and the field builders describe your data, and how that config compiles to a Drizzle schema.
sidebar:
  order: 1
---

An entity is a named set of typed fields plus its permissions. You declare
entities with a small builder DSL, and frogCP turns that declaration into a
Drizzle table, a migration, REST routes, and validation.

## defineBackend

`defineBackend` takes a map of entity builders and returns a `BackendConfig`.
It resolves each builder to a plain `EntityDef`, validates the result, and
freezes it.

```ts
import { defineBackend, entity, text, timestamp } from "frogcp";

export default defineBackend({
  entities: {
    posts: entity({
      title: text().required(),
      body: text(),
      createdAt: timestamp().auto(),
    }),
  },
});
```

The returned config is what you hand to `createBackend` or `defineApp`. It is
a plain, inspectable object: `{ entities, resources? }`.

`defineBackend` also accepts an optional `resources` block, a
`type -> bindingName -> options` map of deploy resources for a control plane to
provision. The framework never provisions anything itself; it only carries the
declaration so a deploy command can forward it.

## Fields

Each field builder returns a `FieldBuilder`. There are nine field types:

| Builder | Field type | Notes |
| --- | --- | --- |
| `text()` | `text` | |
| `number()` | `number` | |
| `boolean()` | `boolean` | |
| `date()` | `date` | |
| `timestamp()` | `timestamp` | the only type that accepts `.auto()` |
| `json()` | `json` | stored as JSON |
| `select(options)` | `select` | requires a non-empty options array |
| `media()` | `media` | stores a storage key, not the bytes |
| `ref(target)` | `ref` | a foreign key to another entity's `id` |

`select` throws if you pass no options. `media` stores a storage-key string
pointing at bytes in the configured `StorageAdapter`; the column is plain text
and the `frogcp/media` plugin handles upload and serving by that key.

```ts
import { entity, boolean, json, media, number, ref, select, text } from "frogcp";

const products = entity({
  name: text().required(),
  slug: text().required().unique(),
  price: number().required(),
  active: boolean().default(true),
  status: select(["draft", "live", "archived"]).default("draft"),
  metadata: json(),
  cover: media(),
  category: ref("categories").onDelete("cascade"),
  internalNote: text().hidden(),
});
```

### Modifiers

Modifiers are chainable and each returns the same builder:

- `.required()` makes the column `NOT NULL`.
- `.default(value)` sets a SQL-level column default.
- `.auto()` marks a `timestamp()` as populated at insert time. It throws on any
  other field type. Auto timestamps are stamped by the data engine rather than
  by a SQL default, which keeps the schema portable across dialects, so
  `.default()` is ignored on an auto field.
- `.unique()` adds a unique constraint.
- `.hidden()` strips the field from every API response. The data engine removes
  hidden fields at a single choke point, including for an admin caller and
  including embedded relation rows, and rejects filtering or sorting on them.
- `.readonly()` blocks non-admin callers from writing the field. Unlike
  `.hidden()`, it stays visible in responses.
- `.onDelete(mode)` sets the referential action on a `ref()` field, one of
  `"cascade"`, `"set null"`, or `"restrict"`. It throws on any other field type.

## Permissions on an entity

`entity(...).permissions(map)` attaches rules keyed by action. See
[Permissions](/concepts/permissions/) for the rule DSL.

```ts
import { entity, rule, text } from "frogcp";

const notes = entity({
  title: text().required(),
  owner: text().required(),
}).permissions({
  create: rule.authenticated(),
  list: rule.owner("owner"),
  read: rule.owner("owner"),
  update: rule.owner("owner"),
  delete: rule.owner("owner"),
});
```

## Validation at definition time

`defineBackend` runs `validateConfig` over the resolved entities, so a
misconfiguration fails at startup rather than at request time. It checks that:

- `id` and `expand` are not used as field names. `id` is the implicit primary
  key and `expand` is the relation-embed key on API responses.
- No entity or field name starts with `__frogcp`, which is reserved for
  framework bookkeeping tables such as `__frogcp_migrations`.
- Every `owner()` rule references a real field on the same entity, or the
  implicit `id`.
- An `owner()` field is text-compatible. Ownership compares the stored value
  against `ctx.userId`, a string, so `number`, `boolean`, `date`, and `json`
  fields are rejected.
- An `owner()` field is not `.hidden()`, since ownership decided by an
  invisible field would be unobservable.

## How the config compiles

`compileTables(config, dialect)` turns a `BackendConfig` into one Drizzle table
per entity, keyed by entity name. The dialect is `"sqlite"` (the default) or
`"postgres"`, and a single call always produces tables of one dialect.

```ts
import { compileTables } from "frogcp";
import config from "./backend.config";

const tables = compileTables(config, "sqlite");
```

Every table gets an implicit `id` text primary key, which the data engine fills
with `crypto.randomUUID()` on insert. Field types map to columns per dialect.
On SQLite:

- `text`, `select`, and `media` become `text`
- `number` becomes `real`
- `boolean` becomes `integer` in boolean mode
- `date` and `timestamp` become `integer` in timestamp mode
- `json` becomes `text` in JSON mode
- `ref` becomes `text` with a foreign key to the target table's `id`, carrying
  the `onDelete` action when one is set

Ref columns use Drizzle's lazy `references(() => target.id)` callback, so
entities can be declared in any order. Ref targets are still validated eagerly
at compile time, so an unknown target fails at boot rather than at query time.

`createBackend` calls `compileTables` for you and then runs `migrateToConfig`
to bring the database in line with the compiled schema, unless you pass
`migrate: false`.

## Entities from a plugin

A plugin declares entities the same way, using `resolveEntities` instead of
`defineBackend`. It resolves the builders without the config-level validation
and freezing, because the kernel validates the merged result at boot.

```ts
import { entity, resolveEntities, text, timestamp, type FrogPlugin } from "frogcp";

export function auditLogPlugin(): FrogPlugin {
  return {
    name: "audit-log",
    entities: resolveEntities({
      audit_events: entity({
        action: text().required(),
        actor: text().required(),
        at: timestamp().auto(),
      }),
    }),
  };
}
```

The kernel merges plugin entities on top of the user config in plugin array
order and throws on the first name collision, naming the plugin that lost.
