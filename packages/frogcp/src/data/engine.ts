import { and, asc, count, desc, eq, gt, gte, inArray, is, like, lt, lte, ne, getTableColumns, type SQL } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import type { DatabaseAdapter } from "../adapter";
import type { CompiledTables } from "../compile/drizzle";
import type { ZodError } from "zod";
import type { EventBus } from "../events";
import { checkRow, decide, type Ctx } from "../permissions/engine";
import type { RuleExpr } from "../permissions/rules";
import type { BackendConfig, EntityDef } from "../schema/types";
import { buildInsertSchema, buildPatchSchema } from "./validate";

/** A single persisted (or embedded) record, keyed by field name. */
export type Row = Record<string, unknown>;

/**
 * A row as returned by `read`/`list`: when `with` relations were requested, the
 * embedded target rows live under `expand`, keyed by the ref field name
 * (PocketBase-style). The ref field itself always keeps its raw id value.
 * `expand` is absent when no `with` was requested.
 */
export type ExpandedRow = Row & { expand?: Record<string, Row | null> };

export type FilterOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "like" | "in";

export interface FilterCondition {
  op: FilterOp;
  value: unknown;
}

export interface ListQuery {
  // Each field may carry multiple conditions (ANDed together), e.g. a gte+lte
  // pair on the same field expresses a range.
  filter?: Record<string, FilterCondition[]>;
  sort?: { field: string; dir: "asc" | "desc" }[];
  limit?: number; // default 50, max 200
  offset?: number; // default 0
  with?: string[]; // ref field names to embed
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Error thrown by every `DataEngine` method for permission and validation
 * failures. `status`/`code` are stable so a REST (or other) layer can map them
 * mechanically:
 *
 * - `404 not_found`: entity/row does not exist, or a row exists but the
 *   caller's read/row-scoped rule denies it (no existence oracle: a foreign row
 *   and a missing row look identical to the caller).
 * - `403 forbidden`: the action is denied outright, independent of which row.
 * - `422 validation`: malformed input, or an unknown `with` relation name.
 * - `404 unknown_entity`: the entity name itself does not exist.
 * - `409 conflict`: a write collided with a database constraint (a duplicate
 *   `.unique()` value, or a delete blocked by a non-cascading foreign key).
 * - `401 unauthorized`: never thrown by this engine; reserved for
 *   plugin-contributed routes (`frogcp/auth`'s login/me) so every layer maps
 *   errors through the same code list.
 * - `413 payload_too_large`: never thrown by this engine; reserved for plugin
 *   routes (`frogcp/media`'s upload) for the same reason.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface RelationField {
  name: string;
  target: string;
}

/** zod's ZodError#message is a JSON dump of every issue; surface the first issue's own message. */
function validationMessage(error: ZodError): string {
  return error.issues[0]?.message ?? error.message;
}

/**
 * True when `error` is (or wraps) a foreign-key constraint violation. SQLite
 * reports `SQLITE_CONSTRAINT_FOREIGNKEY` for a dangling reference and
 * `SQLITE_CONSTRAINT_TRIGGER` for an `ON DELETE RESTRICT` (the better-sqlite3
 * convention; other sqlite adapters remap to it). Postgres uses SQLSTATE
 * `23503` (`foreign_key_violation`) for both directions.
 *
 * Drizzle's async sessions wrap driver errors in a `DrizzleQueryError` with the
 * real error on `Error#cause`, so this walks the cause chain: a recognized code
 * matches; a level with no `.code` falls back to SQLite's stable message text.
 */
function isForeignKeyViolation(error: unknown): boolean {
  // The depth cap only guards against a pathological self-referential `cause`.
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 8; e = e.cause, depth++) {
    const code = (e as { code?: string }).code;
    if (
      code === "SQLITE_CONSTRAINT_FOREIGNKEY" ||
      code === "SQLITE_CONSTRAINT_TRIGGER" ||
      code === "23503" // Postgres: foreign_key_violation (insert/update AND restrict-delete)
    ) {
      return true;
    }
    if (!code && /FOREIGN KEY constraint failed/i.test(e.message)) return true;
  }
  return false;
}

