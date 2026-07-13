import { describe, expect, it } from "vitest";
import { nodeSqliteAdapter } from "frogcp/adapter/node";
import { createBackend, defineBackend, entity, rule, text, type Backend } from "frogcp";
import { createClient, FrogClientError } from "../../src/client/index";

const BASE = "http://x";
const ADMIN_HEADERS = { "x-frogcp-debug-identity": "admin-1:admin" };

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

async function managedBackend(): Promise<Backend> {
  const adapter = nodeSqliteAdapter(":memory:");
  return createBackend({ config: notesConfig, adapter, mode: "managed", debugIdentity: true });
}

describe("frogcp/client: schema", () => {
  it("client.schema.get() returns mode and the current entities", async () => {
    const backend = await managedBackend();
    const client = createClient(BASE, { fetch: backend.fetch, headers: ADMIN_HEADERS });

    const res = await client.schema.get();
    expect(res.mode).toBe("managed");
    expect(Object.keys(res.data.entities)).toEqual(["notes"]);
  });

  it("a code-mode backend reports mode: code", async () => {
    const adapter = nodeSqliteAdapter(":memory:");
    const backend = await createBackend({ config: notesConfig, adapter, debugIdentity: true });
    const client = createClient(BASE, { fetch: backend.fetch, headers: ADMIN_HEADERS });

    const res = await client.schema.get();
    expect(res.mode).toBe("code");
  });

  it("client.schema.update() adds an entity end-to-end through a managed backend.fetch, then it's immediately usable", async () => {
    const backend = await managedBackend();
    const client = createClient(BASE, { fetch: backend.fetch, headers: ADMIN_HEADERS });

    const updated = await client.schema.update({
      entities: {
        notes: { fields: { title: { type: "text", required: true } }, permissions: {} },
        tags: { fields: { label: { type: "text", required: true } }, permissions: publicRuleExprs() },
      },
    });

    expect(updated.mode).toBe("managed");
    expect(Object.keys(updated.data.entities).sort()).toEqual(["notes", "tags"]);

    const created = await client.entity("tags").create({ label: "urgent" });
    expect((created as { label: string }).label).toBe("urgent");
  });

  it("a non-admin caller's client.schema.get() rejects with a 403 FrogClientError", async () => {
    const backend = await managedBackend();
    const client = createClient(BASE, { fetch: backend.fetch, headers: { "x-frogcp-debug-identity": "member-1:member" } });

    const err = await client.schema.get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FrogClientError);
    expect((err as FrogClientError).status).toBe(403);
  });

  it("client.schema.update() against a code-mode backend rejects with a 409 FrogClientError", async () => {
    const adapter = nodeSqliteAdapter(":memory:");
    const backend = await createBackend({ config: notesConfig, adapter, debugIdentity: true });
    const client = createClient(BASE, { fetch: backend.fetch, headers: ADMIN_HEADERS });

    const err = await client.schema
      .update({ entities: { notes: { fields: { title: { type: "text", required: true } }, permissions: {} } } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FrogClientError);
    expect((err as FrogClientError).status).toBe(409);
  });
});

function publicRuleExprs(): Record<string, { kind: "public" }> {
  return {
    create: { kind: "public" },
    read: { kind: "public" },
    list: { kind: "public" },
    update: { kind: "public" },
    delete: { kind: "public" },
  };
}
