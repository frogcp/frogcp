import { describe, it, expect } from "vitest";
import { nodeSqliteAdapter } from "frogcp/adapter/node";
import { eq, getTableColumns } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import {
  createBackend,
  defineBackend,
  type Backend,
  type SqliteDatabaseAdapter,
  type FrogPlugin,
  type KernelContext,
} from "frogcp";
import { authEntities } from "../../src/auth/entities";
import { issueSession, type SessionConfig } from "../../src/auth/session";
import { makeIdentify } from "../../src/auth/identify";

const CFG: SessionConfig = {
  secret: "test-secret-at-least-32-bytes-long!!",
  ttlSeconds: 3600,
  cookieName: "frogcp_session",
};

function bearerReq(path: string, token?: string): Request {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request(`http://x${path}`, { headers });
}

/** Boots a bare backend with only the auth entities merged in, and hands back
 * the full `KernelContext` (captured via a boot-only plugin) alongside the
 * adapter for direct row manipulation, mirrors how a later `authPlugin()`
 * would capture its own `KernelContext` at boot to close over for `identify`. */
async function setup(): Promise<{ backend: Backend; adapter: SqliteDatabaseAdapter; kernelCtx: KernelContext }> {
  const adapter = nodeSqliteAdapter(":memory:");
  let kernelCtx: KernelContext | undefined;
  const authEntitiesPlugin: FrogPlugin = { name: "auth-entities", entities: authEntities };
  const capturePlugin: FrogPlugin = {
    name: "capture",
    onBoot(ctx) {
      kernelCtx = ctx;
    },
  };
  const backend = await createBackend({
    config: defineBackend({ entities: {} }),
    adapter,
    plugins: [authEntitiesPlugin, capturePlugin],
  });
  if (!kernelCtx) throw new Error("unreachable: onBoot always runs before createBackend resolves");
  return { backend, adapter, kernelCtx };
}

/** `CompiledTables` is `Record<string, SQLiteTable>`, so `tables.users` is
 * typed as possibly-`undefined` with no named columns, this package's own
 * entities guarantee it exists and has `id`/`role`, so tests fetch it once
 * through this small helper rather than repeating the same non-null
 * assertion + column lookup at every call site. */
function usersTable(kernelCtx: KernelContext): SQLiteTable {
  const table = kernelCtx.tables.users;
  if (!table) throw new Error("unreachable: authEntities always defines a users table");
  return table;
}

function usersIdColumn(kernelCtx: KernelContext) {
  const col = getTableColumns(usersTable(kernelCtx)).id;
  if (!col) throw new Error("unreachable: users table always has an id column");
  return col;
}

async function insertUser(
  adapter: SqliteDatabaseAdapter,
  kernelCtx: KernelContext,
  fields: { id: string; email: string; role?: string },
): Promise<void> {
  await adapter.db.insert(usersTable(kernelCtx)).values({
    id: fields.id,
    email: fields.email,
    passwordHash: "unused-in-this-test",
    name: "Someone",
    role: fields.role ?? "member",
    createdAt: new Date(),
  });
}

describe("makeIdentify", () => {
  it("round-trips: a valid session resolves to { userId, role } read fresh from the DB", async () => {
    const { adapter, kernelCtx } = await setup();
    await insertUser(adapter, kernelCtx, { id: "u1", email: "u1@example.com", role: "member" });
    const { token } = await issueSession(CFG, "u1");

    const identify = makeIdentify(CFG, kernelCtx);
    const ctx = await identify(bearerReq("/", token));
    expect(ctx).toEqual({ userId: "u1", role: "member" });
  });

  it("an invalid/garbage token resolves to null (guest)", async () => {
    const { kernelCtx } = await setup();
    const identify = makeIdentify(CFG, kernelCtx);
    expect(await identify(bearerReq("/", "garbage.not.a.jwt"))).toBeNull();
    expect(await identify(bearerReq("/"))).toBeNull(); // no token at all
  });

  it("an expired session resolves to null (guest)", async () => {
    const { adapter, kernelCtx } = await setup();
    await insertUser(adapter, kernelCtx, { id: "u2", email: "u2@example.com" });
    const { token } = await issueSession({ ...CFG, ttlSeconds: -1 }, "u2");

    const identify = makeIdentify(CFG, kernelCtx);
    expect(await identify(bearerReq("/", token))).toBeNull();
  });

  it("a deleted user resolves to null even though the JWT itself is still valid", async () => {
    const { adapter, kernelCtx } = await setup();
    await insertUser(adapter, kernelCtx, { id: "u3", email: "u3@example.com" });
    const { token } = await issueSession(CFG, "u3");

    await adapter.db.delete(usersTable(kernelCtx)).where(eq(usersIdColumn(kernelCtx), "u3"));

    const identify = makeIdentify(CFG, kernelCtx);
    expect(await identify(bearerReq("/", token))).toBeNull();
  });

  it("a role changed directly in the DB takes effect on the very next identify call", async () => {
    const { adapter, kernelCtx } = await setup();
    await insertUser(adapter, kernelCtx, { id: "u4", email: "u4@example.com", role: "member" });
    const { token } = await issueSession(CFG, "u4");
    const identify = makeIdentify(CFG, kernelCtx);

    expect(await identify(bearerReq("/", token))).toEqual({ userId: "u4", role: "member" });

    await adapter.db
      .update(usersTable(kernelCtx))
      .set({ role: "admin" })
      .where(eq(usersIdColumn(kernelCtx), "u4"));

    expect(await identify(bearerReq("/", token))).toEqual({ userId: "u4", role: "admin" });
  });
});

