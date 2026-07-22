import { afterAll, beforeEach, describe, expect, it } from "vitest";
import worker, { type Env } from "../src/worker";
import { applyExampleSchema, resetD1, tryStartMiniflareEnv } from "./support/miniflare-env";

const BASE = "https://worker.example";
const TEST_SECRET = "test-secret-at-least-32-bytes-long!!";
const DEV_SECRET_LITERAL = "dev-secret-do-not-use-in-production-32chars!!";

const mfEnv = await tryStartMiniflareEnv();

afterAll(async () => {
  await mfEnv?.mf.dispose();
});

/** A no-op `ExecutionContext`. The worker takes one to match the Workers `fetch` signature but never uses it. */
function fakeExecutionContext(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
}

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

/** Pulls the `name=value` pair out of a `Set-Cookie` header, ready to send back as a `Cookie`. */
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

/**
 * Uploads a file through the media plugin's multipart endpoint. `cookie` is
 * optional so the same helper covers the guest-denied case. The body is a real
 * `FormData` with a `file` field, exactly what a browser or `curl -F` sends.
 */
function upload(
  env: Env,
  filename: string,
  contentType: string,
  content: string,
  cookie?: string,
): Promise<Response> {
  const form = new FormData();
  form.append("file", new File([content], filename, { type: contentType }));
  return worker.fetch(
    req("/api/media/upload", { method: "POST", body: form, ...(cookie ? { headers: { cookie } } : {}) }),
    env,
    fakeExecutionContext(),
  );
}

