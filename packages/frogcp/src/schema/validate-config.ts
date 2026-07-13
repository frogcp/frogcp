import type { RuleExpr } from "../permissions/rules";
import type { BackendConfig, EntityDef } from "./types";

const RESERVED_FIELD_NAMES = new Set(["id", "expand"]);
const RESERVED_PREFIX = "__frogcp";

function isReservedName(name: string): boolean {
  return RESERVED_FIELD_NAMES.has(name) || name.startsWith(RESERVED_PREFIX);
}

/** Every field name referenced by an `owner()` node anywhere inside `expr`. */
function collectOwnerFields(expr: RuleExpr, out: Set<string>): void {
  if (expr.kind === "owner") {
    out.add(expr.field);
  } else if (expr.kind === "or" || expr.kind === "and") {
    for (const rule of expr.rules) collectOwnerFields(rule, out);
  }
}

/**
 * Structural validation for a `BackendConfig`, run once at `defineBackend`
 * time so misconfigurations fail loudly at startup rather than later:
 *
 * - `id` and `expand` are reserved: `id` is the implicit primary key, `expand`
 *   is the relation-embed key on API responses.
 * - Names starting with `__frogcp` are reserved for framework bookkeeping
 *   (e.g. the `__frogcp_migrations` table).
 * - An `owner()` rule must reference a real field on the same entity, or the
 *   implicit `id` field. `owner("id")` is the standard self-ownership pattern
 *   for a users-style entity (the row is the user).
 * - An `owner()` rule field must be text-compatible: ownership compares the
 *   stored value against `ctx.userId` (a string), so number/boolean/date/json
 *   fields could never match.
 *
 * Throws a plain `Error` naming the entity/field, since this is a
 * developer-time config mistake, not a request-time API failure.
 */
export function validateConfig(config: BackendConfig): void {
  for (const [entityName, entityDef] of Object.entries(config.entities)) {
    if (entityName.startsWith(RESERVED_PREFIX)) {
      throw new Error(
        `Invalid entity name "${entityName}": names starting with "${RESERVED_PREFIX}" are reserved for frogCP's internal use`,
      );
    }

    for (const fieldName of Object.keys(entityDef.fields)) {
      if (isReservedName(fieldName)) {
        throw new Error(
          `Invalid field "${fieldName}" on entity "${entityName}": this field name is reserved` +
            (fieldName.startsWith(RESERVED_PREFIX)
              ? ` (names starting with "${RESERVED_PREFIX}" are reserved for frogCP's internal use)`
              : ""),
        );
      }
    }

    validateOwnerRules(entityName, entityDef);
  }

  validateResources(config);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Light shape check for the optional `resources` block (see
 * `ResourceDeclaration`): it must be `type -> binding -> options`, every level
 * a plain object. Kept shallow: core is platform-agnostic and does not know
 * which resource types a given control plane supports, so validating type
 * names here would couple core to the control plane. This only guarantees the
 * block round-trips as clean JSON. Throws a plain `Error` (a config mistake).
 */
function validateResources(config: BackendConfig): void {
  const { resources } = config;
  if (resources === undefined) return;
  if (!isPlainObject(resources)) {
    throw new Error('Invalid "resources": must be an object of resourceType -> bindingName -> options');
  }
  for (const [type, bindings] of Object.entries(resources)) {
    if (!isPlainObject(bindings)) {
      throw new Error(`Invalid "resources.${type}": must be an object of bindingName -> options`);
    }
    for (const [binding, options] of Object.entries(bindings)) {
      if (!isPlainObject(options)) {
        throw new Error(
          `Invalid "resources.${type}.${binding}": must be an options object (use {} when there are no options)`,
        );
      }
    }
  }
}

/** Field types an owner() rule may legitimately compare against `ctx.userId` (a string). */
const NON_TEXT_COMPATIBLE_TYPES = new Set(["number", "boolean", "date", "json"]);

function validateOwnerRules(entityName: string, entityDef: EntityDef): void {
  for (const [action, rule] of Object.entries(entityDef.permissions)) {
    if (!rule) continue;
    const ownerFields = new Set<string>();
    collectOwnerFields(rule.expr, ownerFields);

    for (const field of ownerFields) {
      // The implicit `id` primary key is always text-compatible and is the
      // standard self-ownership pattern, so allow it (it isn't in entityDef.fields).
      if (field === "id") continue;

      const fieldDef = entityDef.fields[field];
      if (!fieldDef) {
        throw new Error(
          `Invalid owner("${field}") rule on entity "${entityName}" (action "${action}"): ` +
            `field "${field}" does not exist on entity "${entityName}"`,
        );
      }
      if (fieldDef.hidden) {
        throw new Error(
          `Invalid owner("${field}") rule on entity "${entityName}" (action "${action}"): ` +
            `field "${field}" is hidden, so ownership decided by it would be unobservable; ` +
            `hidden fields cannot be used in owner() rules`,
        );
      }
      if (NON_TEXT_COMPATIBLE_TYPES.has(fieldDef.type)) {
        throw new Error(
          `Invalid owner("${field}") rule on entity "${entityName}" (action "${action}"): ` +
            `field "${field}" has type "${fieldDef.type}", which cannot hold a string identity value; ` +
            `owner() fields must be text-compatible (e.g. text/ref/select)`,
        );
      }
    }
  }
}
