import { describe, it, expect } from "vitest";
import { SignJWT, UnsecuredJWT, generateKeyPair, exportJWK, createLocalJWKSet } from "jose";
import { nodeSqliteAdapter } from "frogcp/adapter/node";
import {
  createBackend,
  defineBackend,
  entity,
  rule,
  text,
  type Backend,
  type Ctx,
  type DatabaseAdapter,
  type FrogPlugin,
} from "frogcp";
import { jwtVerifyPlugin, type JwtVerifyOptions } from "../../src/auth/jwt-verify";

const SECRET = "test-secret-at-least-32-bytes-long!!";

/** Signs an HS256 test token. `claims` is the full payload object (so `sub`,
 * `role`, `iss`, `aud`, or any custom claim name can be set directly without
 * a `.setXxx()` builder call per field). */
async function signHS(
  claims: Record<string, unknown>,
  opts: { secret?: string; alg?: string; ttlSeconds?: number } = {},
): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSeconds ?? 3600;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: opts.alg ?? "HS256" })
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttl)
    .sign(new TextEncoder().encode(opts.secret ?? SECRET));
}

/** Builds a request carrying `token` as `Authorization: Bearer <token>` (when
 * given), merged with any other `RequestInit` fields (method/body/headers). */
function bearerReq(path: string, token?: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request(`http://x${path}`, { ...init, headers });
}

