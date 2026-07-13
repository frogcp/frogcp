import { entity, resolveEntities, role, text, timestamp, type EntityDef } from "frogcp";

/**
 * The default entity name the activity plugin registers its audit rows under.
 * Plain and unprefixed, not `__frogcp_audit_log`: `validateConfig` rejects any
 * entity name starting with `"__frogcp"` (reserved for framework bookkeeping),
 * and it runs over plugin-contributed entities too. `frogcp/media`'s
 * `media_files` and `frogcp/auth`'s `users` set the same precedent. The name is
 * configurable via `ActivityPluginOptions.entityName`; this is only the default.
 */
export const DEFAULT_AUDIT_ENTITY = "audit_log";

/**
 * Builds the audit-log entity: one row per `AuditEvent` fanned out to this
 * plugin's `AuditSink`. Every row is system-authored (the sink writes directly
 * through the adapter, bypassing the API and this entity's rules), so
 * `create`/`update`/`delete` are deliberately left undeclared: with no rule for
 * an action the permission engine default-denies every non-admin caller, which
 * is exactly right for rows nothing should write through REST.
 *
 * `read`/`list` are restricted to `adminRole` because audit trails are
 * sensitive: they can carry before/after snapshots of any entity, including
 * ones with tighter read rules, and must not leak through the generic
 * `/api/entity/:name` surface.
 *
 * `before`/`after` are plain `text()` columns holding a JSON-serialized
 * snapshot (or `null`), not `json()`, because the sink writes them as a raw
 * string built with `JSON.stringify`. That keeps the column type dialect
 * portable and independent of how an adapter's `json()` mode round-trips shapes.
 */
export function buildAuditEntity(entityName: string, adminRole: string): Record<string, EntityDef> {
  const auditLog = entity({
    action: text().required(),
    entity: text(),
    recordId: text(),
    actorUserId: text(),
    actorRole: text(),
    before: text(),
    after: text(),
    requestId: text(),
    createdAt: timestamp().auto(),
  }).permissions({
    read: role(adminRole),
    list: role(adminRole),
  });

  return resolveEntities({ [entityName]: auditLog });
}
