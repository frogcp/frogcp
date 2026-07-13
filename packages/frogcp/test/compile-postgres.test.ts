import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { compileTables, defineBackend, entity, text, number, boolean, date, timestamp, json, select, media, ref } from "../src/index";

// Pure unit tests for the Postgres compiler (compilePostgresTables, wired
// through the public compileTables(config, "postgres") dispatcher). No live
// Postgres server is involved: compileTables only builds drizzle pg-core table
// objects in memory. Mirrors compile.test.ts's sqlite coverage so both
// dialects are checked against the same scenarios.
describe("compileTables(config, \"postgres\")", () => {
  const config = defineBackend({
    entities: {
      users: entity({ email: text().required().unique() }),
      notes: entity({
        title: text().required(),
        body: text(),
        views: number().default(0),
        archived: boolean().default(false),
        publishedAt: date(),
        editedAt: timestamp(),
        meta: json(),
        status: select(["draft", "published"]),
        cover: media(),
        owner: ref("users").onDelete("cascade"),
      }),
    },
  });
  const tables = compileTables(config, "postgres");

  it("creates a table per entity with a text id pk", () => {
    const cols = getTableColumns(tables.users!);
    expect(Object.keys(cols).sort()).toEqual(["email", "id"]);
    expect(cols.id!.primary).toBe(true);
    expect(cols.id!.columnType).toBe("PgText");
  });

  it("maps every field type to its Postgres column type", () => {
    const cols = getTableColumns(tables.notes!);
    expect(cols.title!.columnType).toBe("PgText");
    expect(cols.body!.columnType).toBe("PgText");
    expect(cols.views!.columnType).toBe("PgDoublePrecision");
    expect(cols.archived!.columnType).toBe("PgBoolean");
    expect(cols.publishedAt!.columnType).toBe("PgTimestamp");
    expect(cols.editedAt!.columnType).toBe("PgTimestamp");
    expect(cols.meta!.columnType).toBe("PgJsonb");
    expect(cols.status!.columnType).toBe("PgText"); // select -> text
    expect(cols.cover!.columnType).toBe("PgText"); // media -> text
    expect(cols.owner!.columnType).toBe("PgText"); // ref -> text
  });

  it("maps required to notNull and defaults", () => {
    const cols = getTableColumns(tables.notes!);
    expect(cols.title!.notNull).toBe(true);
    expect(cols.body!.notNull).toBe(false);
    expect(cols.views!.default).toBe(0);
    expect(cols.archived!.default).toBe(false);
  });

  it("maps .unique() to a drizzle unique column constraint", () => {
    const cols = getTableColumns(tables.users!);
    expect(cols.email!.isUnique).toBe(true);
    expect(cols.id!.isUnique).toBe(false);
  });

  it("wires ref foreign keys (lazily-resolved, dialect-appropriate target)", () => {
    const cols = getTableColumns(tables.notes!);
    expect(cols.owner).toBeDefined();
    expect(cols.owner!.columnType).toBe("PgText");
  });

  it("throws eagerly on refs to unknown entities", () => {
    const bad = defineBackend({
      entities: {
        notes: entity({ owner: ref("nonexistent") }),
      },
    });
    expect(() => compileTables(bad, "postgres")).toThrow('Unknown ref target "nonexistent" in entity "notes"');
  });

  it("compiles forward references (referencing entity declared before its target)", () => {
    const fwd = defineBackend({
      entities: {
        notes: entity({ title: text().required(), owner: ref("users") }),
        users: entity({ email: text().required() }),
      },
    });
    const fwdTables = compileTables(fwd, "postgres");
    const cols = getTableColumns(fwdTables.notes!);
    expect(cols.owner).toBeDefined();
  });

  it("defaults to the sqlite dialect when no dialect argument is given (regression guard)", () => {
    const sqliteTables = compileTables(config);
    const cols = getTableColumns(sqliteTables.notes!);
    // sqlite's number mapping is "real", not postgres's "doublePrecision",
    // proving the default path is untouched by adding the postgres compiler.
    expect(cols.views!.columnType).toBe("SQLiteReal");
  });
});
