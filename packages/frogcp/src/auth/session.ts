import { jwtVerify, SignJWT } from "jose";

/** Configuration shared by `issueSession`, `verifySession`, and cookie building. */
export interface SessionConfig {
  secret: string;
  ttlSeconds: number;
  cookieName: string;
  /** Appends `; Secure` to the issued cookie. Defaults to off; set `true` in production over HTTPS. */
  secure?: boolean;
}

/** Encodes the shared secret the same way on both the issue and verify paths. */
function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/**
 * The `iss` claim every session JWT carries, and the value `verifySession`
 * requires. Binds a session token to this module and purpose: without it, any
 * HS256 token signed with the same secret (for instance one minted by a
 * `jwtVerifyPlugin({ secret })` sharing this backend's secret for something
 * else) would verify as a session for whatever `sub` it carried.
 */
const SESSION_ISSUER = "frogcp/auth";

/**
 * Signs an HS256 JWT (`sub`, `iss`, `iat`, `exp = iat + ttlSeconds`) and builds
 * the matching `Set-Cookie`. `iat`/`exp` are passed to jose as absolute
 * epoch-second numbers (jose treats a `number` as absolute, not a delta), so
 * `exp` is exactly `iat + ttlSeconds`.
 */
export async function issueSession(
  cfg: SessionConfig,
  userId: string,
): Promise<{ token: string; cookie: string }> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + cfg.ttlSeconds;

  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(SESSION_ISSUER)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(secretKey(cfg.secret));

  const attrs = [
    `${cfg.cookieName}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${cfg.ttlSeconds}`,
  ];
  if (cfg.secure) attrs.push("Secure");
  const cookie = attrs.join("; ");

  return { token, cookie };
}

/**
 * Verifies an HS256 JWT against `cfg.secret`, requires its `iss` to be exactly
 * `SESSION_ISSUER`, and returns its `sub` as `userId`. Returns `null` on any
 * failure (expired, bad signature, wrong issuer, malformed JWS, missing `sub`)
 * and never throws, so callers can treat it as a plain "is this a live session"
 * check. The issuer constraint is load-bearing: it stops a same-secret token
 * minted for an unrelated purpose from being accepted as a session.
 */
export async function verifySession(cfg: SessionConfig, token: string): Promise<{ userId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(cfg.secret), {
      algorithms: ["HS256"],
      issuer: SESSION_ISSUER,
    });
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
    return { userId: payload.sub };
  } catch {
    return null;
  }
}

/**
 * Builds the `Set-Cookie` that immediately expires the session cookie
 * (`Max-Age=0`, empty value), used by logout. Mirrors `issueSession`'s
 * attribute set so the browser matches it against the cookie it is clearing; a
 * mismatched `Path` or attribute set would leave the original cookie in place.
 */
export function clearSessionCookie(cfg: Pick<SessionConfig, "cookieName" | "secure">): string {
  const attrs = [`${cfg.cookieName}=`, "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=0"];
  if (cfg.secure) attrs.push("Secure");
  return attrs.join("; ");
}

/**
 * Extracts a token from a request: `Authorization: Bearer <token>` wins when
 * present, otherwise the named cookie. Cookie parsing splits on `;`, trims each
 * pair (proxies and hand-rolled clients are not always tidy), and matches the
 * first `=` so a value containing `=` is not truncated.
 */
export function extractToken(req: Request, cookieName: string): string | null {
  const auth = req.headers.get("authorization");
  if (auth) {
    const match = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    if (match?.[1]) return match[1];
  }

  const cookieHeader = req.headers.get("cookie");
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;
    const name = trimmed.slice(0, eqIndex).trim();
    if (name === cookieName) return trimmed.slice(eqIndex + 1);
  }

  return null;
}
