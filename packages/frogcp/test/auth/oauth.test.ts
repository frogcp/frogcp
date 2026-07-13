import { describe, it, expect } from "vitest";
import { count } from "drizzle-orm";
import { Hono } from "hono";
import { nodeSqliteAdapter } from "frogcp/adapter/node";
import {
  createBackend,
  defineBackend,
  type Backend,
  type DatabaseAdapter,
  type DataEventPayload,
  type FrogPlugin,
  type KernelContext,
} from "frogcp";
import { authPlugin } from "../../src/auth/index";
import { createOAuthUser } from "../../src/auth/oauth";
import { sqliteDb } from "../../src/auth/routes";

const BASE = "http://x";
const TEST_SECRET = "test-secret-at-least-32-bytes-long!!";
const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret";
const ISSUER = "http://mock-issuer.test";

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`${BASE}${path}`, init);
}

/** Pulls every `name=value` pair (dropping attributes) out of a response's
 * `Set-Cookie` header(s), a callback response sets TWO (session + cleared
 * oauth-state), so callers filter this list by name prefix rather than
 * assuming there's exactly one, unlike `routes.test.ts`'s single-cookie helper. */
function cookiePairs(res: Response): string[] {
  return res.headers.getSetCookie().map((raw) => {
    const pair = raw.split(";")[0];
    if (!pair) throw new Error("malformed Set-Cookie header");
    return pair;
  });
}

function findCookie(res: Response, name: string): string {
  const pair = cookiePairs(res).find((c) => c.startsWith(`${name}=`));
  if (!pair) throw new Error(`expected a "${name}" cookie in the response`);
  return pair;
}

/** Parses the `state` query param straight off a redirect's `Location` header. */
function stateFromLocation(res: Response): string {
  const location = res.headers.get("location");
  if (!location) throw new Error("expected a Location header");
  const state = new URL(location).searchParams.get("state");
  if (!state) throw new Error("expected a state query param on the authorize redirect");
  return state;
}

/**
 * An in-process mock OIDC issuer (a plain Hono app, served via `fetchImpl`
 * injection rather than a real network call, see `oauth.ts`'s `fetchImpl`
 * parameter). Recognizes a small fixed table of authorization codes so each
 * test scenario (happy path, same-subject relogin, cross-provider same
 * email, missing email, upstream token failure) gets a distinct, readable code.
 */
function buildMockIssuer(): Hono {
  const app = new Hono();

  app.get("/.well-known/openid-configuration", (c) =>
    c.json({
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      userinfo_endpoint: `${ISSUER}/userinfo`,
    }),
  );

  // code -> access_token. Deliberately does NOT cover "bad" (simulates a
  // provider-side token-exchange failure) or "null-token" (a hostile/broken
  // provider replying literal JSON `null` with a 200).
  const ACCESS_TOKENS: Record<string, string> = {
    good: "token-alice",
    "good-again": "token-alice-again",
    "good-other-provider": "token-other-provider",
    "no-email": "token-no-email",
    "verified-true": "token-verified-true",
    "unverified-collision": "token-unverified-collision",
    "unverified-fresh": "token-unverified-fresh",
    "string-false-verified": "token-string-false-verified",
  };

  app.post("/token", async (c) => {
    const body = await c.req.parseBody();
    if (body.client_id !== CLIENT_ID || body.client_secret !== CLIENT_SECRET) {
      return c.json({ error: "invalid_client, this text must never reach our caller" }, 400);
    }
    if (body.grant_type !== "authorization_code") {
      return c.json({ error: "unsupported_grant_type" }, 400);
    }
    if (typeof body.redirect_uri !== "string" || !body.redirect_uri.endsWith("/callback")) {
      return c.json({ error: "invalid_request: bad redirect_uri" }, 400);
    }
    const code = typeof body.code === "string" ? body.code : "";
    if (code === "null-token") return c.json(null); // valid JSON, hostile shape
    const accessToken = ACCESS_TOKENS[code];
    if (!accessToken) return c.json({ error: "invalid_grant, this text must never reach our caller" }, 400);
    return c.json({ access_token: accessToken });
  });

  app.get("/userinfo", (c) => {
    const auth = c.req.header("authorization");
    // No `email_verified` claim at all on the three "good" identities, the
    // documented default (absent = verified) is what every linking test
    // below exercises unless it says otherwise.
    if (auth === "Bearer token-alice" || auth === "Bearer token-alice-again") {
      return c.json({ sub: "alice-sub", email: "Alice@Example.com", name: "Alice" });
    }
    if (auth === "Bearer token-other-provider") {
      // Same person, different provider: same (normalized) email, different subject.
      return c.json({ sub: "other-sub", email: "alice@example.com", name: "Alice Elsewhere" });
    }
    if (auth === "Bearer token-no-email") {
      return c.json({ sub: "no-email-sub" }); // no `email` at all
    }
    if (auth === "Bearer token-verified-true") {
      return c.json({ sub: "vt-sub", email: "Victim@Example.com", email_verified: true, name: "Verified Alice" });
    }
    if (auth === "Bearer token-unverified-collision") {
      // The takeover attempt: an IdP account asserting someone ELSE's email, unverified.
      return c.json({ sub: "attacker-sub", email: "victim@example.com", email_verified: false, name: "Mallory" });
    }
    if (auth === "Bearer token-unverified-fresh") {
      return c.json({ sub: "fresh-sub", email: "fresh.unverified@example.com", email_verified: false, name: "Newcomer" });
    }
    if (auth === "Bearer token-string-false-verified") {
      // A hostile/broken provider sending the STRING "false" rather than the
      // boolean, must be treated as unverified, same as the real `false`.
      return c.json({ sub: "string-false-sub", email: "stringfalse@example.com", email_verified: "false", name: "Sneaky" });
    }
    return c.json({ error: "invalid_token" }, 401);
  });

  return app;
}

