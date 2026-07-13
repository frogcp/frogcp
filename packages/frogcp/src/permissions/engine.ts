import { and, or, eq, getTableColumns, type SQL, type Table } from "drizzle-orm";
import type { RuleExpr } from "./rules";
import type { ActionName, EntityDef } from "../schema/types";

export interface Identity {
  userId: string;
  role: string;
  // Arbitrary auth-provider claims (e.g. from a decoded JWT) the permission
  // engine does not yet interpret. Optional so nothing else needs to change.
  claims?: Record<string, unknown>;
}

/** null is a guest (unauthenticated). */
export type Ctx = Identity | null;

export type Decision = { allow: true; filter?: SQL } | { allow: false };

// Tri-state result of evaluating a RuleExpr against a table: statically
// allowed (true), statically denied (false), or row-scoped (an SQL condition
// that must additionally hold).
type SqlTriState = true | false | SQL;

function getOwnerColumn(table: Table, field: string) {
  const columns = getTableColumns(table);
  const col = columns[field];
  if (!col) {
    throw new Error(`owner() rule references unknown field "${field}" on table`);
  }
  return col;
}

function evalSql(expr: RuleExpr, ctx: Ctx, table: Table): SqlTriState {
  switch (expr.kind) {
    case "role":
      return ctx?.role === expr.role;
    case "authenticated":
      return ctx !== null;
    case "public":
      return true;
    case "owner": {
      if (ctx === null) return false;
      const col = getOwnerColumn(table, expr.field);
      return eq(col, ctx.userId);
    }
    case "or": {
      // Short-circuit on a statically-true branch so a misconfigured sibling
      // (e.g. owner() on an unknown column) never throws once the outcome is
      // already settled. Mirrors evalRow's `.some()`.
      const sqlParts: SQL[] = [];
      for (const r of expr.rules) {
        const part = evalSql(r, ctx, table);
        if (part === true) return true;
        if (part !== false) sqlParts.push(part);
      }
      if (sqlParts.length === 0) return false;
      if (sqlParts.length === 1) {
        const only = sqlParts[0];
        if (only === undefined) throw new Error("unreachable: sqlParts.length === 1 but element missing");
        return only;
      }
      // or(...) only returns undefined for zero conditions; we have at least two.
      return or(...sqlParts) as SQL;
    }
    case "and": {
      // Short-circuit on a statically-false branch. Mirrors evalRow's `.every()`.
      const sqlParts: SQL[] = [];
      for (const r of expr.rules) {
        const part = evalSql(r, ctx, table);
        if (part === false) return false;
        if (part !== true) sqlParts.push(part);
      }
      if (sqlParts.length === 0) return true;
      if (sqlParts.length === 1) {
        const only = sqlParts[0];
        if (only === undefined) throw new Error("unreachable: sqlParts.length === 1 but element missing");
        return only;
      }
      // and(...) only returns undefined for zero conditions; we have at least two.
      return and(...sqlParts) as SQL;
    }
  }
}

function evalRow(expr: RuleExpr, ctx: Ctx, row: Record<string, unknown>): boolean {
  switch (expr.kind) {
    case "role":
      return ctx?.role === expr.role;
    case "authenticated":
      return ctx !== null;
    case "public":
      return true;
    case "owner":
      if (ctx === null) return false;
      return row[expr.field] === ctx.userId;
    case "or":
      return expr.rules.some((r) => evalRow(r, ctx, row));
    case "and":
      return expr.rules.every((r) => evalRow(r, ctx, row));
  }
}

/**
 * Decide whether `ctx` may perform `action` on `entity`, returning either a
 * static allow/deny or an allow with a row-scoped SQL `filter` to apply to the
 * query.
 *
 * A missing rule for the action means admin only. `admin` is always allowed
 * with no filter, regardless of any rule defined for the action.
 */
export function decide(entity: EntityDef, action: ActionName, ctx: Ctx, table: Table): Decision {
  if (ctx?.role === "admin") return { allow: true };

  const rule = entity.permissions[action];
  if (!rule) return { allow: false };

  const result = evalSql(rule.expr, ctx, table);
  if (result === true) return { allow: true };
  if (result === false) return { allow: false };
  return { allow: true, filter: result };
}

/**
 * Evaluate the same permission semantics as `decide`, but against a concrete
 * row rather than producing a SQL filter. Used for post-fetch single-row
 * checks (e.g. after a lookup by id).
 */
export function checkRow(
  entity: EntityDef,
  action: ActionName,
  ctx: Ctx,
  row: Record<string, unknown>,
): boolean {
  if (ctx?.role === "admin") return true;

  const rule = entity.permissions[action];
  if (!rule) return false;

  return evalRow(rule.expr, ctx, row);
}
