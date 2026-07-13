import { describe, expect, it } from "vitest";
import { memoryStorage, nodeSqliteAdapter } from "frogcp/adapter/node";
import { authPlugin } from "frogcp/auth";
import { mediaPlugin } from "frogcp/media";
import { createBackend, defineBackend, entity, ref, role, rule, select, text, timestamp, type Backend } from "frogcp";
import { createClient, FrogClientError, type FrogFetch } from "../../src/client/index";

const BASE = "http://x";
const SECRET = "test-secret-at-least-32-bytes-long!!";

interface Note {
  id: string;
  title: string;
  body?: string;
  status: "draft" | "published";
  owner: string;
  createdAt: string;
}

interface NoteInsert {
  title: string;
  body?: string;
  status?: "draft" | "published";
}

interface NotePatch {
  title?: string;
  body?: string;
  status?: "draft" | "published";
}

type TestBackend = {
  notes: { row: Note; insert: NoteInsert; patch: NotePatch };
};

const config = defineBackend({
  entities: {
    notes: entity({
      title: text().required(),
      body: text(),
      status: select(["draft", "published"]).default("draft"),
      owner: ref("users").onDelete("cascade"),
      createdAt: timestamp().auto(),
    }).permissions({
      read: rule.owner("owner"),
      list: rule.owner("owner").or(role("admin")),
      create: rule.authenticated(),
      update: rule.owner("owner"),
      delete: rule.owner("owner").or(role("admin")),
    }),
  },
});

async function setup(): Promise<{ backend: Backend }> {
  const adapter = nodeSqliteAdapter(":memory:");
  const backend = await createBackend({
    config,
    adapter,
    storage: memoryStorage(),
    plugins: [authPlugin({ secret: SECRET }), mediaPlugin()],
  });
  return { backend };
}

/**
 * `backend.fetch` (unlike a real browser `fetch`) has no cookie jar of its
 * own: nothing persists a `Set-Cookie` response header across calls. This
 * wraps it with a tiny per-client jar: it replays the last `Set-Cookie` it saw
 * as a `Cookie` request header, mirroring what a real browser's
 * `credentials: "include"` handling does automatically. One jar per simulated
 * "browser session" (one per test client), so two clients wrapping the same
 * `backend.fetch` stay independent sessions.
 */
function withCookieJar(fetchImpl: FrogFetch): FrogFetch {
  let cookie = "";
  return async (req: Request) => {
    const headers = new Headers(req.headers);
    if (cookie) headers.set("cookie", cookie);
    const request = new Request(req, { headers });
    const res = await fetchImpl(request);
    const setCookie = res.headers.getSetCookie?.() ?? (res.headers.get("set-cookie") ? [res.headers.get("set-cookie") as string] : []);
    for (const raw of setCookie) {
      const pair = raw.split(";")[0];
      if (pair) cookie = pair;
    }
    return res;
  };
}

describe("frogcp/client: auth", () => {
  it("register -> me round-trips (session cookie flows through the jar)", async () => {
    const { backend } = await setup();
    const client = createClient(BASE, { fetch: withCookieJar(backend.fetch) });

    const { user } = await client.auth.register({ email: "alice@example.com", password: "alice-password1" });
    expect(user.email).toBe("alice@example.com");
    expect(user.role).toBe("admin"); // bootstrap: first-ever user

    const me = await client.auth.me();
    expect(me.user.id).toBe(user.id);
    expect(me.user.email).toBe("alice@example.com");
  });

  it("login round-trips for an already-registered user", async () => {
    const { backend } = await setup();
    const registerClient = createClient(BASE, { fetch: withCookieJar(backend.fetch) });
    await registerClient.auth.register({ email: "bob@example.com", password: "bob-password1" });

    const loginClient = createClient(BASE, { fetch: withCookieJar(backend.fetch) });
    const { user } = await loginClient.auth.login({ email: "bob@example.com", password: "bob-password1" });
    expect(user.email).toBe("bob@example.com");

    const me = await loginClient.auth.me();
    expect(me.user.email).toBe("bob@example.com");
  });

  it("logout clears the session: a subsequent me() 401s", async () => {
    const { backend } = await setup();
    const client = createClient(BASE, { fetch: withCookieJar(backend.fetch) });
    await client.auth.register({ email: "carol@example.com", password: "carol-password1" });

    const loggedOut = await client.auth.logout();
    expect(loggedOut.ok).toBe(true);

    await expect(client.auth.me()).rejects.toMatchObject({ status: 401 });
  });
});

describe("frogcp/client: entity CRUD + owner isolation", () => {
  it("create/get/list/update/delete round-trip as the registered user; list filter + sort + meta.total", async () => {
    const { backend } = await setup();
    const client = createClient<TestBackend>(BASE, { fetch: withCookieJar(backend.fetch) });
    await client.auth.register({ email: "dave@example.com", password: "dave-password1" });

    const notes = client.entity("notes");

    const created = await notes.create({ title: "hello" });
    expect(created.title).toBe("hello");
    expect(created.status).toBe("draft");

    const fetched = await notes.get(created.id);
    expect(fetched.title).toBe("hello");

    await notes.create({ title: "second", status: "published" });

    const list = await notes.list({ filter: { status: "published" }, sort: ["-createdAt"] });
    expect(list.meta.total).toBe(1);
    expect(list.data).toHaveLength(1);
    expect(list.data[0]?.title).toBe("second");

    const updated = await notes.update(created.id, { status: "published" });
    expect(updated.status).toBe("published");

    await notes.delete(created.id);
    await expect(notes.get(created.id)).rejects.toMatchObject({ status: 404 });
  });

  it("owner isolation: a second user cannot get the first user's note (404, no oracle)", async () => {
    const { backend } = await setup();

    const aliceClient = createClient<TestBackend>(BASE, { fetch: withCookieJar(backend.fetch) });
    await aliceClient.auth.register({ email: "alice2@example.com", password: "alice2-password1" });
    const aliceNote = await aliceClient.entity("notes").create({ title: "alice's secret" });

    const bobClient = createClient<TestBackend>(BASE, { fetch: withCookieJar(backend.fetch) });
    await bobClient.auth.register({ email: "bob2@example.com", password: "bob2-password1" });

    const err = await bobClient
      .entity("notes")
      .get(aliceNote.id)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FrogClientError);
    expect((err as FrogClientError).status).toBe(404);
  });

  it("a validation failure (missing required field) throws FrogClientError 422/validation", async () => {
    const { backend } = await setup();
    const client = createClient<TestBackend>(BASE, { fetch: withCookieJar(backend.fetch) });
    await client.auth.register({ email: "erin@example.com", password: "erin-password1" });

    const err = await client
      .entity("notes")
      .create({} as NoteInsert)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FrogClientError);
    expect((err as FrogClientError).status).toBe(422);
    expect((err as FrogClientError).code).toBe("validation");
  });
});