/**
 * True when `error` is (or wraps) a UNIQUE constraint violation, i.e. a
 * create/update collided with an existing row on a `.unique()` field. SQLite
 * reports `SQLITE_CONSTRAINT_UNIQUE` (node:sqlite remaps its numeric 2067 to
 * it); Postgres uses SQLSTATE `23505`. Same cause-chain walk as
 * `isForeignKeyViolation`.
 *
 * Exported for plugins that write through `adapter.db` directly (e.g.
 * `frogcp/auth`'s register route) so they map a duplicate to the same 409.
 */
export function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 8; e = e.cause, depth++) {
    const code = (e as { code?: string }).code;
    if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "23505") return true; // 23505: Postgres unique_violation
    if (!code && /UNIQUE constraint failed/i.test(e.message)) return true;
  }
  return false;
}

/**
 * Extracts the offending column name from a UNIQUE-violation error so the 409
 * can name the field without leaking raw SQL. Walks the same cause chain,
 * checking SQLite's "UNIQUE constraint failed: table.column" text or Postgres's
 * `DatabaseError#detail` (`Key (email)=(...) already exists.`). Returns
 * `undefined` if no level matches.
 */
function uniqueViolationField(error: unknown): string | undefined {
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 8; e = e.cause, depth++) {
    const match = /UNIQUE constraint failed: \w+\.(\w+)/i.exec(e.message);
    if (match) return match[1];
    const detail = (e as { detail?: unknown }).detail;
    if (typeof detail === "string") {
      const pgMatch = /^Key \((\w+)\)=/.exec(detail);
      if (pgMatch) return pgMatch[1];
    }
  }
  return undefined;
}

/**
 * The field names referenced by any `owner()` node across all of the entity's
 * permission rules. These define row ownership, so the engine treats them as
 * server-managed for non-admin callers.
 */
function ownerFields(entity: EntityDef): Set<string> {
  const fields = new Set<string>();
  const walk = (expr: RuleExpr): void => {
    if (expr.kind === "owner") {
      fields.add(expr.field);
    } else if (expr.kind === "or" || expr.kind === "and") {
      for (const r of expr.rules) walk(r);
    }
  };
  for (const rule of Object.values(entity.permissions)) {
    if (rule) walk(rule.expr);
  }
  return fields;
}

/**
 * The field names declared `.readonly()` on the entity. Readonly fields are
 * server-managed exactly like owner fields (non-admin clients can never set or
 * change them), but unlike `.hidden()` fields they stay visible in responses.
 */
function readonlyFields(entity: EntityDef): Set<string> {
  const fields = new Set<string>();
  for (const [name, field] of Object.entries(entity.fields)) {
    if (field.readonly) fields.add(name);
  }
  return fields;
}

/**
 * Strips every `.hidden()` field of `entity` from `row`. The single choke point
 * every outbound row funnels through (read, list, create/update returns, and
 * embedded relation rows), so a hidden field can never leak, including to an
 * admin ctx. Returns `row` unchanged (no copy) when the entity has no hidden
 * fields.
 */
function stripHidden<T extends Row>(entity: EntityDef, row: T): T {
  const hiddenNames = Object.entries(entity.fields)
    .filter(([, field]) => field.hidden)
    .map(([name]) => name);
  if (hiddenNames.length === 0) return row;
  const out = { ...row };
  for (const name of hiddenNames) delete out[name];
  return out;
}

// Internal erasure for DataEngine's query-builder plumbing. The method chains
// below are the same calls regardless of dialect, but drizzle's SQLite and
// Postgres database/table/column types are not mutually assignable (different
// generics), so a single field typed for one dialect cannot hold the other's
// objects. Same erasure as compile/{sqlite,postgres}.ts. Never appears in an
// exported signature: every public method stays precisely typed via
// Row/ExpandedRow/ApiError/ListQuery.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTable = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyColumn = any;

/**
 * Permission-enforced CRUD over a compiled frogCP backend. Every read merges
 * the caller's permission-derived SQL filter into the query (including the
 * `meta.total` COUNT for `list`); every write re-checks the caller's rule
 * against the concrete row before applying the mutation. All queries go through
 * the drizzle query builder against the tables `compileTables` produced, no raw
 * SQL strings.
 *
 * Dialect-generic: every query is built from dialect-agnostic `drizzle-orm`
 * primitives plus the query-builder chain both `BaseSQLiteDatabase` and
 * `PgDatabase` implement identically (see the `AnyDb` erasure above for why the
 * stored types don't reflect that). Constraint-violation mapping is
 * dialect-aware (walks both SQLite's and Postgres's error codes).
 */
