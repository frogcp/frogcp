import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { compileTables, defineBackend, entity, text, ref, boolean } from "../src/index";

describe("compileTables", () => {
  const config = defineBackend({
    entities: {
      users: entity({ email: text().required() }),
      notes: entity({ title: text().required(), done: boolean().default(false), owner: ref("users") }),
    },
  });
  const tables = compileTables(config);

  it("creates a table per entity with an id pk", () => {
    const cols = getTableColumns(tables.notes!);
    expect(Object.keys(cols).sort()).toEqual(["done", "id", "owner", "title"]);
    expect(cols.id!.primary).toBe(true);
  });

  it("maps required to notNull and defaults", () => {
    const cols = getTableColumns(tables.notes!);
    expect(cols.title!.notNull).toBe(true);
    expect(cols.done!.default).toBe(false);
  });

  it("wires ref foreign keys", () => {
    const cols = getTableColumns(tables.notes!);
    expect(cols.owner!.columnType).toBe("SQLiteText");
  });

  it("throws eagerly on refs to unknown entities", () => {
    const bad = defineBackend({
      entities: {
        notes: entity({ owner: ref("nonexistent") }),
      },
    });
    expect(() => compileTables(bad)).toThrow('Unknown ref target "nonexistent" in entity "notes"');
  });

  it("maps .unique() to a drizzle unique column constraint", () => {
    const withUnique = defineBackend({
      entities: { accounts: entity({ email: text().required().unique() }) },
    });
    const cols = getTableColumns(compileTables(withUnique).accounts!);
    expect(cols.email!.isUnique).toBe(true);
    // A field without .unique() stays non-unique.
    expect(cols.id!.isUnique).toBe(false);
  });

  it("compiles forward references (referencing entity declared before its target)", () => {
    const fwd = defineBackend({
      entities: {
        notes: entity({ title: text().required(), owner: ref("users") }),
        users: entity({ email: text().required() }),
      },
    });
    const fwdTables = compileTables(fwd);
    const cols = getTableColumns(fwdTables.notes!);
    expect(cols.owner).toBeDefined();
  });
});
