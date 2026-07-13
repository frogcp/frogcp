import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { nodeSqliteAdapter } from "./support/node-sqlite-adapter";
import {
  defineBackend,
  entity,
  text,
  number,
  select,
  ref,
  timestamp,
  rule,
  role,
  migrateToConfig,
  compileTables,
  DataEngine,
  EventBus,
  ApiError,
  type Identity,
  type DatabaseAdapter,
} from "../src/index";

const config = defineBackend({
  entities: {
    users: entity({
      name: text().required(),
      // Optional (not required) so existing { name }-only creates in this
      // file's setup() keep working unchanged; exercised directly by the
      // unique/hidden tests below.
      email: text().unique(),
      passwordHash: text().hidden(),
    }).permissions({
      // Self-ownership: a member's Identity.userId is the row's own id, so
      // owner("id") lets a user read their own row; admin sees everyone.
      read: rule.owner("id"),
    }),
    notes: entity({
      title: text().required(),
      owner: ref("users").required(),
      reviewer: ref("users"),
      status: select(["draft", "published", "archived"]).default("draft"),
      priority: number(),
      createdAt: timestamp().auto(),
    }).permissions({
      create: rule.authenticated(),
      read: rule.owner("owner"),
      list: rule.owner("owner"),
      update: rule.owner("owner"),
      delete: rule.owner("owner"),
    }),
    // Statically-gated entity: read is role-based (no row scoping), so a
    // non-editor's read denial is decided without looking at any row.
    docs: entity({
      title: text().required(),
    }).permissions({
      read: role("editor"),
    }),
    // Public-create entity combined with an owner() read rule: exercises the
    // guest owner-stamping gap, a guest must never be able to plant an owner
    // id that a later owner() rule would honor.
    posts: entity({
      title: text().required(),
      owner: ref("users"),
    }).permissions({
      create: rule.public(),
      read: rule.owner("owner"),
      list: rule.owner("owner"),
    }),
    // notes/users pattern with an explicit onDelete("cascade") ref, to
    // exercise cascading deletes (unlike notes.owner, which has no onDelete
    // override and defaults to SQLite's NO ACTION; see the 409 test below).
    sessions: entity({
      owner: ref("users").required().onDelete("cascade"),
      token: text().required(),
    }),
  },
});

async function setup() {
  // nodeSqliteAdapter returns the concrete SqliteDatabaseAdapter, so direct
  // adapter.db access below is typed without any narrowing cast.
  const adapter = nodeSqliteAdapter(":memory:");
  await migrateToConfig(adapter, config);
  const tables = compileTables(config);
  const engine = new DataEngine(adapter, config, tables, new EventBus());

  const admin: Identity = { userId: "admin-seed", role: "admin" };
  const guest = null;

  const aliceRow = await engine.create("users", { name: "Alice" }, admin);
  const bobRow = await engine.create("users", { name: "Bob" }, admin);
  const alice: Identity = { userId: aliceRow.id as string, role: "member" };
  const bob: Identity = { userId: bobRow.id as string, role: "member" };

  return { engine, admin, guest, alice, bob, aliceRow, bobRow, adapter, tables };
}

describe("DataEngine dialect genericism", () => {
  // DataEngine's query-builder calls are dialect-agnostic drizzle-orm
  // primitives, so construction no longer rejects a postgres-dialect adapter.
  // This is a narrow, no-live-connection proof (construction never touches
  // db). The full proof (CRUD/unique/FK against a live Postgres server) lives
  // in the postgres adapter's conformance suite.
  it("does not throw when constructed with a postgres-dialect adapter", () => {
    const tables = compileTables(config, "postgres");
    const fakePostgresAdapter = {
      dialect: "postgres" as const,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: undefined as any,
      exec: async () => {},
    } as DatabaseAdapter;
    expect(() => new DataEngine(fakePostgresAdapter, config, tables, new EventBus())).not.toThrow();
  });

  it("throws when the adapter's dialect does not match the compiled tables' dialect", () => {
    // A postgres adapter handed sqlite-compiled tables (or vice versa) would
    // emit malformed SQL or fail opaquely deep in drizzle; the constructor's
    // dialect-coherence guard catches it up front with a clear message.
    const sqliteTables = compileTables(config, "sqlite");
    const fakePostgresAdapter = {
      dialect: "postgres" as const,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: undefined as any,
      exec: async () => {},
    } as DatabaseAdapter;
    expect(() => new DataEngine(fakePostgresAdapter, config, sqliteTables, new EventBus())).toThrow(
      /does not match the compiled tables' dialect/,
    );
  });
});

