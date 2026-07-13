import { entity, ref, resolveEntities, rule, text, timestamp, type EntityDef } from "frogcp";

/**
 * The `users` entity backing email/password and OAuth identity.
 *
 * `passwordHash` is `.hidden()` so the data engine strips it from every REST
 * response regardless of caller role; the only way to read it is direct
 * `adapter.db` access, which this package's verify path uses internally.
 *
 * Permissions are self-service: a member may read and update their own row
 * (`rule.owner("id")`). `create`, `list`, and `delete` have no rule, so they
 * default-deny for everyone but admin (the permission engine always allows
 * admin). `role` is `.readonly()` so it stays visible but only admin can
 * change it, which is what stops a member from PATCHing their own row to
 * `"admin"` under the self-service update rule.
 */
export const users = entity({
  email: text().required().unique(),
  passwordHash: text().hidden(),
  name: text(),
  role: text().required().default("member").readonly(),
  // Password-reset token state (see the reset routes). Both `.hidden()`: the
  // hash is credential-equivalent, and even the expiry leaks whether a reset
  // is pending. One outstanding token per user; a new one overwrites the old.
  resetTokenHash: text().hidden(),
  resetTokenExpiresAt: timestamp().hidden(),
  createdAt: timestamp().auto(),
}).permissions({
  read: rule.owner("id"),
  update: rule.owner("id"),
});

/**
 * Links an external OAuth/OIDC identity (`provider` plus provider-scoped
 * `subject`) to a `users` row. Internal bookkeeping only: no permissions, so
 * every action default-denies for non-admins.
 */
export const oauthAccounts = entity({
  provider: text().required(),
  subject: text().required(),
  user: ref("users").required().onDelete("cascade"),
  createdAt: timestamp().auto(),
});

/** Resolved entity defs, ready to hand to `FrogPlugin.entities`. */
export const authEntities: Record<string, EntityDef> = resolveEntities({ users, oauthAccounts });