export class DataEngine {
  private readonly db: AnyDb;
  private readonly dialect: "sqlite" | "postgres";

  constructor(
    adapter: DatabaseAdapter,
    private config: BackendConfig,
    private tables: CompiledTables,
    private readonly events: EventBus,
  ) {
    this.dialect = adapter.dialect;
    // Dialect-coherence guard: a mismatch (e.g. a "postgres" adapter handed
    // sqlite-compiled tables) would emit malformed SQL or fail deep inside
    // drizzle with an opaque error, so fail early here with a clear message.
    // replaceSchema re-asserts the same invariant on every managed-mode swap.
    this.assertTablesDialect(tables);
    this.db = adapter.db;
  }

  /**
   * `is(table, PgTable)` is drizzle's runtime brand check; every table in a
   * `compileTables(config, dialect)` result is the same dialect, so checking
   * the first table is sufficient.
   */
  private assertTablesDialect(tables: CompiledTables): void {
    const firstTable = Object.values(tables)[0];
    if (firstTable === undefined) return;
    const tablesDialect = is(firstTable, PgTable) ? "postgres" : "sqlite";
    if (tablesDialect !== this.dialect) {
      throw new Error(
        `DataEngine: adapter dialect "${this.dialect}" does not match the compiled tables' ` +
          `dialect "${tablesDialect}"; compile the tables with compileTables(config, "${this.dialect}").`,
      );
    }
  }

  /**
   * Atomically swaps the engine's live `config`/`tables`. Managed mode's
   * `Backend.applySchema` calls this after `migrateToConfig` has already
   * applied the DDL, so the database already matches `config`/`tables`.
   *
   * Safe for in-flight requests, with one accepted transient edge. This method
   * is fully synchronous, so a swap can only land between request turns, never
   * mid-statement. Every request method captures its top-level entity/table
   * into a local before its first `await`, so the primary entity a request
   * operates on is fixed for its lifetime.
   *
   * The exception: relation expansion (`embedRelations`) resolves each `?with=`
   * target entity/table at expansion time, after an await, so a swap landing
   * mid-request can resolve a `?with=` target against the new schema. This is
   * non-corrupting (the DB was already migrated), request-scoped, and no write
   * path depends on a relation-target lookup. Documented and accepted rather
   * than eliminated.
   */
  replaceSchema(config: BackendConfig, tables: CompiledTables): void {
    this.assertTablesDialect(tables);
    this.config = config;
    this.tables = tables;
  }

