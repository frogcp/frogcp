import type { FilterScalar } from "frogcp/client";
import type { ActionName, EntitySchemaSummary, FieldDef, FieldSchemaSummary, FieldType, RuleExpr } from "frogcp";

export type { ActionName, EntitySchemaSummary, FieldSchemaSummary };

/** Every field type the schema editor's "add field" control offers, in
 * `frogcp`'s own `FieldType` declaration order. */
export const FIELD_TYPES: readonly FieldType[] = [
  "text",
  "number",
  "boolean",
  "date",
  "timestamp",
  "json",
  "select",
  "media",
  "ref",
];

/** Every action the permission matrix has a column for, in `ActionName`'s own
 * declaration order. */
export const ACTIONS: readonly ActionName[] = ["read", "list", "create", "update", "delete"];

/** A `permissions` map only holds a key for an action the entity DECLARED a
 * rule for; an omitted action means the engine default-denies everyone except
 * an admin. Centralizes that "missing key means admin only" translation so
 * callers don't re-derive it. */
export function permissionSummary(entity: EntitySchemaSummary, action: ActionName): string {
  return entity.permissions[action] ?? "admin only";
}

/**
 * The table's column list: the implicit `id` primary key (never itself a key
 * in the schema's `fields` map) plus every non-`hidden` field, in schema
 * order. The engine's `stripHidden` guarantees hidden fields never reach an
 * API response, so a column for one would always render empty.
 */
export function visibleColumns(fields: Record<string, FieldSchemaSummary>): string[] {
  return ["id", ...Object.keys(fields).filter((name) => !fields[name]?.hidden)];
}

/**
 * Fields eligible for the create/edit form, in schema order. Mirrors
 * `insertEligibleFields` in the codegen exactly: never `hidden` (the server
 * ignores a client-supplied value) and never `auto` (the engine overwrites
 * it). `readonly` fields ARE included, since the engine's readonly guard only
 * applies to non-admin callers; the form renders them disabled so they stay
 * visible rather than silently vanishing.
 */
export function formEligibleFields(fields: Record<string, FieldSchemaSummary>): Array<[string, FieldSchemaSummary]> {
  return Object.entries(fields).filter(([, field]) => !field.hidden && !field.auto);
}

/** Mirrors the codegen's `isInsertMandatory`: a field the create form should
 * reject an empty value for client-side. The `auto` check is redundant given
 * `formEligibleFields`, but kept so this stays a precise mirror. */
export function isMandatory(field: FieldSchemaSummary): boolean {
  return field.required && field.default === undefined && field.auto !== true;
}

/** Fields worth offering a filter input for: every visible field except
 * `json`, since equality-filtering a serialized blob isn't useful (which is
 * also why `list`'s wire grammar has no JSON comparison). */
export function filterableFields(fields: Record<string, FieldSchemaSummary>): Array<[string, FieldSchemaSummary]> {
  return Object.entries(fields).filter(([, field]) => !field.hidden && field.type !== "json");
}

/** Renders one table cell's raw value by field type. `field === undefined`
 * means the implicit `id` column (or any column with no schema entry), which
 * falls through to the plain `String(value)` case. */
export function formatCellValue(value: unknown, field: FieldSchemaSummary | undefined): string {
  if (value === null || value === undefined) return "";
  switch (field?.type) {
    case "boolean":
      return value ? "✓" : "✗";
    case "date":
    case "timestamp": {
      const d = value instanceof Date ? value : new Date(value as string | number);
      return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
    }
    case "json": {
      const str = typeof value === "string" ? value : JSON.stringify(value);
      return str.length > 40 ? `${str.slice(0, 40)}…` : str;
    }
    default:
      return String(value);
  }
}

/** Converts a raw row/default value into the string (or boolean, for a
 * checkbox) a form widget controls. The inverse of the per-type conversions
 * `EntityForm`'s submit handler applies. */
export function toWidgetValue(raw: unknown, field: FieldSchemaSummary): string | boolean {
  if (field.type === "boolean") return Boolean(raw);
  if (raw === null || raw === undefined) return "";
  if (field.type === "json") return typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
  if (field.type === "date" || field.type === "timestamp") return toDatetimeLocalValue(raw);
  return String(raw);
}

