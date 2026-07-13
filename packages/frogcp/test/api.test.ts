import { describe, it, expect } from "vitest";
import { nodeSqliteAdapter } from "frogcp/adapter/node";
import {
  createBackend,
  defineBackend,
  entity,
  text,
  number,
  select,
  ref,
  timestamp,
  rule,
  type DatabaseAdapter,
  type Backend,
} from "../src/index";

const config = defineBackend({
  entities: {
    users: entity({
      name: text().required(),
    }).permissions({
      // Self-ownership: a member's Identity.userId is the row's own id, so
      // owner("id") lets a user read their own row.
      read: rule.owner("id"),
    }),
    notes: entity({
      title: text().required(),
      owner: ref("users").required(),
      reviewer: ref("users"),
      status: select(["draft", "published", "archived"]).default("draft"),
      priority: number(),
      // Hidden field: never returned, and must not be usable in filter/sort
      // (that would leak its value via the result set).
      secret: text().hidden(),
      createdAt: timestamp().auto(),
    }).permissions({
      create: rule.authenticated(),
      read: rule.owner("owner"),
      list: rule.owner("owner"),
      update: rule.owner("owner"),
      delete: rule.owner("owner"),
    }),
  },
});

const BASE = "http://x";
const ADMIN = "admin-seed:admin";

function req(path: string, init: RequestInit & { identity?: string } = {}): Request {
  const { identity, headers, ...rest } = init;
  const h = new Headers(headers);
  if (identity) h.set("x-frogcp-debug-identity", identity);
  return new Request(`${BASE}${path}`, { ...rest, headers: h });
}

function postJson(path: string, body: unknown, identity?: string): Request {
  return req(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    ...(identity !== undefined ? { identity } : {}),
  });
}

async function setup(): Promise<{ backend: Backend }> {
  const adapter: DatabaseAdapter = nodeSqliteAdapter(":memory:");
  const backend = await createBackend({ config, adapter, debugIdentity: true });
  return { backend };
}

async function createUser(backend: Backend, name: string): Promise<string> {
  const res = await backend.fetch(postJson("/api/entity/users", { name }, ADMIN));
  const body = (await res.json()) as { data: { id: string } };
  return body.data.id;
}