  async list(
    name: string,
    ctx: Ctx,
    q: ListQuery = {},
  ): Promise<{ data: ExpandedRow[]; meta: { total: number; limit: number; offset: number } }> {
    const entity = this.getEntity(name);
    const table = this.getTable(name);

    const decision = decide(entity, "list", ctx, table);
    if (!decision.allow) {
      throw new ApiError(403, "forbidden", `Not allowed to list "${name}"`);
    }

    const relations = this.resolveRelationFields(entity, q.with);

    const conditions: SQL[] = [];
    if (decision.filter) conditions.push(decision.filter);
    for (const [field, conds] of Object.entries(q.filter ?? {})) {
      this.assertQueryable(entity, field, "filter");
      for (const cond of conds) {
        conditions.push(this.buildFilterCondition(table, field, cond.op, cond.value));
      }
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    // Clamp both ends: a negative/zero limit must not reach the driver (SQLite
    // treats LIMIT -1 as unlimited), and a negative offset must not reach SQL.
    const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(q.offset ?? 0, 0);

    let selectQuery = this.db.select().from(table).$dynamic();
    if (where) selectQuery = selectQuery.where(where);
    if (q.sort && q.sort.length > 0) {
      const columns = getTableColumns(table);
      const orderings = q.sort.map((s) => {
        this.assertQueryable(entity, s.field, "sort");
        const col = columns[s.field];
        if (!col) throw new ApiError(422, "validation", `Unknown sort field "${s.field}" on "${name}"`);
        return s.dir === "desc" ? desc(col) : asc(col);
      });
      selectQuery = selectQuery.orderBy(...orderings);
    }
    selectQuery = selectQuery.limit(limit).offset(offset);

    const rows = (await selectQuery) as Row[];

    let countQuery = this.db.select({ total: count() }).from(table).$dynamic();
    if (where) countQuery = countQuery.where(where);
    const countRows = await countQuery;
    const total = countRows[0]?.total ?? 0;

    await this.embedRelations(rows, relations, ctx);

    return { data: rows.map((row) => stripHidden(entity, row)), meta: { total, limit, offset } };
  }

  async read(name: string, id: string, ctx: Ctx, withRels?: string[]): Promise<ExpandedRow> {
    const entity = this.getEntity(name);
    const table = this.getTable(name);

    const notFound = () => new ApiError(404, "not_found", `"${name}" with id "${id}" not found`);

    const decision = decide(entity, "read", ctx, table);
    // A statically denied read is a plain 403, mirroring update/delete. Only
    // row-scoped denials hide behind 404, so "not yours" and "doesn't exist"
    // stay indistinguishable (no existence oracle).
    if (!decision.allow) {
      throw new ApiError(403, "forbidden", `Not allowed to read "${name}"`);
    }

    const relations = this.resolveRelationFields(entity, withRels);

    const idCol = this.idColumn(table);
    const conditions: SQL[] = [eq(idCol, id)];
    if (decision.filter) conditions.push(decision.filter);
    const where = this.andAll(conditions);

    const rows = (await this.db.select().from(table).where(where).limit(1)) as Row[];
    const row = rows[0];
    if (!row) throw notFound();

    await this.embedRelations([row], relations, ctx);
    return stripHidden(entity, row);
  }

  /**
   * Permission-respecting single-row lookup by an arbitrary column (not
   * necessarily `id`), for plugin routes that need "find one row by some field,
   * permission-filtered and hidden-stripped like `read`" (e.g. `frogcp/media`'s
   * `GET /files/:key`).
   *
   * Unlike `read`, denial never throws: it collapses to `null` whether the row
   * is missing, or exists but the caller's rule denies it, or the action is
   * denied outright. There is no dedicated REST route here, so the caller
   * decides the status code. `name` unknown throws
   * `ApiError(404, "unknown_entity", ...)`; `field` unknown throws a plain
   * `Error` (this is not an HTTP endpoint and an unknown hardcoded field is a
   * caller bug, not something a client can trigger).
   */
  async findByField(name: string, field: string, value: unknown, ctx: Ctx): Promise<Row | null> {
    const entity = this.getEntity(name);
    const table = this.getTable(name);

    const col = getTableColumns(table)[field];
    if (!col) throw new Error(`DataEngine.findByField: unknown field "${field}" on entity "${name}"`);

    const decision = decide(entity, "read", ctx, table);
    if (!decision.allow) return null;

    const conditions: SQL[] = [eq(col, value)];
    if (decision.filter) conditions.push(decision.filter);
    const where = this.andAll(conditions);

    const rows = (await this.db.select().from(table).where(where).limit(1)) as Row[];
    const row = rows[0];
    if (!row) return null;

    return stripHidden(entity, row);
  }

  async create(name: string, input: unknown, ctx: Ctx, requestId?: string): Promise<Row> {
    const entity = this.getEntity(name);
    const table = this.getTable(name);

    // Readonly fields are server-managed: a non-admin's value is stripped
    // before validation so the field takes its default. Owner fields are then
    // stamped from the caller's identity before validation, so a required owner
    // field an authenticated caller omitted or spoofed is filled with their own
    // userId. Admin keeps explicit values and defaults omitted ones to its own
    // userId; a guest has no identity, so its owner fields are stripped.
    // Readonly stripping runs first so a field that is both readonly and an
    // owner field still ends up server-stamped.
    const stamped = this.stampOwnerFields(entity, this.stripReadonlyFields(entity, input, ctx), ctx);

    // Authorization before validation: unauthorized callers must not learn
    // schema shape from 422s (consistent with update/delete).
    const decision = decide(entity, "create", ctx, table);
    if (!decision.allow) {
      throw new ApiError(403, "forbidden", `Not allowed to create "${name}"`);
    }

    const parsed = buildInsertSchema(entity).safeParse(stamped);
    if (!parsed.success) {
      throw new ApiError(422, "validation", validationMessage(parsed.error));
    }

    const row: Row = { ...parsed.data, id: crypto.randomUUID() };
    for (const [fieldName, field] of Object.entries(entity.fields)) {
      if (field.auto) row[fieldName] = new Date();
    }

    let inserted: Row | undefined;
    try {
      [inserted] = await this.db.insert(table).values(row).returning();
    } catch (error) {
      throw await this.mapWriteConstraintError(error, entity, row);
    }
    if (!inserted) throw new Error(`insert into "${name}" returned no row`);
    const result = stripHidden(entity, inserted as Row);
    await this.events.emit("record.created", { entity: name, row: result, ctx, ...(requestId !== undefined ? { requestId } : {}) });
    return result;
  }

  async update(name: string, id: string, patch: unknown, ctx: Ctx, requestId?: string): Promise<Row> {
    const entity = this.getEntity(name);
    const table = this.getTable(name);

    const decision = decide(entity, "update", ctx, table);
    if (!decision.allow) {
      throw new ApiError(403, "forbidden", `Not allowed to update "${name}"`);
    }

    const existing = await this.fetchById(table, id);
    if (!existing) throw new ApiError(404, "not_found", `"${name}" with id "${id}" not found`);

    // Row exists, but the caller's row-scoped rule may still reject it: same
    // no-existence-oracle principle as `read`, so this surfaces as 404, not 403.
    if (!checkRow(entity, "update", ctx, existing)) {
      throw new ApiError(404, "not_found", `"${name}" with id "${id}" not found`);
    }

    const parsed = buildPatchSchema(entity).safeParse(patch);
    if (!parsed.success) {
      throw new ApiError(422, "validation", validationMessage(parsed.error));
    }

    // A key present with an explicit `undefined` value is not a change: strip
    // such keys so they behave like absent keys and never reach drizzle's
    // .set() (which throws "No values to set" when every value is undefined).
    const patchData: Row = Object.fromEntries(
      Object.entries(parsed.data).filter(([, v]) => v !== undefined),
    );

    // Auto fields are system-managed: strip any client-supplied value so a
    // spoofed timestamp can never persist (create's auto-fill loop is the only
    // writer of these fields).
    for (const [fieldName, field] of Object.entries(entity.fields)) {
      if (field.auto) delete patchData[fieldName];
    }

    // Ownership and readonly integrity: non-admin callers may not change an
    // owner or `.readonly()` field. A patch repeating the current value is a
    // harmless no-op. Enforced here, not in the zod schemas, which stay
    // inclusive of readonly fields so admin writes still validate.
    if (ctx?.role !== "admin") {
      for (const field of new Set([...ownerFields(entity), ...readonlyFields(entity)])) {
        if (field in patchData && patchData[field] !== existing[field]) {
          throw new ApiError(422, "validation", `"${field}" is server-managed`);
        }
      }
    }

    // No-op patch: no DB write, so no `record.updated` event either (events
    // announce successful DB operations, and none ran here).
    if (Object.keys(patchData).length === 0) return stripHidden(entity, existing);

    const idCol = this.idColumn(table);
    let updated: Row | undefined;
    try {
      [updated] = await this.db.update(table).set(patchData).where(eq(idCol, id)).returning();
    } catch (error) {
      throw await this.mapWriteConstraintError(error, entity, patchData);
    }
    if (!updated) throw new Error(`update on "${name}" id "${id}" returned no row`);
    const result = stripHidden(entity, updated as Row);
    await this.events.emit("record.updated", { entity: name, row: result, ctx, ...(requestId !== undefined ? { requestId } : {}) });
    return result;
  }

  async delete(name: string, id: string, ctx: Ctx, requestId?: string): Promise<void> {
    const entity = this.getEntity(name);
    const table = this.getTable(name);

    const decision = decide(entity, "delete", ctx, table);
    if (!decision.allow) {
      throw new ApiError(403, "forbidden", `Not allowed to delete "${name}"`);
    }

    const existing = await this.fetchById(table, id);
    if (!existing) throw new ApiError(404, "not_found", `"${name}" with id "${id}" not found`);

    if (!checkRow(entity, "delete", ctx, existing)) {
      throw new ApiError(404, "not_found", `"${name}" with id "${id}" not found`);
    }

    const idCol = this.idColumn(table);
    try {
      await this.db.delete(table).where(eq(idCol, id));
    } catch (error) {
      if (!isForeignKeyViolation(error)) throw error;
      throw new ApiError(
        409,
        "conflict",
        `Cannot delete "${name}" with id "${id}": other rows still reference it`,
      );
    }
    await this.events.emit("record.deleted", { entity: name, row: stripHidden(entity, existing), ctx, ...(requestId !== undefined ? { requestId } : {}) });
  }

  /**
   * Maps a driver error from a create/update write to the `ApiError` the caller
   * should throw, or rethrows `error` unchanged if it's neither kind this
   * engine handles. A `.unique()` collision wins over a dangling-ref check
   * (the more specific diagnosis) when a driver could report either.
   */
  private async mapWriteConstraintError(error: unknown, entity: EntityDef, data: Row): Promise<unknown> {
    if (isUniqueViolation(error)) {
      const field = uniqueViolationField(error);
      return new ApiError(
        409,
        "conflict",
        field ? `"${field}" already exists` : "a unique constraint was violated",
      );
    }
    if (isForeignKeyViolation(error)) {
      return new ApiError(422, "validation", await this.danglingRefMessage(entity, data));
    }
    return error;
  }

  /**
   * Returns `input` with every `.readonly()` field removed for non-admin
   * callers (guest included): the value is ignored and the field takes its
   * default, like an omitted field. Admin values pass through. Non-object
   * inputs are left for schema validation to reject.
   */
  private stripReadonlyFields(entity: EntityDef, input: unknown, ctx: Ctx): unknown {
    if (ctx?.role === "admin") return input;
    const fields = readonlyFields(entity);
    if (fields.size === 0) return input;
    if (typeof input !== "object" || input === null || Array.isArray(input)) return input;

    const stripped: Record<string, unknown> = { ...(input as Record<string, unknown>) };
    for (const field of fields) delete stripped[field];
    return stripped;
  }

  /**
   * Returns `input` with every owner field under server control: a guest
   * (`ctx === null`) has no identity, so its owner fields are stripped (fail
   * closed) so no `owner()` rule can ever match the row back; a non-admin gets
   * their own userId (any client value is overridden); admin keeps explicit
   * values and defaults omitted ones to its own userId. Non-object inputs are
   * left for schema validation to reject.
   */
  private stampOwnerFields(entity: EntityDef, input: unknown, ctx: Ctx): unknown {
    const fields = ownerFields(entity);
    if (fields.size === 0) return input;
    if (typeof input !== "object" || input === null || Array.isArray(input)) return input;

    const stamped: Record<string, unknown> = { ...(input as Record<string, unknown>) };
    for (const field of fields) {
      if (ctx === null) {
        delete stamped[field];
      } else if (ctx.role === "admin") {
        if (stamped[field] === undefined) stamped[field] = ctx.userId;
      } else {
        stamped[field] = ctx.userId;
      }
    }
    return stamped;
  }

  /**
   * Builds the 422 message for a dangling-reference FK failure. The driver
   * error carries no column info, so re-check each `ref` field present in
   * `data` against its target table to name the offending field; fall back to a
   * generic message if none of the present ref values are individually
   * resolvable.
   */
  private async danglingRefMessage(entity: EntityDef, data: Row): Promise<string> {
    for (const [fieldName, field] of Object.entries(entity.fields)) {
      if (field.type !== "ref" || !field.target) continue;
      const value = data[fieldName];
      if (typeof value !== "string") continue;
      const targetTable = this.tables[field.target];
      if (!targetTable) continue;
      const targetRow = await this.fetchById(targetTable, value);
      if (!targetRow) return `invalid reference: "${fieldName}"`;
    }
    return "invalid reference";
  }

  private getEntity(name: string): EntityDef {
    const entity = this.config.entities[name];
    if (!entity) throw new ApiError(404, "unknown_entity", `Unknown entity "${name}"`);
    return entity;
  }

  private getTable(name: string): AnyTable {
    const table = this.tables[name];
    if (!table) throw new ApiError(404, "unknown_entity", `Unknown entity "${name}"`);
    return table;
  }

  private idColumn(table: AnyTable): AnyColumn {
    const col = getTableColumns(table).id;
    // Invariant: compileTables adds an `id` primary key column to every table.
    if (!col) throw new Error('table is missing its "id" column');
    return col;
  }

  private andAll(conditions: SQL[]): SQL {
    const combined = and(...conditions);
    // and(...) only returns undefined for zero conditions; callers always pass
    // at least one.
    if (!combined) throw new Error("unreachable: andAll called with no conditions");
    return combined;
  }

  private async fetchById(table: AnyTable, id: string): Promise<Row | undefined> {
    const idCol = this.idColumn(table);
    const rows = (await this.db.select().from(table).where(eq(idCol, id)).limit(1)) as Row[];
    return rows[0];
  }

  /**
   * Defense-in-depth guard against querying a `.hidden()` column.
   * `parseListQuery` already strips hidden fields at the REST boundary, but
   * `list` also accepts a hand-built `ListQuery` (bypassing that parser).
   * Allowing a hidden field in WHERE/ORDER BY would leak its value through the
   * set/order of returned rows. Rejected as an "unknown field" 422, identical
   * to an undeclared field.
   */
  private assertQueryable(entity: EntityDef, field: string, kind: "filter" | "sort"): void {
    if (entity.fields[field]?.hidden) {
      throw new ApiError(422, "validation", `Unknown ${kind} field "${field}"`);
    }
  }

  private buildFilterCondition(table: AnyTable, field: string, op: FilterOp, value: unknown): SQL {
    const col = getTableColumns(table)[field];
    if (!col) throw new ApiError(422, "validation", `Unknown filter field "${field}"`);

    switch (op) {
      case "eq":
        return eq(col, value);
      case "ne":
        return ne(col, value);
      case "gt":
        return gt(col, value);
      case "gte":
        return gte(col, value);
      case "lt":
        return lt(col, value);
      case "lte":
        return lte(col, value);
      case "like":
        if (typeof value !== "string") {
          throw new ApiError(422, "validation", `"like" filter on "${field}" requires a string value`);
        }
        // Dialect caveat: LIKE case-sensitivity is not portable. SQLite's LIKE
        // is ASCII case-insensitive by default; Postgres's LIKE is
        // case-sensitive. frogCP does not normalize this; documented here.
        return like(col, value);
      case "in":
        if (!Array.isArray(value)) {
          throw new ApiError(422, "validation", `"in" filter on "${field}" requires an array value`);
        }
        return inArray(col, value);
      default: {
        const exhaustive: never = op;
        throw new ApiError(422, "validation", `Unknown filter operator "${String(exhaustive)}"`);
      }
    }
  }

  private resolveRelationFields(entity: EntityDef, withNames: string[] | undefined): RelationField[] {
    if (!withNames || withNames.length === 0) return [];
    return withNames.map((relName) => {
      const field = entity.fields[relName];
      if (!field || field.type !== "ref" || !field.target) {
        throw new ApiError(422, "validation", `Unknown relation "${relName}"`);
      }
      return { name: relName, target: field.target };
    });
  }

  /**
   * Attaches an `expand` object to each row, keyed by relation name. The ref
   * field keeps its raw id; a denied or dangling target embeds as `null`
   * (no existence oracle through relations). `expand` is only added when
   * relations were requested. Embedded rows are run through `stripHidden`
   * against the target entity's own hidden fields.
   */
  private async embedRelations(rows: Row[], relations: RelationField[], ctx: Ctx): Promise<void> {
    if (relations.length === 0 || rows.length === 0) return;

    for (const row of rows) {
      const expand: Record<string, Row | null> = {};
      for (const { name, target } of relations) {
        const fkValue = row[name];
        let embedded: Row | null = null;

        if (typeof fkValue === "string") {
          const targetEntity = this.getEntity(target);
          const targetTable = this.getTable(target);
          const targetRow = await this.fetchById(targetTable, fkValue);
          if (targetRow && checkRow(targetEntity, "read", ctx, targetRow)) {
            embedded = stripHidden(targetEntity, targetRow);
          }
        }

        expand[name] = embedded;
      }
      (row as ExpandedRow).expand = expand;
    }
  }
}