describe("DataEngine", () => {
  it("alice lists only her notes; meta.total counts only her rows", async () => {
    const { engine, admin, alice, bob } = await setup();
    await engine.create("notes", { title: "alice-1", owner: alice.userId }, admin);
    await engine.create("notes", { title: "alice-2", owner: alice.userId }, admin);
    await engine.create("notes", { title: "bob-1", owner: bob.userId }, admin);

    const result = await engine.list("notes", alice);
    expect(result.data).toHaveLength(2);
    expect(result.data.every((r) => r.owner === alice.userId)).toBe(true);
    expect(result.meta.total).toBe(2);
    expect(result.meta.limit).toBe(50);
    expect(result.meta.offset).toBe(0);
  });

  it("alice reading bob's note is a 404 not_found, not a 403", async () => {
    const { engine, admin, alice, bob } = await setup();
    const bobNote = await engine.create("notes", { title: "bob-note", owner: bob.userId }, admin);

    const err = await engine.read("notes", bobNote.id as string, alice).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).code).toBe("not_found");
  });

  it("statically denied read is a 403 forbidden, not a 404 (mirrors update/delete)", async () => {
    const { engine, admin, alice } = await setup();
    const doc = await engine.create("docs", { title: "secret" }, admin);

    // docs.read is role("editor"), a static decision that does not depend on
    // the row, so denying it leaks no existence information: plain 403.
    const err = await engine.read("docs", doc.id as string, alice).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect((err as ApiError).code).toBe("forbidden");

    // An editor's read is statically allowed (no filter) and succeeds.
    const editor: Identity = { userId: "ed-1", role: "editor" };
    const read = await engine.read("docs", doc.id as string, editor);
    expect(read.title).toBe("secret");
  });

  it("guest create is forbidden (403)", async () => {
    const { engine, guest, alice } = await setup();
    const err = await engine
      .create("notes", { title: "nope", owner: alice.userId }, guest)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect((err as ApiError).code).toBe("forbidden");
  });

  it("invalid payload (missing required title) is a 422 validation error", async () => {
    const { engine, alice } = await setup();
    const err = await engine.create("notes", { owner: alice.userId }, alice).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).code).toBe("validation");
  });

  it("422 validation error message is the first zod issue's message, not the raw issues array", async () => {
    const { engine, alice } = await setup();
    const err = await engine.create("notes", { owner: alice.userId }, alice).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    // A JSON-serialized issues array starts with "["; the message must not be that.
    expect((err as ApiError).message.startsWith("[")).toBe(false);
    expect((err as ApiError).message.length).toBeGreaterThan(0);
  });

  it("create checks permission before validating: guest with an invalid payload still gets 403", async () => {
    const { engine, guest } = await setup();
    // Missing required title and owner, and guest is unauthenticated. The
    // mandated order is decide (403) first, then validate (422), so the 403
    // wins even though the payload is also invalid.
    const err = await engine.create("notes", {}, guest).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect((err as ApiError).code).toBe("forbidden");
  });

  it("guest create on a publicly-creatable entity strips owner fields (fail closed)", async () => {
    const { engine, admin, guest, alice } = await setup();
    const post = await engine.create("posts", { title: "anon-post", owner: "alice" }, guest);

    // The stored row has no owner at all: the guest-supplied value never persisted.
    const stored = await engine.read("posts", post.id as string, admin);
    expect(stored.owner == null).toBe(true);

    // Because the row has no owner, alice's owner("owner") read rule never
    // matches it: alice gets a 404, not access.
    const err = await engine.read("posts", post.id as string, alice).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });

  it("guest owner-spoof: a spoofed victim id never shows up in the victim's own list", async () => {
    const { engine, guest, alice } = await setup();
    // alice is the victim: a guest tries to plant alice's id as the owner of a
    // post it creates.
    await engine.create("posts", { title: "spoofed-onto-alice", owner: alice.userId }, guest);

    const aliceList = await engine.list("posts", alice);
    expect(aliceList.meta.total).toBe(0);
    expect(aliceList.data).toHaveLength(0);
  });

  it("create fills id (a uuid) and auto timestamp fields", async () => {
    const { engine, alice } = await setup();
    const note = await engine.create("notes", { title: "auto-fields", owner: alice.userId }, alice);
    expect(typeof note.id).toBe("string");
    expect(note.id as string).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(note.createdAt).toBeInstanceOf(Date);
  });

  it("alice updates her own note; the change is persisted", async () => {
    const { engine, admin, alice } = await setup();
    const note = await engine.create("notes", { title: "before", owner: alice.userId }, admin);
    const updated = await engine.update("notes", note.id as string, { title: "after" }, alice);
    expect(updated.title).toBe("after");

    const reread = await engine.read("notes", note.id as string, alice);
    expect(reread.title).toBe("after");
  });

  it("update with an invalid patch (wrong type) is a 422 with the first zod issue's message", async () => {
    const { engine, admin, alice } = await setup();
    const note = await engine.create("notes", { title: "before", owner: alice.userId }, admin);
    const err = await engine
      .update("notes", note.id as string, { priority: "not-a-number" }, alice)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).code).toBe("validation");
    expect((err as ApiError).message.startsWith("[")).toBe(false);
    expect((err as ApiError).message.length).toBeGreaterThan(0);
  });

  it("auto fields are system-managed: a spoofed createdAt in a patch never persists", async () => {
    const { engine, admin, alice } = await setup();
    const note = await engine.create("notes", { title: "keep-time", owner: alice.userId }, admin);
    const original = note.createdAt as Date;

    const spoof = new Date("1999-12-31T23:59:59Z");
    const updated = await engine.update(
      "notes",
      note.id as string,
      { title: "still-mine", createdAt: spoof },
      alice,
    );
    expect(updated.title).toBe("still-mine");
    expect((updated.createdAt as Date).getTime()).toBe(original.getTime());

    // A patch containing only the spoofed auto field succeeds as a no-op.
    const noop = await engine.update("notes", note.id as string, { createdAt: spoof }, alice);
    expect((noop.createdAt as Date).getTime()).toBe(original.getTime());
  });

  it("create stamps owner fields for non-admin callers, overriding client values", async () => {
    const { engine, alice, bob } = await setup();
    const note = await engine.create(
      "notes",
      { title: "mine-actually", owner: bob.userId },
      alice,
    );
    expect(note.owner).toBe(alice.userId);
  });

  it("non-admin patch changing an owner field is a 422; same-value no-op passes", async () => {
    const { engine, admin, alice, bob } = await setup();
    const note = await engine.create("notes", { title: "steal-me", owner: alice.userId }, admin);

    const err = await engine
      .update("notes", note.id as string, { owner: bob.userId }, alice)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).code).toBe("validation");
    expect((err as ApiError).message).toContain("server-managed");

    // Same-value "change" is a no-op and passes.
    const same = await engine.update(
      "notes",
      note.id as string,
      { owner: alice.userId, title: "kept" },
      alice,
    );
    expect(same.owner).toBe(alice.userId);
    expect(same.title).toBe("kept");
  });

  it("admin may set owner explicitly on create and reassign it on update", async () => {
    const { engine, admin, alice, bob } = await setup();
    const note = await engine.create("notes", { title: "reassign-me", owner: alice.userId }, admin);
    expect(note.owner).toBe(alice.userId);

    const reassigned = await engine.update("notes", note.id as string, { owner: bob.userId }, admin);
    expect(reassigned.owner).toBe(bob.userId);

    // bob now owns it; alice can no longer read it.
    const err = await engine.read("notes", note.id as string, alice).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });

  it("alice updating bob's note is a 404 not_found", async () => {
    const { engine, admin, alice, bob } = await setup();
    const bobNote = await engine.create("notes", { title: "bob-note", owner: bob.userId }, admin);
    const err = await engine
      .update("notes", bobNote.id as string, { title: "hacked" }, alice)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).code).toBe("not_found");
  });

  it("admin deletes bob's note; a subsequent read is 404", async () => {
    const { engine, admin, bob } = await setup();
    const bobNote = await engine.create("notes", { title: "bob-note", owner: bob.userId }, admin);
    await engine.delete("notes", bobNote.id as string, admin);

    const err = await engine.read("notes", bobNote.id as string, admin).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).code).toBe("not_found");
  });

  it("`with` keeps the raw FK and embeds relations under expand (allowed to row, denied to null)", async () => {
    const { engine, admin, alice, bob } = await setup();
    const note = await engine.create(
      "notes",
      { title: "reviewed", owner: alice.userId, reviewer: bob.userId },
      admin,
    );

    const read = await engine.read("notes", note.id as string, alice, ["owner", "reviewer"]);
    // The FK fields keep their raw id values; expansion never replaces them.
    expect(read.owner).toBe(alice.userId);
    expect(read.reviewer).toBe(bob.userId);
    // alice can read her own user row (users.read: owner("id"))
    expect(read.expand?.owner).toMatchObject({ id: alice.userId, name: "Alice" });
    // alice cannot read bob's user row, so it embeds null
    expect(read.expand?.reviewer).toBeNull();
  });

  it("expand is absent when `with` was not requested", async () => {
    const { engine, admin, alice } = await setup();
    const note = await engine.create("notes", { title: "plain", owner: alice.userId }, admin);

    const read = await engine.read("notes", note.id as string, alice);
    expect("expand" in read).toBe(false);

    const listed = await engine.list("notes", alice);
    expect(listed.data[0] && "expand" in listed.data[0]).toBe(false);
  });

  it("`with` also works via list()", async () => {
    const { engine, admin, alice, bob } = await setup();
    await engine.create("notes", { title: "reviewed", owner: alice.userId, reviewer: bob.userId }, admin);

    const result = await engine.list("notes", alice, { with: ["owner", "reviewer"] });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.owner).toBe(alice.userId);
    expect(result.data[0]?.expand?.owner).toMatchObject({ id: alice.userId });
    expect(result.data[0]?.expand?.reviewer).toBeNull();
  });

  it("unknown relation name in `with` is a 422 validation error", async () => {
    const { engine, admin, alice } = await setup();
    const note = await engine.create("notes", { title: "x", owner: alice.userId }, admin);
    const err = await engine.read("notes", note.id as string, alice, ["nope"]).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).code).toBe("validation");
  });

  it("unknown entity name is a 404 unknown_entity", async () => {
    const { engine, admin } = await setup();
    const err = await engine.list("ghosts", admin).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).code).toBe("unknown_entity");
  });

  it("supports limit/offset pagination with sort under permission scope", async () => {
    const { engine, admin, alice, bob } = await setup();
    const titles = ["charlie", "alpha", "delta", "bravo", "echo"];
    for (const title of titles) {
      await engine.create("notes", { title, owner: alice.userId }, admin);
    }
    // Add noise owned by bob, which must never leak into alice's paginated view.
    await engine.create("notes", { title: "bob-noise", owner: bob.userId }, admin);

    const page1 = await engine.list("notes", alice, {
      sort: [{ field: "title", dir: "asc" }],
      limit: 2,
      offset: 0,
    });
    expect(page1.data.map((r) => r.title)).toEqual(["alpha", "bravo"]);
    expect(page1.meta.total).toBe(5);

    const page2 = await engine.list("notes", alice, {
      sort: [{ field: "title", dir: "asc" }],
      limit: 2,
      offset: 2,
    });
    expect(page2.data.map((r) => r.title)).toEqual(["charlie", "delta"]);
    expect(page2.meta.total).toBe(5);
  });

  it("limit is clamped to [1, 200] and negative offset is treated as 0", async () => {
    const { engine, admin, alice } = await setup();
    for (const title of ["n1", "n2", "n3", "n4", "n5"]) {
      await engine.create("notes", { title, owner: alice.userId }, admin);
    }

    // limit: -1 must not mean "unlimited" (SQLite semantics); it clamps to 1.
    const negLimit = await engine.list("notes", alice, { limit: -1 });
    expect(negLimit.data).toHaveLength(1);
    expect(negLimit.meta.limit).toBe(1);

    // limit: 500 clamps down to the 200 maximum.
    const bigLimit = await engine.list("notes", alice, { limit: 500 });
    expect(bigLimit.meta.limit).toBe(200);
    expect(bigLimit.data).toHaveLength(5);

    // offset: -5 is treated as 0: full first page, nothing skipped.
    const negOffset = await engine.list("notes", alice, {
      sort: [{ field: "title", dir: "asc" }],
      offset: -5,
    });
    expect(negOffset.data).toHaveLength(5);
    expect(negOffset.meta.offset).toBe(0);
    expect(negOffset.data[0]?.title).toBe("n1");
  });

  it("a patch key with an explicit undefined value behaves exactly like an absent key", async () => {
    const { engine, admin, alice } = await setup();
    const note = await engine.create("notes", { title: "unchanged", owner: alice.userId }, admin);

    const result = await engine.update("notes", note.id as string, { title: undefined }, alice);
    expect(result.id).toBe(note.id);
    expect(result.title).toBe("unchanged");

    const reread = await engine.read("notes", note.id as string, alice);
    expect(reread.title).toBe("unchanged");
  });

  it("filters: eq (implicit), gte on number, like on text, in on select", async () => {
    const { engine, admin, alice } = await setup();
    await engine.create(
      "notes",
      { title: "one", owner: alice.userId, priority: 1, status: "draft" },
      admin,
    );
    await engine.create(
      "notes",
      { title: "two", owner: alice.userId, priority: 5, status: "published" },
      admin,
    );
    await engine.create(
      "notes",
      { title: "three", owner: alice.userId, priority: 9, status: "archived" },
      admin,
    );

    const gte = await engine.list("notes", alice, { filter: { priority: [{ op: "gte", value: 5 }] } });
    expect(gte.data.map((r) => r.title).sort()).toEqual(["three", "two"]);

    const like = await engine.list("notes", alice, { filter: { title: [{ op: "like", value: "%wo%" }] } });
    expect(like.data.map((r) => r.title)).toEqual(["two"]);

    const inOp = await engine.list("notes", alice, {
      filter: { status: [{ op: "in", value: ["draft", "archived"] }] },
    });
    expect(inOp.data.map((r) => r.title).sort()).toEqual(["one", "three"]);

    const eqOp = await engine.list("notes", alice, { filter: { status: [{ op: "eq", value: "published" }] } });
    expect(eqOp.data.map((r) => r.title)).toEqual(["two"]);
  });

  it("multiple conditions on the same field are ANDed together (gte+lte expresses a range)", async () => {
    const { engine, admin, alice } = await setup();
    await engine.create("notes", { title: "one", owner: alice.userId, priority: 1 }, admin);
    await engine.create("notes", { title: "two", owner: alice.userId, priority: 5 }, admin);
    await engine.create("notes", { title: "three", owner: alice.userId, priority: 9 }, admin);

    const range = await engine.list("notes", alice, {
      filter: {
        priority: [
          { op: "gte", value: 2 },
          { op: "lte", value: 5 },
        ],
      },
    });
    expect(range.data.map((r) => r.title)).toEqual(["two"]);
  });

  it("like filter with a non-string value is a clean 422", async () => {
    const { engine, alice } = await setup();
    const err = await engine
      .list("notes", alice, { filter: { title: [{ op: "like", value: 42 }] } })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).code).toBe("validation");
  });

  it("in filter with a non-array value is a clean 422", async () => {
    const { engine, alice } = await setup();
    const err = await engine
      .list("notes", alice, { filter: { status: [{ op: "in", value: "draft" }] } })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).code).toBe("validation");
  });

  it("create with a dangling ref is a clean 422 (FK constraint mapped, not a raw SQL error)", async () => {
    const { engine, admin } = await setup();
    const err = await engine
      .create("notes", { title: "ghost-owner", owner: "00000000-0000-0000-0000-000000000000" }, admin)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).code).toBe("validation");
    expect((err as ApiError).message).toContain("owner");
  });

  it("update with a dangling ref is a clean 422 (FK constraint mapped, not a raw SQL error)", async () => {
    const { engine, admin, alice } = await setup();
    const note = await engine.create("notes", { title: "reassign-to-ghost", owner: alice.userId }, admin);
    const err = await engine
      .update("notes", note.id as string, { owner: "00000000-0000-0000-0000-000000000000" }, admin)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).code).toBe("validation");
  });

  it("deleting a row still referenced by a non-cascade ref is a clean 409 conflict", async () => {
    const { engine, admin, alice } = await setup();
    // notes.owner to users has no onDelete override (defaults to SQLite's
    // NO ACTION), so this note keeps alice's row alive.
    await engine.create("notes", { title: "keeps-alice-alive", owner: alice.userId }, admin);

    const err = await engine.delete("users", alice.userId, admin).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).code).toBe("conflict");

    // Nothing was actually deleted: alice's row is still there.
    const stillThere = await engine.read("users", alice.userId, admin);
    expect(stillThere.id).toBe(alice.userId);
  });

  it("deleting a parent row cascades per .onDelete(\"cascade\") (sessions/users pattern)", async () => {
    const { engine, admin, alice } = await setup();
    const session = await engine.create(
      "sessions",
      { owner: alice.userId, token: "tok-1" },
      admin,
    );

    // Unlike the NO ACTION notes.owner ref, sessions.owner cascades: the
    // parent delete must succeed (no 409), and the child row must be gone.
    await expect(engine.delete("users", alice.userId, admin)).resolves.toBeUndefined();

    const err = await engine.read("sessions", session.id as string, admin).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).code).toBe("not_found");
  });

  it("duplicate value on a .unique() field is a clean 409 conflict on create (no SQL text leaked)", async () => {
    const { engine, admin } = await setup();
    await engine.create("users", { name: "First", email: "dup@example.com" }, admin);

    const err = await engine
      .create("users", { name: "Second", email: "dup@example.com" }, admin)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).code).toBe("conflict");
    expect((err as ApiError).message).not.toMatch(/SQLITE/i);
    expect((err as ApiError).message).not.toMatch(/UNIQUE constraint failed/i);
    expect((err as ApiError).message).toContain("email");
  });

  it("duplicate value on a .unique() field is a clean 409 conflict on update", async () => {
    const { engine, admin } = await setup();
    const a = await engine.create("users", { name: "A", email: "a@example.com" }, admin);
    const b = await engine.create("users", { name: "B", email: "b@example.com" }, admin);

    const err = await engine
      .update("users", b.id as string, { email: a.email as string }, admin)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).code).toBe("conflict");
    expect((err as ApiError).message).not.toMatch(/SQLITE/i);

    // Nothing was actually changed: b still has its own original email.
    const stillB = await engine.read("users", b.id as string, admin);
    expect(stillB.email).toBe("b@example.com");
  });

  it("hidden field: create payload is silently dropped, never appears in read/list/create output, and a client patch cannot alter the underlying value", async () => {
    const { engine, admin, adapter } = await setup();

    const created = await engine.create(
      "users",
      { name: "Priv", passwordHash: "client-supplied" },
      admin,
    );
    expect("passwordHash" in created).toBe(false);

    // The create payload's hidden-field value was never persisted at all:
    // hidden fields aren't in the insert zod shape, so the key is stripped
    // before it reaches the insert. A privileged direct-DB read (bypassing the
    // engine, as the framework intends for hidden-field access) proves it.
    const afterCreate = await adapter.db.all<{ passwordHash: unknown }>(
      sql`SELECT passwordHash FROM users WHERE id = ${created.id as string}`,
    );
    expect(afterCreate[0]?.passwordHash == null).toBe(true);

    // Privileged direct write seeds a real stored value.
    await adapter.db.run(
      sql`UPDATE users SET passwordHash = ${"seeded-hash"} WHERE id = ${created.id as string}`,
    );

    const read = await engine.read("users", created.id as string, admin);
    expect("passwordHash" in read).toBe(false);

    const list = await engine.list("users", admin);
    expect(list.data.every((r) => !("passwordHash" in r))).toBe(true);

    // A client patch attempting to change the hidden field is silently
    // ignored (dropped from the patch shape); the underlying value is
    // untouched, provable only via a privileged direct read.
    const patched = await engine.update(
      "users",
      created.id as string,
      { name: "Priv2", passwordHash: "attacker-hash" },
      admin,
    );
    expect(patched.name).toBe("Priv2");
    expect("passwordHash" in patched).toBe(false);

    const afterPatch = await adapter.db.all<{ passwordHash: unknown }>(
      sql`SELECT passwordHash FROM users WHERE id = ${created.id as string}`,
    );
    expect(afterPatch[0]?.passwordHash).toBe("seeded-hash");
  });

  it("hidden field never appears in an embedded relation row under `expand`", async () => {
    const { engine, admin, adapter, alice } = await setup();
    await adapter.db.run(
      sql`UPDATE users SET passwordHash = ${"alice-secret-hash"} WHERE id = ${alice.userId}`,
    );

    const note = await engine.create("notes", { title: "reviewed", owner: alice.userId }, admin);
    const read = await engine.read("notes", note.id as string, alice, ["owner"]);
    expect(read.expand?.owner).toMatchObject({ id: alice.userId });
    expect(read.expand?.owner && "passwordHash" in read.expand.owner).toBe(false);
  });
});

