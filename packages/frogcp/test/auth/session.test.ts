import { describe, it, expect } from "vitest";
import { SignJWT } from "jose";
import { issueSession, verifySession, extractToken, type SessionConfig } from "../../src/auth/session";

const baseCfg: SessionConfig = {
  secret: "test-secret-at-least-32-bytes-long!!",
  ttlSeconds: 3600,
  cookieName: "frogcp_session",
};

describe("issueSession / verifySession", () => {
  it("round-trips: verifySession(issueSession(userId).token) resolves to the same userId", async () => {
    const { token } = await issueSession(baseCfg, "user-123");
    const verified = await verifySession(baseCfg, token);
    expect(verified).toEqual({ userId: "user-123" });
  });

  it("an already-expired token (ttlSeconds: -1) verifies to null", async () => {
    const { token } = await issueSession({ ...baseCfg, ttlSeconds: -1 }, "user-123");
    expect(await verifySession(baseCfg, token)).toBeNull();
  });

  it("a tampered token (payload/signature mismatch) verifies to null", async () => {
    const { token } = await issueSession(baseCfg, "user-123");
    const parts = token.split(".");
    // Flip a char in the signature segment.
    const sig = parts[2] as string;
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    const tampered = `${parts[0]}.${parts[1]}.${flipped}`;
    expect(await verifySession(baseCfg, tampered)).toBeNull();
  });

  it("a token signed with a different secret verifies to null", async () => {
    const { token } = await issueSession(baseCfg, "user-123");
    const otherCfg = { ...baseCfg, secret: "a-totally-different-secret-value!!!" };
    expect(await verifySession(otherCfg, token)).toBeNull();
  });

  it("garbage input verifies to null without throwing", async () => {
    await expect(verifySession(baseCfg, "")).resolves.toBeNull();
    await expect(verifySession(baseCfg, "not.a.jwt")).resolves.toBeNull();
    await expect(verifySession(baseCfg, "complete garbage")).resolves.toBeNull();
  });

  it("a token missing the sub claim verifies to null", async () => {
    const iat = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(iat)
      .setExpirationTime(iat + 3600)
      .sign(new TextEncoder().encode(baseCfg.secret));
    expect(await verifySession(baseCfg, token)).toBeNull();
  });

  it("a token signed with the SAME secret but no `iss` claim (e.g. minted by an unrelated jwtVerifyPlugin sharing this secret) verifies to null", async () => {
    const iat = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-123")
      .setIssuedAt(iat)
      .setExpirationTime(iat + 3600)
      .sign(new TextEncoder().encode(baseCfg.secret));
    expect(await verifySession(baseCfg, token)).toBeNull();
  });

  it("a token signed with the same secret but a DIFFERENT `iss` claim verifies to null", async () => {
    const iat = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-123")
      .setIssuer("some-other-issuer")
      .setIssuedAt(iat)
      .setExpirationTime(iat + 3600)
      .sign(new TextEncoder().encode(baseCfg.secret));
    expect(await verifySession(baseCfg, token)).toBeNull();
  });

  it("a normal issueSession/verifySession round-trip still works (the issuer is set and matches internally)", async () => {
    const { token } = await issueSession(baseCfg, "user-with-issuer");
    expect(await verifySession(baseCfg, token)).toEqual({ userId: "user-with-issuer" });
  });

  it("a token signed with a different algorithm (HS384) verifies to null", async () => {
    const iat = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS384" })
      .setSubject("user-123")
      .setIssuedAt(iat)
      .setExpirationTime(iat + 3600)
      .sign(new TextEncoder().encode(baseCfg.secret));
    expect(await verifySession(baseCfg, token)).toBeNull();
  });

  it("cookie string matches the exact required format (no Secure by default)", async () => {
    const { token, cookie } = await issueSession(baseCfg, "user-123");
    expect(cookie).toBe(`frogcp_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=3600`);
  });

  it("cookie string appends Secure when cfg.secure is true", async () => {
    const { token, cookie } = await issueSession({ ...baseCfg, secure: true }, "user-123");
    expect(cookie).toBe(`frogcp_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=3600; Secure`);
  });

  it("honors a custom cookie name", async () => {
    const { cookie } = await issueSession({ ...baseCfg, cookieName: "myapp_sid" }, "user-123");
    expect(cookie.startsWith("myapp_sid=")).toBe(true);
  });
});

function reqWith(init: { authorization?: string; cookie?: string }): Request {
  const headers = new Headers();
  if (init.authorization) headers.set("authorization", init.authorization);
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request("http://x/", { headers });
}

describe("extractToken", () => {
  it("returns null when neither header is present", () => {
    expect(extractToken(reqWith({}), "frogcp_session")).toBeNull();
  });

  it("extracts a bearer token from the Authorization header", () => {
    const req = reqWith({ authorization: "Bearer abc.def.ghi" });
    expect(extractToken(req, "frogcp_session")).toBe("abc.def.ghi");
  });

  it("extracts the named cookie", () => {
    const req = reqWith({ cookie: "frogcp_session=abc.def.ghi" });
    expect(extractToken(req, "frogcp_session")).toBe("abc.def.ghi");
  });

  it("bearer wins over cookie when both are present", () => {
    const req = reqWith({
      authorization: "Bearer bearer-token",
      cookie: "frogcp_session=cookie-token",
    });
    expect(extractToken(req, "frogcp_session")).toBe("bearer-token");
  });

  it("finds the named cookie among multiple cookies, with irregular whitespace", () => {
    const req = reqWith({ cookie: "foo=bar;  frogcp_session=the-token  ; baz=qux" });
    expect(extractToken(req, "frogcp_session")).toBe("the-token");
  });

  it("returns null when the named cookie is absent among other cookies", () => {
    const req = reqWith({ cookie: "foo=bar; baz=qux" });
    expect(extractToken(req, "frogcp_session")).toBeNull();
  });

  it("ignores a malformed Authorization header and falls back to the cookie", () => {
    const req = reqWith({ authorization: "Basic dXNlcjpwYXNz", cookie: "frogcp_session=the-token" });
    expect(extractToken(req, "frogcp_session")).toBe("the-token");
  });
});
