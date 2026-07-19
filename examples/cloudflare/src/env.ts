/** The bindings this Worker declares in `wrangler.jsonc`. */
export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  SESSIONS: KVNamespace;
  /** Session signing secret for `frogcp/auth`. Set it with `wrangler secret put AUTH_SECRET`. */
  AUTH_SECRET?: string;
  /** Set to `"1"` to allow the public dev placeholder secret. Only `.dev.vars` sets this. */
  FROGCP_ALLOW_DEV_SECRET?: string;
}

/**
 * The dev-only secret committed in `.dev.vars`. It is public, so it must never
 * sign real sessions: `resolveAuthSecret` rejects it unless the caller also
 * opts in through `FROGCP_ALLOW_DEV_SECRET`, which nothing but `.dev.vars`
 * does. That turns "deployed without ever setting a secret" from a silent
 * forgeable-session bug into a loud error.
 */
export const DEV_SECRET_LITERAL = "dev-secret-do-not-use-in-production-32chars!!";

/**
 * Takes the runtime's plain env bag rather than `Env`, because that is what a
 * `RuntimeContext` carries and these two vars are all this function reads.
 */
export function resolveAuthSecret(env: Record<string, unknown>): string {
  const secret = env.AUTH_SECRET;
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error(
      "AUTH_SECRET is not set. Set it with `wrangler secret put AUTH_SECRET` (32 characters or more). " +
        "For local `wrangler dev`, this example's `.dev.vars` covers it automatically.",
    );
  }
  if (secret === DEV_SECRET_LITERAL && env.FROGCP_ALLOW_DEV_SECRET !== "1") {
    throw new Error(
      "AUTH_SECRET is set to this example's published dev-only placeholder value, which is public and " +
        "must never sign real sessions. Use `wrangler dev` (which loads .dev.vars) for local development, " +
        "or run `wrangler secret put AUTH_SECRET` with a private random value for a real deployment.",
    );
  }
  return secret;
}
