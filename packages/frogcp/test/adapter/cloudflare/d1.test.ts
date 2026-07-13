import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  ApiError,
  DataEngine,
  EventBus,
  boolean,
  compileTables,
  defineBackend,
  entity,
  json,
  migrateToConfig,
  number,
  ref,
  rule,
  text,
  timestamp,
  type DatabaseAdapter,
  type Identity,
  type SqliteDatabaseAdapter,
} from "frogcp";
import { d1Adapter } from "../../../src/adapter/cloudflare/d1";
import { resetD1, tryStartMiniflareEnv } from "./support/miniflare-env";

/**
 * This suite does not call the shared runAdapterConformance factory
 * (frogcp/conformance) the way every other adapter's test does. Every behavior
 * it covers except one is copied from that suite so coverage stays equivalent,
 * but the "rolls back the whole migration" case does not hold for D1 (see
 * d1Adapter's doc comment), and runAdapterConformance can't exclude a single
 * nested it() from outside. So this file hand-mirrors the parts that hold and
 * replaces the rollback case with a test that asserts what D1 actually does
 * (see the last describe block).
 */
async function listTableNames(adapter: SqliteDatabaseAdapter): Promise<string[]> {
  const rows = await adapter.db.all(sql`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`);
  return rows.map((r) => (r as { name: string }).name);
}

async function listColumnNames(adapter: SqliteDatabaseAdapter, table: string): Promise<string[]> {
  const cols = await adapter.db.all(sql.raw(`PRAGMA table_info(${table})`));
  return cols.map((c) => (c as { name: string }).name);
}

const env = await tryStartMiniflareEnv();

afterAll(async () => {
  await env?.mf.dispose();
});

