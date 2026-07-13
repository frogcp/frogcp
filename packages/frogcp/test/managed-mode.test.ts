import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeSqliteAdapter } from "frogcp/adapter/node";
import {
  createBackend,
  defineBackend,
  entity,
  readStoredSchema,
  ref,
  resolveEntities,
  rule,
  text,
  writeStoredSchema,
  type Backend,
  type DatabaseAdapter,
  type FrogPlugin,
} from "../src/index";

const BASE = "http://x";

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`${BASE}${path}`, init);
}

function postJson(path: string, body: unknown): Request {
  return req(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const publicPerms = {
  create: rule.public(),
  read: rule.public(),
  list: rule.public(),
  update: rule.public(),
  delete: rule.public(),
};

const notesConfig = defineBackend({
  entities: {
    notes: entity({ title: text().required() }).permissions(publicPerms),
  },
});

// Managed mode needs a real on-disk sqlite file whenever a test spins up more
// than one adapter against the same database: ":memory:" is per-connection, so
// a second nodeSqliteAdapter would open a separate empty db. Each test gets its
// own temp directory, removed afterward.
const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "frogcp-managed-mode-"));
  tempDirs.push(dir);
  return join(dir, "db.sqlite3");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("managed mode: boot + seeding", () => {
  it("first boot with a code config seeds __frogcp_schema, and notes CRUD works", async () => {
    const adapter = nodeSqliteAdapter(tempDbPath());
    const backend = await createBackend({ config: notesConfig, adapter, mode: "managed" });

    const stored = await readStoredSchema(adapter);
    expect(stored?.entities).toEqual(notesConfig.entities);

    const createRes = await backend.fetch(postJson("/api/entity/notes", { title: "hello" }));
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { data: { id: string; title: string } };
    expect(created.data.title).toBe("hello");

    const listRes = await backend.fetch(req("/api/entity/notes"));
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { data: { title: string }[] };
    expect(list.data.map((r) => r.title)).toEqual(["hello"]);
  });

  it("seeding: a fresh managed backend with opts.config=notes, readStoredSchema returns notes afterward", async () => {
    const adapter = nodeSqliteAdapter(tempDbPath());
    expect(await readStoredSchema(adapter)).toBeNull();

    await createBackend({ config: notesConfig, adapter, mode: "managed" });

    const stored = await readStoredSchema(adapter);
    expect(stored).not.toBeNull();
    expect(stored?.entities).toEqual(notesConfig.entities);
  });

  it("a second boot (same db, different code config) loads the stored schema; the store is authoritative and the changed code config is ignored", async () => {
    const dbPath = tempDbPath();
    const firstAdapter = nodeSqliteAdapter(dbPath);
    await createBackend({ config: notesConfig, adapter: firstAdapter, mode: "managed" });

    const changedConfig = defineBackend({
      entities: {
        notes: entity({ title: text().required() }).permissions(publicPerms),
        bogus: entity({ label: text().required() }).permissions(publicPerms),
      },
    });

    const secondAdapter = nodeSqliteAdapter(dbPath);
    const backend = await createBackend({ config: changedConfig, adapter: secondAdapter, mode: "managed" });

    // The live schema is still just "notes"; "bogus" from the changed code
    // config never made it in.
    const bogusRes = await backend.fetch(req("/api/entity/bogus"));
    expect(bogusRes.status).toBe(404);

    const notesRes = await backend.fetch(req("/api/entity/notes"));
    expect(notesRes.status).toBe(200);

    // And the store itself still only has "notes"; the second boot's changed
    // code config was never written back.
    const stored = await readStoredSchema(secondAdapter);
    expect(Object.keys(stored?.entities ?? {})).toEqual(["notes"]);
  });
});