describe("REST API (createBackend)", () => {
  it("full CRUD round-trip as a member: create, read, patch, delete, read 404", async () => {
    const { backend } = await setup();
    const aliceId = await createUser(backend, "Alice");
    const alice = `${aliceId}:member`;

    const createRes = await backend.fetch(postJson("/api/entity/notes", { title: "hello" }, alice));
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { data: { id: string; title: string } };
    expect(created.data.title).toBe("hello");
    const id = created.data.id;

    const readRes = await backend.fetch(req(`/api/entity/notes/${id}`, { identity: alice }));
    expect(readRes.status).toBe(200);
    const read = (await readRes.json()) as { data: { title: string } };
    expect(read.data.title).toBe("hello");

    const patchRes = await backend.fetch(
      req(`/api/entity/notes/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: "updated" }),
        headers: { "content-type": "application/json" },
        identity: alice,
      }),
    );
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { data: { title: string } };
    expect(patched.data.title).toBe("updated");

    const deleteRes = await backend.fetch(req(`/api/entity/notes/${id}`, { method: "DELETE", identity: alice }));
    expect(deleteRes.status).toBe(204);
    expect(await deleteRes.text()).toBe("");

    const reReadRes = await backend.fetch(req(`/api/entity/notes/${id}`, { identity: alice }));
    expect(reReadRes.status).toBe(404);
    const reReadBody = (await reReadRes.json()) as { error: { code: string } };
    expect(reReadBody.error.code).toBe("not_found");
  });

  it("list filter+sort+pagination under row scope: meta.total reflects only caller-visible rows", async () => {
    const { backend } = await setup();
    const aliceId = await createUser(backend, "Alice");
    const bobId = await createUser(backend, "Bob");
    const alice = `${aliceId}:member`;
    const bob = `${bobId}:member`;

    await backend.fetch(postJson("/api/entity/notes", { title: "zeta", status: "published" }, alice));
    await backend.fetch(postJson("/api/entity/notes", { title: "alpha", status: "published" }, alice));
    await backend.fetch(postJson("/api/entity/notes", { title: "middle", status: "draft" }, alice));
    // noise owned by bob, must never leak into alice's meta.total or data
    await backend.fetch(postJson("/api/entity/notes", { title: "bob-note", status: "published" }, bob));

    const listRes = await backend.fetch(
      req("/api/entity/notes?filter[status]=published&sort=-title&limit=1&offset=0", { identity: alice }),
    );
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      data: { title: string }[];
      meta: { total: number; limit: number; offset: number };
    };
    expect(list.data.map((r) => r.title)).toEqual(["zeta"]);
    expect(list.meta.total).toBe(2);
    expect(list.meta.limit).toBe(1);
    expect(list.meta.offset).toBe(0);
  });

  it("filter[priority][gte] coerces to a number; filtering on an unknown field is a 422 envelope", async () => {
    const { backend } = await setup();
    const aliceId = await createUser(backend, "Alice");
    const alice = `${aliceId}:member`;

    for (const priority of [1, 5, 9]) {
      await backend.fetch(postJson("/api/entity/notes", { title: `p${priority}`, priority }, alice));
    }

    const gteRes = await backend.fetch(req("/api/entity/notes?filter[priority][gte]=5", { identity: alice }));
    expect(gteRes.status).toBe(200);
    const gte = (await gteRes.json()) as { data: { title: string }[] };
    expect(gte.data.map((r) => r.title).sort()).toEqual(["p5", "p9"]);

    const badRes = await backend.fetch(req("/api/entity/notes?filter[bogus]=x", { identity: alice }));
    expect(badRes.status).toBe(422);
    const bad = (await badRes.json()) as { error: { code: string } };
    expect(bad.error.code).toBe("validation");
  });

  it("a hidden field is 422 (indistinguishable from unknown) in filter and sort, no value oracle", async () => {
    const { backend } = await setup();
    const aliceId = await createUser(backend, "Alice");
    const alice = `${aliceId}:member`;

    // notes.secret is .hidden(): using it in a filter or sort is rejected
    // exactly like an unknown field (same 422/validation envelope), so an
    // attacker cannot learn that secret exists nor extract its value via a
    // prefix/ordering oracle over the returned rows.
    const filterRes = await backend.fetch(req("/api/entity/notes?filter[secret]=abc", { identity: alice }));
    expect(filterRes.status).toBe(422);
    expect(((await filterRes.json()) as { error: { code: string } }).error.code).toBe("validation");

    const sortRes = await backend.fetch(req("/api/entity/notes?sort=secret", { identity: alice }));
    expect(sortRes.status).toBe(422);
    expect(((await sortRes.json()) as { error: { code: string } }).error.code).toBe("validation");
  });

  it("filter[priority][gte]+[lte] range and an empty filter value are both handled cleanly", async () => {
    const { backend } = await setup();
    const aliceId = await createUser(backend, "Alice");
    const alice = `${aliceId}:member`;

    for (const priority of [1, 5, 9]) {
      await backend.fetch(postJson("/api/entity/notes", { title: `p${priority}`, priority }, alice));
    }

    const rangeRes = await backend.fetch(
      req("/api/entity/notes?filter[priority][gte]=2&filter[priority][lte]=5", { identity: alice }),
    );
    expect(rangeRes.status).toBe(200);
    const range = (await rangeRes.json()) as { data: { title: string }[] };
    expect(range.data.map((r) => r.title)).toEqual(["p5"]);

    const emptyRes = await backend.fetch(req("/api/entity/notes?filter[priority]=", { identity: alice }));
    expect(emptyRes.status).toBe(422);
    const empty = (await emptyRes.json()) as { error: { code: string } };
    expect(empty.error.code).toBe("validation");
  });

  it("a create with a dangling ref is a clean 422 envelope; deleting a referenced row is a clean 409", async () => {
    const { backend } = await setup();
    const aliceId = await createUser(backend, "Alice");

    const danglingRes = await backend.fetch(
      postJson("/api/entity/notes", { title: "ghost", owner: "00000000-0000-0000-0000-000000000000" }, ADMIN),
    );
    expect(danglingRes.status).toBe(422);
    const dangling = (await danglingRes.json()) as { error: { code: string } };
    expect(dangling.error.code).toBe("validation");

    await backend.fetch(postJson("/api/entity/notes", { title: "keeps-alice-alive", owner: aliceId }, ADMIN));
    const deleteRes = await backend.fetch(req(`/api/entity/users/${aliceId}`, { method: "DELETE", identity: ADMIN }));
    expect(deleteRes.status).toBe(409);
    const deleteBody = (await deleteRes.json()) as { error: { code: string } };
    expect(deleteBody.error.code).toBe("conflict");
  });

  it("reading a foreign row is a 404 not_found envelope (not a 403)", async () => {
    const { backend } = await setup();
    const aliceId = await createUser(backend, "Alice");
    const bobId = await createUser(backend, "Bob");

    const createRes = await backend.fetch(postJson("/api/entity/notes", { title: "bob-secret", owner: bobId }, ADMIN));
    const created = (await createRes.json()) as { data: { id: string } };

    const readRes = await backend.fetch(
      req(`/api/entity/notes/${created.data.id}`, { identity: `${aliceId}:member` }),
    );
    expect(readRes.status).toBe(404);
    const body = (await readRes.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("not_found");
    expect(typeof body.error.message).toBe("string");
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it("guest POST is a 403 envelope; an invalid payload is a 422 envelope with the zod first-issue message", async () => {
    const { backend } = await setup();
    const aliceId = await createUser(backend, "Alice");

    const guestRes = await backend.fetch(postJson("/api/entity/notes", { title: "nope", owner: aliceId }));
    expect(guestRes.status).toBe(403);
    const guestBody = (await guestRes.json()) as { error: { code: string } };
    expect(guestBody.error.code).toBe("forbidden");

    const invalidRes = await backend.fetch(postJson("/api/entity/notes", {}, `${aliceId}:member`));
    expect(invalidRes.status).toBe(422);
    const invalidBody = (await invalidRes.json()) as { error: { code: string; message: string } };
    expect(invalidBody.error.code).toBe("validation");
    expect(invalidBody.error.message.startsWith("[")).toBe(false);
    expect(invalidBody.error.message.length).toBeGreaterThan(0);
  });

  it("malformed JSON body is 422; an unknown route is a 404 envelope; health check returns { ok: true }", async () => {
    const { backend } = await setup();
    const aliceId = await createUser(backend, "Alice");

    const malformedRes = await backend.fetch(
      req("/api/entity/notes", {
        method: "POST",
        body: "{not-json",
        headers: { "content-type": "application/json" },
        identity: `${aliceId}:member`,
      }),
    );
    expect(malformedRes.status).toBe(422);
    const malformedBody = (await malformedRes.json()) as { error: { code: string } };
    expect(malformedBody.error.code).toBe("validation");

    const notFoundRes = await backend.fetch(req("/api/does-not-exist"));
    expect(notFoundRes.status).toBe(404);
    const notFoundBody = (await notFoundRes.json()) as { error: { code: string } };
    expect(notFoundBody.error.code).toBe("not_found");

    const healthRes = await backend.fetch(req("/api/system/health"));
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toEqual({ ok: true });
  });

  it("/api/system/schema: guest 403, admin 200 with a JSON-safe entities summary", async () => {
    const { backend } = await setup();

    const guestRes = await backend.fetch(req("/api/system/schema"));
    expect(guestRes.status).toBe(403);
    const guestBody = (await guestRes.json()) as { error: { code: string } };
    expect(guestBody.error.code).toBe("forbidden");

    const adminRes = await backend.fetch(req("/api/system/schema", { identity: ADMIN }));
    expect(adminRes.status).toBe(200);
    const raw = await adminRes.text();
    expect(raw.includes("[object")).toBe(false);
    const body = JSON.parse(raw) as {
      data: {
        entities: Record<
          string,
          { fields: Record<string, { type: string }>; permissions: Record<string, string> }
        >;
      };
    };
    expect(body.data.entities.notes).toBeDefined();
    expect(body.data.entities.notes?.fields.title?.type).toBe("text");
    expect(body.data.entities.notes?.permissions.create).toBeDefined();
  });

  it("with=owner expand is present in the GET response", async () => {
    const { backend } = await setup();
    const aliceId = await createUser(backend, "Alice");
    const alice = `${aliceId}:member`;

    const createRes = await backend.fetch(postJson("/api/entity/notes", { title: "with-owner" }, alice));
    const created = (await createRes.json()) as { data: { id: string } };

    const readRes = await backend.fetch(
      req(`/api/entity/notes/${created.data.id}?with=owner`, { identity: alice }),
    );
    expect(readRes.status).toBe(200);
    const body = (await readRes.json()) as { data: { expand?: { owner: { id: string; name: string } | null } } };
    expect(body.data.expand).toBeDefined();
    expect(body.data.expand?.owner).toMatchObject({ id: aliceId, name: "Alice" });
  });

  it("debugIdentity disabled by default: the debug header is ignored and the request stays guest", async () => {
    const adapter: DatabaseAdapter = nodeSqliteAdapter(":memory:");
    const backend = await createBackend({ config, adapter }); // debugIdentity omitted, defaults to false

    const res = await backend.fetch(req("/api/entity/notes", { identity: "someone:admin" }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });
});
