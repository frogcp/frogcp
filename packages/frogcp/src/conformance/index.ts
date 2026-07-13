import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import type { DatabaseAdapter } from "../adapter";
import { migrateToConfig } from "../migrate/index";
import { extractRows } from "../migrate/postgres";
import { compileTables } from "../compile/drizzle";
import { defineBackend, entity } from "../schema/entity";
import { text, ref, number, boolean, timestamp, json } from "../schema/fields";
import { rule } from "../permissions/rules";
import type { Identity } from "../permissions/engine";
import { DataEngine, ApiError } from "../data/engine";
import { EventBus } from "../events";

/**
 * Lists every table name in the database `adapter` is connected to, the one
 * piece of raw introspection this suite needs that genuinely differs by dialect
 * (there is no portable drizzle query-builder way to ask "what tables exist").
 * SQLite exposes this via the `sqlite_master` catalog table; Postgres via
 * `pg_catalog.pg_tables` scoped to the `public` schema, where `compile/postgres.ts`'s
 * `pgTable()` calls create everything since no schema is ever specified.
 */
async function listTableNames(adapter: DatabaseAdapter): Promise<string[]> {
  if (adapter.dialect === "sqlite") {
    const rows = await adapter.db.all(sql`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`);
    return rows.map((r: any) => r.name);
  }
  const result = await adapter.db.execute(
    sql`SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  return extractRows<{ name: string }>(result).map((r) => r.name);
}

/** Lists every column name on `table`: SQLite via `PRAGMA table_info`, Postgres via `information_schema.columns`. */
async function listColumnNames(adapter: DatabaseAdapter, table: string): Promise<string[]> {
  if (adapter.dialect === "sqlite") {
    const cols = await adapter.db.all(sql.raw(`PRAGMA table_info(${table})`));
    return cols.map((c: any) => c.name);
  }
  const result = await adapter.db.execute(
    sql`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table}`,
  );
  return extractRows<{ name: string }>(result).map((r) => r.name);
}

/** Counts the rows in `__frogcp_migrations`, one per successfully-applied migration. */
async function countMigrationSnapshots(adapter: DatabaseAdapter): Promise<number> {
  if (adapter.dialect === "sqlite") {
    return (await adapter.db.all(sql`SELECT id FROM __frogcp_migrations`)).length;
  }
  const result = await adapter.db.execute(sql`SELECT id FROM __frogcp_migrations`);
  return extractRows(result).length;
}

/**
 * The shared behavioral contract every `DatabaseAdapter` implementation must
 * satisfy, so every adapter (node:sqlite, libSQL, Postgres, D1, ...) is checked
 * against the exact same behaviors rather than a hand-copied approximation.
 *
 * Dialect-generic: `makeAdapter` may hand back either a `"sqlite"` or a
 * `"postgres"` adapter. Every test branches on `adapter.dialect` only where it
 * genuinely differs (via `migrateToConfig`'s own dispatcher and this module's
 * introspection helpers). The CRUD/unique/FK tests need no branching, since
 * `DataEngine`'s query-builder calls are dialect-agnostic drizzle-orm
 * primitives, so the same engine code runs against either dialect's tables.
 *
 * `makeAdapter` is called once per `it()` (never shared across tests) so each
 * test starts from a clean database. Callers typically hand in a factory that
 * opens a fresh `:memory:` (or equivalently isolated) connection.
 *
 * Imported by adapter test suites as `runAdapterConformance` so each adapter can
 * call it directly.
 */
export function runAdapterConformance(
  name: string,
  makeAdapter: () => DatabaseAdapter | Promise<DatabaseAdapter>,
): void {
  describe(`adapter conformance: ${name}`, () => {
    it("fresh migrate creates tables (plus the migrations bookkeeping table)", async () => {
      const adapter = await makeAdapter();
      const config = defineBackend({ entities: { notes: entity({ title: text().required() }) } });
      await migrateToConfig(adapter, config);

      const names = await listTableNames(adapter);
      expect(names).toContain("notes");
      expect(names).toContain("__frogcp_migrations");
    });

    it("incremental migrate adds a column on re-migrate", async () => {
      const adapter = await makeAdapter();
      const v1 = defineBackend({ entities: { notes: entity({ title: text().required() }) } });
      await migrateToConfig(adapter, v1);

      const v2 = defineBackend({
        entities: { notes: entity({ title: text().required(), body: text() }) },
      });
      await migrateToConfig(adapter, v2);

      expect(await listColumnNames(adapter, "notes")).toContain("body");
    });

    it("rolls back the whole migration (DDL and bookkeeping) when a statement fails mid-sequence", async () => {
      const real = await makeAdapter();
      let failOnDdl: number | null = null;
      let ddlCount = 0;
      // Delegate to the real adapter, but throw on the Nth migration DDL
      // statement (transaction control and the bookkeeping table's own CREATE
      // TABLE don't count) to force a mid-sequence failure.
      const adapter: DatabaseAdapter = {
        ...real,
        async exec(ddl: string): Promise<void> {
          const isControl = /^(BEGIN|COMMIT|ROLLBACK)/i.test(ddl) || ddl.includes("__frogcp_migrations");
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

      // v2 adds two tables, so the diff has at least two statements; fail on the
      // second so the first has already applied inside the transaction.
      const v2 = defineBackend({
        entities: {
          notes: entity({ title: text().required() }),
          tags: entity({ label: text().required() }),
          comments: entity({ body: text().required() }),
        },
      });
      failOnDdl = ddlCount + 2;
      await expect(migrateToConfig(adapter, v2)).rejects.toThrow("injected DDL failure");

      // (a) nothing from the failed migration is present...
      const names = await listTableNames(real);
      expect(names).not.toContain("tags");
      expect(names).not.toContain("comments");
      // ...and the bookkeeping still points at the v1 snapshot only.
      expect(await countMigrationSnapshots(real)).toBe(1);

      // (b) a subsequent migrate with the same config succeeds cleanly.
      failOnDdl = null;
      await migrateToConfig(adapter, v2);
      const after = await listTableNames(real);
      expect(after).toContain("tags");
      expect(after).toContain("comments");
      expect(await countMigrationSnapshots(real)).toBe(2);
    });

    it("full CRUD round-trip through DataEngine honors owner-scoped permissions", async () => {
      const adapter = await makeAdapter();
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
      expect(typeof created.id).toBe("string");

      const read = await engine.read("notes", created.id as string, alice);
      expect(read.title).toBe("hello");

      // bob's row-scoped rule doesn't match alice's note -> 404, not 403.
      const readErr = await engine.read("notes", created.id as string, bob).catch((e) => e);
      expect(readErr).toBeInstanceOf(ApiError);
      expect((readErr as ApiError).status).toBe(404);

      const listed = await engine.list("notes", alice);
      expect(listed.data).toHaveLength(1);
      expect(listed.meta.total).toBe(1);
      const bobListed = await engine.list("notes", bob);
      expect(bobListed.data).toHaveLength(0);

      const updated = await engine.update("notes", created.id as string, { title: "updated" }, alice);
      expect(updated.title).toBe("updated");

      await engine.delete("notes", created.id as string, alice);
      const afterDelete = await engine.read("notes", created.id as string, alice).catch((e) => e);
      expect(afterDelete).toBeInstanceOf(ApiError);
      expect((afterDelete as ApiError).status).toBe(404);
    });

    it("a duplicate value on a .unique() field maps to ApiError 409 conflict", async () => {
      const adapter = await makeAdapter();
      const config = defineBackend({
        entities: {
          users: entity({ email: text().required().unique() }),
        },
      });
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
      const adapter = await makeAdapter();
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
      expect((danglingErr as ApiError).code).toBe("validation");

      const user = await engine.create("users", { name: "Alice" }, admin);
      const session = await engine.create("sessions", { owner: user.id as string, token: "t2" }, admin);

      // Cascading FK: deleting the parent must succeed (no 409) and remove the child.
      await expect(engine.delete("users", user.id as string, admin)).resolves.toBeUndefined();
      const afterCascade = await engine.read("sessions", session.id as string, admin).catch((e) => e);
      expect(afterCascade).toBeInstanceOf(ApiError);
      expect((afterCascade as ApiError).status).toBe(404);
      expect((afterCascade as ApiError).code).toBe("not_found");
    });

    it("typed fields round-trip through DataEngine with the correct JS type and value (number/boolean/timestamp/json), and filtering by them works", async () => {
      const adapter = await makeAdapter();
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

      // A whole-second Date: sqlite's integer(..., { mode: "timestamp" }) column
      // stores unix seconds (truncating sub-second precision), while Postgres's
      // timestamp column keeps full precision. A value already at second
      // granularity round-trips identically on both, so this assertion is
      // dialect-honest rather than papering over that documented divergence.
      const createdAt = new Date("2026-01-01T00:00:00.000Z");
      const meta = { nested: { list: [1, 2, 3] }, label: "widget", flag: false };

      const created = await engine.create(
        "widgets",
        { count: 3.5, active: false, createdAt, meta },
        admin,
      );
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

      // A second row so filtering by the boolean/number fields is meaningful.
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
}
