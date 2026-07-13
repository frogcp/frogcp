import { describe, it, expect } from "vitest";
import { nodeSqliteAdapter } from "frogcp/adapter/node";
import { createBackend, defineBackend, type Backend } from "frogcp";
import { authPlugin, type PasswordResetInfo } from "../../src/auth/index";

const BASE = "http://x";
const TEST_SECRET = "test-secret-at-least-32-bytes-long!!";

function jsonReq(method: string, path: string, body: unknown, extraHeaders: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function cookieFromSetHeader(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("expected a Set-Cookie header on this response");
  const pair = setCookie.split(";")[0];
  if (!pair) throw new Error("malformed Set-Cookie header");
  return pair;
}

const emptyConfig = defineBackend({ entities: {} });

async function setup(opts: { resetMailer?: (info: PasswordResetInfo) => Promise<void> } = {}): Promise<Backend> {
  return createBackend({
    config: emptyConfig,
    adapter: nodeSqliteAdapter(":memory:"),
    plugins: [authPlugin({ secret: TEST_SECRET, ...(opts.resetMailer ? { resetMailer: opts.resetMailer } : {}) })],
  });
}

async function register(backend: Backend, email: string, password: string): Promise<string> {
  const res = await backend.fetch(jsonReq("POST", "/api/auth/register", { email, password }));
  expect(res.status).toBe(201);
  return cookieFromSetHeader(res);
}

async function loginStatus(backend: Backend, email: string, password: string): Promise<number> {
  const res = await backend.fetch(jsonReq("POST", "/api/auth/login", { email, password }));
  return res.status;
}

describe("POST /api/auth/password (authenticated change)", { timeout: 30_000 }, () => {
  it("changes the password with the correct current password; old stops working, new works", async () => {
    const backend = await setup();
    const cookie = await register(backend, "chg@example.com", "original-pw-1");

    const res = await backend.fetch(
      jsonReq("POST", "/api/auth/password", { currentPassword: "original-pw-1", newPassword: "brand-new-pw-2" }, { cookie }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { ok: boolean } }).data.ok).toBe(true);

    expect(await loginStatus(backend, "chg@example.com", "original-pw-1")).toBe(401);
    expect(await loginStatus(backend, "chg@example.com", "brand-new-pw-2")).toBe(200);
  });

  it("rejects a wrong current password with 401, leaving the password unchanged", async () => {
    const backend = await setup();
    const cookie = await register(backend, "wrong@example.com", "original-pw-1");

    const res = await backend.fetch(
      jsonReq("POST", "/api/auth/password", { currentPassword: "not-the-password", newPassword: "brand-new-pw-2" }, { cookie }),
    );
    expect(res.status).toBe(401);
    expect(await loginStatus(backend, "wrong@example.com", "original-pw-1")).toBe(200);
  });

  it("requires authentication (401) and validates the new password (422)", async () => {
    const backend = await setup();
    const anon = await backend.fetch(jsonReq("POST", "/api/auth/password", { currentPassword: "x", newPassword: "long-enough-1" }));
    expect(anon.status).toBe(401);

    const cookie = await register(backend, "weak@example.com", "original-pw-1");
    const weak = await backend.fetch(
      jsonReq("POST", "/api/auth/password", { currentPassword: "original-pw-1", newPassword: "short" }, { cookie }),
    );
    expect(weak.status).toBe(422);
  });
});

