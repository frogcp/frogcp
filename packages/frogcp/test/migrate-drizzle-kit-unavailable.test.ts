import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * On a deployed Worker the lazy `import(DRIZZLE_KIT_API_SPECIFIER)` fails with
 * `No such module "drizzle-kit/api".`, which surfaced from `createBackend` as a
 * 500 on every request and told the user nothing. A failure to LOAD the module
 * is rethrown with instructions; anything drizzle-kit itself throws after it
 * loaded must pass through untouched.
 *
 * Each test remocks and re-imports the migrate module, so `vi.resetModules()`
 * runs between them to clear the cached specifier binding.
 */

const NO_SUCH_MODULE = 'No such module "drizzle-kit/api".';

/**
 * Joins the messages down an error's `cause` chain. vitest wraps a throwing
 * mock factory in an error of its own, so the runtime's real load failure sits
 * one level below the cause we attach.
 */
function describeCause(error: Error): string {
  const messages: string[] = [];
  let current: unknown = error.cause;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("drizzle-kit/api");
});

describe("drizzle-kit is unavailable at runtime", () => {
  it("sqlite: rethrows an actionable error and keeps the load failure as `cause`", async () => {
    vi.doMock("drizzle-kit/api", () => {
      throw new Error(NO_SUCH_MODULE);
    });

    const { generateSqliteMigration } = await import("../src/migrate/sqlite");
    const error = (await generateSqliteMigration({}).catch((thrown: unknown) => thrown)) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("drizzle-kit");
    expect(error.message).toContain("migrate: false");
    expect(error.message).toContain("Cloudflare Workers");
    expect(error.message).toContain("wrangler d1 execute");
    // The rejection that the import() produced, not a message we rewrote.
    expect(describeCause(error)).toContain(NO_SUCH_MODULE);
  });

  it("postgres: rethrows an actionable error and keeps the load failure as `cause`", async () => {
    vi.doMock("drizzle-kit/api", () => {
      throw new Error(NO_SUCH_MODULE);
    });

    const { generatePostgresMigration } = await import("../src/migrate/postgres");
    const error = (await generatePostgresMigration({}).catch((thrown: unknown) => thrown)) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("drizzle-kit");
    expect(error.message).toContain("migrate: false");
    expect(error.message).toContain("Cloudflare Workers");
    expect(error.message).toContain("wrangler d1 execute");
    expect(describeCause(error)).toContain(NO_SUCH_MODULE);
  });
});

describe("drizzle-kit loaded but threw", () => {
  it("sqlite: propagates a post-load drizzle-kit error unchanged", async () => {
    const inner = new Error("snapshot ids are out of order");
    vi.doMock("drizzle-kit/api", () => ({
      generateSQLiteDrizzleJson: () => {
        throw inner;
      },
      generateSQLiteMigration: () => [],
    }));

    const { generateSqliteMigration } = await import("../src/migrate/sqlite");
    const error = await generateSqliteMigration({}).catch((thrown: unknown) => thrown);

    expect(error).toBe(inner);
  });

  it("postgres: propagates a post-load drizzle-kit error unchanged", async () => {
    const inner = new Error("snapshot ids are out of order");
    vi.doMock("drizzle-kit/api", () => ({
      generateDrizzleJson: () => {
        throw inner;
      },
      generateMigration: () => [],
    }));

    const { generatePostgresMigration } = await import("../src/migrate/postgres");
    const error = await generatePostgresMigration({}).catch((thrown: unknown) => thrown);

    expect(error).toBe(inner);
  });
});

describe("drizzle-kit available", () => {
  it("sqlite: the real module still generates a migration", async () => {
    const { generateSqliteMigration } = await import("../src/migrate/sqlite");
    const { sqliteTable, text } = await import("drizzle-orm/sqlite-core");

    const { statements, snapshot } = await generateSqliteMigration({
      notes: sqliteTable("notes", { id: text("id").primaryKey() }),
    });

    expect(statements.join("\n")).toContain("CREATE TABLE");
    expect(snapshot).toBeTypeOf("object");
  });

  it("postgres: the real module still generates a migration", async () => {
    const { generatePostgresMigration } = await import("../src/migrate/postgres");
    const { pgTable, text } = await import("drizzle-orm/pg-core");

    const { statements, snapshot } = await generatePostgresMigration({
      notes: pgTable("notes", { id: text("id").primaryKey() }),
    });

    expect(statements.join("\n")).toContain("CREATE TABLE");
    expect(snapshot).toBeTypeOf("object");
  });
});
