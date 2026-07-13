# frogCP

frogCP is an open-source backend framework. You define your data as typed
entities and get a REST API, a typed client, an admin UI, and permissions
(role and row-level) compiled to SQL. It is a small microkernel plus plugins,
with swappable database and runtime adapters.

This file is the guide for anyone working in the repo, human or agent. Read the
house style section before you write code.

## Layout

The framework is one package, `packages/frogcp`, with subpath exports:

- `frogcp`: the kernel (entity DSL, data engine, permissions, REST, plugins).
- `frogcp/{auth,media,kv,mail,activity,client,cli}`: first-party plugins, the
  typed client, and the CLI.
- `frogcp/adapter/{node,libsql,postgres,cloudflare,nextjs}`: database and runtime
  adapters. Drivers like `pg` and `@libsql/client` are optional peers.
- `packages/admin` (`@frogcp/admin`): the admin UI, a separate package with its
  own build.
- `examples/*`: runnable example apps.
- `docs/`: the documentation site (Astro Starlight, MDX).

## Commands

pnpm 10, Node 24 or newer. Run everything from the repo root.

```
pnpm install          # bootstrap the workspace
pnpm -r build         # build every package
pnpm -r typecheck     # typecheck every package
pnpm -r test          # run the tests
pnpm --filter frogcp test    # just the framework suite
```

Tests and typecheck read the framework from source (a tsconfig path alias), so
you do not need a built dist to run them.

## Architecture

A request flows through the kernel: identity resolution, then a permission
check that compiles to a SQL `WHERE`, then the data engine (Drizzle), then the
adapter. Observability sinks run on the side.

The entity DSL (`defineBackend`, `entity`, `text`, `select`, ...) compiles to a
Drizzle schema and a migration. Permissions like `rule.owner("owner")` become
`WHERE owner = :current_user_id`, so row-level access is enforced in the
database, not in application code.

Every capability past the kernel is a plugin. A plugin is a plain object with
some of: `entities`, `middleware`, `onBoot`, and routes. Auth, media, kv, mail,
and activity are all just plugins. So is anything you write.

## House style

Match the surrounding code. Beyond that:

**Comments.** Explain why, not what. If the code already says it, do not
comment it. Keep comments to a line or two. Save longer notes for a genuinely
non-obvious decision or a public API doc.

- No em-dashes. Use commas, parentheses, colons, or two sentences.
- No filler: drop "on purpose", "load-bearing", "crucially", "note that",
  "importantly", and ALL-CAPS for emphasis.
- Write like a teammate leaving a short note, not an essay.

Before:
```
// These specifiers are routed through module-scope `const`s rather than passed
// as string LITERALS to `import()` on purpose: esbuild eagerly resolves and
// inlines whatever a dynamic `import()`'s argument constant-folds to —
// INCLUDING a plain literal — so a literal here would drag pg into every bundle.
```
After:
```
// Import through a variable, not a literal. esbuild inlines literal dynamic
// imports, which would pull pg/libsql/node:sqlite into every Worker bundle.
```

**TypeScript.** Strict, with `exactOptionalPropertyTypes`. Build optional object
fields with conditional spreads, not `key: undefined`. No `.js` import
extensions.

**Naming.** Plain and direct. Prefer a clear name over a comment.

## Testing

Write the test first, watch it fail, then write the code to pass it. This holds
for features, bug fixes, and refactors. A bug fix starts with a test that
reproduces the bug.

Keep tests focused: one behavior each, a clear name, real code over mocks.

## Adding a plugin, adapter, or transport

The extension points are small interfaces, so most additions are a standalone
file or package, no kernel change needed. For example, a mail transport is one
function:

```ts
type MailTransport = (message: MailMessage) => Promise<void>;
```

See `docs/` (the plugin guide) for the full walkthrough. Community plugins can
live as their own npm packages that depend on `frogcp`; name them `frogcp-*`.

## Commits and pull requests

Small, focused PRs, one concern each. Every PR builds, types, and tests green on
its own.

Use Conventional Commits: `type(scope): summary`, imperative, lowercase, no
trailing period. Common types are `feat`, `fix`, `refactor`, `test`, `docs`,
`chore`. For example, `feat(auth): add email and password login`.

Branch names follow the same shape: `type/short-name`, for example `feat/auth` or
`fix/list-query-sort`.

Describe the change itself. Never reference an old repo, a port, a migration, a
comment cleanup, or removing em-dashes in a branch name, commit, or PR. None of
that is part of this project's story.

## Notes for agents

- Read the neighboring files first and follow their patterns.
- Follow the house style exactly, especially the comment rules above. Do not
  reintroduce em-dashes or essay comments.
- Keep changes scoped to the task. If you find unrelated cleanup, mention it
  rather than folding it in.
- Run the tests and typecheck before you call something done, and say plainly
  if something fails.