describe("hidden fields are not part of the queryable surface", () => {
  // A .hidden() field is output-stripped (stripHidden), but a client-supplied
  // filter/sort that references it would leak its value through the set/order
  // of returned rows: like becomes a prefix-extraction oracle, eq a presence
  // oracle, sort an ordering oracle, defeating the confidentiality guarantee
  // even though the column never appears in a response. So hidden columns must
  // not be usable in a WHERE or ORDER BY by any caller (admin included; the
  // REST surface never queries hidden fields, and privileged access is via
  // tables + adapter.db directly, outside the engine).
  it("rejects a filter on a hidden field (would otherwise be a value-extraction oracle)", async () => {
    const { engine, admin } = await setup();
    for (const op of ["eq", "like", "in"] as const) {
      const value = op === "in" ? ["a"] : "a%";
      const err = await engine
        .list("users", admin, { filter: { passwordHash: [{ op, value }] } })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(422);
    }
  });

  it("rejects a sort on a hidden field (ordering leaks the secret value)", async () => {
    const { engine, admin } = await setup();
    const err = await engine
      .list("users", admin, { sort: [{ field: "passwordHash", dir: "asc" }] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
  });
});

describe("readonly fields", () => {
  // Public-create entity with a .readonly() field: readonly fields are
  // server-managed (like owner fields) but stay visible in responses (unlike
  // hidden fields). Enforcement lives in the engine, not the zod schemas, so
  // admin writes still validate through the same schemas.
  const roConfig = defineBackend({
    entities: {
      profiles: entity({
        label: text().required(),
        tier: text().required().default("free").readonly(),
        owner: text(),
      }).permissions({
        create: rule.public(),
        read: rule.owner("owner"),
        list: rule.owner("owner"),
        update: rule.owner("owner"),
      }),
    },
  });

  async function setupRo() {
    const adapter = nodeSqliteAdapter(":memory:");
    await migrateToConfig(adapter, roConfig);
    const tables = compileTables(roConfig);
    const engine = new DataEngine(adapter, roConfig, tables, new EventBus());
    const admin: Identity = { userId: "admin-seed", role: "admin" };
    const mallory: Identity = { userId: "mallory", role: "member" };
    return { engine, adapter, admin, mallory };
  }

  it("non-admin create: a client-supplied readonly value is ignored and the default applies", async () => {
    const { engine, mallory } = await setupRo();
    const created = await engine.create("profiles", { label: "mine", tier: "vip" }, mallory);
    expect(created.tier).toBe("free");
  });

  it("guest create: a client-supplied readonly value is ignored too (guest is non-admin)", async () => {
    const { engine } = await setupRo();
    const created = await engine.create("profiles", { label: "anon", tier: "vip" }, null);
    expect(created.tier).toBe("free");
  });

  it("admin create: an explicit readonly value passes through", async () => {
    const { engine, admin } = await setupRo();
    const created = await engine.create("profiles", { label: "staff", tier: "vip" }, admin);
    expect(created.tier).toBe("vip");
  });

  it("non-admin patch CHANGING a readonly field is a 422 'server-managed' and the DB value is untouched", async () => {
    const { engine, adapter, mallory } = await setupRo();
    const created = await engine.create("profiles", { label: "mine", tier: "vip" }, mallory);

    const err = await engine
      .update("profiles", created.id as string, { tier: "vip" }, mallory)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).code).toBe("validation");
    expect((err as ApiError).message).toBe('"tier" is server-managed');

    const rows = await adapter.db.all<{ tier: string }>(
      sql`SELECT tier FROM profiles WHERE id = ${created.id as string}`,
    );
    expect(rows[0]?.tier).toBe("free");
  });

  it("non-admin patch resubmitting the CURRENT readonly value is a harmless no-op (other fields still apply)", async () => {
    const { engine, mallory } = await setupRo();
    const created = await engine.create("profiles", { label: "mine" }, mallory);

    const patched = await engine.update(
      "profiles",
      created.id as string,
      { label: "renamed", tier: "free" },
      mallory,
    );
    expect(patched.label).toBe("renamed");
    expect(patched.tier).toBe("free");
  });

  it("admin patch may change a readonly field", async () => {
    const { engine, admin, mallory } = await setupRo();
    const created = await engine.create("profiles", { label: "mine" }, mallory);

    const patched = await engine.update("profiles", created.id as string, { tier: "vip" }, admin);
    expect(patched.tier).toBe("vip");
  });

  it("readonly fields stay visible in create/read/list responses (unlike hidden)", async () => {
    const { engine, admin, mallory } = await setupRo();
    const created = await engine.create("profiles", { label: "mine" }, mallory);
    expect(created.tier).toBe("free");

    const read = await engine.read("profiles", created.id as string, admin);
    expect(read.tier).toBe("free");

    const list = await engine.list("profiles", admin);
    expect(list.data.every((r) => r.tier === "free")).toBe(true);
  });
});

