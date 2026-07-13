import { ApiError, type FilterCondition, type FilterOp, type ListQuery } from "../data/engine";
import type { EntityDef, FieldDef } from "../schema/types";

const FILTER_OPS: readonly FilterOp[] = ["eq", "ne", "gt", "gte", "lt", "lte", "like", "in"];

function isFilterOp(candidate: string): candidate is FilterOp {
  return (FILTER_OPS as readonly string[]).includes(candidate);
}

/**
 * Field names a filter/sort clause may reference: declared fields plus the
 * implicit `id`, but never a `.hidden()` field.
 *
 * A hidden field is stripped from every outbound row, but filtering or sorting
 * by it would still leak its value through which rows come back and in what
 * order (a prefix/presence/ordering oracle). Naming a hidden field is rejected
 * with the same "unknown field" 422 as an undeclared one, so a caller cannot
 * even tell which fields are hidden.
 */
function knownFieldNames(entity: EntityDef): Set<string> {
  const names = new Set<string>(["id"]);
  for (const [name, field] of Object.entries(entity.fields)) {
    if (!field.hidden) names.add(name);
  }
  return names;
}

/** Coerces a single raw query-string scalar according to the target field's declared type. */
function coerceScalar(field: FieldDef | undefined, raw: string): unknown {
  if (!field) return raw;
  switch (field.type) {
    case "number": {
      // `Number("")` and `Number("  ")` coerce to 0, not NaN, so guard empty
      // and whitespace-only values explicitly.
      if (raw.trim() === "") throw new ApiError(422, "validation", `Invalid number value "${raw}"`);
      const n = Number(raw);
      if (Number.isNaN(n)) throw new ApiError(422, "validation", `Invalid number value "${raw}"`);
      return n;
    }
    case "date":
    case "timestamp": {
      // Guard empty explicitly so the 422 message stays consistent regardless
      // of Date's own quirks.
      if (raw.trim() === "") throw new ApiError(422, "validation", `Invalid date value "${raw}"`);
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) throw new ApiError(422, "validation", `Invalid date value "${raw}"`);
      return d;
    }
    case "boolean": {
      if (raw.trim() === "") throw new ApiError(422, "validation", `Invalid boolean value "${raw}"`);
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new ApiError(422, "validation", `Invalid boolean value "${raw}"`);
    }
    default:
      return raw;
  }
}

/**
 * Coerces the value(s) of an `in` filter. Two wire encodings land on the same
 * coerced array:
 *
 * - Repeated params (`filter[f][in]=a&filter[f][in]=b`): each entry taken
 *   verbatim. This is what `frogcp/client` emits and the only form that keeps
 *   an item containing a literal comma (`"a,b"`) intact.
 * - A single comma-joined param (`filter[f][in]=a,b`): split on `,`. Legacy
 *   grammar, kept for backward compatibility with hand-built query strings.
 */
function coerceInValues(field: FieldDef | undefined, raws: string[]): unknown[] {
  const items = raws.length > 1 ? raws : (raws[0] ?? "").split(",");
  return items.map((part) => coerceScalar(field, part));
}

const FILTER_KEY = /^filter\[([^\]]+)\](?:\[([^\]]+)\])?$/;

/**
 * Parses the frogCP REST query grammar off a request URL into a `ListQuery`:
 *
 * - `filter[field]=x` -> `{ field: [{ op: "eq", value: x }] }`
 * - `filter[field][op]=v` -> op is one of ne/gt/gte/lt/lte/like/in
 * - `in` takes either repeated params (the only form that preserves a comma
 *   within an item) or a single comma-joined value (legacy); both fold into
 *   one `in` condition (see `coerceInValues`)
 * - repeating `filter[field][op]` for the same field (ops other than `in`)
 *   ANDs the conditions, e.g. `filter[priority][gte]=2&filter[priority][lte]=5`
 * - values are coerced to number/date/boolean when the field is typed that way
 * - `sort=-createdAt,title` -> `[{ field: "createdAt", dir: "desc" }, ...]`
 * - `limit`/`offset` -> integers
 * - `with=owner,reviewer` -> `["owner", "reviewer"]`
 *
 * Any filter/sort field name not declared on `entity` (and not `id`) throws a
 * 422 `ApiError`, so callers get a clean validation envelope instead of an
 * opaque SQL failure downstream.
 */
export function parseListQuery(url: URL, entity: EntityDef): ListQuery {
  const known = knownFieldNames(entity);
  const query: ListQuery = {};

  const filter: Record<string, FilterCondition[]> = {};
  // An `in` filter sent as repeated params surfaces once per value in
  // `entries()`. Fold the whole set via `getAll` on first sighting and skip
  // the rest of that key, so they don't each spawn a redundant single-item
  // `in` condition.
  const seenInKeys = new Set<string>();
  for (const [key, rawValue] of url.searchParams.entries()) {
    const match = FILTER_KEY.exec(key);
    if (!match) continue;
    const field = match[1] ?? "";
    if (!known.has(field)) {
      throw new ApiError(422, "validation", `Unknown filter field "${field}"`);
    }

    const opRaw = match[2];
    let op: FilterOp = "eq";
    if (opRaw !== undefined) {
      if (!isFilterOp(opRaw)) {
        throw new ApiError(422, "validation", `Unknown filter operator "${opRaw}"`);
      }
      op = opRaw;
    }

    if (op === "in") {
      if (seenInKeys.has(key)) continue;
      seenInKeys.add(key);
      const value = coerceInValues(entity.fields[field], url.searchParams.getAll(key));
      (filter[field] ??= []).push({ op, value });
      continue;
    }

    const condition = { op, value: coerceScalar(entity.fields[field], rawValue) };
    // Multiple conditions on the same field (distinct ops, e.g. gte+lte) are
    // ANDed by the engine rather than the later one clobbering the earlier.
    (filter[field] ??= []).push(condition);
  }
  if (Object.keys(filter).length > 0) query.filter = filter;

  const sortRaw = url.searchParams.get("sort");
  if (sortRaw !== null && sortRaw.length > 0) {
    query.sort = sortRaw.split(",").map((token) => {
      const desc = token.startsWith("-");
      const field = desc ? token.slice(1) : token;
      if (!known.has(field)) {
        throw new ApiError(422, "validation", `Unknown sort field "${field}"`);
      }
      return { field, dir: desc ? ("desc" as const) : ("asc" as const) };
    });
  }

  const limitRaw = url.searchParams.get("limit");
  if (limitRaw !== null) {
    const limit = Number(limitRaw);
    if (!Number.isInteger(limit)) throw new ApiError(422, "validation", `Invalid "limit" value "${limitRaw}"`);
    query.limit = limit;
  }

  const offsetRaw = url.searchParams.get("offset");
  if (offsetRaw !== null) {
    const offset = Number(offsetRaw);
    if (!Number.isInteger(offset)) throw new ApiError(422, "validation", `Invalid "offset" value "${offsetRaw}"`);
    query.offset = offset;
  }

  const withRaw = url.searchParams.get("with");
  if (withRaw !== null && withRaw.length > 0) {
    query.with = withRaw.split(",");
  }

  return query;
}