function jsonReq(method: string, path: string, body: unknown, token?: string): Request {
  return bearerReq(path, token, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

/** Pulls the `identify` function off a `FrogPlugin`, failing loudly (rather
 * than silently resolving every request to guest) if `jwtVerifyPlugin` ever
 * stopped providing one. */
function identifyOf(plugin: FrogPlugin): (req: Request) => Promise<Ctx> {
  const fn = plugin.identify;
  if (!fn) throw new Error("unreachable: jwtVerifyPlugin always defines identify");
  return async (req) => fn(req);
}

describe("jwtVerifyPlugin construction", () => {
  it("throws when neither secret nor jwksUrl is provided", () => {
    expect(() => jwtVerifyPlugin({})).toThrow(/exactly one/);
  });

  it("throws when both secret and jwksUrl are provided", () => {
    expect(() => jwtVerifyPlugin({ secret: SECRET, jwksUrl: "https://issuer.example/jwks.json" })).toThrow(
      /exactly one/,
    );
  });

  it("throws when secret is shorter than 32 characters", () => {
    expect(() => jwtVerifyPlugin({ secret: "too-short" })).toThrow(/32/);
  });

  it("accepts a secret exactly 32 characters long", () => {
    expect(() => jwtVerifyPlugin({ secret: "x".repeat(32) })).not.toThrow();
  });

  it("accepts a jwksUrl with no secret", () => {
    expect(() => jwtVerifyPlugin({ jwksUrl: "https://issuer.example/.well-known/jwks.json" })).not.toThrow();
  });

  it("the plugin is identify-only: no entities, routes, or onBoot", () => {
    const plugin = jwtVerifyPlugin({ secret: SECRET });
    expect(plugin.name).toBe("jwt-verify");
    expect(plugin.entities).toBeUndefined();
    expect(plugin.routes).toBeUndefined();
    expect(plugin.onBoot).toBeUndefined();
    expect(typeof plugin.identify).toBe("function");
  });
});

describe("jwtVerifyPlugin, HS256 secret mode", () => {
  it("a valid token resolves userId from `sub` and role from the `role` claim, with the full payload as claims", async () => {
    const identify = identifyOf(jwtVerifyPlugin({ secret: SECRET }));
    const token = await signHS({ sub: "alice", role: "editor" });

    const ctx = await identify(bearerReq("/", token));
    expect(ctx).toMatchObject({ userId: "alice", role: "editor" });
    expect(ctx?.claims).toMatchObject({ sub: "alice", role: "editor" });
    expect(typeof ctx?.claims?.iat).toBe("number");
  });

  it('a missing role claim falls back to "member" (never "admin")', async () => {
    const identify = identifyOf(jwtVerifyPlugin({ secret: SECRET }));
    const token = await signHS({ sub: "alice" });

    expect(await identify(bearerReq("/", token))).toMatchObject({ userId: "alice", role: "member" });
  });

  it("a non-string/empty role claim also falls back to \"member\"", async () => {
    const identify = identifyOf(jwtVerifyPlugin({ secret: SECRET }));
    const token = await signHS({ sub: "alice", role: "" });

    expect(await identify(bearerReq("/", token))).toMatchObject({ userId: "alice", role: "member" });
  });

  it("honors a custom roleClaim and userIdClaim", async () => {
    const identify = identifyOf(jwtVerifyPlugin({ secret: SECRET, roleClaim: "perm", userIdClaim: "uid" }));
    const token = await signHS({ uid: "u-42", perm: "admin" });

    expect(await identify(bearerReq("/", token))).toMatchObject({ userId: "u-42", role: "admin" });
  });

  it("a missing/non-string/empty userId claim resolves to guest (not an identity with an empty userId)", async () => {
    const identify = identifyOf(jwtVerifyPlugin({ secret: SECRET }));
    const noSub = await signHS({ role: "member" });
    const emptySub = await signHS({ sub: "" });

    expect(await identify(bearerReq("/", noSub))).toBeNull();
    expect(await identify(bearerReq("/", emptySub))).toBeNull();
  });

  it("a bad signature (wrong secret) resolves to guest", async () => {
    const identify = identifyOf(jwtVerifyPlugin({ secret: SECRET }));
    const token = await signHS({ sub: "alice" }, { secret: "a-totally-different-secret-value!!!" });

    expect(await identify(bearerReq("/", token))).toBeNull();
  });

  it("an expired token resolves to guest", async () => {
    const identify = identifyOf(jwtVerifyPlugin({ secret: SECRET }));
    const token = await signHS({ sub: "alice" }, { ttlSeconds: -1 });

    expect(await identify(bearerReq("/", token))).toBeNull();
  });

  it("a wrong issuer resolves to guest when issuer is constrained", async () => {
    const identify = identifyOf(jwtVerifyPlugin({ secret: SECRET, issuer: "https://issuer.example" }));
    const token = await signHS({ sub: "alice", iss: "https://someone-else.example" });

    expect(await identify(bearerReq("/", token))).toBeNull();
  });

  it("a wrong audience resolves to guest when audience is constrained", async () => {
    const identify = identifyOf(jwtVerifyPlugin({ secret: SECRET, audience: "my-api" }));
    const token = await signHS({ sub: "alice", aud: "someone-elses-api" });

    expect(await identify(bearerReq("/", token))).toBeNull();
  });

  it("a matching issuer and audience verifies successfully", async () => {
    const identify = identifyOf(
      jwtVerifyPlugin({ secret: SECRET, issuer: "https://issuer.example", audience: "my-api" }),
    );
    const token = await signHS({ sub: "alice", iss: "https://issuer.example", aud: "my-api" });

    expect(await identify(bearerReq("/", token))).toMatchObject({ userId: "alice" });
  });

  it('an alg:"none" unsecured token resolves to guest', async () => {
    const identify = identifyOf(jwtVerifyPlugin({ secret: SECRET }));
    const iat = Math.floor(Date.now() / 1000);
    const token = new UnsecuredJWT({ sub: "alice" })
      .setIssuedAt(iat)
      .setExpirationTime(iat + 3600)
      .encode();

    expect(await identify(bearerReq("/", token))).toBeNull();
  });

  it("garbage input resolves to guest without throwing", async () => {
    const identify = identifyOf(jwtVerifyPlugin({ secret: SECRET }));

    await expect(identify(bearerReq("/", "not.a.jwt"))).resolves.toBeNull();
    await expect(identify(bearerReq("/", "complete garbage"))).resolves.toBeNull();
  });

  it("no token at all resolves to guest", async () => {
    const identify = identifyOf(jwtVerifyPlugin({ secret: SECRET }));
    expect(await identify(bearerReq("/"))).toBeNull();
  });

  it("is bearer-only: a token presented only as a cookie is ignored (guest)", async () => {
    const identify = identifyOf(jwtVerifyPlugin({ secret: SECRET }));
    const token = await signHS({ sub: "alice" });
    const req = new Request("http://x/", { headers: { cookie: `frogcp_session=${token}` } });

    expect(await identify(req)).toBeNull();
  });
});

describe("jwtVerifyPlugin, JWKS mode (internal `jwks` test-only override)", () => {
  it("a valid RS256 token verified against a local JWKS resolves the identity", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk = await exportJWK(publicKey);
    const jwks = createLocalJWKSet({ keys: [{ ...jwk, alg: "RS256", use: "sig" }] });

    const identify = identifyOf(jwtVerifyPlugin({ jwks } as JwtVerifyOptions));

    const iat = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sub: "alice", role: "editor" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt(iat)
      .setExpirationTime(iat + 3600)
      .sign(privateKey);

    expect(await identify(bearerReq("/", token))).toMatchObject({ userId: "alice", role: "editor" });
  });

  it("alg-confusion: an HS256 token presented to a JWKS-mode plugin resolves to guest", async () => {
    const { publicKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk = await exportJWK(publicKey);
    const jwks = createLocalJWKSet({ keys: [{ ...jwk, alg: "RS256", use: "sig" }] });

    const identify = identifyOf(jwtVerifyPlugin({ jwks } as JwtVerifyOptions));

    // Signed with HS256 using the (public!) RSA modulus bytes as if they were
    // an HMAC secret, the classic alg-confusion forgery. Must be rejected.
    const forged = await signHS({ sub: "attacker" }, { secret: JSON.stringify(jwk), alg: "HS256" });

    expect(await identify(bearerReq("/", forged))).toBeNull();
  });

  it("an expired RS256 token resolves to guest", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk = await exportJWK(publicKey);
    const jwks = createLocalJWKSet({ keys: [{ ...jwk, alg: "RS256", use: "sig" }] });
    const identify = identifyOf(jwtVerifyPlugin({ jwks } as JwtVerifyOptions));

    const iat = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sub: "alice" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt(iat)
      .setExpirationTime(iat - 1)
      .sign(privateKey);

    expect(await identify(bearerReq("/", token))).toBeNull();
  });
});

describe("jwtVerifyPlugin, swappability proof: the permission engine consuming a completely different identity source", () => {
  // Deliberately NOT `ref("users")`, there is no `users` table anywhere in
  // this backend's config (no `authPlugin`, no auth entities at all).
  // `rule.owner()` only needs a text-compatible field to compare against
  // `ctx.userId`; it has no requirement that the field be a foreign key.
  const notesConfig = defineBackend({
    entities: {
      notes: entity({
        title: text().required(),
        owner: text().required(),
      }).permissions({
        create: rule.authenticated(),
        read: rule.owner("owner"),
        list: rule.owner("owner"),
        update: rule.owner("owner"),
        delete: rule.owner("owner"),
      }),
    },
  });

  async function setup(): Promise<{ backend: Backend }> {
    const adapter: DatabaseAdapter = nodeSqliteAdapter(":memory:");
    const backend = await createBackend({
      config: notesConfig,
      adapter,
      // ONLY jwtVerifyPlugin, no authPlugin, no users entity, no session
      // cookies. This is the whole point of the task: the same permission
      // engine (owner rules, admin bypass) consuming a totally different
      // auth provider.
      plugins: [jwtVerifyPlugin({ secret: SECRET })],
    });
    return { backend };
  }

  it("alice (from the token's sub claim) CRUDs her own rows but cannot touch bob's (404, no existence oracle)", async () => {
    const { backend } = await setup();
    const aliceToken = await signHS({ sub: "alice" });
    const bobToken = await signHS({ sub: "bob" });

    const createRes = await backend.fetch(
      jsonReq("POST", "/api/entity/notes", { title: "Alice's note" }, aliceToken),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { data: { id: string; owner: string } };
    // The engine stamps the owner field from ctx.userId itself, the client
    // never sent an `owner` value in the create payload.
    expect(created.data.owner).toBe("alice");

    const readOwn = await backend.fetch(bearerReq(`/api/entity/notes/${created.data.id}`, aliceToken));
    expect(readOwn.status).toBe(200);

    const readAsBob = await backend.fetch(bearerReq(`/api/entity/notes/${created.data.id}`, bobToken));
    expect(readAsBob.status).toBe(404);

    const patchAsBob = await backend.fetch(
      jsonReq("PATCH", `/api/entity/notes/${created.data.id}`, { title: "hijacked" }, bobToken),
    );
    expect(patchAsBob.status).toBe(404);

    const deleteAsBob = await backend.fetch(
      bearerReq(`/api/entity/notes/${created.data.id}`, bobToken, { method: "DELETE" }),
    );
    expect(deleteAsBob.status).toBe(404);

    // Alice can still update/delete her own row throughout.
    const patchAsAlice = await backend.fetch(
      jsonReq("PATCH", `/api/entity/notes/${created.data.id}`, { title: "Updated" }, aliceToken),
    );
    expect(patchAsAlice.status).toBe(200);

    const listAsAlice = await backend.fetch(bearerReq("/api/entity/notes", aliceToken));
    const list = (await listAsAlice.json()) as { data: { id: string }[] };
    expect(list.data.map((n) => n.id)).toEqual([created.data.id]);

    const deleteAsAlice = await backend.fetch(
      bearerReq(`/api/entity/notes/${created.data.id}`, aliceToken, { method: "DELETE" }),
    );
    expect(deleteAsAlice.status).toBe(204);
  });

  it('a token with role claim "admin" bypasses ownership entirely', async () => {
    const { backend } = await setup();
    const aliceToken = await signHS({ sub: "alice" });
    const createRes = await backend.fetch(
      jsonReq("POST", "/api/entity/notes", { title: "Alice's note" }, aliceToken),
    );
    const created = (await createRes.json()) as { data: { id: string } };

    const adminToken = await signHS({ sub: "root", role: "admin" });

    const readAsAdmin = await backend.fetch(bearerReq(`/api/entity/notes/${created.data.id}`, adminToken));
    expect(readAsAdmin.status).toBe(200);

    const deleteAsAdmin = await backend.fetch(
      bearerReq(`/api/entity/notes/${created.data.id}`, adminToken, { method: "DELETE" }),
    );
    expect(deleteAsAdmin.status).toBe(204);
  });

  it("no token at all is a guest -> 403 creating a row", async () => {
    const { backend } = await setup();
    const res = await backend.fetch(jsonReq("POST", "/api/entity/notes", { title: "nope" }));
    expect(res.status).toBe(403);
  });
});