describe("POST /api/auth/password-reset/issue + /confirm (admin-issued link)", { timeout: 30_000 }, () => {
  it("full loop: admin issues a token for a member, member confirms, logs in with the new password", async () => {
    const backend = await setup();
    const adminCookie = await register(backend, "admin@example.com", "admin-password-1"); // first user = admin
    await register(backend, "member@example.com", "member-password-1");

    const issueRes = await backend.fetch(
      jsonReq("POST", "/api/auth/password-reset/issue", { email: "member@example.com" }, { cookie: adminCookie }),
    );
    expect(issueRes.status).toBe(200);
    const issued = ((await issueRes.json()) as { data: { resetToken: string; expiresAt: string } }).data;
    expect(issued.resetToken.startsWith("rst_")).toBe(true);
    expect(new Date(issued.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Confirm is unauthenticated, the token itself is the credential.
    const confirmRes = await backend.fetch(
      jsonReq("POST", "/api/auth/password-reset/confirm", { token: issued.resetToken, newPassword: "reset-password-2" }),
    );
    expect(confirmRes.status).toBe(200);

    expect(await loginStatus(backend, "member@example.com", "member-password-1")).toBe(401);
    expect(await loginStatus(backend, "member@example.com", "reset-password-2")).toBe(200);
  });

  it("a consumed token cannot be replayed (same 404 as a bogus token)", async () => {
    const backend = await setup();
    const adminCookie = await register(backend, "admin2@example.com", "admin-password-1");
    await register(backend, "victim@example.com", "victim-password-1");

    const issueRes = await backend.fetch(
      jsonReq("POST", "/api/auth/password-reset/issue", { email: "victim@example.com" }, { cookie: adminCookie }),
    );
    const { resetToken } = ((await issueRes.json()) as { data: { resetToken: string } }).data;

    const first = await backend.fetch(
      jsonReq("POST", "/api/auth/password-reset/confirm", { token: resetToken, newPassword: "reset-password-2" }),
    );
    expect(first.status).toBe(200);

    const replay = await backend.fetch(
      jsonReq("POST", "/api/auth/password-reset/confirm", { token: resetToken, newPassword: "attacker-password-3" }),
    );
    expect(replay.status).toBe(404);
    expect(await loginStatus(backend, "victim@example.com", "reset-password-2")).toBe(200);
  });

  it("issue is admin-only (403 member, 401 anonymous) and 404s an unknown email", async () => {
    const backend = await setup();
    const adminCookie = await register(backend, "admin3@example.com", "admin-password-1");
    const memberCookie = await register(backend, "pleb@example.com", "member-password-1");

    const asMember = await backend.fetch(
      jsonReq("POST", "/api/auth/password-reset/issue", { email: "admin3@example.com" }, { cookie: memberCookie }),
    );
    expect(asMember.status).toBe(403);

    const anon = await backend.fetch(jsonReq("POST", "/api/auth/password-reset/issue", { email: "admin3@example.com" }));
    expect(anon.status).toBe(401);

    const unknown = await backend.fetch(
      jsonReq("POST", "/api/auth/password-reset/issue", { email: "ghost@example.com" }, { cookie: adminCookie }),
    );
    expect(unknown.status).toBe(404);
  });

  it("bogus and weak-password confirms fail without touching anything", async () => {
    const backend = await setup();
    await register(backend, "solo@example.com", "solo-password-1");

    const bogus = await backend.fetch(
      jsonReq("POST", "/api/auth/password-reset/confirm", { token: "rst_totally-bogus", newPassword: "fine-password-1" }),
    );
    expect(bogus.status).toBe(404);

    const weak = await backend.fetch(
      jsonReq("POST", "/api/auth/password-reset/confirm", { token: "rst_whatever", newPassword: "short" }),
    );
    expect(weak.status).toBe(422);

    expect(await loginStatus(backend, "solo@example.com", "solo-password-1")).toBe(200);
  });

  it("issuing a new token invalidates the previously-issued one (one outstanding token per user)", async () => {
    const backend = await setup();
    const adminCookie = await register(backend, "admin4@example.com", "admin-password-1");
    await register(backend, "twice@example.com", "member-password-1");

    const first = ((await (
      await backend.fetch(jsonReq("POST", "/api/auth/password-reset/issue", { email: "twice@example.com" }, { cookie: adminCookie }))
    ).json()) as { data: { resetToken: string } }).data.resetToken;
    const second = ((await (
      await backend.fetch(jsonReq("POST", "/api/auth/password-reset/issue", { email: "twice@example.com" }, { cookie: adminCookie }))
    ).json()) as { data: { resetToken: string } }).data.resetToken;

    const staleRes = await backend.fetch(
      jsonReq("POST", "/api/auth/password-reset/confirm", { token: first, newPassword: "via-stale-token-1" }),
    );
    expect(staleRes.status).toBe(404);

    const freshRes = await backend.fetch(
      jsonReq("POST", "/api/auth/password-reset/confirm", { token: second, newPassword: "via-fresh-token-1" }),
    );
    expect(freshRes.status).toBe(200);
  });

  it("changing the password clears an outstanding reset token", async () => {
    const backend = await setup();
    const adminCookie = await register(backend, "admin5@example.com", "admin-password-1");
    const memberCookie = await register(backend, "cleared@example.com", "member-password-1");

    const { resetToken } = ((await (
      await backend.fetch(jsonReq("POST", "/api/auth/password-reset/issue", { email: "cleared@example.com" }, { cookie: adminCookie }))
    ).json()) as { data: { resetToken: string } }).data;

    const change = await backend.fetch(
      jsonReq(
        "POST",
        "/api/auth/password",
        { currentPassword: "member-password-1", newPassword: "self-changed-2" },
        { cookie: memberCookie },
      ),
    );
    expect(change.status).toBe(200);

    const confirm = await backend.fetch(
      jsonReq("POST", "/api/auth/password-reset/confirm", { token: resetToken, newPassword: "via-dead-token-1" }),
    );
    expect(confirm.status).toBe(404);
  });
});

describe("POST /api/auth/password-reset/request (self-serve, mailer-gated)", { timeout: 30_000 }, () => {
  it("answers 202 identically for existing and unknown emails when no mailer is configured, and mints nothing", async () => {
    const backend = await setup();
    await register(backend, "nomailer@example.com", "member-password-1");

    for (const email of ["nomailer@example.com", "ghost@example.com", "not-an-email"]) {
      const res = await backend.fetch(jsonReq("POST", "/api/auth/password-reset/request", { email }));
      expect(res.status).toBe(202);
      expect(((await res.json()) as { data: { ok: boolean } }).data.ok).toBe(true);
    }
  });

  it("with a mailer: delivers a working token for an existing email, stays silent (202, no call) for unknown", async () => {
    const delivered: PasswordResetInfo[] = [];
    const backend = await setup({
      resetMailer: async (info) => {
        delivered.push(info);
      },
    });
    await register(backend, "mailme@example.com", "member-password-1");

    const known = await backend.fetch(jsonReq("POST", "/api/auth/password-reset/request", { email: "mailme@example.com" }));
    expect(known.status).toBe(202);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.email).toBe("mailme@example.com");

    const unknown = await backend.fetch(jsonReq("POST", "/api/auth/password-reset/request", { email: "ghost@example.com" }));
    expect(unknown.status).toBe(202);
    expect(delivered).toHaveLength(1);

    // The delivered token really works.
    const confirm = await backend.fetch(
      jsonReq("POST", "/api/auth/password-reset/confirm", { token: delivered[0]!.resetToken, newPassword: "mailed-reset-2" }),
    );
    expect(confirm.status).toBe(200);
    expect(await loginStatus(backend, "mailme@example.com", "mailed-reset-2")).toBe(200);
  });

  it("a mailer that throws still yields 202 (no oracle) and the token stays usable", async () => {
    const delivered: PasswordResetInfo[] = [];
    const backend = await setup({
      resetMailer: async (info) => {
        delivered.push(info);
        throw new Error("smtp down");
      },
    });
    await register(backend, "flaky@example.com", "member-password-1");

    const res = await backend.fetch(jsonReq("POST", "/api/auth/password-reset/request", { email: "flaky@example.com" }));
    expect(res.status).toBe(202);
    expect(delivered).toHaveLength(1);
  });
});
