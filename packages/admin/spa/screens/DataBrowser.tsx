import { FrogClientError, type ListQueryInput } from "frogcp/client";
import type { FieldSchemaSummary } from "frogcp";
import { ChevronDown, ChevronUp, Plus } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/CopyField";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { roleForValue, StatusPill } from "@/components/ui/StatusPill";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { client } from "../api";
import { coerceFilterValue, filterableFields, formatCellValue, visibleColumns } from "../lib/schema";
import { EntityForm } from "./EntityForm";

export interface DataBrowserProps {
  entityName: string;
  /** The entity's full field map from `GET /api/system/schema`, hidden fields
   * included (flagged `hidden: true`). This component is entirely
   * schema-driven from this one prop. */
  fields: Record<string, FieldSchemaSummary>;
}

const DEFAULT_LIMIT = 25;

type Row = Record<string, unknown>;
type FormState = { mode: "create" } | { mode: "edit"; row: Row } | null;
type SortState = { field: string; dir: "asc" | "desc" } | null;

/** Renders one table cell's value: `id` as a copyable `CopyField`, boolean and
 * select values as a themed `StatusPill` whose role is guessed by
 * `roleForValue`, everything else via `formatCellValue`. */
function Cell({ column, value, field }: { column: string; value: unknown; field: FieldSchemaSummary | undefined }) {
  if (column === "id") {
    return <CopyField value={String(value)} />;
  }
  if (field?.type === "boolean") {
    return <StatusPill role={value ? "success" : "neutral"} label={value ? "true" : "false"} />;
  }
  if (field?.type === "select" && value) {
    const label = String(value);
    return <StatusPill role={roleForValue(label)} label={label} />;
  }
  return <>{formatCellValue(value, field)}</>;
}

/**
 * A schema-driven record table with pagination, an `eq`-only filter bar,
 * click-a-header sorting, a create/edit dialog (`EntityForm`), and per-row
 * delete.
 *
 * Mount it with `key={entityName}` so switching entities resets offset,
 * filters, sort, and any open form through a full remount rather than a pile
 * of reset-on-prop-change effects.
 */
