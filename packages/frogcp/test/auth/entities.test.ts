import { describe, it, expect } from "vitest";
import { nodeSqliteAdapter } from "frogcp/adapter/node";
import { sql } from "drizzle-orm";
import {
  createBackend,
  defineBackend,
  type Backend,
  type SqliteDatabaseAdapter,
  type FrogPlugin,
} from "frogcp";
import { authEntities } from "../../src/auth/entities";

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

async function setup(): Promise<{ backend: Backend; adapter: SqliteDatabaseAdapter }> {
  const adapter = nodeSqliteAdapter(":memory:");
  const authPlugin: FrogPlugin = { name: "auth-entities", entities: authEntities };
  const backend = await createBackend({
    config: defineBackend({ entities: {} }),
    adapter,
    debugIdentity: true,
    plugins: [authPlugin],
  });
  return { backend, adapter };
}

async function createUser(
  backend: Backend,
  overrides: { email: string; name?: string },
): Promise<{ id: string; body: Record<string, unknown> }> {
  const res = await backend.fetch(
    postJson(
      "/api/entity/users",
      { email: overrides.email, name: overrides.name ?? "Someone", passwordHash: "should-be-dropped" },
      ADMIN,
    ),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { data: Record<string, unknown> };
  return { id: body.data.id as string, body: body.data };
}

describe("frogcp/auth entities", () => {
  it("the merged config accepts users + oauthAccounts and boots cleanly", async () => {
    const { backend } = await setup();
    const res = await backend.fetch(req("/api/entity/users", { identity: ADMIN }));
    // Booting + a basic authenticated list call both succeed (no 404/500).
    expect(res.status).toBe(200);
  });

  it("create is admin-only (default-deny): a non-admin member cannot create a user", async () => {
    const { backend } = await setup();
    const res = await backend.fetch(
      postJson("/api/entity/users", { email: "self-signup@example.com" }, "some-member:member"),
    );
    expect(res.status).toBe(403);
  });

  it("admin can create users; role defaults to \"member\" and createdAt is auto-stamped", async () => {
    const { backend } = await setup();
    const { body } = await createUser(backend, { email: "alice@example.com", name: "Alice" });
    expect(body.role).toBe("member");
    expect(body.createdAt).toBeTruthy();
    expect(body.email).toBe("alice@example.com");
  });

  it("passwordHash is never present in the create response, even though it was in the payload", async () => {
    const { backend } = await setup();
    const { body } = await createUser(backend, { email: "hidden@example.com" });
    expect("passwordHash" in body).toBe(false);
  });

  it("passwordHash never appears in a read/list response, even when set directly at the DB layer", async () => {
    const { backend, adapter } = await setup();
    const { id } = await createUser(backend, { email: "carrier@example.com" });

    // Simulate what a password-setting code path (arriving in a later task)
    // would do: write passwordHash directly via privileged direct-DB access,
    // bypassing the REST insert schema (which excludes hidden fields
    // entirely), the same pattern frogcp's own hidden-field tests use.
    await adapter.db.run(sql`UPDATE users SET passwordHash = ${"top-secret-hash"} WHERE id = ${id}`);

    const readRes = await backend.fetch(req(`/api/entity/users/${id}`, { identity: ADMIN }));
    expect(readRes.status).toBe(200);
    const read = (await readRes.json()) as { data: Record<string, unknown> };
    expect("passwordHash" in read.data).toBe(false);

    const listRes = await backend.fetch(req("/api/entity/users", { identity: ADMIN }));
    const list = (await listRes.json()) as { data: Record<string, unknown>[] };
    expect(list.data.every((row) => !("passwordHash" in row))).toBe(true);
  });

  it("owner(\"id\") self-service: a user can read their own row but not another user's", async () => {
    const { backend } = await setup();
    const { id: aliceId } = await createUser(backend, { email: "alice2@example.com", name: "Alice" });
    const { id: bobId } = await createUser(backend, { email: "bob@example.com", name: "Bob" });
    const alice = `${aliceId}:member`;

    const ownRes = await backend.fetch(req(`/api/entity/users/${aliceId}`, { identity: alice }));
    expect(ownRes.status).toBe(200);
    const own = (await ownRes.json()) as { data: { email: string } };
    expect(own.data.email).toBe("alice2@example.com");

    // Not yours -> 404 (no existence oracle for row-scoped denials).
    const otherRes = await backend.fetch(req(`/api/entity/users/${bobId}`, { identity: alice }));
    expect(otherRes.status).toBe(404);
    const otherBody = (await otherRes.json()) as { error: { code: string } };
    expect(otherBody.error.code).toBe("not_found");
  });

  it("owner(\"id\") self-service: a user can update their own row but not another user's", async () => {
    const { backend } = await setup();
    const { id: aliceId } = await createUser(backend, { email: "alice3@example.com", name: "Alice" });
    const { id: bobId } = await createUser(backend, { email: "bob2@example.com", name: "Bob" });
    const alice = `${aliceId}:member`;

    const ownPatch = await backend.fetch(
      req(`/api/entity/users/${aliceId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "Alice Updated" }),
        headers: { "content-type": "application/json" },
        identity: alice,
      }),
    );
    expect(ownPatch.status).toBe(200);

    const otherPatch = await backend.fetch(
      req(`/api/entity/users/${bobId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "Hijacked" }),
        headers: { "content-type": "application/json" },
        identity: alice,
      }),
    );
    expect(otherPatch.status).toBe(404);
  });

  it("list/delete are admin-only (no rule declared): a member cannot list or delete users", async () => {
    const { backend } = await setup();
    const { id: aliceId } = await createUser(backend, { email: "alice4@example.com", name: "Alice" });
    const alice = `${aliceId}:member`;

    const listRes = await backend.fetch(req("/api/entity/users", { identity: alice }));
    expect(listRes.status).toBe(403);

    const deleteRes = await backend.fetch(req(`/api/entity/users/${aliceId}`, { method: "DELETE", identity: alice }));
    expect(deleteRes.status).toBe(403);
  });

  it("role escalation is closed: a member PATCHing their own role to \"admin\" gets a 422 and the DB is untouched", async () => {
    const { backend, adapter } = await setup();
    const { id: malloryId } = await createUser(backend, { email: "mallory@example.com", name: "Mallory" });
    const mallory = `${malloryId}:member`;

    const res = await backend.fetch(
      req(`/api/entity/users/${malloryId}`, {
        method: "PATCH",
        body: JSON.stringify({ role: "admin" }),
        headers: { "content-type": "application/json" },
        identity: mallory,
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("validation");
    expect(body.error.message).toBe('"role" is server-managed');

    // The role is genuinely unchanged at the DB layer, not just in the response.
    const rows = await adapter.db.all<{ role: string }>(
      sql`SELECT role FROM users WHERE id = ${malloryId}`,
    );
    expect(rows[0]?.role).toBe("member");
  });

  it("a member resubmitting their CURRENT role alongside a real change is a harmless no-op", async () => {
    const { backend } = await setup();
    const { id } = await createUser(backend, { email: "benign@example.com", name: "Benign" });

    const res = await backend.fetch(
      req(`/api/entity/users/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "Renamed", role: "member" }),
        headers: { "content-type": "application/json" },
        identity: `${id}:member`,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { name: string; role: string } };
    expect(body.data.name).toBe("Renamed");
    expect(body.data.role).toBe("member");
  });

  it("admin may change a user's role, and role stays visible in read responses", async () => {
    const { backend } = await setup();
    const { id } = await createUser(backend, { email: "promotee@example.com", name: "Promotee" });

    const patchRes = await backend.fetch(
      req(`/api/entity/users/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ role: "admin" }),
        headers: { "content-type": "application/json" },
        identity: ADMIN,
      }),
    );
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { data: { role: string } };
    expect(patched.data.role).toBe("admin");

    // readonly (unlike hidden) stays visible, the promoted user can see
    // their own role on a self-read.
    const readRes = await backend.fetch(req(`/api/entity/users/${id}`, { identity: `${id}:admin` }));
    const read = (await readRes.json()) as { data: { role: string } };
    expect(read.data.role).toBe("admin");
  });

  it("duplicate email on create is a clean 409 conflict", async () => {
    const { backend } = await setup();
    await createUser(backend, { email: "dupe@example.com" });

    const res = await backend.fetch(postJson("/api/entity/users", { email: "dupe@example.com" }, ADMIN));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("conflict");
  });

  it("oauthAccounts links to users with cascade delete and has no non-admin permissions", async () => {
    const { backend } = await setup();
    const { id: userId } = await createUser(backend, { email: "oauth@example.com" });

    const createRes = await backend.fetch(
      postJson("/api/entity/oauthAccounts", { provider: "github", subject: "gh-123", user: userId }, ADMIN),
    );
    expect(createRes.status).toBe(201);

    // No rule declared for any action -> default-deny for non-admins.
    const memberRes = await backend.fetch(
      postJson("/api/entity/oauthAccounts", { provider: "github", subject: "gh-456", user: userId }, `${userId}:member`),
    );
    expect(memberRes.status).toBe(403);

    // Deleting the user cascades to the linked oauthAccounts row.
    const deleteUserRes = await backend.fetch(req(`/api/entity/users/${userId}`, { method: "DELETE", identity: ADMIN }));
    expect(deleteUserRes.status).toBe(204);

    const listRes = await backend.fetch(req("/api/entity/oauthAccounts", { identity: ADMIN }));
    const list = (await listRes.json()) as { data: { user: string }[] };
    expect(list.data.some((r) => r.user === userId)).toBe(false);
  });
});
