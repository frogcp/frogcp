import { validateRefTargets } from "../compile/shared";
import { Rule, type RuleExpr } from "../permissions/rules";
import type { ActionName, BackendConfig, EntityDef, FieldDef, FieldType } from "../schema/types";
import { validateConfig } from "../schema/validate-config";

const FIELD_TYPES: ReadonlySet<FieldType> = new Set([
  "text",
  "number",
  "boolean",
  "date",
  "timestamp",
  "json",
  "select",
  "media",
  "ref",
]);

const RULE_KINDS = new Set(["role", "owner", "authenticated", "public", "or", "and"]);

/** Shape of the JSON produced by `serializeConfig` / consumed by `deserializeConfig`. */
interface SerializedEntity {
  fields: Record<string, FieldDef>;
  permissions: Partial<Record<string, RuleExpr>>;
}
interface SerializedConfig {
  entities: Record<string, SerializedEntity>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Serializes a resolved `BackendConfig` to a JSON string for the
 * `__frogcp_schema` table (see `managed/store.ts`) or the admin UI.
 * `EntityDef.fields` is JSON-serializable except a `date`/`timestamp` field's
 * `default`, which may be a `Date`: `JSON.stringify` renders it as an ISO string
 * (via `Date.prototype.toJSON`) and `deserializeConfig` revives it, so the
 * round-trip is lossless. `EntityDef.permissions` maps action names to `Rule`
 * instances, so each `Rule` is unwrapped to its plain `RuleExpr`.
 */
export function serializeConfig(config: BackendConfig): string {
  const entities: Record<string, SerializedEntity> = {};
  for (const [entityName, entityDef] of Object.entries(config.entities)) {
    const permissions: Partial<Record<string, RuleExpr>> = {};
    for (const [action, rule] of Object.entries(entityDef.permissions)) {
      if (rule) permissions[action] = rule.expr;
    }
    entities[entityName] = { fields: entityDef.fields, permissions };
  }
  const serialized: SerializedConfig = { entities };
  return JSON.stringify(serialized);
}

/** Validates and returns `raw` as a well-formed `FieldDef`, or throws a descriptive error. */
function parseFieldDef(entityName: string, fieldName: string, raw: unknown): FieldDef {
  const label = `entity "${entityName}" field "${fieldName}"`;
  if (!isPlainObject(raw)) {
    throw new Error(`deserializeConfig: ${label} is malformed (expected an object)`);
  }
  if (typeof raw.type !== "string" || !FIELD_TYPES.has(raw.type as FieldType)) {
    throw new Error(`deserializeConfig: ${label} has unknown field type "${String(raw.type)}"`);
  }
  if (typeof raw.required !== "boolean") {
    throw new Error(`deserializeConfig: ${label} is missing boolean "required"`);
  }

  const field = { ...raw } as unknown as FieldDef;

  // `select` options are consumed by data/validate.ts (z.enum) at request
  // time; validate them here so a malformed schema fails with this module's
  // clear per-field message instead of an opaque Zod-internal error later.
  if (field.type === "select") {
    const options = (raw as { options?: unknown }).options;
    if (!Array.isArray(options) || options.length === 0 || !options.every((o) => typeof o === "string")) {
      throw new Error(`deserializeConfig: ${label}: select requires a non-empty string[] options`);
    }
  }

  // `date`/`timestamp` defaults may have been a `Date`, which `JSON.stringify`
  // renders as an ISO string (Date.prototype.toJSON). Revive it so the
  // round-trip is lossless and compile/{sqlite,postgres}.ts get the `Date`
  // their `col.default()` expects for timestamp columns.
  if ((field.type === "date" || field.type === "timestamp") && typeof field.default === "string") {
    const revived = new Date(field.default);
    if (Number.isNaN(revived.getTime())) {
      throw new Error(
        `deserializeConfig: ${label}: default "${field.default}" is not a valid ${field.type} value`,
      );
    }
    field.default = revived;
  }

  return field;
}

/** Validates that `raw` is a well-formed `RuleExpr` (recursively for or/and), or throws. */
function parseRuleExpr(entityName: string, action: string, raw: unknown): RuleExpr {
  const label = `entity "${entityName}" permission "${action}"`;
  if (!isPlainObject(raw) || typeof raw.kind !== "string") {
    throw new Error(`deserializeConfig: ${label} is malformed (expected a rule object with "kind")`);
  }
  if (!RULE_KINDS.has(raw.kind)) {
    throw new Error(`deserializeConfig: ${label} has unknown rule kind "${raw.kind}"`);
  }
  switch (raw.kind) {
    case "role":
      // Reject a non-string or empty/whitespace-only role at this persistence
      // boundary: a stored `role("")` would match a role no caller can hold
      // (silent lockout) rather than surface a clear config error at edit time.
      if (typeof raw.role !== "string" || raw.role.trim().length === 0) {
        throw new Error(`deserializeConfig: ${label} rule "role" requires a non-empty string "role"`);
      }
      break;
    case "owner":
      // Same reasoning as `role`: an empty `owner("")` field would compare an
      // unnamed column against `ctx.userId` and never match.
      if (typeof raw.field !== "string" || raw.field.trim().length === 0) {
        throw new Error(`deserializeConfig: ${label} rule "owner" requires a non-empty string "field"`);
      }
      break;
    case "authenticated":
    case "public":
      break;
    case "or":
    case "and":
      if (!Array.isArray(raw.rules)) {
        throw new Error(`deserializeConfig: ${label} rule "${raw.kind}" is missing array "rules"`);
      }
      // A combinator with zero sub-rules is corrupt: `decide()` evaluates an
      // empty `and` as vacuously-true (grant-all) and an empty `or` as
      // vacuously-false (deny-all), neither of which an admin intends. Require
      // at least one sub-rule so a malformed combinator can't be persisted.
      if (raw.rules.length === 0) {
        throw new Error(`deserializeConfig: ${label} rule "${raw.kind}" requires at least one sub-rule (got an empty "rules" array)`);
      }
      for (const sub of raw.rules) parseRuleExpr(entityName, action, sub);
      break;
  }
  return raw as unknown as RuleExpr;
}

/**
 * Parses a JSON string produced by `serializeConfig` (or hand-authored /
 * admin-edited JSON of the same shape) back into a `BackendConfig`: fields are
 * validated against the known `FieldType`s, and each permission `RuleExpr` is
 * validated (recursively through `or`/`and`) and re-wrapped in a `new
 * Rule(expr)`. The reconstructed config is then run through `validateConfig`
 * (reserved names, owner-rule field checks) and `validateRefTargets` (every
 * `ref` field's `target` names a real entity), the same structural guarantees
 * `defineBackend` gives a code-mode config, so a stored config can't silently
 * regress those checks.
 *
 * Throws a plain `Error` with a descriptive message on any malformed input:
 * invalid JSON, an unknown field type, a malformed/unknown-kind `RuleExpr`, or
 * a `validateConfig`/`validateRefTargets` failure.
 */
export function deserializeConfig(json: string): BackendConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`deserializeConfig: invalid JSON (${(error as Error).message})`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error('deserializeConfig: malformed config (expected an object with an "entities" map)');
  }
  const rawEntities = parsed.entities;
  if (!isPlainObject(rawEntities)) {
    throw new Error('deserializeConfig: malformed config (expected an object with an "entities" map)');
  }

  const entities: Record<string, EntityDef> = {};
  for (const [entityName, rawEntity] of Object.entries(rawEntities)) {
    if (!isPlainObject(rawEntity) || !isPlainObject(rawEntity.fields)) {
      throw new Error(`deserializeConfig: entity "${entityName}" is malformed (expected a "fields" object)`);
    }

    const fields: Record<string, FieldDef> = {};
    for (const [fieldName, rawField] of Object.entries(rawEntity.fields)) {
      fields[fieldName] = parseFieldDef(entityName, fieldName, rawField);
    }

    const rawPermissions = rawEntity.permissions;
    const permissions: Partial<Record<ActionName, Rule>> = {};
    if (rawPermissions !== undefined) {
      if (!isPlainObject(rawPermissions)) {
        throw new Error(`deserializeConfig: entity "${entityName}" has malformed "permissions"`);
      }
      for (const [action, rawExpr] of Object.entries(rawPermissions)) {
        const expr = parseRuleExpr(entityName, action, rawExpr);
        permissions[action as ActionName] = new Rule(expr);
      }
    }

    entities[entityName] = { fields, permissions };
  }

  const config: BackendConfig = { entities };
  validateConfig(config);
  validateRefTargets(config);
  return config;
}
