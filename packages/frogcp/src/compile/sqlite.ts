import { sqliteTable, text, integer, real, type SQLiteTable, type SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { BackendConfig, FieldDef } from "../schema/types";
import { validateRefTargets } from "./shared";

// Erases drizzle's column builder generics, which do not compose across a
// dynamic switch. Internal only; never appears in an exported signature.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyColumnBuilder = any;

/**
 * Compiles a frogCP BackendConfig into one Drizzle sqlite-core table per entity.
 *
 * Ref columns use drizzle's lazy `references(() => target.id, ...)` callback so
 * tables can be declared in a single pass regardless of order; the callback
 * resolves the target from `tables` only when queried. Ref targets are still
 * validated eagerly via `validateRefTargets` before returning, since the lazy
 * callback would otherwise defer the error to query time.
 */
export function compileSqliteTables(config: BackendConfig): Record<string, SQLiteTable> {
  validateRefTargets(config);

  const tables: Record<string, SQLiteTable> = {};

  for (const [entityName, entityDef] of Object.entries(config.entities)) {
    const columns: Record<string, AnyColumnBuilder> = {
      id: text("id").primaryKey(),
    };

    for (const [fieldName, fieldDef] of Object.entries(entityDef.fields)) {
      columns[fieldName] = buildColumn(fieldName, fieldDef, tables);
    }

    tables[entityName] = sqliteTable(entityName, columns);
  }

  return tables;
}

function buildColumn(name: string, field: FieldDef, tables: Record<string, SQLiteTable>): AnyColumnBuilder {
  let col: AnyColumnBuilder;

  switch (field.type) {
    case "text":
    case "select":
    case "media":
      col = text(name);
      break;
    case "number":
      col = real(name);
      break;
    case "boolean":
      col = integer(name, { mode: "boolean" });
      break;
    case "date":
    case "timestamp":
      col = integer(name, { mode: "timestamp" });
      break;
    case "json":
      col = text(name, { mode: "json" });
      break;
    case "ref": {
      const target = field.target as string;
      col = text(name).references(
        () => {
          const targetTable = tables[target];
          if (!targetTable) {
            // Unreachable: compileSqliteTables validates all ref targets
            // eagerly before this lazy callback can run.
            throw new Error(`Unknown ref target "${target}"`);
          }
          return (targetTable as SQLiteTable & { id: SQLiteColumn }).id;
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