describe.skipIf(env === null)("d1Adapter (miniflare/workerd)", () => {
  beforeEach(async () => {
    await resetD1(env!.d1);
  });

  it("fresh migrate creates tables (plus the migrations bookkeeping table)", async () => {
    const adapter = d1Adapter(env!.d1);
    const config = defineBackend({ entities: { notes: entity({ title: text().required() }) } });
    await migrateToConfig(adapter, config);

    const names = await listTableNames(adapter);
    expect(names).toContain("notes");
    expect(names).toContain("__frogcp_migrations");
  });

  it("incremental migrate adds a column on re-migrate", async () => {
    const adapter = d1Adapter(env!.d1);
    const v1 = defineBackend({ entities: { notes: entity({ title: text().required() }) } });
    await migrateToConfig(adapter, v1);

    const v2 = defineBackend({
      entities: { notes: entity({ title: text().required(), body: text() }) },
    });
    await migrateToConfig(adapter, v2);

    expect(await listColumnNames(adapter, "notes")).toContain("body");
  });

  it("full CRUD round-trip through DataEngine honors owner-scoped permissions", async () => {
    const adapter = d1Adapter(env!.d1);
    const config = defineBackend({
      entities: {
        notes: entity({
          title: text().required(),
          owner: text().required(),
        }).permissions({
          create: rule.authenticated(),
          read: rule.owner("owner"),
          list: rule.owner("owner"),
          update: rule.owner("owner"),
          delete: rule.owner("owner"),
        }),
      },
    });
    await migrateToConfig(adapter, config);
    const tables = compileTables(config, adapter.dialect);
    const engine = new DataEngine(adapter, config, tables, new EventBus());

    const alice: Identity = { userId: "alice", role: "member" };
    const bob: Identity = { userId: "bob", role: "member" };

    const created = await engine.create("notes", { title: "hello", owner: alice.userId }, alice);
    expect(created.owner).toBe(alice.userId);

    const read = await engine.read("notes", created.id as string, alice);
    expect(read.title).toBe("hello");

    const readErr = await engine.read("notes", created.id as string, bob).catch((e) => e);
    expect(readErr).toBeInstanceOf(ApiError);
    expect((readErr as ApiError).status).toBe(404);

    const updated = await engine.update("notes", created.id as string, { title: "updated" }, alice);
    expect(updated.title).toBe("updated");

    await engine.delete("notes", created.id as string, alice);
    const afterDelete = await engine.read("notes", created.id as string, alice).catch((e) => e);
    expect(afterDelete).toBeInstanceOf(ApiError);
    expect((afterDelete as ApiError).status).toBe(404);
  });

  it("a duplicate value on a .unique() field maps to ApiError 409 conflict", async () => {
    // D1's error carries no .code, just the standard SQLite message text on a
    // .cause-chained error, which the engine's existing message-fallback
    // detection already recognizes without any adapter-side translation.
    const adapter = d1Adapter(env!.d1);
    const config = defineBackend({ entities: { users: entity({ email: text().required().unique() }) } });
    await migrateToConfig(adapter, config);
    const tables = compileTables(config, adapter.dialect);
    const engine = new DataEngine(adapter, config, tables, new EventBus());
    const admin: Identity = { userId: "admin", role: "admin" };

    await engine.create("users", { email: "dup@example.com" }, admin);
    const err = await engine.create("users", { email: "dup@example.com" }, admin).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).code).toBe("conflict");
  });

  it("a dangling ref maps to ApiError 422, and a cascading ref deletes children with the parent", async () => {
    const adapter = d1Adapter(env!.d1);
    const config = defineBackend({
      entities: {
        users: entity({ name: text().required() }),
        sessions: entity({
          owner: ref("users").required().onDelete("cascade"),
          token: text().required(),
        }),
      },
    });
    await migrateToConfig(adapter, config);
    const tables = compileTables(config, adapter.dialect);
    const engine = new DataEngine(adapter, config, tables, new EventBus());
    const admin: Identity = { userId: "admin", role: "admin" };

    const danglingErr = await engine
      .create("sessions", { owner: "00000000-0000-0000-0000-000000000000", token: "t1" }, admin)
      .catch((e) => e);
    expect(danglingErr).toBeInstanceOf(ApiError);
    expect((danglingErr as ApiError).status).toBe(422);

    const user = await engine.create("users", { name: "Alice" }, admin);
    const session = await engine.create("sessions", { owner: user.id as string, token: "t2" }, admin);

    await expect(engine.delete("users", user.id as string, admin)).resolves.toBeUndefined();
    const afterCascade = await engine.read("sessions", session.id as string, admin).catch((e) => e);
    expect(afterCascade).toBeInstanceOf(ApiError);
    expect((afterCascade as ApiError).status).toBe(404);
  });

  // Mirrors frogcp/conformance's "typed fields round-trip" case so D1 gets the
  // same number/boolean/timestamp/json coverage every other adapter gets
  // through the shared suite.
  it("typed fields round-trip through DataEngine with the correct JS type and value (number/boolean/timestamp/json), and filtering by them works", async () => {
    const adapter = d1Adapter(env!.d1);
    const config = defineBackend({
      entities: {
        widgets: entity({
          count: number().required(),
          active: boolean().required(),
          createdAt: timestamp().required(),
          meta: json().required(),
        }),
      },
    });
    await migrateToConfig(adapter, config);
    const tables = compileTables(config, adapter.dialect);
    const engine = new DataEngine(adapter, config, tables, new EventBus());
    const admin: Identity = { userId: "admin", role: "admin" };

    // Whole-second Date: sqlite's integer timestamp-mode column truncates
    // sub-second precision, and D1 compiles to the same sqlite-dialect tables.
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const meta = { nested: { list: [1, 2, 3] }, label: "widget", flag: false };

    const created = await engine.create("widgets", { count: 3.5, active: false, createdAt, meta }, admin);
    expect(typeof created.count).toBe("number");
    expect(created.count).toBe(3.5);
    expect(typeof created.active).toBe("boolean");
    expect(created.active).toBe(false);
    expect(created.createdAt).toBeInstanceOf(Date);
    expect((created.createdAt as Date).getTime()).toBe(createdAt.getTime());
    expect(created.meta).toEqual(meta);

    const read = await engine.read("widgets", created.id as string, admin);
    expect(typeof read.count).toBe("number");
    expect(read.count).toBe(3.5);
    expect(typeof read.active).toBe("boolean");
    expect(read.active).toBe(false);
    expect(read.createdAt).toBeInstanceOf(Date);
    expect((read.createdAt as Date).getTime()).toBe(createdAt.getTime());
    expect(read.meta).toEqual(meta);

    await engine.create(
      "widgets",
      { count: 10, active: true, createdAt, meta: { nested: { list: [] }, label: "other", flag: true } },
      admin,
    );

    const activeOnly = await engine.list("widgets", admin, {
      filter: { active: [{ op: "eq", value: true }] },
    });
    expect(activeOnly.data).toHaveLength(1);
    expect(activeOnly.data[0]!.active).toBe(true);
    expect(activeOnly.data[0]!.count).toBe(10);

    const highCount = await engine.list("widgets", admin, {
      filter: { count: [{ op: "gte", value: 5 }] },
    });
    expect(highCount.data).toHaveLength(1);
    expect(highCount.data[0]!.count).toBe(10);
  });
});