describe("DataEngine.findByField", () => {
  it("owner finds their own row by a non-id field, with hidden fields stripped", async () => {
    const { engine, admin } = await setup();
    const carolRow = await engine.create(
      "users",
      { name: "Carol", passwordHash: "carol-hash" },
      admin,
    );
    const carol: Identity = { userId: carolRow.id as string, role: "member" };

    const found = await engine.findByField("users", "name", "Carol", carol);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(carolRow.id);
    expect(found?.passwordHash).toBeUndefined();
  });

  it("a non-owner looking up someone else's row by field gets null (no existence oracle)", async () => {
    const { engine, admin, alice } = await setup();
    const carolRow = await engine.create("users", { name: "Carol" }, admin);
    void carolRow;

    const found = await engine.findByField("users", "name", "Carol", alice);
    expect(found).toBeNull();
  });

  it("a value that matches no row returns null", async () => {
    const { engine, admin } = await setup();
    const found = await engine.findByField("users", "name", "does-not-exist", admin);
    expect(found).toBeNull();
  });

  it("admin bypasses the row-scoped rule, same as read/list", async () => {
    const { engine, admin } = await setup();
    await engine.create("users", { name: "Dave" }, admin);
    const found = await engine.findByField("users", "name", "Dave", admin);
    expect(found).not.toBeNull();
  });

  it("unknown entity throws ApiError(unknown_entity)", async () => {
    const { engine, admin } = await setup();
    const err = await engine.findByField("no-such-entity", "name", "x", admin).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("unknown_entity");
  });

  it("unknown field throws a clear error", async () => {
    const { engine, admin } = await setup();
    await expect(engine.findByField("users", "no-such-field", "x", admin)).rejects.toThrow(
      /unknown field/i,
    );
  });
});
