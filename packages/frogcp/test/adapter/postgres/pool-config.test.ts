import { describe, it, expect, afterAll } from "vitest";
import { Pool } from "pg";
import { migrateToConfig, defineBackend, entity, text, compileTables, DataEngine, EventBus } from "frogcp";
import { postgresAdapter } from "../../../src/adapter/postgres/index";
import { startEphemeralPostgres } from "../../../src/adapter/postgres/testing/ephemeral-postgres";

// A narrower check for the { pool } config shape, which the shared conformance
// suite doesn't exercise (it only passes { connectionString }). postgresAdapter
// reads pool.options to open its own dedicated Client rather than querying the
// supplied Pool, and this proves that connects and runs a real migrate + CRUD
// round-trip. Uses the same ephemeral server, skipped the same way when none is
// found.
const ephemeral = await startEphemeralPostgres();

afterAll(async () => {
  await ephemeral?.stop();
});

describe.skipIf(ephemeral === null)("postgresAdapter({ pool }), live ephemeral server", () => {
  it("opens its own connection from the pool's config and supports migrate + CRUD", async () => {
    const connectionString = await ephemeral!.createDatabase();
    const pool = new Pool({ connectionString });
    try {
      const adapter = postgresAdapter({ pool });
      const config = defineBackend({ entities: { notes: entity({ title: text().required() }) } });
      await migrateToConfig(adapter, config);

      const tables = compileTables(config, "postgres");
      const engine = new DataEngine(adapter, config, tables, new EventBus());
      const admin = { userId: "admin", role: "admin" as const };

      const created = await engine.create("notes", { title: "hello from pool config" }, admin);
      expect(created.title).toBe("hello from pool config");

      const read = await engine.read("notes", created.id as string, admin);
      expect(read.title).toBe("hello from pool config");
    } finally {
      // Only the caller's Pool is closed here. postgresAdapter's own Client
      // (opened from pool.options) is a separate connection this test leaves
      // open, like every other adapter the conformance suite creates.
      await pool.end();
    }
  });
});
