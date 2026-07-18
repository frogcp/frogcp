import { mkdtempSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { main } from "../../src/cli/index";

const CONFIG = `import { defineBackend, entity, text } from "frogcp";

export default defineBackend({
  entities: {
    notes: entity({ title: text().required() }),
  },
});
`;

let cwd: string;
let originalCwd: string;
let errors: string[];

beforeEach(() => {
  originalCwd = process.cwd();
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "frogcp-cli-main-")));
  process.chdir(cwd);
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
});

describe("cli arg parser: boolean vs value flags", () => {
  it("`generate --apply` with no --db errors (exit non-zero) instead of silently dry-running", async () => {
    writeFileSync(join(cwd, "frogcp.config.ts"), CONFIG, "utf8");
    const code = await main(["generate", "--apply"]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/--apply requires --db/);
  });

  it("`generate --apply data.sqlite` does NOT swallow the filename as --apply's value nor silently dry-run", async () => {
    // If the parser treated --apply as value-taking, apply would become the
    // string "data.sqlite" (falsy for `=== true`) and this would silently
    // dry-run and exit 0. Instead --apply is boolean and "data.sqlite" is an
    // unexpected positional, so a clear error, exit 1.
    writeFileSync(join(cwd, "frogcp.config.ts"), CONFIG, "utf8");
    const code = await main(["generate", "--apply", "data.sqlite"]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/no positional arguments/);
  });

  it("`generate --apply --db <path>` (correctly parsed) applies the migration and exits 0", async () => {
    writeFileSync(join(cwd, "frogcp.config.ts"), CONFIG, "utf8");
    const dbPath = join(cwd, "out.sqlite");
    const code = await main(["generate", "--apply", "--db", dbPath]);
    expect(code).toBe(0);
    expect(existsSync(dbPath)).toBe(true);
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

  it("a value flag with no following value errors clearly", async () => {
    const code = await main(["generate", "--db"]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/--db requires a value/);
  });

  it("an unknown flag is rejected", async () => {
    const code = await main(["generate", "--bogus"]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/Unknown flag: --bogus/);
  });

  it("`create <name> --template bogus` rejects the unknown template (no silent fallback)", async () => {
    const code = await main(["create", "app", "--template", "bogus"]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/Unknown template "bogus"/);
    expect(existsSync(join(cwd, "app"))).toBe(false);
  });

  it("`create <name> --template cloudflare` (valid) scaffolds and exits 0", async () => {
    const code = await main(["create", "app", "--template", "cloudflare"]);
    expect(code).toBe(0);
    expect(existsSync(join(cwd, "app", "wrangler.jsonc"))).toBe(true);
  });
});
