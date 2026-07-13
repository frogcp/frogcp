import { describe, it, expect } from "vitest";
import { nodeSqliteAdapter } from "frogcp/adapter/node";
import {
  createBackend,
  defineBackend,
  entity,
  ref,
  rule,
  text,
  type Backend,
  type DatabaseAdapter,
  type DataEventPayload,
} from "frogcp";
import { authPlugin } from "../../src/auth/index";

const BASE = "http://x";
const TEST_SECRET = "test-secret-at-least-32-bytes-long!!";

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`${BASE}${path}`, init);
}

function jsonReq(method: string, path: string, body: unknown, extraHeaders: Record<string, string> = {}): Request {
  return req(path, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

/** Pulls the `name=value` pair out of a `Set-Cookie` response header (dropping
 * the `HttpOnly`/`Path`/... attributes), ready to hand back as a request's
 * `Cookie` header, mirrors what a real browser round-trip would send. */
function cookieFromSetHeader(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("expected a Set-Cookie header on this response");
  const pair = setCookie.split(";")[0];
  if (!pair) throw new Error("malformed Set-Cookie header");
  return pair;
}

// An owner-ruled application entity (same self-service pattern frogcp's own
// tests use for `notes`/`owner: ref("users")`), proves `authPlugin`'s
// `identify` genuinely feeds the permission engine, not just the auth
// entities' own owner("id") rule.
const postsConfig = defineBackend({
  entities: {
    posts: entity({
      title: text().required(),
      owner: ref("users").required(),
    }).permissions({
      create: rule.authenticated(),
      read: rule.owner("owner"),
      list: rule.owner("owner"),
      update: rule.owner("owner"),
      delete: rule.owner("owner"),
    }),
  },
});

async function setup(): Promise<{ backend: Backend; adapter: DatabaseAdapter }> {
  const adapter: DatabaseAdapter = nodeSqliteAdapter(":memory:");
  const backend = await createBackend({
    config: postsConfig,
    adapter,
    // Deliberately no `debugIdentity`, every authenticated request in this
    // file goes through a REAL session cookie/bearer token issued by the
    // plugin's own register/login routes.
    plugins: [authPlugin({ secret: TEST_SECRET })],
  });
  return { backend, adapter };
}

describe("authPlugin construction", () => {
  it("throws synchronously when secret is shorter than 32 characters", () => {
    expect(() => authPlugin({ secret: "too-short" })).toThrow(/32/);
  });

  it("accepts a secret exactly 32 characters long", () => {
    expect(() => authPlugin({ secret: "x".repeat(32) })).not.toThrow();
  });
});

describe("authPlugin: dialect guard fires at boot, not per-request", () => {
  it("createBackend rejects immediately when the adapter's dialect is not \"sqlite\"", async () => {
    // A minimal stub, not a real `frogcp/adapter/postgres` connection:
    // `authPlugin`'s `onBoot` guard reads only `adapter.dialect`, so a stub
    // that declares `dialect: "postgres"` and never gets its `db`/`exec`
    // actually called (this rejects during `onBoot`, before any query runs)
    // is an honest, sufficient double for this test, and keeps `frogcp/auth`
    // from needing a `pg`-backed devDependency just to prove this guard.
    const stubPostgresAdapter = {
      dialect: "postgres",
      db: undefined,
      exec: async () => {
        throw new Error("unreachable: onBoot's dialect guard must reject before any query runs");
      },
    } as unknown as DatabaseAdapter;

    await expect(
      createBackend({
        config: defineBackend({ entities: {} }),
        adapter: stubPostgresAdapter,
        // Skip migration entirely, this test is only about the boot-time
        // dialect guard firing before the backend is usable, not about
        // actually migrating a (nonexistent) Postgres connection.
        migrate: false,
        plugins: [authPlugin({ secret: TEST_SECRET })],
      }),
    ).rejects.toThrow(/frogcp\/auth currently requires the sqlite dialect \(adapter dialect: "postgres"\)/);
  });
});

describe("POST /api/auth/register", () => {
  it("round-trips: the issued cookie is accepted by GET /api/auth/me", async () => {
    const { backend } = await setup();
    const res = await backend.fetch(
      jsonReq("POST", "/api/auth/register", { email: "alice@example.com", password: "hunter22", name: "Alice" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { user: Record<string, unknown> } };
    expect(body.data.user.email).toBe("alice@example.com");
    expect(body.data.user.name).toBe("Alice");
    expect("passwordHash" in body.data.user).toBe(false);
    expect("password" in body.data.user).toBe(false);

    const cookie = cookieFromSetHeader(res);
    const meRes = await backend.fetch(req("/api/auth/me", { headers: { cookie } }));
    expect(meRes.status).toBe(200);
    const meBody = (await meRes.json()) as { data: { user: Record<string, unknown> } };
    expect(meBody.data.user.email).toBe("alice@example.com");
    expect(meBody.data.user.id).toBe(body.data.user.id);
  });

  it("the first user ever registered is admin; the second is member", async () => {
    const { backend } = await setup();
    const first = await backend.fetch(
      jsonReq("POST", "/api/auth/register", { email: "first@example.com", password: "password1" }),
    );
    const firstBody = (await first.json()) as { data: { user: { role: string } } };
    expect(firstBody.data.user.role).toBe("admin");

    const second = await backend.fetch(
      jsonReq("POST", "/api/auth/register", { email: "second@example.com", password: "password1" }),
    );
    const secondBody = (await second.json()) as { data: { user: { role: string } } };
    expect(secondBody.data.user.role).toBe("member");
  });

  it("duplicate email is a clean 409 conflict (via the driver's UNIQUE violation, there is no pre-check SELECT)", async () => {
    const { backend } = await setup();
    await backend.fetch(jsonReq("POST", "/api/auth/register", { email: "dupe@example.com", password: "password1" }));

    // Register performs no duplicate pre-check: this second attempt reaches
    // the INSERT and trips the real UNIQUE constraint, so this test covers
    // the exact insert-time mapping path a concurrent-register race hits.
    const res = await backend.fetch(
      jsonReq("POST", "/api/auth/register", { email: "dupe@example.com", password: "password2" }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("conflict");
    expect(body.error.message).toBe('"email" already exists');
  });

  it("two CONCURRENT registers for the same email settle as exactly one 201 and one 409, never a 500", async () => {
    const { backend } = await setup();
    // Seed a first user so neither racer is the admin-bootstrap user.
    await backend.fetch(jsonReq("POST", "/api/auth/register", { email: "seed@example.com", password: "password1" }));

    // No pre-check means the single INSERT is the atomic arbiter: whichever
    // request's insert lands first wins, the other's UNIQUE violation maps to
    // 409, the outcome set is deterministic even though the ordering isn't.
    const [a, b] = await Promise.all([
      backend.fetch(jsonReq("POST", "/api/auth/register", { email: "racer@example.com", password: "password1" })),
      backend.fetch(jsonReq("POST", "/api/auth/register", { email: "racer@example.com", password: "password2" })),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);

    const loser = a.status === 409 ? a : b;
    const loserBody = (await loser.json()) as { error: { code: string } };
    expect(loserBody.error.code).toBe("conflict");
  });

  it("a password shorter than 8 characters is a 422", async () => {
    const { backend } = await setup();
    const res = await backend.fetch(
      jsonReq("POST", "/api/auth/register", { email: "shortpw@example.com", password: "short" }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation");
  });

  it("a malformed email is a 422", async () => {
    const { backend } = await setup();
    const res = await backend.fetch(
      jsonReq("POST", "/api/auth/register", { email: "not-an-email", password: "password1" }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation");
  });

  it("injected role/passwordHash/id in the payload are ignored: the row is a fresh-uuid member, and the real password still works", async () => {
    const { backend } = await setup();
    // Seed an admin first so this registration is NOT the bootstrap first user.
    await backend.fetch(jsonReq("POST", "/api/auth/register", { email: "seed-admin@example.com", password: "password1" }));

    const res = await backend.fetch(
      jsonReq("POST", "/api/auth/register", {
        email: "mallory@example.com",
        password: "realpassword1",
        role: "admin",
        passwordHash: "x",
        id: "evil",
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { user: { id: string; role: string } } };
    expect(body.data.user.role).toBe("member");
    expect(body.data.user.id).not.toBe("evil");
    expect(body.data.user.id).toMatch(/^[0-9a-f-]{36}$/);

    const loginRes = await backend.fetch(
      jsonReq("POST", "/api/auth/login", { email: "mallory@example.com", password: "realpassword1" }),
    );
    expect(loginRes.status).toBe(200);
  });

  it("a password longer than 256 characters is a 422 (scrypt cost scales with input length)", async () => {
    const { backend } = await setup();
    const res = await backend.fetch(
      jsonReq("POST", "/api/auth/register", { email: "longpw@example.com", password: "a".repeat(300) }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation");
  });

  it("a 256-character password (the exact boundary) is accepted", async () => {
    const { backend } = await setup();
    const res = await backend.fetch(
      jsonReq("POST", "/api/auth/register", { email: "boundarypw@example.com", password: "a".repeat(256) }),
    );
    expect(res.status).toBe(201);
  });

  it("emits a record.created event for the users entity (hidden fields stripped, same shape the client receives)", async () => {
    const { backend } = await setup();
    const seen: DataEventPayload[] = [];
    backend.events.on("record.created", (payload) => {
      seen.push(payload);
    });

    const res = await backend.fetch(
      jsonReq("POST", "/api/auth/register", { email: "eventuser@example.com", password: "password1" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { user: { id: string } } };

    expect(seen).toHaveLength(1);
    expect(seen[0]?.entity).toBe("users");
    expect(seen[0]?.ctx).toBeNull();
    expect(seen[0]?.row.id).toBe(body.data.user.id);
    expect(seen[0]?.row.email).toBe("eventuser@example.com");
    expect("passwordHash" in seen[0]!.row).toBe(false);
  });
});

describe("email normalization (trim + lowercase, identical in register and login)", () => {
  it("register with a mixed-case email stores the lowercase form, and a lowercase login finds the account", async () => {
    const { backend } = await setup();
    const registerRes = await backend.fetch(
      jsonReq("POST", "/api/auth/register", { email: "Alice@Example.COM", password: "password1" }),
    );
    expect(registerRes.status).toBe(201);
    const registered = (await registerRes.json()) as { data: { user: { email: string } } };
    expect(registered.data.user.email).toBe("alice@example.com");

    const loginRes = await backend.fetch(
      jsonReq("POST", "/api/auth/login", { email: "alice@example.com", password: "password1" }),
    );
    expect(loginRes.status).toBe(200);
  });

  it("register lowercase then register the mixed-case variant is a 409 (one account, not two)", async () => {
    const { backend } = await setup();
    await backend.fetch(jsonReq("POST", "/api/auth/register", { email: "case@example.com", password: "password1" }));

    const res = await backend.fetch(
      jsonReq("POST", "/api/auth/register", { email: "Case@Example.com", password: "password2" }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("conflict");
  });

  it("surrounding whitespace is trimmed: registers cleanly and logs in with (differently) padded input", async () => {
    const { backend } = await setup();
    const registerRes = await backend.fetch(
      jsonReq("POST", "/api/auth/register", { email: "  spaced@example.com  ", password: "password1" }),
    );
    expect(registerRes.status).toBe(201);
    const registered = (await registerRes.json()) as { data: { user: { email: string } } };
    expect(registered.data.user.email).toBe("spaced@example.com");

    const loginRes = await backend.fetch(
      jsonReq("POST", "/api/auth/login", { email: " SPACED@example.com", password: "password1" }),
    );
    expect(loginRes.status).toBe(200);
  });
});

describe("POST /api/auth/login", () => {
  it("wrong password and unknown email produce byte-identical 401 responses (no user-enumeration signal)", async () => {
    const { backend } = await setup();
    await backend.fetch(jsonReq("POST", "/api/auth/register", { email: "known@example.com", password: "correcthorse1" }));

    const wrongPassword = await backend.fetch(
      jsonReq("POST", "/api/auth/login", { email: "known@example.com", password: "wrongpassword" }),
    );
    const unknownEmail = await backend.fetch(
      jsonReq("POST", "/api/auth/login", { email: "nobody@example.com", password: "wrongpassword" }),
    );

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(wrongPassword.status);

    const wrongBody = await wrongPassword.text();
    const unknownBody = await unknownEmail.text();
    expect(unknownBody).toBe(wrongBody);
    expect(JSON.parse(wrongBody)).toEqual({ error: { code: "unauthorized", message: "invalid credentials" } });
  });

  it("success returns the user envelope and sets a session cookie", async () => {
    const { backend } = await setup();
    await backend.fetch(jsonReq("POST", "/api/auth/register", { email: "loginworks@example.com", password: "correcthorse1" }));

    const res = await backend.fetch(
      jsonReq("POST", "/api/auth/login", { email: "loginworks@example.com", password: "correcthorse1" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { user: { email: string } } };
    expect(body.data.user.email).toBe("loginworks@example.com");
    expect(cookieFromSetHeader(res)).toMatch(/^frogcp_session=/);
  });
});

describe("POST /api/auth/logout", () => {
  it("clears the cookie (Max-Age=0) and succeeds even with no session at all", async () => {
    const { backend } = await setup();
    const res = await backend.fetch(req("/api/auth/logout", { method: "POST" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { ok: boolean } };
    expect(body.data.ok).toBe(true);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("GET /api/auth/me with the post-logout (cleared) cookie is a 401", async () => {
    const { backend } = await setup();
    const registerRes = await backend.fetch(
      jsonReq("POST", "/api/auth/register", { email: "loggedout@example.com", password: "password1" }),
    );
    const cookie = cookieFromSetHeader(registerRes);

    // The session is live before logging out.
    const meBefore = await backend.fetch(req("/api/auth/me", { headers: { cookie } }));
    expect(meBefore.status).toBe(200);

    const logoutRes = await backend.fetch(req("/api/auth/logout", { method: "POST", headers: { cookie } }));
    const clearedCookie = cookieFromSetHeader(logoutRes);

    const meAfter = await backend.fetch(req("/api/auth/me", { headers: { cookie: clearedCookie } }));
    expect(meAfter.status).toBe(401);
  });
});

describe("GET /api/auth/me", () => {
  it("401s with no session at all", async () => {
    const { backend } = await setup();
    const res = await backend.fetch(req("/api/auth/me"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });
});

describe("end-to-end: an authenticated member CRUDs an owner-ruled entity", () => {
  it("register once, then create/list/read/update/delete a post scoped to the caller's own rows", async () => {
    const { backend } = await setup();
    const registerRes = await backend.fetch(
      jsonReq("POST", "/api/auth/register", { email: "author@example.com", password: "password1" }),
    );
    const cookie = cookieFromSetHeader(registerRes);

    const createRes = await backend.fetch(
      req("/api/entity/posts", {
        method: "POST",
        body: JSON.stringify({ title: "Hello" }),
        headers: { "content-type": "application/json", cookie },
      }),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { data: { id: string; title: string } };
    expect(created.data.title).toBe("Hello");

    const listRes = await backend.fetch(req("/api/entity/posts", { headers: { cookie } }));
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { data: { id: string }[] };
    expect(list.data.map((p) => p.id)).toEqual([created.data.id]);

    const readRes = await backend.fetch(req(`/api/entity/posts/${created.data.id}`, { headers: { cookie } }));
    expect(readRes.status).toBe(200);

    const patchRes = await backend.fetch(
      req(`/api/entity/posts/${created.data.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: "Updated" }),
        headers: { "content-type": "application/json", cookie },
      }),
    );
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { data: { title: string } };
    expect(patched.data.title).toBe("Updated");

    const deleteRes = await backend.fetch(
      req(`/api/entity/posts/${created.data.id}`, { method: "DELETE", headers: { cookie } }),
    );
    expect(deleteRes.status).toBe(204);

    // A guest (no session at all) is default-denied end to end, proves the
    // above access was genuinely gated by `identify`, not incidentally open.
    const guestRes = await backend.fetch(req("/api/entity/posts"));
    expect(guestRes.status).toBe(403);
  });
});
