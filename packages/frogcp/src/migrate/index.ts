import type { DatabaseAdapter } from "../adapter";
import type { Logger } from "../observability/logger";
import type { BackendConfig } from "../schema/types";
import { migrateToConfig as migrateSqlite } from "./sqlite";
import { migrateToConfig as migratePostgres } from "./postgres";

export { generateSqliteMigration } from "./sqlite";
export { generatePostgresMigration } from "./postgres";

/**
 * Dialect-dispatching `migrateToConfig`, the publicly-exported entry point
 * (re-exported from the package root). Branches on `adapter.dialect` to the
 * sqlite or postgres module.
 *
 * `logger` is optional (each dialect module defaults to `consoleLogger()`) and
 * is forwarded through so the destructive-migration warning routes through the
 * kernel's configured logger when `createBackend` passes one.
 */
export async function migrateToConfig(adapter: DatabaseAdapter, config: BackendConfig, logger?: Logger): Promise<void> {
  if (adapter.dialect === "postgres") {
    await migratePostgres(adapter, config, logger);
    return;
  }
  await migrateSqlite(adapter, config, logger);
}
