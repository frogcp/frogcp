import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeSqliteAdapter } from "frogcp/adapter/node";
import {
  createBackend,
  defineBackend,
  entity,
  resolveEntities,
  role,
  rule,
  text,
  type Backend,
  type DatabaseAdapter,
  type FrogPlugin,
  type RuleExpr,
} from "../src/index";

const BASE = "http://x";
const ADMIN = "admin-seed:admin";
const MEMBER = "member-seed:member";

function req(path: string, identity?: string): Request {
  const h = new Headers();
  if (identity) h.set("x-frogcp-debug-identity", identity);
  return new Request(`${BASE}${path}`, { headers: h });
}

function postSchema(config: unknown, identity?: string): Request {
  const h = new Headers({ "content-type": "application/json" });
  if (identity) h.set("x-frogcp-debug-identity", identity);
  return new Request(`${BASE}/api/system/schema`, { method: "POST", headers: h, body: JSON.stringify(config) });
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

const notesWithTags = {
  entities: {
    notes: { fields: { title: { type: "text", required: true } }, permissions: { create: { kind: "public" }, read: { kind: "public" }, list: { kind: "public" }, update: { kind: "public" }, delete: { kind: "public" } } },
    tags: { fields: { label: { type: "text", required: true } }, permissions: { create: { kind: "public" }, read: { kind: "public" }, list: { kind: "public" }, update: { kind: "public" }, delete: { kind: "public" } } },
  },
};

async function managedBackend(): Promise<Backend> {
  const adapter: DatabaseAdapter = nodeSqliteAdapter(":memory:");
  return createBackend({ config: notesConfig, adapter, mode: "managed", debugIdentity: true });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/system/schema: mode field", () => {
  it("managed backend reports mode: managed", async () => {
    const backend = await managedBackend();
    const res = await backend.fetch(req("/api/system/schema", ADMIN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string };
    expect(body.mode).toBe("managed");
  });

  it("code-mode backend reports mode: code", async () => {
    const adapter = nodeSqliteAdapter(":memory:");
    const backend = await createBackend({ config: notesConfig, adapter, debugIdentity: true });
    const res = await backend.fetch(req("/api/system/schema", ADMIN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string };
    expect(body.mode).toBe("code");
  });
});

describe("GET /api/system/schema: permissionRules (structured source of truth)", () => {
  it("includes the raw RuleExpr per declared action alongside the human summary", async () => {
    const richConfig = defineBackend({
      entities: {
        docs: entity({ title: text().required() }).permissions({
          read: rule.owner("id").or(role("admin")),
          create: rule.authenticated(),
        }),
      },
    });
    const adapter = nodeSqliteAdapter(":memory:");
    const backend = await createBackend({ config: richConfig, adapter, debugIdentity: true });

    const res = await backend.fetch(req("/api/system/schema", ADMIN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { entities: Record<string, { permissions: Record<string, string>; permissionRules: Record<string, RuleExpr> }> };
    };
    const docs = body.data.entities.docs!;

    // Human summary (Phase 5 shape) unchanged.
    expect(docs.permissions.read).toBe("owner(id) OR role(admin)");
    // Structured tree present and re-sendable.
    expect(docs.permissionRules.read).toEqual({
      kind: "or",
      rules: [{ kind: "owner", field: "id" }, { kind: "role", role: "admin" }],
    });
    expect(docs.permissionRules.create).toEqual({ kind: "authenticated" });
    // An undeclared action is omitted from both maps.
    expect(docs.permissionRules.delete).toBeUndefined();
    expect(docs.permissions.delete).toBeUndefined();
  });
});

describe("POST /api/system/schema (managed mode)", () => {
  it("admin adds a 'tags' entity -> 200 with the new schema, and GET/POST /api/entity/tags both work", async () => {
    const backend = await managedBackend();

    const res = await backend.fetch(postSchema(notesWithTags, ADMIN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { entities: Record<string, unknown> }; mode: string };
    expect(body.mode).toBe("managed");
    expect(Object.keys(body.data.entities).sort()).toEqual(["notes", "tags"]);

    const createRes = await backend.fetch(
      new Request(`${BASE}/api/entity/tags`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-frogcp-debug-identity": ADMIN },
        body: JSON.stringify({ label: "urgent" }),
      }),
    );
    expect(createRes.status).toBe(201);

    const listRes = await backend.fetch(req("/api/entity/tags", ADMIN));
    expect(listRes.status).toBe(200);
  });

  it("member gets 403", async () => {
    const backend = await managedBackend();
    const res = await backend.fetch(postSchema(notesWithTags, MEMBER));
    expect(res.status).toBe(403);
  });

  it("guest gets 403", async () => {
    const backend = await managedBackend();
    const res = await backend.fetch(postSchema(notesWithTags));
    expect(res.status).toBe(403);
  });

  it("code-mode backend rejects with 409 not_managed", async () => {
    const adapter = nodeSqliteAdapter(":memory:");
    const backend = await createBackend({ config: notesConfig, adapter, debugIdentity: true });
    const res = await backend.fetch(postSchema(notesWithTags, ADMIN));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_managed");
  });

  it("an invalid config (ref to a missing entity) -> 422 with a clean message (no SQLITE/pg leak)", async () => {
    const backend = await managedBackend();

    const invalid = {
      entities: {
        notes: { fields: { title: { type: "text", required: true } }, permissions: {} },
        orphan: { fields: { noteId: { type: "ref", required: true, target: "doesNotExist" } }, permissions: {} },
      },
    };

    const res = await backend.fetch(postSchema(invalid, ADMIN));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("validation");
    expect(body.error.message).not.toMatch(/sqlite/i);
    expect(body.error.message).not.toMatch(/\bpg\b/i);
    expect(body.error.message).toMatch(/ref target/i);
  });

  it("malformed JSON body -> 422", async () => {
    const backend = await managedBackend();
    const res = await backend.fetch(
      new Request(`${BASE}/api/system/schema`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-frogcp-debug-identity": ADMIN },
        body: "{ not json",
      }),
    );
    expect(res.status).toBe(422);
  });

  it("ref reachability: a config exercising every field type + owner/role/or permissions round-trips through POST", async () => {
    const backend = await managedBackend();
    const richConfig = {
      entities: {
        notes: { fields: { title: { type: "text", required: true } }, permissions: {} },
        authors: {
          fields: {
            name: { type: "text", required: true },
            noteRef: { type: "ref", required: false, target: "notes" },
          },
          permissions: {
            read: { kind: "or", rules: [{ kind: "owner", field: "id" }, { kind: "role", role: "admin" }] },
          },
        },
      },
    };
    const res = await backend.fetch(postSchema(richConfig, ADMIN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { entities: Record<string, { permissions: Record<string, string> }> } };
    expect(body.data.entities.authors?.permissions.read).toBe("owner(id) OR role(admin)");
  });

  it("a REAL DDL failure during migration -> 422 migration_failed with a CURATED message and no raw driver text leaked", async () => {
    // A structurally valid config (passes deserializeConfig) whose migration
    // fails at DDL execution time, driven with the same adapter-exec injection
    // the managed-mode rollback test uses, but with an error message shaped like
    // a real driver error (constraint code + table/column name) so the test
    // meaningfully asserts none of it leaks into the response body.
    const real = nodeSqliteAdapter(":memory:");
    let armed = false;
    const adapter: DatabaseAdapter = {
      ...real,
      async exec(ddl: string): Promise<void> {
        if (armed && /^CREATE TABLE/i.test(ddl.trimStart()) && !ddl.includes("__frogcp")) {
          throw new Error('SQLITE_CONSTRAINT: NOT NULL constraint failed: tags.label');
        }
        return real.exec(ddl);
      },
    } as DatabaseAdapter;

    // Silence the deliberate server-side console.error for this expected path.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const backend = await createBackend({ config: notesConfig, adapter, mode: "managed", debugIdentity: true });

    armed = true;
    const res = await backend.fetch(postSchema(notesWithTags, ADMIN));
    armed = false;

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("migration_failed");
    // Curated message, and none of the raw driver text.
    expect(body.error.message).toMatch(/schema migration failed/i);
    expect(body.error.message).not.toMatch(/sqlite/i);
    expect(body.error.message).not.toMatch(/constraint/i);
    expect(body.error.message).not.toMatch(/tags\.label/i);
    // The raw error was logged server-side (for debugging), just not returned.
    expect(errorSpy).toHaveBeenCalled();

    // The old schema still works; the failed migration rolled back.
    const notesRes = await backend.fetch(req("/api/entity/notes", ADMIN));
    expect(notesRes.status).toBe(200);
  });
});

// The plugin-entity-collision regression: GET /api/system/schema returns the
// full merged entity map, including plugin-owned entities (e.g. frogcp/auth's
// "users"). Before this fix, a client that posted that same map back (natural
// for an admin UI) would 422 on every save, because applySchema re-merges plugin
// entities and throws on a name collision. A test-double plugin named "auth"
// contributing a "users" entity is used here (rather than importing the real
// frogcp/auth) to stay inside this package with no frogcp/auth workspace cycle,
// the same pattern managed-mode.test.ts uses.
describe("POST/GET /api/system/schema: plugin-owned entities are flagged and never collide", () => {
  function usersPlugin(): FrogPlugin {
    return {
      name: "auth",
      entities: resolveEntities({
        users: entity({ email: text().required() }).permissions(publicPerms),
      }),
    };
  }

  async function managedBackendWithUsersPlugin(): Promise<Backend> {
    const adapter: DatabaseAdapter = nodeSqliteAdapter(":memory:");
    return createBackend({
      config: notesConfig,
      adapter,
      mode: "managed",
      debugIdentity: true,
      plugins: [usersPlugin()],
    });
  }

  it("GET /api/system/schema flags the plugin's 'users' entity pluginOwned:true, and the user entity 'notes' pluginOwned:false", async () => {
    const backend = await managedBackendWithUsersPlugin();
    const res = await backend.fetch(req("/api/system/schema", ADMIN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { entities: Record<string, { pluginOwned: boolean }> } };
    expect(body.data.entities.users?.pluginOwned).toBe(true);
    expect(body.data.entities.notes?.pluginOwned).toBe(false);
  });

  it("adding a new user entity 'tags' -> 200, tags works, AND the plugin's 'users' entity still works (not dropped)", async () => {
    const backend = await managedBackendWithUsersPlugin();

    const res = await backend.fetch(postSchema(notesWithTags, ADMIN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { entities: Record<string, unknown> } };
    expect(Object.keys(body.data.entities).sort()).toEqual(["notes", "tags", "users"]);

    const tagsRes = await backend.fetch(req("/api/entity/tags", ADMIN));
    expect(tagsRes.status).toBe(200);
    const usersRes = await backend.fetch(req("/api/entity/users", ADMIN));
    expect(usersRes.status).toBe(200);
  });

  it("POSTing a config that INCLUDES the plugin's 'users' entity -> still 200 (the server strips it), never a 422 collision", async () => {
    const backend = await managedBackendWithUsersPlugin();

    // Exactly what a naive "post back everything GET returned" admin client
    // would build: the full merged map, users included.
    const bodyIncludingPluginEntity = {
      entities: {
        ...notesWithTags.entities,
        users: {
          fields: { email: { type: "text", required: true } },
          permissions: {
            create: { kind: "public" },
            read: { kind: "public" },
            list: { kind: "public" },
            update: { kind: "public" },
            delete: { kind: "public" },
          },
        },
      },
    };

    const res = await backend.fetch(postSchema(bodyIncludingPluginEntity, ADMIN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { entities: Record<string, unknown> } };
    expect(Object.keys(body.data.entities).sort()).toEqual(["notes", "tags", "users"]);

    // The plugin entity and the new user entity both still work.
    const tagsRes = await backend.fetch(req("/api/entity/tags", ADMIN));
    expect(tagsRes.status).toBe(200);
    const usersRes = await backend.fetch(req("/api/entity/users", ADMIN));
    expect(usersRes.status).toBe(200);
  });
});
