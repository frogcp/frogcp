import { describe, expectTypeOf, it } from "vitest";
import { createClient, type FrogFetch } from "../../src/client/client";

/**
 * A fetch stub that resolves immediately without touching the network. The
 * assertions in this file are compile-time only, but a handful are written as
 * real method CALLS (`void notes.create(...)`) to keep the argument literal in
 * "fresh" position where TS's excess-property check applies, and those calls
 * DO execute at runtime. Without a stub they each fire a real
 * `fetch("http://x/...")`, which fails DNS as an unhandled rejection and can
 * flake the whole `vitest run` process to a non-zero exit even when every
 * assertion passes. The stub makes every such call resolve cleanly; it does
 * NOT affect any type under test (types flow from the `TB` generic, not from
 * `opts.fetch`).
 */
const stubFetch: FrogFetch = async () =>
  new Response(JSON.stringify({ data: {}, meta: { total: 0, limit: 0, offset: 0 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/**
 * Proves `createClient<TBackend>` flows the entity's `row`/`insert`/`patch`
 * shapes through to `EntityClient`'s method signatures, not just structurally
 * accepted at the `Client<TBackend>` level. This is a type-level test: the
 * assertions are enforced by the TypeScript compiler, so a regression in
 * `client.ts`'s generics fails `tsc` (this package's `typecheck`, which
 * includes `test/`) rather than silently passing.
 *
 * Two assertion styles are used deliberately:
 *  - `expectTypeOf(...).toEqualTypeOf<...>()` for "this resolves to exactly
 *    this type" checks (return types, parameter types).
 *  - A direct call with an object literal plus `@ts-expect-error` for "this
 *    exact call is rejected" checks (missing required field / unknown field).
 *    `expectTypeOf(fn).toBeCallableWith(literal)` does NOT run excess-property
 *    checks on the literal; a direct call keeps it in "fresh" position where
 *    TS's excess-property check applies.
 *
 * `TB` mirrors what `frogcp generate`'s type output emits for a `notes` entity
 * with `title: text().required()` and `done: boolean().default(false)`. `done`
 * is optional (undefined-omittable) in both insert and patch, but in the ROW
 * it is optional AND nullable (`boolean | null`): a non-required field
 * compiles to a nullable column, and Drizzle returns SQL `NULL` as JS `null`,
 * not `undefined`.
 */
type TB = {
  notes: {
    row: { id: string; title: string; done?: boolean | null };
    insert: { title: string; done?: boolean };
    patch: { title?: string; done?: boolean };
  };
};

describe("createClient<TBackend> type flow (compile-time only)", () => {
  it("entity(\"notes\").get(id)/list() resolve to TB's row type", () => {
    const client = createClient<TB>("http://x", { fetch: stubFetch });
    const notes = client.entity("notes");

    expectTypeOf(notes.get).parameter(0).toEqualTypeOf<string>();
    expectTypeOf(notes.get).returns.resolves.toEqualTypeOf<{ id: string; title: string; done?: boolean | null }>();
    expectTypeOf(notes.list).returns.resolves.toEqualTypeOf<{
      data: { id: string; title: string; done?: boolean | null }[];
      meta: { total: number; limit: number; offset: number };
    }>();
  });

  it("create(data) is typed exactly as TB's insert shape: title mandatory, done optional", () => {
    const client = createClient<TB>("http://x", { fetch: stubFetch });
    const notes = client.entity("notes");

    expectTypeOf(notes.create).parameter(0).toEqualTypeOf<{ title: string; done?: boolean }>();
    expectTypeOf(notes.create).returns.resolves.toEqualTypeOf<{ id: string; title: string; done?: boolean | null }>();

    // Required field present, optional omitted/supplied: both accepted.
    void notes.create({ title: "hello" });
    void notes.create({ title: "hello", done: true });

    // Missing the mandatory `title`: REJECTED. If `create`'s parameter ever
    // degraded to `unknown`/`any` (the generic no longer flowing through),
    // this call would stop erroring and the `@ts-expect-error` below would
    // itself become a compile error ("unused '@ts-expect-error' directive").
    // @ts-expect-error - title is required by TB["notes"]["insert"]
    void notes.create({ done: true });

    // An unknown field on an otherwise-valid payload: REJECTED (TS's
    // excess-property check on a fresh object-literal argument).
    // @ts-expect-error - "extra" is not a key of TB["notes"]["insert"]
    void notes.create({ title: "hello", extra: 1 });
  });

  it("update(id, patch) is typed exactly as TB's (fully optional) patch shape", () => {
    const client = createClient<TB>("http://x", { fetch: stubFetch });
    const notes = client.entity("notes");

    expectTypeOf(notes.update).parameter(1).toEqualTypeOf<{ title?: string; done?: boolean }>();

    void notes.update("id-1", {});
    void notes.update("id-1", { title: "renamed" });

    // @ts-expect-error - "extra" is not a key of TB["notes"]["patch"]
    void notes.update("id-1", { extra: 1 });
  });

  it("entity(name) is constrained to TB's own entity names: an unknown name is a compile error", () => {
    const client = createClient<TB>("http://x", { fetch: stubFetch });

    // @ts-expect-error - "unknown_entity" is not a key of TB
    client.entity("unknown_entity");
  });

  it("the untyped DefaultBackend fallback still works: every entity name resolves to unknown-shaped row/insert/patch", () => {
    const client = createClient("http://x", { fetch: stubFetch }); // no type argument -> DefaultBackend
    const anything = client.entity("whatever"); // any string name is accepted

    expectTypeOf(anything.get).returns.resolves.toEqualTypeOf<unknown>();
    // With no TBackend, `insert` is `unknown` too, so any literal is
    // assignable to it: no excess-property rejection possible/expected here.
    void anything.create({ whatever: "goes" });
  });
});