async function register(env: Env, email: string, password: string): Promise<RegisteredUser> {
  const res = await worker.fetch(
    jsonReq("POST", "/api/auth/register", { email, password }),
    env,
    fakeExecutionContext(),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { data: { user: { id: string; role: string } } };
  return { cookie: cookieFromSetHeader(res), id: body.data.user.id, role: body.data.user.role };
}

/**
 * Boots the example's own default export against real D1/R2/KV bindings and
 * registers alice and bob through `/api/auth/register`. The first account on a
 * fresh database becomes `admin`, so alice is admin and bob is a member. Each
 * call builds a fresh `env` object, matching the per-env caching the worker and
 * `createWorkerHandler` both rely on.
 */
async function setup(): Promise<{ env: Env; alice: RegisteredUser; bob: RegisteredUser }> {
  if (!mfEnv) throw new Error("unreachable: setup() only runs in tests gated on mfEnv");
  await resetD1(mfEnv.d1);
  // The worker never migrates, so the schema comes from `frogcp schema`, the
  // same path a deploy uses.
  await applyExampleSchema(mfEnv.d1);
  const env: Env = {
    DB: mfEnv.d1,
    BUCKET: mfEnv.r2,
    SESSIONS: mfEnv.kv,
    AUTH_SECRET: TEST_SECRET,
  };

  const alice = await register(env, "alice@example.com", "alice-password1");
  const bob = await register(env, "bob@example.com", "bob-password1");

  return { env, alice, bob };
}

it("rejects a request when AUTH_SECRET is missing", async () => {
  const env = { DB: {}, BUCKET: {}, SESSIONS: {} } as unknown as Env;
  await expect(worker.fetch(req("/api/system/health"), env, fakeExecutionContext())).rejects.toThrow(
    /AUTH_SECRET is not set/,
  );
});

it("rejects the published dev placeholder secret without FROGCP_ALLOW_DEV_SECRET", async () => {
  const env = { DB: {}, BUCKET: {}, SESSIONS: {}, AUTH_SECRET: DEV_SECRET_LITERAL } as unknown as Env;
  await expect(worker.fetch(req("/api/system/health"), env, fakeExecutionContext())).rejects.toThrow(
    /published dev-only placeholder value/,
  );
});

it("accepts the dev placeholder secret when FROGCP_ALLOW_DEV_SECRET=1 is set, as .dev.vars does", async () => {
  const env = {
    DB: {},
    BUCKET: {},
    SESSIONS: {},
    AUTH_SECRET: DEV_SECRET_LITERAL,
    FROGCP_ALLOW_DEV_SECRET: "1",
  } as unknown as Env;
  const res = await worker.fetch(req("/api/system/health"), env, fakeExecutionContext());
  expect(res.status).toBe(200);
});

describe.skipIf(mfEnv === null)("cloudflare worker example over real D1, R2, and KV", () => {
  beforeEach(async () => {
    if (mfEnv) await resetD1(mfEnv.d1);
  });

  it("makes the first registered user an admin and the second a member", async () => {
    const { alice, bob } = await setup();
    expect(alice.role).toBe("admin");
    expect(bob.role).toBe("member");
  });

  it("lets a member create, list, patch, and delete their own note", async () => {
    const { env, bob } = await setup();

    const createRes = await worker.fetch(
      jsonReq("POST", "/api/entity/notes", { title: "hello" }, { cookie: bob.cookie }),
      env,
      fakeExecutionContext(),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { data: { id: string; title: string; status: string } };
    expect(created.data.title).toBe("hello");
    expect(created.data.status).toBe("draft");
    const id = created.data.id;

    const listRes = await worker.fetch(
      req("/api/entity/notes", { headers: { cookie: bob.cookie } }),
      env,
      fakeExecutionContext(),
    );
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { data: unknown[]; meta: { total: number } };
    expect(list.meta.total).toBe(1);
    expect(list.data).toHaveLength(1);

    const patchRes = await worker.fetch(
      jsonReq("PATCH", `/api/entity/notes/${id}`, { status: "published" }, { cookie: bob.cookie }),
      env,
      fakeExecutionContext(),
    );
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { data: { status: string } };
    expect(patched.data.status).toBe("published");

    const deleteRes = await worker.fetch(
      req(`/api/entity/notes/${id}`, { method: "DELETE", headers: { cookie: bob.cookie } }),
      env,
      fakeExecutionContext(),
    );
    expect(deleteRes.status).toBe(204);

    const readAfterDelete = await worker.fetch(
      req(`/api/entity/notes/${id}`, { headers: { cookie: bob.cookie } }),
      env,
      fakeExecutionContext(),
    );
    expect(readAfterDelete.status).toBe(404);
  });

  it("denies a note create from a guest with a 403", async () => {
    const { env } = await setup();

    const res = await worker.fetch(jsonReq("POST", "/api/entity/notes", { title: "nope" }), env, fakeExecutionContext());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("hides one member's note from another while letting an admin read it", async () => {
    const { env, alice, bob } = await setup();

    const aliceNoteRes = await worker.fetch(
      jsonReq("POST", "/api/entity/notes", { title: "alice's secret" }, { cookie: alice.cookie }),
      env,
      fakeExecutionContext(),
    );
    expect(aliceNoteRes.status).toBe(201);
    const aliceNote = (await aliceNoteRes.json()) as { data: { id: string } };

    const bobNoteRes = await worker.fetch(
      jsonReq("POST", "/api/entity/notes", { title: "bob's note" }, { cookie: bob.cookie }),
      env,
      fakeExecutionContext(),
    );
    expect(bobNoteRes.status).toBe(201);
    const bobNote = (await bobNoteRes.json()) as { data: { id: string } };

    // 404 rather than 403, so the response never confirms the row exists.
    const bobReadsAlice = await worker.fetch(
      req(`/api/entity/notes/${aliceNote.data.id}`, { headers: { cookie: bob.cookie } }),
      env,
      fakeExecutionContext(),
    );
    expect(bobReadsAlice.status).toBe(404);
    const bobReadsAliceBody = (await bobReadsAlice.json()) as Record<string, unknown>;
    expect(bobReadsAliceBody).not.toHaveProperty("data");

    // Admin bypasses the entity's declared rule.
    const aliceReadsBob = await worker.fetch(
      req(`/api/entity/notes/${bobNote.data.id}`, { headers: { cookie: alice.cookie } }),
      env,
      fakeExecutionContext(),
    );
    expect(aliceReadsBob.status).toBe(200);
    const aliceReadsBobBody = (await aliceReadsBob.json()) as { data: { id: string; title: string } };
    expect(aliceReadsBobBody.data.id).toBe(bobNote.data.id);
    expect(aliceReadsBobBody.data.title).toBe("bob's note");
  });

  it("lets a member upload a file and read its exact bytes back", async () => {
    const { env, bob } = await setup();

    const uploadRes = await upload(env, "hello.txt", "text/plain", "hello media", bob.cookie);
    expect(uploadRes.status).toBe(200);
    const uploaded = (await uploadRes.json()) as { data: { key: string; filename: string; contentType: string } };
    expect(uploaded.data.filename).toBe("hello.txt");
    expect(uploaded.data.key).toMatch(/\.txt$/);

    const getRes = await worker.fetch(
      req(`/files/${uploaded.data.key}`, { headers: { cookie: bob.cookie } }),
      env,
      fakeExecutionContext(),
    );
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("content-type")).toBe("text/plain");
    expect(await getRes.text()).toBe("hello media");
  });

  it("serves a text/html upload as an attachment, never inline", async () => {
    const { env, bob } = await setup();

    const uploadRes = await upload(env, "page.html", "text/html", "<script>alert(1)</script>", bob.cookie);
    expect(uploadRes.status).toBe(200);
    const uploaded = (await uploadRes.json()) as { data: { key: string } };

    const getRes = await worker.fetch(
      req(`/files/${uploaded.data.key}`, { headers: { cookie: bob.cookie } }),
      env,
      fakeExecutionContext(),
    );
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("content-disposition")).toBe("attachment");
    expect(getRes.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("hides one member's file from another with a 404, no existence oracle", async () => {
    const { env, alice, bob } = await setup();

    const uploadRes = await upload(env, "secret.txt", "text/plain", "alice's bytes", alice.cookie);
    expect(uploadRes.status).toBe(200);
    const uploaded = (await uploadRes.json()) as { data: { key: string } };

    const bobReads = await worker.fetch(
      req(`/files/${uploaded.data.key}`, { headers: { cookie: bob.cookie } }),
      env,
      fakeExecutionContext(),
    );
    expect(bobReads.status).toBe(404);
    const body = (await bobReads.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("data");
  });

  it("denies a file upload from a guest with a 403", async () => {
    const { env } = await setup();

    const res = await upload(env, "nope.txt", "text/plain", "guest bytes");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("builds a separate handler for each distinct env object", async () => {
    if (!mfEnv) throw new Error("unreachable: gated on mfEnv");
    const envA: Env = { DB: mfEnv.d1, BUCKET: mfEnv.r2, SESSIONS: mfEnv.kv, AUTH_SECRET: TEST_SECRET };
    const envB: Env = { DB: mfEnv.d1, BUCKET: mfEnv.r2, SESSIONS: mfEnv.kv, AUTH_SECRET: TEST_SECRET };

    const resA = await worker.fetch(req("/api/system/health"), envA, fakeExecutionContext());
    const resB = await worker.fetch(req("/api/system/health"), envB, fakeExecutionContext());
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
  });
});
