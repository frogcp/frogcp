import { describe, expect, it } from "vitest";
import { adminPlugin } from "@frogcp/admin";
import { memoryStorage, nodeSqliteAdapter } from "frogcp/adapter/node";
import { authPlugin } from "frogcp/auth";
import { createClient, type FrogFetch } from "frogcp/client";
import { mediaPlugin } from "frogcp/media";
import { createBackend, type Backend } from "frogcp";
import config from "../frogcp.config";

const BASE = "http://x";
const TEST_SECRET = "test-secret-at-least-32-bytes-long!!";

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`${BASE}${path}`, init);
}

function jsonReq(
  method: string,
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Request {
  return req(path, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

/** Takes the `name=value` pair off a Set-Cookie header, ready to send back as a Cookie header. */
function cookieFromSetHeader(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("expected a Set-Cookie header on this response");
  const pair = setCookie.split(";")[0];
  if (!pair) throw new Error("malformed Set-Cookie header");
  return pair;
}

interface RegisteredUser {
  cookie: string;
  id: string;
  role: string;
}

async function register(
  backend: Backend,
  email: string,
  password: string,
  extra: Record<string, unknown> = {},
): Promise<RegisteredUser> {
  const res = await backend.fetch(
    jsonReq("POST", "/api/auth/register", { email, password, ...extra }),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { data: { user: { id: string; role: string } } };
  return { cookie: cookieFromSetHeader(res), id: body.data.user.id, role: body.data.user.role };
}

/** Fresh in-memory backend with alice and bob registered. Alice registers first, so she is admin. */
async function setup(): Promise<{ backend: Backend; alice: RegisteredUser; bob: RegisteredUser }> {
  const backend = await createBackend({
    config,
    adapter: nodeSqliteAdapter(":memory:"),
    plugins: [authPlugin({ secret: TEST_SECRET }), adminPlugin()],
  });

  const alice = await register(backend, "alice@example.com", "alice-password1");
  const bob = await register(backend, "bob@example.com", "bob-password1");

  return { backend, alice, bob };
}

/**
 * The shape `frogcp generate` would emit for this example's `notes` entity.
 * Only `title` is required, so every other field is optional and nullable in
 * the row shape. `createdAt` arrives as an ISO string, not a Date, because the
 * client parses responses with a bare JSON.parse.
 */
type ClientBackend = {
  notes: {
    row: {
      id: string;
      title: string;
      body?: string | null;
      status?: "draft" | "published" | null;
      owner?: string | null;
      createdAt?: string | null;
    };
    insert: { title: string; body?: string; status?: "draft" | "published" };
    patch: { title?: string; body?: string; status?: "draft" | "published" };
  };
};

/** Boots the backend with the same plugin set server.ts uses. */
async function setupWithMedia(): Promise<{ backend: Backend }> {
  const backend = await createBackend({
    config,
    adapter: nodeSqliteAdapter(":memory:"),
    storage: memoryStorage(),
    plugins: [authPlugin({ secret: TEST_SECRET }), mediaPlugin()],
  });
  return { backend };
}

/**
 * `backend.fetch` has no cookie jar, so wrap it in one that replays the last
 * Set-Cookie it saw. Stands in for a browser's `credentials: "include"`.
 */
function withCookieJar(fetchImpl: FrogFetch): FrogFetch {
  let cookie = "";
  return async (incoming: Request) => {
    const headers = new Headers(incoming.headers);
    if (cookie) headers.set("cookie", cookie);
    const res = await fetchImpl(new Request(incoming, { headers }));
    const setCookie =
      res.headers.getSetCookie?.() ??
      (res.headers.get("set-cookie") ? [res.headers.get("set-cookie") as string] : []);
    for (const raw of setCookie) {
      const pair = raw.split(";")[0];
      if (pair) cookie = pair;
    }
    return res;
  };
}

describe("basic-node example: the typed client", () => {
  it("registers, creates and lists a note, uploads a file and reads it back", async () => {
    const { backend } = await setupWithMedia();
    const jarredFetch = withCookieJar(backend.fetch);
    const client = createClient<ClientBackend>(BASE, { fetch: jarredFetch });

    const { user } = await client.auth.register({
      email: "ivy@example.com",
      password: "ivy-password1",
    });
    expect(user.email).toBe("ivy@example.com");
    expect(user.role).toBe("admin"); // first user on a fresh backend

    const notes = client.entity("notes");
    const created = await notes.create({ title: "via the client" });
    expect(created.title).toBe("via the client");
    expect(created.status).toBe("draft");

    const list = await notes.list();
    expect(list.meta.total).toBe(1);
    expect(list.data[0]?.id).toBe(created.id);

    const blob = new Blob(["hello from the client"], { type: "text/plain" });
    const uploaded = await client.media.upload(blob, { filename: "greeting.txt" });
    expect(uploaded.filename).toBe("greeting.txt");
    expect(uploaded.contentType).toBe("text/plain");
    expect(uploaded.size).toBe("hello from the client".length);

    const url = client.media.url(uploaded.key);
    expect(url).toBe(`${BASE}/files/${uploaded.key}`);

    // `media.url` returns a plain download URL, so fetch it the way an <img src>
    // would, with the same session.
    const fileRes = await jarredFetch(new Request(url));
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get("content-type")).toBe("text/plain");
    expect(await fileRes.text()).toBe("hello from the client");

    // Files are owner scoped by default, so another user gets a 404.
    const jackFetch = withCookieJar(backend.fetch);
    const jackClient = createClient<ClientBackend>(BASE, { fetch: jackFetch });
    await jackClient.auth.register({ email: "jack@example.com", password: "jack-password1" });
    expect((await jackFetch(new Request(url))).status).toBe(404);
  });
});

describe("basic-node example: entity CRUD and permissions", () => {
  it("makes the first registered user an admin and the second a member", async () => {
    const { alice, bob } = await setup();
    expect(alice.role).toBe("admin");
    expect(bob.role).toBe("member");
  });

  it("lets a member create, list, patch and delete their own note", async () => {
    const { backend, bob } = await setup();

    const createRes = await backend.fetch(
      jsonReq("POST", "/api/entity/notes", { title: "hello" }, { cookie: bob.cookie }),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { data: { id: string; title: string; status: string } };
    expect(created.data.title).toBe("hello");
    expect(created.data.status).toBe("draft");
    const id = created.data.id;

    const listRes = await backend.fetch(req("/api/entity/notes", { headers: { cookie: bob.cookie } }));
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { data: unknown[]; meta: { total: number } };
    expect(list.meta.total).toBe(1);
    expect(list.data).toHaveLength(1);

    const patchRes = await backend.fetch(
      jsonReq("PATCH", `/api/entity/notes/${id}`, { status: "published" }, { cookie: bob.cookie }),
    );
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { data: { status: string } };
    expect(patched.data.status).toBe("published");

    const deleteRes = await backend.fetch(
      req(`/api/entity/notes/${id}`, { method: "DELETE", headers: { cookie: bob.cookie } }),
    );
    expect(deleteRes.status).toBe(204);

    const readAfterDelete = await backend.fetch(
      req(`/api/entity/notes/${id}`, { headers: { cookie: bob.cookie } }),
    );
    expect(readAfterDelete.status).toBe(404);
    const afterDelete = (await readAfterDelete.json()) as Record<string, unknown> & {
      error: { code: string; message: string };
    };
    expect(afterDelete.error.code).toBe("not_found");
    expect(afterDelete).not.toHaveProperty("data");
  });

  it("denies a guest creating a note", async () => {
    const { backend } = await setup();

    const res = await backend.fetch(jsonReq("POST", "/api/entity/notes", { title: "nope" }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("hides another member's note but lets an admin read it", async () => {
    const { backend, alice, bob } = await setup();

    const aliceNoteRes = await backend.fetch(
      jsonReq("POST", "/api/entity/notes", { title: "alice's secret" }, { cookie: alice.cookie }),
    );
    const aliceNote = (await aliceNoteRes.json()) as { data: { id: string } };

    const bobNoteRes = await backend.fetch(
      jsonReq("POST", "/api/entity/notes", { title: "bob's note" }, { cookie: bob.cookie }),
    );
    const bobNote = (await bobNoteRes.json()) as { data: { id: string } };

    // 404 rather than 403: the row is invisible, so there is no existence oracle.
    const bobReadsAlice = await backend.fetch(
      req(`/api/entity/notes/${aliceNote.data.id}`, { headers: { cookie: bob.cookie } }),
    );
    expect(bobReadsAlice.status).toBe(404);

    // Admin bypasses the entity rule, which names no admin clause of its own.
    const aliceReadsBob = await backend.fetch(
      req(`/api/entity/notes/${bobNote.data.id}`, { headers: { cookie: alice.cookie } }),
    );
    expect(aliceReadsBob.status).toBe(200);
    const body = (await aliceReadsBob.json()) as { data: { id: string; title: string } };
    expect(body.data.id).toBe(bobNote.data.id);
    expect(body.data.title).toBe("bob's note");
  });

  it("ignores a role injected into the register payload", async () => {
    const { backend } = await setup(); // alice and bob already took the bootstrap slot

    const res = await backend.fetch(
      jsonReq("POST", "/api/auth/register", {
        email: "mallory@example.com",
        password: "mallory-password1",
        role: "admin",
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { user: { role: string } } };
    expect(body.data.user.role).toBe("member");

    const cookie = cookieFromSetHeader(res);
    const createOwn = await backend.fetch(
      jsonReq("POST", "/api/entity/notes", { title: "mallory's note" }, { cookie }),
    );
    expect(createOwn.status).toBe(201);

    const listRes = await backend.fetch(req("/api/entity/notes", { headers: { cookie } }));
    const list = (await listRes.json()) as { meta: { total: number } };
    expect(list.meta.total).toBe(1); // her own note only, not everyone's
  });
});

describe("basic-node example: auth session lifecycle", () => {
  it("logs in, reads /me, then logs out", async () => {
    const { backend } = await setup();

    const loginRes = await backend.fetch(
      jsonReq("POST", "/api/auth/login", { email: "bob@example.com", password: "bob-password1" }),
    );
    expect(loginRes.status).toBe(200);
    const loginBody = (await loginRes.json()) as { data: { user: { email: string } } };
    expect(loginBody.data.user.email).toBe("bob@example.com");
    const cookie = cookieFromSetHeader(loginRes);

    const meRes = await backend.fetch(req("/api/auth/me", { headers: { cookie } }));
    expect(meRes.status).toBe(200);
    const meBody = (await meRes.json()) as { data: { user: { email: string } } };
    expect(meBody.data.user.email).toBe("bob@example.com");

    const logoutRes = await backend.fetch(
      req("/api/auth/logout", { method: "POST", headers: { cookie } }),
    );
    expect(logoutRes.status).toBe(200);
    const cleared = cookieFromSetHeader(logoutRes);

    const meAfterLogout = await backend.fetch(req("/api/auth/me", { headers: { cookie: cleared } }));
    expect(meAfterLogout.status).toBe(401);
  });
});

describe("basic-node example: the admin UI", () => {
  it("serves the SPA shell at /admin", async () => {
    const { backend } = await setup();

    const res = await backend.fetch(req("/admin"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('id="root"');
    expect(body).toMatch(/<script[^>]+src="\/admin\/assets\/[^"]+\.js"/);
  });

  it("serves the schema to an admin and denies a member", async () => {
    const { backend, alice, bob } = await setup();

    const denied = await backend.fetch(req("/api/system/schema", { headers: { cookie: bob.cookie } }));
    expect(denied.status).toBe(403);

    const res = await backend.fetch(req("/api/system/schema", { headers: { cookie: alice.cookie } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { entities: Record<string, { fields: Record<string, unknown> }> };
    };
    expect(Object.keys(body.data.entities)).toEqual(expect.arrayContaining(["notes", "users"]));
    expect(body.data.entities.notes?.fields.title).toMatchObject({ type: "text", required: true });
    expect(body.data.entities.users?.fields).toHaveProperty("email");
  });
});
