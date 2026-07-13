import { entity, number, resolveEntities, rule, text, timestamp, type EntityDef } from "frogcp";

/**
 * The entity name media upload metadata registers under. Plain and
 * unprefixed: validateConfig rejects any name starting with "__frogcp" (that
 * prefix is reserved for framework bookkeeping such as __frogcp_migrations),
 * and createBackend runs validateConfig over plugin-contributed entities too.
 */
export const FILES_ENTITY = "media_files";

/**
 * Builds the media_files entity: one row per uploaded object, keyed by the
 * storage key the bytes actually live under.
 *
 * owner is a plain text() field holding the uploader's userId, deliberately
 * not a ref("users"): the media plugin must work standalone, without
 * frogcp/auth or any users entity configured, and a ref would fail
 * validateConfig's target-entity check. It is populated from ctx.userId on
 * every upload regardless of ownerScoped, so the uploader is always on record.
 *
 * create is always rule.authenticated(): only a logged-in caller may upload.
 * read and delete share one rule chosen by ownerScoped: rule.owner("owner")
 * (the default, so only the uploader can fetch or remove their files) or
 * rule.public() (any caller, including guests).
 */
export function buildFilesEntities(ownerScoped: boolean): Record<string, EntityDef> {
  const scopedRule = ownerScoped ? rule.owner("owner") : rule.public();

  const files = entity({
    key: text().required().unique(),
    filename: text(),
    contentType: text(),
    size: number(),
    owner: text(),
    createdAt: timestamp().auto(),
  }).permissions({
    create: rule.authenticated(),
    read: scopedRule,
    delete: scopedRule,
  });

  return resolveEntities({ [FILES_ENTITY]: files });
}
