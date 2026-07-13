import { and, eq, getTableColumns } from "drizzle-orm";
import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ApiError, isUniqueViolation, type ApiVariables, type KernelContext, type Row } from "frogcp";
import { bootstrapRole, normalizeEmail, publicUser, sqliteDb, usersTableOrThrow } from "./routes";
import { issueSession, type SessionConfig } from "./session";

/**
 * Generic OIDC authorization-code flow plus GitHub/Google presets.
 *
 * Security note (v1 scope): this module does not validate an `id_token` JWS
 * signature. The whole flow runs server-side over TLS: the code is exchanged
 * directly against the token endpoint (never through the browser) and the access
 * token is used to call the userinfo endpoint directly. That server-to-server
 * pairing is exactly the trust boundary an `id_token` signature check exists to
 * shore up for a client that cannot make its own server-to-server calls, so it
 * does not apply here. Revisit if an implicit-flow or client-side consumer is
 * ever added.
 *
 * Email verification (`email_verified`): a userinfo email is trusted to link to
 * or create a `users` row only when the provider does not assert
 * `email_verified: false`. Without this, anyone who can register an IdP account
 * claiming a victim's unverified email could take over the victim's existing
 * account (link-based) or pre-seed one a later verified login would link into
 * (creation-based). Both are closed the same way:
 * - `email_verified === false` (only a literal boolean `false`): this identity
 *   can neither link nor create. `createOAuthUser` throws 403 before any insert,
 *   so an unverified email cannot onboard via OAuth at all.
 * - claim absent: treated as verified. Many IdPs omit it; requiring it would
 *   break most real-world generic-OIDC configurations.
 * - GitHub preset: inherently verified (`/user/emails` is filtered to verified).
 */

/** Credentials for a single OAuth/OIDC application registration. */
export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * A generic OIDC provider: `name` is the path segment (`/api/auth/oauth/:name`)
 * and the value stored in `oauthAccounts.provider`; `issuer` is the OIDC issuer
 * base URL. Endpoints are resolved via discovery at
 * `${issuer}/.well-known/openid-configuration`, fetched lazily and cached for
 * the life of this `authPlugin()` instance.
 */
export interface OidcProviderConfig extends OAuthProviderConfig {
  name: string;
  issuer: string;
}

/** `authPlugin({ oauth: ... })`'s shape: any mix of the built-in presets and any number of generic OIDC providers. */
export interface OAuthOptions {
  github?: OAuthProviderConfig;
  google?: OAuthProviderConfig;
  oidc?: OidcProviderConfig[];
}

const OAUTH_STATE_COOKIE = "frogcp_oauth_state";
const OAUTH_STATE_TTL_SECONDS = 600;

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_SCOPE = "read:user user:email";
const GITHUB_USER_AGENT = "frogcp-auth"; // GitHub 403s any request with no User-Agent; the exact value is otherwise unchecked.

const GOOGLE_ISSUER = "https://accounts.google.com";
const GOOGLE_SCOPE = "openid email profile";

/** Default scope for a generic OIDC provider: `openid` is required by the spec, `email`/`profile` supply the userinfo fields this flow consumes. */
const DEFAULT_OIDC_SCOPE = "openid email profile";

/**
 * One configured provider, classified into its internal shape. Both kinds share
 * the same route handlers; only endpoint resolution and userinfo parsing branch
 * on `kind`, so GitHub is a data-only descriptor, not a special route.
 */
type ProviderRecord =
  | { kind: "oidc"; name: string; clientId: string; clientSecret: string; scope: string; issuer: string }
  | { kind: "github"; name: string; clientId: string; clientSecret: string; scope: string };

interface ProviderEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  /** Absent for GitHub, which has no single OIDC-shaped userinfo endpoint; `fetchUserInfo` special-cases it into two REST calls. */
  userinfoUrl?: string;
}

interface UserInfo {
  subject: string;
  email: string;
  name: string | undefined;
  /** May this email match or create a `users` row? See the file-header `email_verified` note. */
  emailVerified: boolean;
}

/**
 * Guards a parsed provider JSON body before any property access. `null` and
 * primitives are valid JSON a broken provider can return, and unguarded access
 * on `null` would escape as a raw 500 instead of the intended 502. Arrays pass
 * (they are non-null objects) and narrow themselves afterward.
 */
function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new ApiError(502, "oauth_upstream", message);
  }
  return value as Record<string, unknown>;
}

/**
 * Builds the name-to-provider map, throwing at registration time (not first
 * request) if two entries claim the same route segment, so a misconfigured
 * plugin fails at boot.
 */
