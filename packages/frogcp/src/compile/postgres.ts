import {
  pgTable,
  text,
  doublePrecision,
  boolean,
  timestamp,
  jsonb,
  type PgTable,
  type PgColumn,
} from "drizzle-orm/pg-core";
import type { BackendConfig, FieldDef } from "../schema/types";
import { validateRefTargets } from "./shared";

// Erases drizzle's column builder generics, which do not compose across a
// dynamic switch. Internal only; never appears in an exported signature.
// Mirrors the identical erasure in `compile/sqlite.ts`; the two compilers are
// structurally parallel.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyColumnBuilder = any;

/**
 * Compiles a frogCP BackendConfig into one Drizzle pg-core table per entity,
 * the Postgres counterpart to `compile/sqlite.ts`'s `compileSqliteTables`.
 * Column mapping: id to text primary key (portable id, not a Postgres
 * serial/uuid default, so ids stay dialect-agnostic at the application layer);
 * text/select/media to text; number to doublePrecision; boolean to boolean;
 * date/timestamp to timestamp (JS `Date` mode); json to jsonb; ref to text plus
 * a lazy `references()` callback, using the same forward-declaration technique
 * and eager `validateRefTargets` check as the sqlite compiler.
 *
 * This function only builds drizzle pg-core table objects; it never opens a
 * connection, so it (and its tests) require no live Postgres server.
 */
export function compilePostgresTables(config: BackendConfig): Record<string, PgTable> {
  validateRefTargets(config);

  const tables: Record<string, PgTable> = {};

  for (const [entityName, entityDef] of Object.entries(config.entities)) {
    const columns: Record<string, AnyColumnBuilder> = {
      id: text("id").primaryKey(),
    };

    for (const [fieldName, fieldDef] of Object.entries(entityDef.fields)) {
      columns[fieldName] = buildColumn(fieldName, fieldDef, tables);
    }

    tables[entityName] = pgTable(entityName, columns);
  }

  return tables;
}

function buildColumn(name: string, field: FieldDef, tables: Record<string, PgTable>): AnyColumnBuilder {
  let col: AnyColumnBuilder;

  switch (field.type) {
    case "text":
    case "select":
    case "media":
      col = text(name);
      break;
    case "number":
      col = doublePrecision(name);
      break;
    case "boolean":
      col = boolean(name);
      break;
    case "date":
    case "timestamp":
      col = timestamp(name, { mode: "date" });
      break;
    case "json":
      col = jsonb(name);
      break;
    case "ref": {
      const target = field.target as string;
      col = text(name).references(
        () => {
          const targetTable = tables[target];
          if (!targetTable) {
            // Unreachable: compilePostgresTables validates all ref targets
            // eagerly before this lazy callback can run.
            throw new Error(`Unknown ref target "${target}"`);
          }
          return (targetTable as PgTable & { id: PgColumn }).id;
        },
        field.onDelete !== undefined ? { onDelete: field.onDelete } : {},
      );
      break;
    }
    default: {
      const exhaustive: never = field.type;
      throw new Error(`Unknown field type: ${exhaustive}`);
    }
  }

  if (field.required) col = col.notNull();
  // Auto timestamps are populated by the data engine at insert time, not via a
  // SQL-level default, which keeps the schema portable across dialects.
  if (field.default !== undefined && !field.auto) col = col.default(field.default);
  if (field.unique) col = col.unique();

  return col;
}