describe.skipIf(env === null)("d1Adapter migration atomicity caveat", () => {
  beforeEach(async () => {
    await resetD1(env!.d1);
  });

  it("does not roll back a partially-applied migration on failure (unlike every other adapter here)", async () => {
    // Same fault injection frogcp/conformance's "rolls back the whole
    // migration" case uses: wrap exec to throw on the Nth non-transaction-
    // control DDL statement. Every other adapter (node:sqlite, libSQL-local,
    // Postgres) rolls the whole migration back. D1 cannot: its exec() and
    // prepare().run() calls each auto-commit, and BEGIN IMMEDIATE / ROLLBACK
    // are no-ops in this adapter (see d1Adapter's doc comment) so
    // migrateToConfig can run at all. The verified consequence: the first
    // statement's table survives a later statement's failure.
    const real = d1Adapter(env!.d1);
    let failOnDdl: number | null = null;
    let ddlCount = 0;
    const adapter: DatabaseAdapter = {
      ...real,
      async exec(ddl: string): Promise<void> {
        const isControl = /^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(ddl) || ddl.includes("__frogcp_migrations");
        if (!isControl) {
          ddlCount += 1;
          if (failOnDdl !== null && ddlCount === failOnDdl) {
            throw new Error("injected DDL failure");
          }
        }
        return real.exec(ddl);
      },
    } as DatabaseAdapter;

    const v1 = defineBackend({ entities: { notes: entity({ title: text().required() }) } });
    await migrateToConfig(adapter, v1);

    const v2 = defineBackend({
      entities: {
        notes: entity({ title: text().required() }),
        tags: entity({ label: text().required() }),
        comments: entity({ body: text().required() }),
      },
    });
    failOnDdl = ddlCount + 2;
    await expect(migrateToConfig(adapter, v2)).rejects.toThrow("injected DDL failure");

    const names = await listTableNames(real);
    // On every other adapter, tags (created by the statement just before the
    // injected failure) would be absent here because the whole migration rolls
    // back. On D1 it is present: there is no real rollback, so tags's CREATE
    // TABLE already committed before the next statement failed.
    expect(names).toContain("tags");
    // The bookkeeping insert never ran (it runs after all DDL, and DDL failed
    // first), so __frogcp_migrations still holds only the v1 row. A later
    // migrateToConfig would then re-diff from the stale v1 snapshot against a
    // database that already has tags.
    const snapshotRows = await real.db.all(sql`SELECT id FROM __frogcp_migrations`);
    expect(snapshotRows).toHaveLength(1);
  });

  it("warns exactly once per adapter instance when it no-ops transaction control", async () => {
    // The one runtime signal that a D1 migration is not atomic. It must fire
    // once per adapter, not once per intercepted BEGIN/COMMIT/ROLLBACK, since a
    // real migration issues several.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const adapter = d1Adapter(env!.d1);
      // A two-entity migration runs several statements inside one BEGIN
      // IMMEDIATE ... COMMIT (2 control calls), then a re-migrate adds a column
      // inside its own BEGIN ... COMMIT (2 more): 4 intercepted control
      // statements, still exactly one warning.
      const v1 = defineBackend({
        entities: {
          notes: entity({ title: text().required() }),
          tags: entity({ label: text().required() }),
        },
      });
      await migrateToConfig(adapter, v1);

      const v2 = defineBackend({
        entities: {
          notes: entity({ title: text().required(), body: text() }),
          tags: entity({ label: text().required() }),
        },
      });
      await migrateToConfig(adapter, v2);

      const nonAtomicWarnings = warnSpy.mock.calls.filter(
        ([message]) => typeof message === "string" && message.includes("D1 does not support atomic"),
      );
      expect(nonAtomicWarnings).toHaveLength(1);
      expect(nonAtomicWarnings[0]![0]).toContain("migrate:false");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
