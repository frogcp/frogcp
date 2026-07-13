import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import { generateCommand, loadBackendConfig } from "../../src/cli/commands/generate";
import { CliError } from "../../src/cli/errors";

const FIXTURE_CONFIG = `import { defineBackend, entity, text, boolean, timestamp } from "frogcp";

export default defineBackend({
  entities: {
    notes: entity({
      title: text().required(),
      done: boolean().default(false),
      createdAt: timestamp().auto(),
    }),
  },
});
`;

function writeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "frogcp-cli-generate-"));
  const configPath = join(dir, "frogcp.config.ts");
  writeFileSync(configPath, FIXTURE_CONFIG, "utf8");
  return configPath;
}

describe("loadBackendConfig", () => {
  it("loads a BackendConfig default-exported from a .ts file via jiti", async () => {
    const configPath = writeFixture();
    const config = await loadBackendConfig(configPath);
    expect(Object.keys(config.entities)).toEqual(["notes"]);
  });

  it("rejects a config whose default export isn't a BackendConfig", async () => {
    const dir = mkdtempSync(join(tmpdir(), "frogcp-cli-generate-bad-"));
    const configPath = join(dir, "frogcp.config.ts");
    writeFileSync(configPath, "export default 42;\n", "utf8");
    await expect(loadBackendConfig(configPath)).rejects.toThrow(CliError);
  });

  it("rejects a config whose entities is null with a clear error, not a raw crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "frogcp-cli-generate-null-"));
    const configPath = join(dir, "frogcp.config.ts");
    writeFileSync(configPath, "export default { entities: null };\n", "utf8");
    await expect(loadBackendConfig(configPath)).rejects.toThrow(/config\.entities must be an object/);
  });
});

describe("generateCommand", () => {
  it("writes frogcp.gen.d.ts next to the config with Row/Insert/Patch/ClientBackend shapes", async () => {
    const configPath = writeFixture();
    const dir = join(configPath, "..");

    const result = await generateCommand({ config: configPath });

    const typesPath = join(dir, "frogcp.gen.d.ts");
    expect(result.typesPath).toBe(typesPath);
    expect(existsSync(typesPath)).toBe(true);

    const written = readFileSync(typesPath, "utf8");
    expect(written).toBe(result.typesContent);
    expect(written).toContain("export interface Notes");
    expect(written).toContain("export interface InsertNotes");
    expect(written).toContain("export interface PatchNotes");
    expect(written).toContain("export type ClientBackend");
  });

  it("dry run (no --apply) returns/prints CREATE TABLE statements without touching a database", async () => {
    const configPath = writeFixture();
    const result = await generateCommand({ config: configPath });

    expect(result.applied).toBe(false);
    expect(result.migrationSql.length).toBeGreaterThan(0);
    const joined = result.migrationSql.join("\n");
    expect(joined).toMatch(/CREATE TABLE/i);
    expect(joined).toMatch(/notes/i);
  });

  it("--apply with --db applies the migration to a real sqlite database", async () => {
    const configPath = writeFixture();
    const dbDir = mkdtempSync(join(tmpdir(), "frogcp-cli-db-"));
    const dbPath = join(dbDir, "test.sqlite");

    const result = await generateCommand({ config: configPath, apply: true, db: dbPath });
    expect(result.applied).toBe(true);
    expect(result.dbPath).toBe(dbPath);

    const db = new DatabaseSync(dbPath);
    try {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notes'")
        .all();
      expect(rows.length).toBe(1);
    } finally {
      db.close();
    }
  });

  it("--apply without --db throws a clear CliError", async () => {
    const configPath = writeFixture();
    await expect(generateCommand({ config: configPath, apply: true })).rejects.toThrow(
      /--apply requires --db/,
    );
  });
});
