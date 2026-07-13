# frogCP

An open-source backend framework. Define your data as typed entities and get a
REST API, a typed client, an admin UI, and permissions (role and row-level)
compiled to SQL. It is a small microkernel plus plugins, with swappable database
and runtime adapters.

## Status

Early. The framework is being migrated here module by module, so the surface
below fills in as each lands. See [AGENTS.md](./AGENTS.md) for how the repo is
organized, the house style, and how to contribute.

## Install

```
pnpm add frogcp
```

## A taste

```ts
import { defineBackend, entity, text, rule } from "frogcp";

export default defineBackend({
  entities: {
    notes: entity({ title: text().required() }).permissions({
      read: rule.owner("owner"),
      create: rule.authenticated(),
    }),
  },
});
```

## Develop

```
pnpm install
pnpm -r typecheck
pnpm -r test
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
