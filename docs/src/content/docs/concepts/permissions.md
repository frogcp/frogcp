---
title: Permissions
description: Rules and roles, the five actions, and how row-level access compiles into the SQL query instead of being filtered in app code.
sidebar:
  order: 2
---

Permissions in frogCP are declared per entity, per action, as rules. A rule is
either a static allow or deny, or a row-level condition. Row-level conditions
compile into the SQL `WHERE` clause of the query the data engine runs, so the
database enforces them.

## Actions

There are five actions, the `ActionName` union:

- `create`
- `read` (a single row by id)
- `list` (a collection query)
- `update`
- `delete`

`read` and `list` are separate on purpose: an entity can be listable by its
owner but readable by anyone with the id, or the reverse.

## Rules

`rule` is an object of leaf constructors and `role` is a standalone one. All
four return a `Rule`.

```ts
import { role, rule } from "frogcp";

rule.public();          // anyone, including a guest
rule.authenticated();   // any caller with an identity
rule.owner("owner");    // rows whose `owner` field equals the caller's userId
role("editor");         // callers whose role is exactly "editor"
```

`rule.owner(field)` is the row-level one. The field must exist on the entity
(or be the implicit `id`), must be text-compatible, and must not be hidden;
`defineBackend` checks all three. `rule.owner("id")` is the standard
self-ownership pattern for a users-style entity, where the row is the user.

### Combining rules

`Rule` has `.or()` and `.and()`, both of which flatten nested combinators of the
same kind:

```ts
import { role, rule, entity, text } from "frogcp";

const articles = entity({
  title: text().required(),
  author: text().required(),
  published: text(),
}).permissions({
  create: rule.authenticated(),
  // Editors see everything; everyone else sees only their own articles.
  list: role("editor").or(rule.owner("author")),
  read: role("editor").or(rule.owner("author")),
  update: rule.owner("author"),
  delete: role("editor"),
});
```

## Default deny

The engine denies anything you have not allowed:

- An action with no rule is denied for every caller except `admin`.
- An entity with no `permissions` call at all is admin-only.

`admin` is special-cased ahead of any rule: a caller whose role is `admin` is
always allowed, with no row filter. Everything else goes through the rules you
wrote.

## Deciding a request

`decide(entity, action, ctx, table)` is the entry point. `ctx` is an `Identity`
(`{ userId, role, claims? }`) or `null` for a guest. It returns a `Decision`:

```ts
type Decision = { allow: true; filter?: SQL } | { allow: false };
```

Three outcomes:

- `{ allow: false }`: the data engine throws a 403.
- `{ allow: true }` with no `filter`: statically allowed, the query runs
  unconstrained.
- `{ allow: true, filter }`: allowed, but the Drizzle `SQL` condition in
  `filter` must also hold. The data engine ands it into the query.

This is the key property. `rule.owner("author")` on `list` does not fetch rows
and drop the ones that fail a check. It becomes `WHERE author = :userId` in the
statement the database executes, alongside your own filters, sorting, and
pagination. The row count, the `total` in the list response, and the pagination
window are all computed over the permitted set.

`create` is the exception: it has no row to scope, so the engine uses only the
allow or deny half of the decision.

### Single-row checks

Some paths already hold a row (a lookup by id, for example) and need the same
semantics evaluated in memory rather than as SQL. That is `checkRow`:

```ts
import { checkRow } from "frogcp";

const allowed = checkRow(entityDef, "update", ctx, row);
```

`checkRow` mirrors `decide` exactly: the same admin bypass, the same
default-deny, the same `or`/`and` semantics, evaluated against a concrete row
instead of compiled to SQL.

## Identity

`Identity` is `{ userId: string; role: string; claims?: Record<string, unknown> }`.
`claims` carries arbitrary auth-provider data (decoded JWT claims, for
instance); the permission engine does not interpret it today.

The kernel resolves a caller's identity, by precedence: an explicit `identify`
option on `createBackend`, then the `x-frogcp-debug-identity` header when
`debugIdentity: true` (dev tooling only), then the first plugin providing
`identify`, then guest. Only the first plugin with `identify` is consulted, and
the kernel warns at boot if more than one provides it.

A plugin `identify` that throws is caught, logged as a warning, and resolves to
guest. A misbehaving identity plugin degrades its caller rather than returning
a 500.
