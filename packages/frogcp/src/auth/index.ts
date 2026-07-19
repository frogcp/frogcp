/// <reference types="node" />
import type { Ctx, FrogPlugin } from "frogcp";
import { authEntities } from "./entities";
import { makeIdentify } from "./identify";
import { registerOAuthRoutes, type OAuthOptions } from "./oauth";
import { registerAuthRoutes, type PasswordResetMailer } from "./routes";
import type { SessionConfig } from "./session";

export const VERSION = "0.0.1";

export { users, oauthAccounts, authEntities } from "./entities";
export { hashPassword, verifyPassword } from "./password";
export { issueSession, verifySession, extractToken, clearSessionCookie } from "./session";
export type { SessionConfig } from "./session";
export { makeIdentify } from "./identify";
export type { OAuthOptions, OAuthProviderConfig, OidcProviderConfig } from "./oauth";
export { jwtVerifyPlugin } from "./jwt-verify";
export type { JwtVerifyOptions } from "./jwt-verify";
export type { PasswordResetInfo, PasswordResetMailer, AuthRouteExtras } from "./routes";

const MIN_SECRET_LENGTH = 32;
const DEFAULT_SESSION_TTL_SECONDS = 604800; // 7 days
const DEFAULT_COOKIE_NAME = "frogcp_session";

function assertSecretLength(secret: string): void {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`authPlugin: "secret" must be at least ${MIN_SECRET_LENGTH} characters long`);
  }
}

/**
 * Produces the signing secret at boot instead of at construction. Exists for
 * runtimes where the secret is not readable when the plugin list is built:
 * Cloudflare Workers hands `env` (and so the secret) to the app only once a
 * request arrives, and `frogcp schema` builds the plugin list purely to collect
 * entities, with no secret in scope at all.
 */
export type AuthSecretResolver = () => string;

export interface AuthPluginOptions {
  /**
   * Shared HMAC (HS256) signing secret for session JWTs, or a resolver called
   * once at boot to produce it. Must be at least 32 characters either way; a
   * literal is checked synchronously at construction and a resolver's result at
   * boot, so a weak secret fails before the backend serves a request rather than
   * silently issuing forgeable sessions.
   */
  secret: string | AuthSecretResolver;
  /** Registers the email/password routes (`/api/auth/register|login|logout|me`). Defaults to `true`. */
  emailPassword?: boolean;
  /**
   * OAuth/OIDC provider configuration: any mix of `github`, `google`, and
   * generic `oidc` entries. Registers `GET /api/auth/oauth/:provider` and its
   * `/callback` for each configured provider.
   */
  oauth?: OAuthOptions;
  /** Absolute base URL the backend is served from. Required when `oauth` is configured (redirect URIs need it), unused otherwise. */
  baseUrl?: string;
  /**
   * Overrides the `fetch` OAuth's discovery/token-exchange/userinfo calls use.
   * Defaults to `globalThis.fetch`. Exists so tests can inject an in-process
   * mock issuer; production callers should never need it.
   */
  oauthFetch?: typeof fetch;
  /** Session lifetime, in seconds. Defaults to `604800` (7 days). */
  sessionTtlSeconds?: number;
  /** Name of the session cookie. Defaults to `"frogcp_session"`. */
  cookieName?: string;
  /** Appends `; Secure` to every `Set-Cookie` this plugin issues. Defaults to `false`; set `true` in production (HTTPS-only). */
  secureCookies?: boolean;
  /**
   * Delivers self-serve password-reset tokens (see
   * `POST /api/auth/password-reset/request`). Without it that endpoint is a
   * no-oracle no-op (still 202); admin-issued reset links
   * (`/password-reset/issue`) work regardless.
   */
  resetMailer?: PasswordResetMailer;
}

/**
 * Builds the `frogcp/auth` `FrogPlugin`: the `users` and `oauthAccounts`
 * entities, a JWT-session `identify` resolver, and (when `emailPassword` is
 * enabled, the default) the `/api/auth/register|login|logout|me` routes.
 *
 * `identify` needs the assembled `KernelContext` to look up the caller's
 * current role per request, but a plugin's `identify` is fixed at construction
 * time, before `createBackend` has built that context. Closing over a mutable
 * box filled in by `onBoot` bridges the gap: the kernel runs every plugin's
 * `onBoot` before registering any routes, and both finish before
 * `createBackend` resolves, long before the first request reaches this closure.
 *
 * `onBoot` also asserts the adapter dialect is sqlite. This plugin talks to
 * `adapter.db` directly throughout (bypassing `DataEngine`), and `sqliteDb()`
 * enforces the same constraint at each call site, but that only fires on the
 * first auth hit; asserting here means a dialect mismatch fails at
 * `createBackend` time instead of 500ing on every login.
 *
 * The `SessionConfig` is assembled in `onBoot` rather than here, because a
 * resolver-form `secret` cannot be read until then. Routes are mounted after
 * every `onBoot` has run, so they always see a fully resolved config.
 */
export function authPlugin(opts: AuthPluginOptions): FrogPlugin {
  if (typeof opts.secret === "string") assertSecretLength(opts.secret);
  if (opts.oauth !== undefined && !opts.baseUrl) {
    throw new Error('authPlugin: "baseUrl" is required when "oauth" is configured');
  }

  const emailPassword = opts.emailPassword ?? true;

  let cfg: SessionConfig | undefined;
  let identifyFn: ((req: Request) => Promise<Ctx>) | undefined;

  function sessionConfig(): SessionConfig {
    if (!cfg) throw new Error("unreachable: authPlugin builds its session config in onBoot, which runs before routes");
    return cfg;
  }

  return {
    name: "auth",
    entities: authEntities,
    identify: (req) => (identifyFn ? identifyFn(req) : null),
    onBoot(kernelCtx) {
      if (kernelCtx.adapter.dialect !== "sqlite") {
        throw new Error(
          `frogcp/auth currently requires the sqlite dialect (adapter dialect: "${kernelCtx.adapter.dialect}")`,
        );
      }
      const secret = typeof opts.secret === "string" ? opts.secret : opts.secret();
      assertSecretLength(secret);
      cfg = {
        secret,
        ttlSeconds: opts.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS,
        cookieName: opts.cookieName ?? DEFAULT_COOKIE_NAME,
        secure: opts.secureCookies ?? false,
      };
      identifyFn = makeIdentify(cfg, kernelCtx);
    },
    routes(app, kernelCtx) {
      const cfg = sessionConfig();
      if (emailPassword) registerAuthRoutes(app, kernelCtx, cfg, opts.resetMailer ? { resetMailer: opts.resetMailer } : {});
      if (opts.oauth) {
        const baseUrl = opts.baseUrl;
        if (!baseUrl) throw new Error('unreachable: "baseUrl" is guarded (throws) at authPlugin construction whenever "oauth" is set');
        registerOAuthRoutes(app, kernelCtx, cfg, opts.oauth, baseUrl, opts.oauthFetch ?? globalThis.fetch);
      }
    },
  };
}