describe("managed mode: applySchema hot-swap", () => {
  it("adds a new entity 'tags', immediately queryable through the same backend.fetch, and a fresh boot on the same db also sees it", async () => {
    const dbPath = tempDbPath();
    const adapter = nodeSqliteAdapter(dbPath);
    const backend = await createBackend({ config: notesConfig, adapter, mode: "managed" });

    const newConfig = defineBackend({
      entities: {
        notes: entity({ title: text().required() }).permissions(publicPerms),
        tags: entity({ label: text().required() }).permissions(publicPerms),
      },
    });

    await backend.applySchema(newConfig);

    const createRes = await backend.fetch(postJson("/api/entity/tags", { label: "urgent" }));
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { data: { id: string; label: string } };
    expect(created.data.label).toBe("urgent");

    const listRes = await backend.fetch(req("/api/entity/tags"));
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { data: { label: string }[] };
    expect(list.data.map((r) => r.label)).toEqual(["urgent"]);

    // Backend.tables reflects the post-hot-swap live schema too.
    expect(Object.keys(backend.tables)).toContain("tags");

    // A fresh boot against the same database also sees "tags"; the store (not
    // just the in-memory engine) was updated.
    const freshAdapter = nodeSqliteAdapter(dbPath);
    const freshBackend = await createBackend({
      config: notesConfig, // deliberately the old code config; the store wins
      adapter: freshAdapter,
      mode: "managed",
    });
    const freshRes = await freshBackend.fetch(req("/api/entity/tags"));
    expect(freshRes.status).toBe(200);
  });

  it("an invalid config (ref to a missing entity) throws, and the old schema still works", async () => {
    const adapter = nodeSqliteAdapter(tempDbPath());
    const backend = await createBackend({ config: notesConfig, adapter, mode: "managed" });

    const invalidConfig = defineBackend({
      entities: {
        notes: entity({ title: text().required() }).permissions(publicPerms),
        orphan: entity({ noteId: ref("doesNotExist").required() }).permissions(publicPerms),
      },
    });

    await expect(backend.applySchema(invalidConfig)).rejects.toThrow();

    // Old schema still fully functional.
    const createRes = await backend.fetch(postJson("/api/entity/notes", { title: "still here" }));
    expect(createRes.status).toBe(201);

    // The failed entity never became routable.
    const orphanRes = await backend.fetch(req("/api/entity/orphan"));
    expect(orphanRes.status).toBe(404);

    // And the store was never overwritten with the invalid config.
    const stored = await readStoredSchema(adapter);
    expect(Object.keys(stored?.entities ?? {})).toEqual(["notes"]);
  });

  it("a migration failing during DDL execution (not validation) rejects, rolls back, and leaves the old schema + store intact", async () => {
    // Distinct from the invalid-config test above, which fails at validateConfig
    // before any DDL runs. Here the config is valid and migrateToConfig gets as
    // far as executing CREATE TABLE inside its transaction, then a wrapped
    // adapter throws mid-sequence, so we exercise the db-level atomic rollback.
    const real = nodeSqliteAdapter(tempDbPath());
    let armed = false;
    const adapter: DatabaseAdapter = {
      ...real,
      async exec(ddl: string): Promise<void> {
        // Only trip during the armed applySchema migration, and only on the new
        // entity's CREATE TABLE, never transaction control (BEGIN/COMMIT/
        // ROLLBACK) or the framework's own __frogcp bookkeeping tables.
        if (armed && /^CREATE TABLE/i.test(ddl.trimStart()) && !ddl.includes("__frogcp")) {
          throw new Error("injected DDL failure");
        }
        return real.exec(ddl);
      },
    } as DatabaseAdapter;

    const backend = await createBackend({ config: notesConfig, adapter, mode: "managed" });

    const withTags = defineBackend({
      entities: {
        notes: entity({ title: text().required() }).permissions(publicPerms),
        tags: entity({ label: text().required() }).permissions(publicPerms),
      },
    });

    armed = true;
    await expect(backend.applySchema(withTags)).rejects.toThrow("injected DDL failure");
    armed = false;

    // (a) applySchema rejected; (b) the old schema still works...
    const createRes = await backend.fetch(postJson("/api/entity/notes", { title: "survives" }));
    expect(createRes.status).toBe(201);
    // ...(c) the failed entity never became live (rolled back)...
    const tagsRes = await backend.fetch(req("/api/entity/tags"));
    expect(tagsRes.status).toBe(404);
    // ...and (d) __frogcp_schema still holds only the old schema; the store
    // write runs after migrate, so a mid-DDL failure never reaches it.
    const stored = await readStoredSchema(adapter);
    expect(Object.keys(stored?.entities ?? {})).toEqual(["notes"]);
  });

  it("two concurrent applySchema calls serialize (the second's migration only starts once the first has settled)", async () => {
    const adapter = nodeSqliteAdapter(tempDbPath());
    const backend = await createBackend({ config: notesConfig, adapter, mode: "managed" });

    const configA = defineBackend({
      entities: {
        notes: entity({ title: text().required() }).permissions(publicPerms),
        a: entity({ v: text().required() }).permissions(publicPerms),
      },
    });
    const configB = defineBackend({
      entities: {
        notes: entity({ title: text().required() }).permissions(publicPerms),
        a: entity({ v: text().required() }).permissions(publicPerms),
        b: entity({ v: text().required() }).permissions(publicPerms),
      },
    });

    await Promise.all([backend.applySchema(configA), backend.applySchema(configB)]);

    // Whichever order they settled in, the final live schema is exactly one of
    // the two full configs (never a torn merge of both). Both a and b present is
    // the only way that is true here, since B is a superset.
    const bRes = await backend.fetch(req("/api/entity/b"));
    expect(bRes.status).toBe(200);
    const aRes = await backend.fetch(req("/api/entity/a"));
    expect(aRes.status).toBe(200);
  });
});

