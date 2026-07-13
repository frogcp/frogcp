import { describe, it, expect, vi } from "vitest";
import { nodeSqliteAdapter } from "../../../src/adapter/node/index";
import { defineBackend, entity, text, migrateToConfig } from "frogcp";
import { runAdapterConformance } from "frogcp/conformance";

// The shared cross-adapter behavioral contract (fresh migrate, incremental
// migrate, atomic rollback, full CRUD via DataEngine, unique -> 409, FK ->
// 422/cascade). Every DatabaseAdapter is checked against this same suite.
runAdapterConformance("node:sqlite", () => nodeSqliteAdapter(":memory:"));

describe("sqlite migrations", () => {
  it("warns once, listing the statements, when a migration drops a column", async () => {
    const adapter = nodeSqliteAdapter(":memory:");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const v1 = defineBackend({ entities: { notes: entity({ title: text().required() }) } });
      await migrateToConfig(adapter, v1);
      expect(warnSpy).not.toHaveBeenCalled();

      const v2 = defineBackend({
        entities: { notes: entity({ title: text().required(), body: text() }) },
      });
      await migrateToConfig(adapter, v2);
      expect(warnSpy).not.toHaveBeenCalled();

      // v3 removes body again, so a DROP COLUMN statement must trigger exactly one warning.
      const v3 = defineBackend({ entities: { notes: entity({ title: text().required() }) } });
      await migrateToConfig(adapter, v3);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      // migrateToConfig (no logger passed) warns through the default
      // consoleLogger(), which emits one JSON-string argument to console.warn.
      const [line] = warnSpy.mock.calls[0] as [string];
      const parsed = JSON.parse(line) as { message: string; statements: string[] };
      expect(parsed.message).toContain("destructive migration statements about to run");
      expect(parsed.statements.some((s) => /DROP COLUMN/i.test(s))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
