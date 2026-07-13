import type { PgTable } from "drizzle-orm/pg-core";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { BackendConfig } from "../schema/types";
import { compileSqliteTables } from "./sqlite";
import { compilePostgresTables } from "./postgres";

/**
 * The tables `compileTables` produces, keyed by entity name. Each value is
 * either a drizzle sqlite-core or pg-core table depending on the `dialect` the
 * call used. A single `compileTables(config, dialect)` call always produces
 * tables that are all one dialect (never mixed), so any given `CompiledTables`
 * instance is homogeneous even though the type is a union.
 */
export type CompiledTables = Record<string, SQLiteTable | PgTable>;

/**
 * Compiles a frogCP `BackendConfig` into one Drizzle table per entity for the
 * given SQL `dialect`. Defaults to `"sqlite"` so every pre-Phase-3 caller keeps
 * working unchanged. See `compile/sqlite.ts` and `compile/postgres.ts` for the
 * per-dialect column mapping.
 */
export function compileTables(config: BackendConfig, dialect: "sqlite" | "postgres" = "sqlite"): CompiledTables {
  return dialect === "postgres" ? compilePostgresTables(config) : compileSqliteTables(config);
}
