/**
 * The frogCP REST filter operators, mirrored from the data engine's own
 * `FilterOp` union. Re-declared rather than imported: the client has zero
 * runtime dependency on the server, so the wire grammar it targets lives here.
 */
export type FilterOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "like" | "in";

/** Deterministic serialize order when a field has more than one condition, so
 * the emitted query string never depends on object iteration order. */
const FILTER_OP_ORDER: readonly FilterOp[] = ["eq", "ne", "gt", "gte", "lt", "lte", "like", "in"];

/** A single filter value. A `Date` serializes to its ISO string, everything
 * else via `String()`, matching the scalar types the server round-trips. */
export type FilterScalar = string | number | boolean | Date;

/**
 * A field's filter clause: either a bare scalar (shorthand for `{ eq: ... }`),
 * or an object mapping one or more operators to a value. `in` takes an array,
 * every other op takes a single scalar.
 */
export type FilterOpMap = Partial<Record<Exclude<FilterOp, "in">, FilterScalar>> & {
  in?: readonly FilterScalar[];
};

export type FilterValue = FilterScalar | FilterOpMap;

export interface ListQueryInput {
  /** `{ field: value }` for equality, or `{ field: { op: value, ... } }` for
   * anything else. Multiple ops on the same field AND together server-side. */
  filter?: Record<string, FilterValue>;
  /** Field names in sort priority order, each optionally prefixed with `-`
   * for descending (e.g. `["-createdAt", "title"]`). */
  sort?: readonly string[];
  limit?: number;
  offset?: number;
  /** Ref field names to embed on each row (`row.expand[name]`). */
  with?: readonly string[];
}

function serializeScalar(value: FilterScalar): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function isFilterOpMap(value: FilterValue): value is FilterOpMap {
  return typeof value === "object" && value !== null && !(value instanceof Date);
}

/** Explicit type-guard wrapper around `Array.isArray`: the builtin's `arg is
 * any[]` predicate does not narrow a `readonly T[]` union member out of the
 * false branch reliably, so this pins the exact predicate type instead. */
function isScalarArray(value: FilterScalar | readonly FilterScalar[]): value is readonly FilterScalar[] {
  return Array.isArray(value);
}

/** Percent-encodes a single query value token. Field and operator names are
 * our own controlled bracket syntax, so only values run through this. */
function encodeToken(raw: string): string {
  return encodeURIComponent(raw);
}

/**
 * Encodes a `ListQueryInput` into the frogCP REST query grammar (the
 * client-side mirror of the server's `parseListQuery`): `filter[field]=v` for
 * eq, `filter[field][op]=v` otherwise, `sort=-a,b`, `limit`/`offset`, and
 * `with=a,b`. Returns `""` when the query is empty, or `"?..."` otherwise.
 */
export function encodeListQuery(query?: ListQueryInput): string {
  const params: string[] = [];

  if (query?.filter) {
    for (const [field, value] of Object.entries(query.filter)) {
      if (isFilterOpMap(value)) {
        for (const op of FILTER_OP_ORDER) {
          const raw = value[op];
          if (raw === undefined) continue;
          const key = op === "eq" ? `filter[${field}]` : `filter[${field}][${op}]`;
          if (isScalarArray(raw)) {
            // `in` values are emitted as repeated params (one
            // `filter[field][in]=<item>` per item), not a single comma-joined
            // value. The server reads the value after `URLSearchParams` has
            // percent-decoded it, then splits a single value on `,`, so a
            // comma-joined encoding would let a comma within an item ("a,b")
            // split into two items server-side. Repeated params keep each
            // item atomic via `searchParams.getAll`, commas preserved.
            //
            // A lone item is emitted twice: the server's `coerceInValues`
            // only takes the "already repeated" path when `getAll(...)`
            // returns more than one value; a single value falls back to its
            // legacy comma-split branch, which would wrongly re-split a lone
            // item containing a literal comma. Duplicating the one item forces
            // `getAll(...).length === 2`, landing on the safe path; SQL
            // `IN (...)` dedupes, so the filter semantics never change.
            const encodedItems = raw.map((item) => encodeToken(serializeScalar(item)));
            const wireItems = encodedItems.length === 1 ? [...encodedItems, ...encodedItems] : encodedItems;
            for (const enc of wireItems) {
              params.push(`${key}=${enc}`);
            }
          } else {
            params.push(`${key}=${encodeToken(serializeScalar(raw))}`);
          }
        }
      } else {
        params.push(`filter[${field}]=${encodeToken(serializeScalar(value))}`);
      }
    }
  }

  if (query?.sort && query.sort.length > 0) {
    params.push(`sort=${query.sort.map(encodeToken).join(",")}`);
  }

  if (query?.limit !== undefined) {
    params.push(`limit=${encodeToken(String(query.limit))}`);
  }

  if (query?.offset !== undefined) {
    params.push(`offset=${encodeToken(String(query.offset))}`);
  }

  if (query?.with && query.with.length > 0) {
    params.push(`with=${query.with.map(encodeToken).join(",")}`);
  }

  return params.length > 0 ? `?${params.join("&")}` : "";
}