export function DataBrowser({ entityName, fields }: DataBrowserProps) {
  const columns = useMemo(() => visibleColumns(fields), [fields]);
  const filterFields = useMemo(() => filterableFields(fields), [fields]);

  const [rows, setRows] = useState<Row[]>([]);
  const [meta, setMeta] = useState({ total: 0, limit: DEFAULT_LIMIT, offset: 0 });
  const [offset, setOffset] = useState(0);
  const [filterDraft, setFilterDraft] = useState<Record<string, string>>({});
  const [appliedFilters, setAppliedFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<SortState>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formState, setFormState] = useState<FormState>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query: ListQueryInput = { limit: DEFAULT_LIMIT, offset };

      const filterEntries = Object.entries(appliedFilters).filter(([, raw]) => raw !== "");
      if (filterEntries.length > 0) {
        query.filter = Object.fromEntries(
          filterEntries.map(([name, raw]) => [name, coerceFilterValue(raw, fields[name]?.type)]),
        );
      }
      if (sort) query.sort = [sort.dir === "desc" ? `-${sort.field}` : sort.field];

      const result = await client.entity(entityName).list(query);
      setRows(result.data as Row[]);
      setMeta(result.meta);
    } catch (err) {
      setError(err instanceof FrogClientError ? err.message : "Failed to load records.");
    } finally {
      setLoading(false);
    }
  }, [entityName, offset, appliedFilters, sort, fields]);

  useEffect(() => {
    load();
  }, [load]);

  function handleApplyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAppliedFilters(filterDraft);
    setOffset(0);
  }

  function toggleSort(field: string) {
    setSort((prev) => {
      if (!prev || prev.field !== field) return { field, dir: "asc" };
      return prev.dir === "asc" ? { field, dir: "desc" } : null;
    });
    // Like applying a filter, changing sort order jumps back to page 1.
    // Otherwise a re-sort on page 3 would silently show page 3 of the new
    // ordering, which reads as "records went missing" to an admin.
    setOffset(0);
  }

  async function handleDelete(row: Row) {
    const id = String(row.id);
    if (!window.confirm(`Delete this ${entityName} record? This cannot be undone.`)) return;
    try {
      await client.entity(entityName).delete(id);
      await load();
    } catch (err) {
      setError(err instanceof FrogClientError ? err.message : "Failed to delete record.");
    }
  }

  const page = Math.floor(offset / meta.limit) + 1;
  const totalPages = Math.max(1, Math.ceil(meta.total / meta.limit));

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-foreground">{entityName}</h1>
        <Button type="button" onClick={() => setFormState({ mode: "create" })}>
          <Plus /> New
        </Button>
      </div>

      {filterFields.length > 0 && (
        <form
          className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-3"
          onSubmit={handleApplyFilters}
          aria-label="Filters"
        >
          {filterFields.map(([name, field]) => {
            // The "Filter " prefix keeps this label distinct from
            // `EntityForm`'s plain field label for the same column, so the two
            // controls never share an accessible name (assistive tech and
            // `getByLabelText` alike could otherwise not tell them apart).
            const id = `filter-${name}`;
            return (
              <div key={name} className="flex flex-col gap-1">
                <Label htmlFor={id} className="text-[11px] tracking-wide text-muted-foreground uppercase">
                  Filter {name}
                </Label>
                {field.type === "select" || field.type === "boolean" ? (
                  <Select
                    id={id}
                    className="min-w-[9rem]"
                    value={filterDraft[name] ?? ""}
                    onChange={(event) => setFilterDraft((prev) => ({ ...prev, [name]: event.target.value }))}
                  >
                    <option value="">All</option>
                    {(field.type === "boolean" ? ["true", "false"] : (field.options ?? [])).map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    id={id}
                    className="min-w-[9rem]"
                    type={field.type === "number" ? "number" : "text"}
                    value={filterDraft[name] ?? ""}
                    onChange={(event) => setFilterDraft((prev) => ({ ...prev, [name]: event.target.value }))}
                  />
                )}
              </div>
            );
          })}
          <Button type="submit" variant="outline" size="sm">
            Apply
          </Button>
        </form>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((col) => {
                const active = sort?.field === col;
                return (
                  <TableHead
                    key={col}
                    onClick={() => toggleSort(col)}
                    className="cursor-pointer select-none hover:text-foreground"
                  >
                    <span className="inline-flex items-center gap-1">
                      {col}
                      {active && (sort.dir === "asc" ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />)}
                    </span>
                  </TableHead>
                );
              })}
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={columns.length + 1} className="text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length + 1} className="text-muted-foreground">
                  No records.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={String(row.id)} className="cursor-pointer" onClick={() => setFormState({ mode: "edit", row })}>
                  {columns.map((col) => (
                    <TableCell key={col}>
                      <Cell column={col} value={row[col]} field={fields[col]} />
                    </TableCell>
                  ))}
                  <TableCell>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleDelete(row);
                      }}
                    >
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <Button type="button" variant="outline" size="sm" disabled={offset <= 0} onClick={() => setOffset((o) => Math.max(0, o - meta.limit))}>
          Prev
        </Button>
        <span>
          Page {page} of {totalPages}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={offset + meta.limit >= meta.total}
          onClick={() => setOffset((o) => o + meta.limit)}
        >
          Next
        </Button>
      </div>

      {formState?.mode === "create" && (
        <EntityForm
          entityName={entityName}
          mode="create"
          fields={fields}
          onCancel={() => setFormState(null)}
          onSuccess={() => {
            setFormState(null);
            load();
          }}
        />
      )}
      {formState?.mode === "edit" && (
        <EntityForm
          entityName={entityName}
          mode="edit"
          fields={fields}
          initial={formState.row}
          onCancel={() => setFormState(null)}
          onSuccess={() => {
            setFormState(null);
            load();
          }}
        />
      )}
    </div>
  );
}
