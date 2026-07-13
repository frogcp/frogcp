import { sql } from "drizzle-orm";
import type { DatabaseAdapter } from "../adapter";
import { extractRows } from "../migrate/postgres";
import type { BackendConfig } from "../schema/types";
import { deserializeConfig, serializeConfig } from "./serialize";

const SCHEMA_TABLE = "__frogcp_schema";
const ROW_ID = "current";

/**
 * Creates the `__frogcp_schema` bookkeeping table if it does not already exist.
 * It is a framework-internal table (raw SQL, like `__frogcp_migrations`), not an
 * entity run through `validateConfig`, so it sidesteps the reserved-`__frogcp`
 * prefix check. It holds a single row (`id = "current"`) with the serialized
 * live `BackendConfig` for managed mode. Dialect-aware: sqlite stores JSON as
 * `TEXT` with an integer `updated_at` (epoch ms); postgres stores it as `JSONB`
 * with a `TIMESTAMPTZ` `updated_at`.
 */
export async function ensureSchemaTable(adapter: DatabaseAdapter): Promise<void> {
  if (adapter.dialect === "postgres") {
    await adapter.exec(`CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLE} (
      id TEXT PRIMARY KEY,
      schema JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    return;
  }
  await adapter.exec(`CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLE} (
    id TEXT PRIMARY KEY,
    schema TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}

/**
 * Reads the current managed-mode schema from `__frogcp_schema`, or `null` when
 * no row has been written yet (fresh database, before the first-boot seed).
 * Ensures the table exists first, so this is safe to call before any prior
 * `ensureSchemaTable`/`writeStoredSchema`.
 */
export async function readStoredSchema(adapter: DatabaseAdapter): Promise<BackendConfig | null> {
  await ensureSchemaTable(adapter);

  let storedJson: string | undefined;
  if (adapter.dialect === "postgres") {
    const rows = extractRows<{ schema: unknown }>(
      await adapter.db.execute(
        sql`SELECT schema FROM ${sql.raw(SCHEMA_TABLE)} WHERE id = ${ROW_ID}`,
      ),
    );
    const row = rows[0];
    if (row === undefined) return null;
    storedJson = typeof row.schema === "string" ? row.schema : JSON.stringify(row.schema);
  } else {
    const rows = await adapter.db.all<{ schema: string }>(
      sql`SELECT schema FROM ${sql.raw(SCHEMA_TABLE)} WHERE id = ${ROW_ID}`,
    );
    const row = rows[0];
    if (row === undefined) return null;
    storedJson = row.schema;
  }

  return deserializeConfig(storedJson);
}

/**
 * Upserts `config` as the current managed-mode schema: a single row
 * (`id = "current"`) in `__frogcp_schema`, overwritten on every call (not one
 * row per write, unlike `__frogcp_migrations`'s append-only history). Ensures
 * the table exists first.
 */
export async function writeStoredSchema(adapter: DatabaseAdapter, config: BackendConfig): Promise<void> {
  await ensureSchemaTable(adapter);

  const json = serializeConfig(config);

  if (adapter.dialect === "postgres") {
    await adapter.db.execute(
      sql`INSERT INTO ${sql.raw(SCHEMA_TABLE)} (id, schema, updated_at) VALUES (${ROW_ID}, ${json}, now())
          ON CONFLICT (id) DO UPDATE SET schema = EXCLUDED.schema, updated_at = EXCLUDED.updated_at`,
    );
    return;
  }

  await adapter.db.run(
    sql`INSERT INTO ${sql.raw(SCHEMA_TABLE)} (id, schema, updated_at) VALUES (${ROW_ID}, ${json}, ${Date.now()})
        ON CONFLICT(id) DO UPDATE SET schema = excluded.schema, updated_at = excluded.updated_at`,
  );
}
