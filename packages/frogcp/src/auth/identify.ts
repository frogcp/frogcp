import { eq, getTableColumns } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Ctx, KernelContext } from "frogcp";
import { sqliteDb } from "./routes";
import { extractToken, verifySession, type SessionConfig } from "./session";

/**
 * Builds the `FrogPlugin.identify` hook for JWT-backed sessions: extract the
 * token (bearer or cookie), verify its signature and expiry, then look up the
 * user's current `role` directly in the `users` table. This reads the DB
 * rather than trusting the JWT payload, which bypasses the permission engine
 * on purpose: identify establishes who is calling, before there is a `Ctx` to
 * evaluate a rule against.
 *
 * Reading the role per request costs one indexed PK SELECT but means a role
 * change or a deletion takes effect on the next request instead of waiting out
 * the session TTL. If it ever becomes a hot-path cost, the fix is a short-TTL
 * cache, not trusting the token's claims.
 *
 * Returns `null` (guest) when there is no token, verification fails, or the
 * referenced user row no longer exists (a deleted user is a dead session even
 * if the JWT has not expired).
 */
export function makeIdentify(
  cfg: SessionConfig,
  ctx: KernelContext,
): (req: Request) => Promise<Ctx> {
  return async (req: Request): Promise<Ctx> => {
    const token = extractToken(req, cfg.cookieName);
    if (!token) return null;

    const verified = await verifySession(cfg, token);
    if (!verified) return null;

    // Cast: this plugin only supports the sqlite dialect. `sqliteDb(ctx)` below
    // throws (before any query runs) on a non-sqlite adapter, so on the path
    // that reaches the query every table is genuinely a SQLiteTable even though
    // the tables type is a sqlite/postgres union. `getTableColumns` is
    // dialect-agnostic.
    const table = ctx.tables.users as SQLiteTable | undefined;
    if (!table) return null; // defensive: no `users` table wired into this backend

    const columns = getTableColumns(table);
    const idCol = columns.id;
    const roleCol = columns.role;
    if (!idCol || !roleCol) return null; // defensive: table shape doesn't match what auth expects

    const rows = (await sqliteDb(ctx)
      .select({ id: idCol, role: roleCol })
      .from(table)
      .where(eq(idCol, verified.userId))
      .limit(1)) as { id: string; role: string }[];

    const row = rows[0];
    if (!row) return null; // deleted user = dead session

    return { userId: row.id, role: row.role };
  };
}