const mockIssuer = buildMockIssuer();
const mockFetch: typeof fetch = (input, init) => Promise.resolve(mockIssuer.request(input as string, init));

async function setup(): Promise<{ backend: Backend; adapter: DatabaseAdapter; kernelCtx: KernelContext }> {
  const adapter: DatabaseAdapter = nodeSqliteAdapter(":memory:");
  let kernelCtx: KernelContext | undefined;
  const capturePlugin: FrogPlugin = { name: "capture", onBoot: (ctx) => void (kernelCtx = ctx) };

  const backend = await createBackend({
    config: defineBackend({ entities: {} }),
    adapter,
    plugins: [
      authPlugin({
        secret: TEST_SECRET,
        baseUrl: BASE,
        oauthFetch: mockFetch,
        oauth: {
          github: { clientId: "gh-client-id", clientSecret: "gh-client-secret" },
          oidc: [
            { name: "test", issuer: ISSUER, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
            { name: "test2", issuer: ISSUER, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
          ],
        },
      }),
      capturePlugin,
    ],
  });
  if (!kernelCtx) throw new Error("unreachable: onBoot always runs before createBackend resolves");
  return { backend, adapter, kernelCtx };
}

function usersTable(kernelCtx: KernelContext) {
  const table = kernelCtx.tables.users;
  if (!table) throw new Error("unreachable: authPlugin always registers a users table");
  return table;
}

function oauthAccountsTable(kernelCtx: KernelContext) {
  const table = kernelCtx.tables.oauthAccounts;
  if (!table) throw new Error("unreachable: authPlugin always registers an oauthAccounts table");
  return table;
}

async function rowCount(kernelCtx: KernelContext, table: ReturnType<typeof usersTable>): Promise<number> {
  const [row] = await sqliteDb(kernelCtx).select({ total: count() }).from(table);
  return row?.total ?? 0;
}

/** Registers an email/password user through the real register route, returning the new user's id. */
async function registerPasswordUser(backend: Backend, email: string): Promise<string> {
  const res = await backend.fetch(
    req("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password: "correcthorse1" }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { data: { user: { id: string } } };
  return body.data.user.id;
}

/** Drives one full authorize -> callback round trip for `provider`/`code`, returning the callback response. */
async function runOAuthFlow(backend: Backend, provider: string, code: string): Promise<Response> {
  const authorizeRes = await backend.fetch(req(`/api/auth/oauth/${provider}`));
  expect(authorizeRes.status).toBe(302);
  const state = stateFromLocation(authorizeRes);
  const stateCookie = findCookie(authorizeRes, "frogcp_oauth_state");

  return backend.fetch(
    req(`/api/auth/oauth/${provider}/callback?code=${code}&state=${state}`, {
      headers: { cookie: stateCookie },
    }),
  );
}

describe("GET /api/auth/oauth/:provider (authorize redirect)", () => {
  it("302s to the provider's authorization endpoint with client_id/redirect_uri/scope/state, and sets the state cookie", async () => {
    const { backend } = await setup();
    const res = await backend.fetch(req("/api/auth/oauth/test"));
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(`${ISSUER}/authorize`);
    expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(location.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/oauth/test/callback`);
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("scope")).toBe("openid email profile");
    expect(location.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);

    const stateCookie = findCookie(res, "frogcp_oauth_state");
    expect(stateCookie).toBe(`frogcp_oauth_state=${location.searchParams.get("state")}`);
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
    expect(res.headers.get("set-cookie")).toContain("Max-Age=600");
  });

  it("the GitHub preset redirects to github.com with its fixed scope, no network call needed for this step", async () => {
    const { backend } = await setup();
    const res = await backend.fetch(req("/api/auth/oauth/github"));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("scope")).toBe("read:user user:email");
  });

  it("unknown provider is a 404", async () => {
    const { backend } = await setup();
    const res = await backend.fetch(req("/api/auth/oauth/nope"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });
});

describe("GET /api/auth/oauth/:provider/callback", () => {
  it("happy path: creates a user (normalized email), links an oauthAccounts row, sets a session cookie, and clears the state cookie", async () => {
    const { backend, kernelCtx } = await setup();
    const res = await runOAuthFlow(backend, "test", "good");

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");

    const sessionCookie = findCookie(res, "frogcp_session");
    const clearedState = findCookie(res, "frogcp_oauth_state");
    expect(clearedState).toBe("frogcp_oauth_state=");

    const meRes = await backend.fetch(req("/api/auth/me", { headers: { cookie: sessionCookie } }));
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { data: { user: { email: string; role: string } } };
    expect(me.data.user.email).toBe("alice@example.com"); // normalized from "Alice@Example.com"
    expect(me.data.user.role).toBe("admin"); // first-ever user, via OAuth

    const accounts = (await sqliteDb(kernelCtx).select().from(oauthAccountsTable(kernelCtx))) as {
      provider: string;
      subject: string;
    }[];
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ provider: "test", subject: "alice-sub" });
  });

  it("unknown provider is a 404", async () => {
    const { backend } = await setup();
    const res = await backend.fetch(req("/api/auth/oauth/nope/callback?code=x&state=y"));
    expect(res.status).toBe(404);
  });

  it("state mismatch is a 403 that clears the state cookie and sets no session cookie", async () => {
    const { backend } = await setup();
    const authorizeRes = await backend.fetch(req("/api/auth/oauth/test"));
    const stateCookie = findCookie(authorizeRes, "frogcp_oauth_state");

    const res = await backend.fetch(
      req("/api/auth/oauth/test/callback?code=good&state=not-the-real-state", { headers: { cookie: stateCookie } }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body).toEqual({ error: { code: "forbidden", message: "invalid oauth state" } });

    // The error exit still clears the state cookie, and only that cookie.
    expect(findCookie(res, "frogcp_oauth_state")).toBe("frogcp_oauth_state=");
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(cookiePairs(res).some((c) => c.startsWith("frogcp_session="))).toBe(false);
  });

  it("missing state cookie entirely is a 403 (with the clearing Set-Cookie)", async () => {
    const { backend } = await setup();
    const authorizeRes = await backend.fetch(req("/api/auth/oauth/test"));
    const state = stateFromLocation(authorizeRes);

    const res = await backend.fetch(req(`/api/auth/oauth/test/callback?code=good&state=${state}`));
    expect(res.status).toBe(403);
    expect(findCookie(res, "frogcp_oauth_state")).toBe("frogcp_oauth_state=");
  });

  it("a token-exchange failure (upstream 400) is a 502 oauth_upstream with no upstream text leaked, and clears the state cookie", async () => {
    const { backend } = await setup();
    const res = await runOAuthFlow(backend, "test", "bad");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("oauth_upstream");
    expect(body.error.message).not.toMatch(/invalid_grant|invalid_client|upstream/i);
    expect(findCookie(res, "frogcp_oauth_state")).toBe("frogcp_oauth_state=");
  });

  it("a token endpoint replying literal JSON null (200) is a 502 oauth_upstream, not a crash", async () => {
    const { backend } = await setup();
    const res = await runOAuthFlow(backend, "test", "null-token");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("oauth_upstream");
  });

  it("userinfo missing an email is a 502 oauth_upstream", async () => {
    const { backend } = await setup();
    const res = await runOAuthFlow(backend, "test", "no-email");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("oauth_upstream");
  });

  it("a second login with the same (provider, subject) reuses the SAME user, no duplicate row", async () => {
    const { backend, kernelCtx } = await setup();
    const first = await runOAuthFlow(backend, "test", "good");
    const firstCookie = findCookie(first, "frogcp_session");
    const firstMe = (await (await backend.fetch(req("/api/auth/me", { headers: { cookie: firstCookie } }))).json()) as {
      data: { user: { id: string } };
    };

    const second = await runOAuthFlow(backend, "test", "good-again");
    expect(second.status).toBe(302);
    const secondCookie = findCookie(second, "frogcp_session");
    const secondMe = (await (await backend.fetch(req("/api/auth/me", { headers: { cookie: secondCookie } }))).json()) as {
      data: { user: { id: string } };
    };

    expect(secondMe.data.user.id).toBe(firstMe.data.user.id);
    expect(await rowCount(kernelCtx, usersTable(kernelCtx))).toBe(1);
    expect(await rowCount(kernelCtx, oauthAccountsTable(kernelCtx))).toBe(1);
  });

  it("a DIFFERENT provider with the SAME (normalized) email links to the existing user: one users row, two oauthAccounts rows", async () => {
    const { backend, kernelCtx } = await setup();
    const first = await runOAuthFlow(backend, "test", "good");
    const firstCookie = findCookie(first, "frogcp_session");
    const firstMe = (await (await backend.fetch(req("/api/auth/me", { headers: { cookie: firstCookie } }))).json()) as {
      data: { user: { id: string } };
    };

    const second = await runOAuthFlow(backend, "test2", "good-other-provider");
    expect(second.status).toBe(302);
    const secondCookie = findCookie(second, "frogcp_session");
    const secondMe = (await (await backend.fetch(req("/api/auth/me", { headers: { cookie: secondCookie } }))).json()) as {
      data: { user: { id: string } };
    };

    expect(secondMe.data.user.id).toBe(firstMe.data.user.id);
    expect(await rowCount(kernelCtx, usersTable(kernelCtx))).toBe(1);
    expect(await rowCount(kernelCtx, oauthAccountsTable(kernelCtx))).toBe(2);

    const accounts = (await sqliteDb(kernelCtx).select().from(oauthAccountsTable(kernelCtx))) as {
      provider: string;
      subject: string;
      user: string;
    }[];
    expect(accounts.map((a) => a.provider).sort()).toEqual(["test", "test2"]);
    expect(new Set(accounts.map((a) => a.user)).size).toBe(1);
  });

  it("an OAuth-only user (no passwordHash) gets a clean 401, never a crash, on a password login attempt", async () => {
    const { backend } = await setup();
    await runOAuthFlow(backend, "test", "good");

    const res = await backend.fetch(
      new Request(`${BASE}/api/auth/login`, {
        method: "POST",
        body: JSON.stringify({ email: "alice@example.com", password: "whatever-guess" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });
});

describe("email_verified semantics (linking gate, fail-closed: unverified can neither link NOR create)", () => {
  it("email_verified:false asserting an EXISTING user's email is a 403 forbidden, victim untouched, no session issued", async () => {
    // Fail-closed per the security fix: an unverified identity is refused
    // OUTRIGHT (403, before any insert is even attempted) rather than being
    // allowed to create a colliding row that then surfaces as a 409. Same
    // net protection for the victim, just caught one step earlier.
    const { backend, kernelCtx } = await setup();
    const victimId = await registerPasswordUser(backend, "victim@example.com");

    const res = await runOAuthFlow(backend, "test", "unverified-collision");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("forbidden");
    expect(body.error.message).toBe("email not verified by provider");
    expect(cookiePairs(res).some((c) => c.startsWith("frogcp_session="))).toBe(false);
    expect(findCookie(res, "frogcp_oauth_state")).toBe("frogcp_oauth_state="); // error exit still cleans up

    // Victim's account is completely untouched: still the only users row,
    // no oauthAccounts link was created, and their password still works.
    expect(await rowCount(kernelCtx, usersTable(kernelCtx))).toBe(1);
    expect(await rowCount(kernelCtx, oauthAccountsTable(kernelCtx))).toBe(0);
    const loginRes = await backend.fetch(
      new Request(`${BASE}/api/auth/login`, {
        method: "POST",
        body: JSON.stringify({ email: "victim@example.com", password: "correcthorse1" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(loginRes.status).toBe(200);
    const login = (await loginRes.json()) as { data: { user: { id: string } } };
    expect(login.data.user.id).toBe(victimId);
  });

  it("email_verified:false with a previously unseen email is ALSO a 403 forbidden, it cannot onboard via OAuth at all, not even a fresh account", async () => {
    const { backend, kernelCtx } = await setup();
    const res = await runOAuthFlow(backend, "test", "unverified-fresh");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("forbidden");
    expect(body.error.message).toBe("email not verified by provider");
    expect(cookiePairs(res).some((c) => c.startsWith("frogcp_session="))).toBe(false);

    expect(await rowCount(kernelCtx, usersTable(kernelCtx))).toBe(0);
    expect(await rowCount(kernelCtx, oauthAccountsTable(kernelCtx))).toBe(0);
  });

  it('email_verified as the STRING "false" (not the boolean) is also treated as unverified, 403 forbidden, not silently accepted as verified', async () => {
    const { backend, kernelCtx } = await setup();
    const res = await runOAuthFlow(backend, "test", "string-false-verified");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
    expect(await rowCount(kernelCtx, usersTable(kernelCtx))).toBe(0);
  });

  it("email_verified:true links to the existing password user (normalized email match)", async () => {
    const { backend, kernelCtx } = await setup();
    const victimId = await registerPasswordUser(backend, "victim@example.com");

    const res = await runOAuthFlow(backend, "test", "verified-true"); // userinfo email is "Victim@Example.com", verified
    expect(res.status).toBe(302);
    const sessionCookie = findCookie(res, "frogcp_session");
    const me = (await (await backend.fetch(req("/api/auth/me", { headers: { cookie: sessionCookie } }))).json()) as {
      data: { user: { id: string } };
    };
    expect(me.data.user.id).toBe(victimId);
    expect(await rowCount(kernelCtx, usersTable(kernelCtx))).toBe(1);
    expect(await rowCount(kernelCtx, oauthAccountsTable(kernelCtx))).toBe(1);
  });

  it("an ABSENT email_verified claim links to the existing password user (documented default: absent = verified)", async () => {
    const { backend, kernelCtx } = await setup();
    const existingId = await registerPasswordUser(backend, "alice@example.com");

    const res = await runOAuthFlow(backend, "test", "good"); // "good" userinfo carries no email_verified claim at all
    expect(res.status).toBe(302);
    const sessionCookie = findCookie(res, "frogcp_session");
    const me = (await (await backend.fetch(req("/api/auth/me", { headers: { cookie: sessionCookie } }))).json()) as {
      data: { user: { id: string } };
    };
    expect(me.data.user.id).toBe(existingId);
    expect(await rowCount(kernelCtx, usersTable(kernelCtx))).toBe(1);
  });
});

describe("record.created events", () => {
  it("a brand-new OAuth user fires record.created (hidden fields stripped); linking an existing user does NOT re-fire it", async () => {
    const { backend } = await setup();
    const seen: DataEventPayload[] = [];
    backend.events.on("record.created", (payload) => {
      seen.push(payload);
    });

    const first = await runOAuthFlow(backend, "test", "good");
    expect(first.status).toBe(302);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.entity).toBe("users");
    expect(seen[0]?.ctx).toBeNull();
    expect(seen[0]?.row.email).toBe("alice@example.com");
    expect("passwordHash" in seen[0]!.row).toBe(false);

    // A second login for the SAME (provider, subject) reuses the existing
    // user, no new `users` row, so no additional record.created fires.
    const second = await runOAuthFlow(backend, "test", "good-again");
    expect(second.status).toBe(302);
    expect(seen).toHaveLength(1);
  });
});

describe("createOAuthUser unique-violation recovery", () => {
  // The real race window (the email appearing between resolveOAuthUser's
  // lookup and the insert) cannot be forced through the HTTP surface, so
  // these call the exported creation step directly with an email that
  // ALREADY exists, a sequential simulation proving exactly what the
  // catch does when the insert collides. It does NOT prove the
  // interleaving itself.
  it("a verified email colliding at insert time self-heals: re-queries and returns the existing user's id", async () => {
    const { backend, kernelCtx } = await setup();
    const existingId = await registerPasswordUser(backend, "racer@example.com");

    const id = await createOAuthUser(kernelCtx, "racer@example.com", "Racer", true);
    expect(id).toBe(existingId);
    expect(await rowCount(kernelCtx, usersTable(kernelCtx))).toBe(1); // no duplicate row was left behind
  });

  it("an UNVERIFIED email throws 403 forbidden immediately, before any insert is attempted, whether or not the email already exists", async () => {
    const { backend, kernelCtx } = await setup();
    await registerPasswordUser(backend, "racer@example.com");

    // Colliding email: still a 403 (fail-closed), never the 409 a
    // verified-but-colliding call would produce, the guard runs first.
    await expect(createOAuthUser(kernelCtx, "racer@example.com", "Mallory", false)).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });
    expect(await rowCount(kernelCtx, usersTable(kernelCtx))).toBe(1);

    // Non-colliding email: same 403, an unverified identity cannot create
    // ANY new account, not just ones that happen to collide.
    await expect(createOAuthUser(kernelCtx, "nobody-yet@example.com", "Mallory", false)).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });
    expect(await rowCount(kernelCtx, usersTable(kernelCtx))).toBe(1);
  });
});