function buildProviders(oauth: OAuthOptions): Map<string, ProviderRecord> {
  const providers = new Map<string, ProviderRecord>();

  function add(record: ProviderRecord): void {
    if (providers.has(record.name)) {
      throw new Error(`authPlugin: OAuth provider "${record.name}" is configured more than once`);
    }
    providers.set(record.name, record);
  }

  if (oauth.github) {
    add({ kind: "github", name: "github", clientId: oauth.github.clientId, clientSecret: oauth.github.clientSecret, scope: GITHUB_SCOPE });
  }
  if (oauth.google) {
    add({
      kind: "oidc",
      name: "google",
      clientId: oauth.google.clientId,
      clientSecret: oauth.google.clientSecret,
      scope: GOOGLE_SCOPE,
      issuer: GOOGLE_ISSUER,
    });
  }
  for (const provider of oauth.oidc ?? []) {
    add({
      kind: "oidc",
      name: provider.name,
      clientId: provider.clientId,
      clientSecret: provider.clientSecret,
      scope: DEFAULT_OIDC_SCOPE,
      issuer: provider.issuer,
    });
  }

  return providers;
}

/** Fetches and validates an OIDC discovery document. Never caches on failure (see `resolveEndpoints`). */
async function discover(issuer: string, fetchImpl: typeof fetch): Promise<ProviderEndpoints> {
  const res = await fetchImpl(`${issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new ApiError(502, "oauth_upstream", "Failed to reach the OAuth provider");

  let doc: unknown;
  try {
    doc = await res.json();
  } catch {
    throw new ApiError(502, "oauth_upstream", "OAuth provider returned a malformed discovery document");
  }

  const { authorization_endpoint, token_endpoint, userinfo_endpoint } = asRecord(
    doc,
    "OAuth provider returned a malformed discovery document",
  );
  if (typeof authorization_endpoint !== "string" || typeof token_endpoint !== "string" || typeof userinfo_endpoint !== "string") {
    throw new ApiError(502, "oauth_upstream", "OAuth provider returned a malformed discovery document");
  }
  return { authorizeUrl: authorization_endpoint, tokenUrl: token_endpoint, userinfoUrl: userinfo_endpoint };
}

/**
 * Resolves a provider's endpoints. GitHub's are fixed data, no network call. A
 * generic/Google provider's are resolved via discovery, fetched lazily (never at
 * registration time, so a temporarily-unreachable issuer does not fail boot) and
 * cached per issuer for this registration. A failed discovery evicts its own
 * cache entry so the next request retries instead of getting stuck.
 */
async function resolveEndpoints(
  provider: ProviderRecord,
  fetchImpl: typeof fetch,
  cache: Map<string, Promise<ProviderEndpoints>>,
): Promise<ProviderEndpoints> {
  if (provider.kind === "github") {
    return { authorizeUrl: GITHUB_AUTHORIZE_URL, tokenUrl: GITHUB_TOKEN_URL };
  }

  const cached = cache.get(provider.issuer);
  if (cached) return cached;

  const pending = discover(provider.issuer, fetchImpl).catch((error: unknown) => {
    cache.delete(provider.issuer);
    throw error;
  });
  cache.set(provider.issuer, pending);
  return pending;
}

/** 32 random bytes, hex-encoded: the OAuth `state` value, matched against its cookie on callback. */
function randomStateHex(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function stateCookie(cfg: Pick<SessionConfig, "secure">, state: string): string {
  const attrs = [`${OAUTH_STATE_COOKIE}=${state}`, "HttpOnly", "Path=/", "SameSite=Lax", `Max-Age=${OAUTH_STATE_TTL_SECONDS}`];
  if (cfg.secure) attrs.push("Secure");
  return attrs.join("; ");
}

function clearStateCookie(cfg: Pick<SessionConfig, "secure">): string {
  const attrs = [`${OAUTH_STATE_COOKIE}=`, "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=0"];
  if (cfg.secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** Reads the raw `frogcp_oauth_state` cookie value off a request (same parsing as `extractToken`). Returns `null` when absent. */
function readStateCookie(req: Request): string | null {
  const cookieHeader = req.headers.get("cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;
    const name = trimmed.slice(0, eqIndex).trim();
    if (name === OAUTH_STATE_COOKIE) return trimmed.slice(eqIndex + 1);
  }
  return null;
}

/**
 * Exchanges an authorization `code` for an access token. Every provider gets the
 * same form-encoded POST with `Accept: application/json`: GitHub's token
 * endpoint replies form-encoded unless asked for JSON, and asking is harmless
 * for OIDC providers (which reply JSON anyway), so one request shape serves both.
 */
async function exchangeCode(
  provider: ProviderRecord,
  tokenUrl: string,
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const res = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body,
  });
  if (!res.ok) throw new ApiError(502, "oauth_upstream", "OAuth provider rejected the token exchange");

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ApiError(502, "oauth_upstream", "OAuth provider returned a malformed token response");
  }

  const accessToken = asRecord(json, "OAuth provider returned a malformed token response").access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new ApiError(502, "oauth_upstream", "OAuth provider did not return an access token");
  }
  return accessToken;
}

/** OIDC-shaped userinfo: a single bearer-authenticated GET returning `{ sub, email, name }`. Used for Google and every generic `oidc[]` entry. */
async function fetchOidcUserInfo(userinfoUrl: string, accessToken: string, fetchImpl: typeof fetch): Promise<UserInfo> {
  const res = await fetchImpl(userinfoUrl, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new ApiError(502, "oauth_upstream", "OAuth provider rejected the userinfo request");

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ApiError(502, "oauth_upstream", "OAuth provider returned a malformed userinfo response");
  }

  const doc = asRecord(json, "OAuth provider returned a malformed userinfo response");
  if (doc.sub === undefined || doc.sub === null) {
    throw new ApiError(502, "oauth_upstream", "OAuth provider did not return a subject");
  }
  const email = normalizeEmail(doc.email);
  if (!email) throw new ApiError(502, "oauth_upstream", "OAuth provider did not return an email address");

  return {
    subject: String(doc.sub),
    email,
    name: typeof doc.name === "string" ? doc.name : undefined,
    // Only a literal boolean `true`, or the claim being absent, counts as
    // verified. Anything else (a literal `false`, but also `"false"`, `0`, or
    // `null`) is unverified. `!== false` would let the string `"false"` sail
    // through, so this uses the strict allowlist form instead.
    emailVerified: doc.email_verified === undefined || doc.email_verified === true,
  };
}

/**
 * GitHub preset userinfo: `GET /user` for subject and name, then
 * `GET /user/emails` for the primary verified email (GitHub's `/user` includes
 * `email` only when the user made one public, so the emails endpoint is the
 * reliable source). Both calls require a `User-Agent` header.
 */
async function fetchGithubUserInfo(accessToken: string, fetchImpl: typeof fetch): Promise<UserInfo> {
  const headers = {
    authorization: `Bearer ${accessToken}`,
    "user-agent": GITHUB_USER_AGENT,
    accept: "application/vnd.github+json",
  };

  const userRes = await fetchImpl("https://api.github.com/user", { headers });
  if (!userRes.ok) throw new ApiError(502, "oauth_upstream", "OAuth provider rejected the userinfo request");
  let user: unknown;
  try {
    user = await userRes.json();
  } catch {
    throw new ApiError(502, "oauth_upstream", "OAuth provider returned a malformed userinfo response");
  }
  const userDoc = asRecord(user, "OAuth provider returned a malformed userinfo response");
  if (userDoc.id === undefined || userDoc.id === null) {
    throw new ApiError(502, "oauth_upstream", "OAuth provider did not return a subject");
  }

  const emailsRes = await fetchImpl("https://api.github.com/user/emails", { headers });
  if (!emailsRes.ok) throw new ApiError(502, "oauth_upstream", "OAuth provider rejected the userinfo request");
  let emails: unknown;
  try {
    emails = await emailsRes.json();
  } catch {
    throw new ApiError(502, "oauth_upstream", "OAuth provider returned a malformed userinfo response");
  }

  // `asRecord` lets arrays through (an array is the well-formed shape here); it
  // only rejects null/primitives, which would otherwise crash below.
  const emailsDoc = asRecord(emails, "OAuth provider returned a malformed userinfo response");
  const primary = Array.isArray(emailsDoc)
    ? (emailsDoc as unknown[]).find(
        (e): e is Record<string, unknown> =>
          typeof e === "object" &&
          e !== null &&
          (e as Record<string, unknown>).primary === true &&
          (e as Record<string, unknown>).verified === true &&
          typeof (e as Record<string, unknown>).email === "string",
      )
    : undefined;
  const email = normalizeEmail(primary?.email);
  if (!email) throw new ApiError(502, "oauth_upstream", "OAuth provider did not return an email address");

  const name = typeof userDoc.name === "string" ? userDoc.name : typeof userDoc.login === "string" ? userDoc.login : undefined;
  // The primary-email filter already required `verified === true`, so a GitHub
  // email is verified by construction.
  return { subject: String(userDoc.id), email, name, emailVerified: true };
}

async function fetchUserInfo(
  provider: ProviderRecord,
  endpoints: ProviderEndpoints,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<UserInfo> {
  if (provider.kind === "github") return fetchGithubUserInfo(accessToken, fetchImpl);

  const userinfoUrl = endpoints.userinfoUrl;
  if (!userinfoUrl) throw new Error("unreachable: OIDC discovery always resolves userinfo_endpoint");
  return fetchOidcUserInfo(userinfoUrl, accessToken, fetchImpl);
}

/** Looks up an existing `users` row by (already normalized) email, returning its id or `null`. */
async function findUserIdByEmail(kernelCtx: KernelContext, email: string): Promise<string | null> {
  const usersTable = usersTableOrThrow(kernelCtx);
  const emailCol = getTableColumns(usersTable).email;
  if (!emailCol) throw new Error('unreachable: users table always has an "email" column');

  const rows = (await sqliteDb(kernelCtx).select().from(usersTable).where(eq(emailCol, email)).limit(1)) as Row[];
  const user = rows[0];
  return user ? (user.id as string) : null;
}

/**
 * Creates the `users` row for a first-time OAuth login (bootstrap-admin rule via
 * `bootstrapRole`) and returns its id. The row has no `passwordHash` key, which
 * the login handler treats as "no password set", so a later password login gets
 * a clean 401 rather than a crash.
 *
 * Fail-closed guard (see the file-header note): an unverified email is refused
 * before any DB access. This is the single choke point for OAuth-driven `users`
 * creation, so guarding here closes the creation-based takeover for every caller.
 *
 * Past the guard, `emailVerified` is always true. The insert is the atomic
 * duplicate check (no pre-check SELECT could close the race). On a UNIQUE
 * violation (a concurrent insert of this email) it re-queries by email and
 * returns that id, so the caller proceeds to linking instead of surfacing an
 * error mid-redirect; safe because only a verified email reaches this point.
 *
 * Exported so tests can drive both the fail-closed guard and the
 * violation-recovery path (the race cannot be forced through the HTTP surface).
 */
export async function createOAuthUser(
  kernelCtx: KernelContext,
  email: string,
  name: string | undefined,
  emailVerified: boolean,
): Promise<string> {
  if (!emailVerified) {
    throw new ApiError(403, "forbidden", "email not verified by provider");
  }

  const usersTable = usersTableOrThrow(kernelCtx);
  const role = await bootstrapRole(kernelCtx, usersTable);
  const userId = crypto.randomUUID();

  try {
    const [inserted] = (await sqliteDb(kernelCtx)
      .insert(usersTable)
      .values({ id: userId, email, name: name ?? null, role, createdAt: new Date() })
      .returning()) as Row[];
    if (!inserted) throw new Error('insert into "users" returned no row');
    // Same rationale as register: this bypasses `engine.create`, so the engine's
    // own `record.created` never runs; fire it manually with the same
    // hidden-stripped shape.
    await kernelCtx.events.emit("record.created", { entity: "users", row: publicUser(inserted), ctx: null });
    return userId;
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existingId = await findUserIdByEmail(kernelCtx, email);
      if (existingId) return existingId;
      throw new ApiError(409, "conflict", '"email" already exists');
    }
    throw error;
  }
}

/**
 * Resolves the `users` row a successful callback should issue a session for, and
 * ensures an `oauthAccounts` link exists for this (provider, subject) pair:
 *
 * 1. An existing link for (provider, subject) wins outright (same account, same
 *    provider, logging in again).
 * 2. Otherwise, only when the provider vouches for the email, an existing
 *    `users` row with the same normalized email is linked (a returning user who
 *    registered by password or via a different provider). An unverified email
 *    skips this step; it must never claim an existing account.
 * 3. Otherwise a new `users` row is created and linked, unless the email is
 *    unverified, in which case `createOAuthUser`'s guard throws 403. An identity
 *    that can neither link nor create cannot onboard via OAuth.
 *
 * There is no `unique(provider, subject)` constraint on `oauthAccounts`, so two
 * concurrent callbacks for a new subject could both insert a link row. This
 * mirrors the accepted bootstrap race; a composite unique index is deferred. The
 * users-row side of that race is handled in `createOAuthUser`.
 */
async function resolveOAuthUser(kernelCtx: KernelContext, providerName: string, info: UserInfo): Promise<string> {
  const accountsTable = kernelCtx.tables.oauthAccounts;
  if (!accountsTable) throw new Error('unreachable: authPlugin always registers an "oauthAccounts" table');

  const accountColumns = getTableColumns(accountsTable);
  const providerCol = accountColumns.provider;
  const subjectCol = accountColumns.subject;
  if (!providerCol || !subjectCol) {
    throw new Error('unreachable: oauthAccounts always has "provider"/"subject" columns');
  }

  const existingLinks = (await sqliteDb(kernelCtx)
    .select()
    .from(accountsTable)
    .where(and(eq(providerCol, providerName), eq(subjectCol, info.subject)))
    .limit(1)) as Row[];
  const existingLink = existingLinks[0];
  if (existingLink) return existingLink.user as string;

  const existingUserId = info.emailVerified ? await findUserIdByEmail(kernelCtx, info.email) : null;
  const userId = existingUserId ?? (await createOAuthUser(kernelCtx, info.email, info.name, info.emailVerified));

  await sqliteDb(kernelCtx).insert(accountsTable).values({
    id: crypto.randomUUID(),
    provider: providerName,
    subject: info.subject,
    user: userId,
    createdAt: new Date(),
  });

  return userId;
}

/**
 * Registers `GET /api/auth/oauth/:provider` (authorize redirect) and its
 * `/callback` (code exchange to session) for every provider in `oauth`. Called
 * from `authPlugin`'s `routes()` only when `opts.oauth` is configured.
 *
 * `fetchImpl` defaults to `globalThis.fetch`; tests inject an in-process mock
 * issuer instead of hitting the network.
 */
export function registerOAuthRoutes(
  app: Hono<{ Variables: ApiVariables }>,
  kernelCtx: KernelContext,
  cfg: SessionConfig,
  oauth: OAuthOptions,
  baseUrl: string,
  fetchImpl: typeof fetch,
): void {
  const providers = buildProviders(oauth);
  const discoveryCache = new Map<string, Promise<ProviderEndpoints>>();

  app.get("/api/auth/oauth/:provider", async (c) => {
    const providerName = c.req.param("provider");
    const provider = providers.get(providerName);
    if (!provider) throw new ApiError(404, "not_found", `Unknown OAuth provider "${providerName}"`);

    const endpoints = await resolveEndpoints(provider, fetchImpl, discoveryCache);
    const state = randomStateHex();
    const redirectUri = `${baseUrl}/api/auth/oauth/${providerName}/callback`;

    const url = new URL(endpoints.authorizeUrl);
    url.searchParams.set("client_id", provider.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", provider.scope);
    url.searchParams.set("state", state);

    c.header("Set-Cookie", stateCookie(cfg, state));
    return c.redirect(url.toString(), 302);
  });

  app.get("/api/auth/oauth/:provider/callback", async (c) => {
    // The body is wrapped so the state cookie is cleared on every exit, not just
    // success. The guards and upstream paths throw `ApiError`s, and the kernel's
    // error renderer has no access to this route's cookie config, so `ApiError`s
    // are rendered here (identical envelope and status to the kernel) with the
    // clearing `Set-Cookie` attached; otherwise a stale state cookie would linger
    // for its full TTL. Non-`ApiError`s rethrow to the kernel unchanged.
    try {
      const providerName = c.req.param("provider");
      const provider = providers.get(providerName);
      if (!provider) throw new ApiError(404, "not_found", `Unknown OAuth provider "${providerName}"`);

      const state = c.req.query("state");
      const code = c.req.query("code");
      const cookieState = readStateCookie(c.req.raw);

      // Checked first, before even looking at `code`: a state mismatch means the
      // request did not originate from the authorize redirect this backend issued
      // (CSRF on the callback), regardless of whether it carries a code.
      if (!state || !cookieState || state !== cookieState) {
        throw new ApiError(403, "forbidden", "invalid oauth state");
      }
      if (!code) {
        throw new ApiError(400, "validation", "missing oauth code");
      }

      const endpoints = await resolveEndpoints(provider, fetchImpl, discoveryCache);
      const redirectUri = `${baseUrl}/api/auth/oauth/${providerName}/callback`;

      const accessToken = await exchangeCode(provider, endpoints.tokenUrl, code, redirectUri, fetchImpl);
      const info = await fetchUserInfo(provider, endpoints, accessToken, fetchImpl);
      const userId = await resolveOAuthUser(kernelCtx, providerName, info);

      const { cookie } = await issueSession(cfg, userId);
      c.header("Set-Cookie", cookie);
      c.header("Set-Cookie", clearStateCookie(cfg), { append: true });
      return c.redirect("/", 302);
    } catch (error) {
      if (error instanceof ApiError) {
        c.header("Set-Cookie", clearStateCookie(cfg));
        return c.json({ error: { code: error.code, message: error.message } }, error.status as ContentfulStatusCode);
      }
      throw error;
    }
  });
}