describe("frogcp/client: filter value round-trips through the real server parser", () => {
  it("an `in` filter with a comma-containing item matches exactly the right row (repeated-param encoding survives server decode)", async () => {
    const { backend } = await setup();
    const client = createClient<TestBackend>(BASE, { fetch: withCookieJar(backend.fetch) });
    await client.auth.register({ email: "grace@example.com", password: "grace-password1" });
    const notes = client.entity("notes");

    // A naive comma-joined `in` encoding would split "a,b" into two items
    // ("a", "b") server-side and wrongly match the "a" and "b" rows. The
    // repeated-param encoding keeps "a,b" atomic. A SECOND item is included
    // ("no-such-title", matching nothing) so the wire form is unambiguously
    // repeated params (>1 value) rather than a single value the server's
    // legacy comma-split fallback would still break apart. See
    // `coerceInValues`'s note on the single-value backward-compat path.
    const target = await notes.create({ title: "a,b" });
    await notes.create({ title: "a" });
    await notes.create({ title: "b" });

    const list = await notes.list({ filter: { title: { in: ["a,b", "no-such-title"] } } });
    expect(list.meta.total).toBe(1);
    expect(list.data).toHaveLength(1);
    expect(list.data[0]?.id).toBe(target.id);
    expect(list.data[0]?.title).toBe("a,b");
  });

  it("a SINGLE-item `in` filter with an embedded comma still matches exactly the right row (not the server's single-value comma-split fallback)", async () => {
    const { backend } = await setup();
    const client = createClient<TestBackend>(BASE, { fetch: withCookieJar(backend.fetch) });
    await client.auth.register({ email: "ivan@example.com", password: "ivan-password1" });
    const notes = client.entity("notes");

    // Exactly ONE item in the `in` array, and that item itself contains a
    // comma. A naive single-param encoding (`filter[title][in]=a%2Cb`) is
    // still just ONE value server-side (`getAll(...).length === 1`), which the
    // server's `coerceInValues` legacy path would comma-split into
    // ["a", "b"], silently matching the WRONG rows (or none). The fix
    // duplicates the lone item on the wire so it survives as one atomic "a,b"
    // value end-to-end.
    const target = await notes.create({ title: "a,b" });
    await notes.create({ title: "a" });
    await notes.create({ title: "b" });

    const list = await notes.list({ filter: { title: { in: ["a,b"] } } });
    expect(list.meta.total).toBe(1);
    expect(list.data).toHaveLength(1);
    expect(list.data[0]?.id).toBe(target.id);
    expect(list.data[0]?.title).toBe("a,b");
  });

  it("an eq filter whose VALUE contains &, =, #, and a space round-trips exactly through the backend", async () => {
    const { backend } = await setup();
    const client = createClient<TestBackend>(BASE, { fetch: withCookieJar(backend.fetch) });
    await client.auth.register({ email: "heidi@example.com", password: "heidi-password1" });
    const notes = client.entity("notes");

    // Every one of these characters is query-syntax-significant (& separates
    // params, = separates key/value, # starts a fragment, space is illegal
    // unencoded), proving the client's per-value percent-encoding survives an
    // end-to-end round-trip through the real server parser, not just a unit
    // string assertion.
    const tricky = "a&b=c#d e";
    const target = await notes.create({ title: tricky });
    await notes.create({ title: "unrelated" });

    const list = await notes.list({ filter: { title: tricky } });
    expect(list.meta.total).toBe(1);
    expect(list.data).toHaveLength(1);
    expect(list.data[0]?.id).toBe(target.id);
    expect(list.data[0]?.title).toBe(tricky);
  });
});

describe("frogcp/client: media", () => {
  it("uploads a Blob and serves the exact bytes + content-type back through client.media.url", async () => {
    const { backend } = await setup();
    const fetchImpl = withCookieJar(backend.fetch);
    const client = createClient(BASE, { fetch: fetchImpl });
    await client.auth.register({ email: "frank@example.com", password: "frank-password1" });

    const blob = new Blob(["hello media"], { type: "text/plain" });
    const uploaded = await client.media.upload(blob, { filename: "greeting.txt" });
    expect(uploaded.filename).toBe("greeting.txt");
    expect(uploaded.contentType).toBe("text/plain");
    expect(uploaded.size).toBe("hello media".length);

    const url = client.media.url(uploaded.key);
    expect(url).toBe(`${BASE}/files/${uploaded.key}`);

    const res = await fetchImpl(new Request(url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(await res.text()).toBe("hello media");
  });
});