/** A `datetime-local` input needs `YYYY-MM-DDTHH:mm` (no timezone, no
 * seconds); converts an ISO string / `Date` / epoch number to that shape, in
 * the viewer's LOCAL time (matching what the input itself displays/edits).
 * Returns `""` for anything that doesn't parse, so the widget just renders
 * empty rather than throwing. */
export function toDatetimeLocalValue(raw: unknown): string {
  if (raw === null || raw === undefined || raw === "") return "";
  const d = raw instanceof Date ? raw : new Date(raw as string | number);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The inverse of `toDatetimeLocalValue`: a `datetime-local` input's value to
 * the ISO string the wire expects. */
export function fromDatetimeLocalValue(value: string): string {
  return new Date(value).toISOString();
}

// ---------------------------------------------------------------------------
// Dashboard: schema-driven metrics (see DashboardScreen).
// ---------------------------------------------------------------------------

/** The first `select` field with at least one option, in schema order. Drives
 * the dashboard's "status breakdown", which works off whatever select field an
 * app happens to declare rather than a hardcoded name. `undefined` means the
 * dashboard omits the breakdown for that entity. */
export function firstSelectField(
  fields: Record<string, FieldSchemaSummary>,
): [string, FieldSchemaSummary] | undefined {
  return Object.entries(fields).find(([, field]) => field.type === "select" && (field.options?.length ?? 0) > 0);
}

/** The first system-managed (`auto: true`) `timestamp` field, in schema order:
 * the one field trustworthy as "when this record was created" without the app
 * author declaring anything dashboard-specific. Non-`auto` timestamps are
 * excluded because a user-editable date needn't reflect creation order. */
export function firstAutoTimestampField(
  fields: Record<string, FieldSchemaSummary>,
): [string, FieldSchemaSummary] | undefined {
  return Object.entries(fields).find(([, field]) => field.type === "timestamp" && field.auto === true);
}

/** Field names that read as a human title for a row, checked
 * case-insensitively in this preference order. A display heuristic only. */
const TITLE_LIKE_FIELD_NAMES = ["title", "name", "label", "subject", "headline"];

/** A reasonable "title" field for summarizing one row: the first non-hidden
 * `text` field whose name looks title-ish, else the first non-hidden `text`
 * field, else `undefined` (the caller falls back to the row's `id`). */
export function pickLabelField(fields: Record<string, FieldSchemaSummary>): string | undefined {
  const textFields = Object.entries(fields).filter(([, field]) => field.type === "text" && !field.hidden);
  const named = textFields.find(([name]) => TITLE_LIKE_FIELD_NAMES.includes(name.toLowerCase()));
  return (named ?? textFields[0])?.[0];
}

/** Coerces a raw filter input string to the `FilterScalar` its field type
 * expects. `encodeListQuery` needs an actual `boolean`/`number`, not the
 * string `"true"`/`"42"`, to round-trip through the server's `coerceScalar`. */
export function coerceFilterValue(raw: string, type: FieldSchemaSummary["type"] | undefined): FilterScalar {
  switch (type) {
    case "boolean":
      return raw === "true";
    case "number":
      return Number(raw);
    default:
      return raw;
  }
}

// ---------------------------------------------------------------------------
// Managed-mode schema editing (SchemaViewerScreen / PermissionMatrixScreen).
// ---------------------------------------------------------------------------

/**
 * `FieldSchemaSummary` (what `GET /api/system/schema` returns) and `FieldDef`
 * (what `POST /api/system/schema` takes back) declare the same optional keys,
 * because the server's `serializeField` is a straight passthrough of a
 * `FieldDef`'s properties. So this is a structural copy, never a re-mapping.
 */
export function fieldSummaryToFieldDef(field: FieldSchemaSummary): FieldDef {
  return { ...field };
}

/** A leaf `RuleExpr`: every kind except the `or`/`and` combinators. Exactly
 * what the permission matrix's rule builder lets an admin pick; combining more
 * than one ORs them together (see `leavesToRuleExpr`). */
export type RuleLeaf = Extract<RuleExpr, { kind: "public" | "authenticated" | "role" | "owner" }>;

export function isRuleLeaf(expr: RuleExpr): expr is RuleLeaf {
  return expr.kind === "public" || expr.kind === "authenticated" || expr.kind === "role" || expr.kind === "owner";
}

/** Renders a single `RuleLeaf` the same way the server's `describeRuleExpr`
 * would, for the read-out next to each condition in the rule builder. */
export function describeRuleLeaf(leaf: RuleLeaf): string {
  switch (leaf.kind) {
    case "role":
      return `role(${leaf.role})`;
    case "owner":
      return `owner(${leaf.field})`;
    case "authenticated":
      return "authenticated";
    case "public":
      return "public";
  }
}

/**
 * Flattens `expr` into the list of OR'd leaves the permission matrix's rule
 * builder can represent. Returns `null` for anything the builder can't edit
 * structurally (an `and`, or an `or` containing a non-leaf); the matrix then
 * shows that cell read-only rather than mangling a rule it can't faithfully
 * round-trip.
 */
export function ruleExprToLeaves(expr: RuleExpr): RuleLeaf[] | null {
  if (isRuleLeaf(expr)) return [expr];
  if (expr.kind === "or") {
    const leaves: RuleLeaf[] = [];
    for (const sub of expr.rules) {
      if (!isRuleLeaf(sub)) return null;
      leaves.push(sub);
    }
    return leaves;
  }
  return null;
}

/** The inverse of `ruleExprToLeaves`: `[]` means "no rule", so the caller
 * should omit the action's key entirely (default-deny/admin-only). A single
 * leaf is returned bare; 2+ leaves are OR-combined. */
export function leavesToRuleExpr(leaves: readonly RuleLeaf[]): RuleExpr | null {
  if (leaves.length === 0) return null;
  if (leaves.length === 1) return leaves[0] ?? null;
  return { kind: "or", rules: [...leaves] };
}

/**
 * Converts one `EntitySchemaSummary` into the `{fields, permissions}` shape
 * `POST /api/system/schema` expects. Permissions come VERBATIM from the
 * structured `permissionRules` map, never re-parsed from the lossy
 * `permissions` summary string, so a rule the UI can't edit (an `and`, a
 * nested combinator) round-trips intact instead of being dropped. An omitted
 * action stays omitted (admin-only), never synthesized.
 *
 * This is the baseline every schema-edit screen builds its outgoing config
 * from, overriding only the piece it actually edits.
 */
export function entitySummaryToConfigEntity(
  entity: EntitySchemaSummary,
): { fields: Record<string, FieldDef>; permissions: Partial<Record<ActionName, RuleExpr>> } {
  const fields: Record<string, FieldDef> = {};
  for (const [name, field] of Object.entries(entity.fields)) {
    fields[name] = fieldSummaryToFieldDef(field);
  }
  const permissions: Partial<Record<ActionName, RuleExpr>> = {};
  for (const [action, expr] of Object.entries(entity.permissionRules ?? {})) {
    if (expr !== undefined) permissions[action as ActionName] = expr;
  }
  return { fields, permissions };
}

/** Builds the full `POST /api/system/schema` body from a draft schema map,
 * excluding `pluginOwned` entities (e.g. `frogcp/auth`'s "users"). Those are
 * code-defined: the endpoint expects only the entities the CALLER owns and
 * re-merges the real plugin entities itself regardless of what's posted.
 * Sending them anyway would be harmless, but omitting them keeps the client's
 * contract honest and the payload minimal. */
export function buildSchemaUpdateConfig(entities: Record<string, EntitySchemaSummary>): {
  entities: Record<string, { fields: Record<string, FieldDef>; permissions: Partial<Record<ActionName, RuleExpr>> }>;
} {
  const out: Record<string, { fields: Record<string, FieldDef>; permissions: Partial<Record<ActionName, RuleExpr>> }> = {};
  for (const [name, entity] of Object.entries(entities)) {
    if (entity.pluginOwned) continue;
    out[name] = entitySummaryToConfigEntity(entity);
  }
  return { entities: out };
}
