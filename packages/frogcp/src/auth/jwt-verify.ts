import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTPayload, JWTVerifyGetKey, JWTVerifyOptions as JoseVerifyOptions } from "jose";
import type { Ctx, FrogPlugin } from "frogcp";

const MIN_SECRET_LENGTH = 32;
const DEFAULT_ROLE_CLAIM = "role";
const DEFAULT_USER_ID_CLAIM = "sub";
const DEFAULT_ROLE = "member";

/**
 * Algorithms accepted when verifying against a JWKS (asymmetric only). Excludes
 * every `HS*` and `none`. jose already rejects `alg: "none"`, but pinning an
 * asymmetric-only allowlist also closes the classic alg-confusion attack, where
 * a token forged with `alg: "HS256"` and signed using one of the JWKS's public
 * key bytes as an HMAC secret could otherwise be accepted as genuine.
 */
const JWKS_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "ES256K",
  "EdDSA",
];

export interface JwtVerifyOptions {
  /** HS256 shared secret. Mutually exclusive with `jwksUrl`; exactly one is required. Min length 32, enforced at construction. */
  secret?: string;
  /** Remote JSON Web Key Set URL (via jose's `createRemoteJWKSet`) for RS/ES/PS/EdDSA issuers. Mutually exclusive with `secret`; exactly one is required. */
  jwksUrl?: string;
  /** When set, the token's `iss` claim must match exactly (jose verify constraint). */
  issuer?: string;
  /** When set, the token's `aud` claim must match exactly (jose verify constraint). */
  audience?: string;
  /** Claim the caller's role is read from. Defaults to `"role"`. A missing/non-string/empty value falls back to `"member"`, never `"admin"`, so an omitted claim can never grant elevated access. */
  roleClaim?: string;
  /** Claim the caller's user id is read from. Defaults to `"sub"`. A missing/non-string/empty value resolves the identity to guest (`null`); there is no identity without a user id. */
  userIdClaim?: string;
  /**
   * @internal Test-only escape hatch: a pre-built local JWKS key resolver (e.g.
   * jose's `createLocalJWKSet`) in place of `jwksUrl`, so tests can exercise the
   * JWKS path against an in-test keypair without a network endpoint. Not part of
   * the public contract. Production callers should use `jwksUrl`.
   */
  jwks?: JWTVerifyGetKey;
}

/**
 * Builds the token-to-payload verifier once at construction: resolves the key
 * material (HS256 secret, or a JWKS resolver, remote for `jwksUrl` or the
 * internal `jwks` override for tests) and the fixed jose verify options (pinned
 * algorithm allowlist plus any issuer/audience constraints), then returns a
 * closure that just calls `jwtVerify` with them.
 */
function buildVerifier(opts: JwtVerifyOptions): (token: string) => Promise<JWTPayload> {
  const claimOptions: JoseVerifyOptions = {};
  if (opts.issuer !== undefined) claimOptions.issuer = opts.issuer;
  if (opts.audience !== undefined) claimOptions.audience = opts.audience;

  if (opts.secret !== undefined) {
    const key = new TextEncoder().encode(opts.secret);
    // Pinned to HS256 only: this is a shared-secret instance, so no other
    // algorithm (including other HMAC variants) should ever verify.
    const verifyOptions: JoseVerifyOptions = { ...claimOptions, algorithms: ["HS256"] };
    return async (token) => {
      const { payload } = await jwtVerify(token, key, verifyOptions);
      return payload;
    };
  }

  // `jwtVerifyPlugin` validates that at least one of `jwksUrl`/`jwks` is set
  // before calling this, so the `null` case is unreachable; the explicit check
  // just avoids an unsafe cast to build the remote JWKS URL.
  const jwksSource = opts.jwks ?? (opts.jwksUrl !== undefined ? createRemoteJWKSet(new URL(opts.jwksUrl)) : null);
  if (jwksSource === null) {
    throw new Error('unreachable: jwtVerifyPlugin validates "jwksUrl"/"jwks" before calling buildVerifier');
  }
  const getKey = jwksSource;
  const verifyOptions: JoseVerifyOptions = { ...claimOptions, algorithms: JWKS_ALGORITHMS };
  return async (token) => {
    const { payload } = await jwtVerify(token, getKey, verifyOptions);
    return payload;
  };
}

/**
 * Extracts a bearer token from `Authorization: Bearer <token>`. Bearer-only (no
 * cookie fallback): tokens from an external issuer are a per-request credential
 * the client attaches, not a cookie this backend sets, so there is nothing to
 * fall back to.
 */
function extractBearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(auth.trim());
  return match?.[1] ?? null;
}

/**
 * Builds an identify-only `FrogPlugin` that authenticates callers purely from a
 * JWT minted by an external issuer: no `users` table, no cookies, no
 * register/login routes. This is frogCP's auth-swappability proof: the same
 * permission engine consumes the `Ctx` this plugin produces unchanged, even
 * though the identity source differs entirely from `authPlugin`.
 *
 * Exactly one of `secret` (HS256) or `jwksUrl` (remote JWKS) must be provided;
 * throws synchronously at construction otherwise.
 */
export function jwtVerifyPlugin(opts: JwtVerifyOptions): FrogPlugin {
  const hasSecret = opts.secret !== undefined;
  const hasJwks = opts.jwksUrl !== undefined || opts.jwks !== undefined;

  if (hasSecret === hasJwks) {
    throw new Error('jwtVerifyPlugin: exactly one of "secret" or "jwksUrl" must be provided');
  }
  if (opts.jwksUrl !== undefined && opts.jwks !== undefined) {
    throw new Error('jwtVerifyPlugin: provide only one of "jwksUrl" or the internal "jwks" override');
  }
  if (opts.secret !== undefined && opts.secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`jwtVerifyPlugin: "secret" must be at least ${MIN_SECRET_LENGTH} characters long`);
  }

  const verify = buildVerifier(opts);
  const userIdClaim = opts.userIdClaim ?? DEFAULT_USER_ID_CLAIM;
  const roleClaim = opts.roleClaim ?? DEFAULT_ROLE_CLAIM;

  return {
    name: "jwt-verify",
    async identify(req: Request): Promise<Ctx> {
      const token = extractBearerToken(req);
      if (!token) return null;

      let payload: JWTPayload;
      try {
        payload = await verify(token);
      } catch {
        // Any verify failure (bad signature, expired, wrong issuer/audience,
        // malformed JWS, alg not in the allowlist) is a guest, never a thrown
        // error; mirrors `verifySession`'s contract.
        return null;
      }

      const rawUserId = payload[userIdClaim];
      if (typeof rawUserId !== "string" || rawUserId.length === 0) return null;

      const rawRole = payload[roleClaim];
      const role = typeof rawRole === "string" && rawRole.length > 0 ? rawRole : DEFAULT_ROLE;

      return { userId: rawUserId, role, claims: payload };
    },
  };
}