describe("identify wired as a FrogPlugin, end to end through backend.fetch", () => {
  /** A minimal plugin shape a later `authPlugin()` will implement for real:
   * capture the `KernelContext` at boot, then delegate every request's
   * `identify` to `makeIdentify` closed over that captured context. */
  function jwtSessionPlugin(cfg: SessionConfig): FrogPlugin {
    let identifyFn: ((req: Request) => Promise<import("frogcp").Ctx>) | undefined;
    return {
      name: "jwt-session",
      entities: authEntities,
      onBoot(ctx) {
        identifyFn = makeIdentify(cfg, ctx);
      },
      identify: (req) => (identifyFn ? identifyFn(req) : null),
    };
  }

  async function setupPluginBackend(): Promise<{ backend: Backend; adapter: SqliteDatabaseAdapter; kernelCtx: KernelContext }> {
    const adapter = nodeSqliteAdapter(":memory:");
    let kernelCtx: KernelContext | undefined;
    const capturePlugin: FrogPlugin = {
      name: "capture",
      onBoot(ctx) {
        kernelCtx = ctx;
      },
    };
    const backend = await createBackend({
      config: defineBackend({ entities: {} }),
      adapter,
      plugins: [jwtSessionPlugin(CFG), capturePlugin],
    });
    if (!kernelCtx) throw new Error("unreachable: onBoot always runs before createBackend resolves");
    return { backend, adapter, kernelCtx };
  }

  it("an authenticated request (bearer token) can read its own users row (owner-ruled entity)", async () => {
    const { backend, adapter, kernelCtx } = await setupPluginBackend();
    await insertUser(adapter, kernelCtx, { id: "alice", email: "alice@example.com" });
    const { token } = await issueSession(CFG, "alice");

    const res = await backend.fetch(bearerReq("/api/entity/users/alice", token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; email: string } };
    expect(body.data.email).toBe("alice@example.com");
  });

  it("an authenticated request can PATCH its own users row but not another user's", async () => {
    const { backend, adapter, kernelCtx } = await setupPluginBackend();
    await insertUser(adapter, kernelCtx, { id: "alice2", email: "alice2@example.com" });
    await insertUser(adapter, kernelCtx, { id: "bob2", email: "bob2@example.com" });
    const { token } = await issueSession(CFG, "alice2");

    const ownPatch = await backend.fetch(
      new Request("http://x/api/entity/users/alice2", {
        method: "PATCH",
        body: JSON.stringify({ name: "Alice Updated" }),
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      }),
    );
    expect(ownPatch.status).toBe(200);

    const otherPatch = await backend.fetch(
      new Request("http://x/api/entity/users/bob2", {
        method: "PATCH",
        body: JSON.stringify({ name: "Hijacked" }),
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      }),
    );
    expect(otherPatch.status).toBe(404); // not yours -> no existence oracle
  });

  it("no auth at all resolves to guest -> 403 reading an owner-ruled row", async () => {
    const { backend, adapter, kernelCtx } = await setupPluginBackend();
    await insertUser(adapter, kernelCtx, { id: "carol", email: "carol@example.com" });

    const res = await backend.fetch(new Request("http://x/api/entity/users/carol"));
    expect(res.status).toBe(403);
  });

  it("an invalid bearer token resolves to guest -> 403, same as no auth", async () => {
    const { backend, adapter, kernelCtx } = await setupPluginBackend();
    await insertUser(adapter, kernelCtx, { id: "dave", email: "dave@example.com" });

    const res = await backend.fetch(bearerReq("/api/entity/users/dave", "not-a-real-token"));
    expect(res.status).toBe(403);
  });
});