describe("managed mode: code mode still rejects applySchema", () => {
  it("code-mode backend.applySchema(...) throws", async () => {
    const adapter = nodeSqliteAdapter(":memory:");
    const backend: Backend = await createBackend({ config: notesConfig, adapter });

    await expect(backend.applySchema(notesConfig)).rejects.toThrow(
      "applySchema is only available in managed mode",
    );
  });
});

describe("managed mode: plugin entities are re-merged, never stored", () => {
  it("a managed backend with a plugin contributing 'users' has it live, but __frogcp_schema does not contain it", async () => {
    const adapter = nodeSqliteAdapter(tempDbPath());
    const usersPlugin: FrogPlugin = {
      name: "fake-auth",
      entities: resolveEntities({
        users: entity({ email: text().required() }).permissions(publicPerms),
      }),
    };

    const backend = await createBackend({
      config: notesConfig,
      adapter,
      mode: "managed",
      plugins: [usersPlugin],
    });

    // Plugin entity is live.
    const usersRes = await backend.fetch(req("/api/entity/users"));
    expect(usersRes.status).toBe(200);

    // But not persisted to the managed store; only "notes" (the user entity)
    // is there.
    const stored = await readStoredSchema(adapter);
    expect(Object.keys(stored?.entities ?? {})).toEqual(["notes"]);
    expect(stored?.entities.users).toBeUndefined();
  });

  it("a stored user entity 'users' colliding with a plugin's 'users' throws the mergeEntities collision at boot, naming the plugin", async () => {
    const dbPath = tempDbPath();

    // Pre-store a user schema that already declares a "users" entity (as if a
    // user had seeded/edited one before adding auth).
    const seedAdapter = nodeSqliteAdapter(dbPath);
    await writeStoredSchema(
      seedAdapter,
      defineBackend({
        entities: {
          users: entity({ email: text().required() }).permissions(publicPerms),
        },
      }),
    );

    // A plugin that also contributes "users", the same shape frogcp/auth's
    // authPlugin has. A test-double named "auth" keeps this test inside the
    // frogcp package with no frogcp/auth workspace cycle; the collision path is
    // purely mergeEntities, driven by plugin.name + entity keys, so the double
    // exercises the identical guard and produces the identical message.
    const authLike: FrogPlugin = {
      name: "auth",
      entities: resolveEntities({
        users: entity({ email: text().required() }).permissions(publicPerms),
      }),
    };

    const bootAdapter = nodeSqliteAdapter(dbPath);
    await expect(
      createBackend({ config: notesConfig, adapter: bootAdapter, mode: "managed", plugins: [authLike] }),
    ).rejects.toThrow('Entity "users" already defined (plugin "auth")');
  });
});
