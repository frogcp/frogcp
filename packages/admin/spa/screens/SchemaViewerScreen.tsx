import { FrogClientError } from "frogcp/client";
import type { EntitySchemaSummary, FieldSchemaSummary, FieldType } from "frogcp";
import { useState } from "react";
import { client } from "../api";
import { buildSchemaUpdateConfig, FIELD_TYPES } from "../lib/schema";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  Input,
  Label,
  Select,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";

export interface SchemaViewerScreenProps {
  /** The same full schema-summary map `PermissionMatrixScreen` reads. This
   * screen reads `.fields` off of it instead of `.permissions`. */
  entities: Record<string, EntitySchemaSummary>;
  /** From `GET /api/system/schema`'s `mode` field. Editing affordances render
   * only in `"managed"`; `"code"` stays a read-only view. */
  mode: "code" | "managed";
  /** Called with the fresh entity map after a successful save, so the shell
   * (sidebar nav, other screens) picks up the change without a full reload. */
  onSchemaUpdated: (entities: Record<string, EntitySchemaSummary>) => void;
}

/** Flags as badges, ordered the way a developer scans them: is it mandatory,
 * constrained, visible, writable, system-managed. */
function fieldFlags(field: FieldSchemaSummary): string[] {
  const flags: string[] = [];
  if (field.required) flags.push("required");
  if (field.unique) flags.push("unique");
  if (field.hidden) flags.push("hidden");
  if (field.readonly) flags.push("readonly");
  if (field.auto) flags.push("auto");
  return flags;
}

/** Local "add field" form state for one entity card. */
interface FieldDraft {
  name: string;
  type: FieldType;
  required: boolean;
  unique: boolean;
  hidden: boolean;
  readonly: boolean;
  options: string;
  target: string;
}

function blankFieldDraft(): FieldDraft {
  return { name: "", type: "text", required: false, unique: false, hidden: false, readonly: false, options: "", target: "" };
}

/** The boolean flag toggles shown in the "add field" form, kept in one place
 * so the label text and draft key stay in lockstep. */
const FLAG_TOGGLES: Array<{ key: "required" | "unique" | "hidden" | "readonly"; label: string }> = [
  { key: "required", label: "required" },
  { key: "unique", label: "unique" },
  { key: "hidden", label: "hidden" },
  { key: "readonly", label: "readonly" },
];

/**
 * The developer's-eye view of the schema: every field per entity with its
 * type, flags, and type-specific detail. Hidden fields are shown here even
 * though `DataBrowser` hides them, because an admin configuring the backend
 * needs to see them.
 *
 * Code mode is read-only: the schema lives in source, not the database, so
 * there is nothing to submit an edit to. Managed mode adds entity and field
 * editing, saving through `buildSchemaUpdateConfig` so every entity's existing
 * permissions survive the round-trip.
 */
export function SchemaViewerScreen({ entities, mode, onSchemaUpdated }: SchemaViewerScreenProps) {
  const [draft, setDraft] = useState<Record<string, EntitySchemaSummary>>(entities);
  const [newEntityName, setNewEntityName] = useState("");
  const [entityError, setEntityError] = useState<string | null>(null);
  const [fieldDrafts, setFieldDrafts] = useState<Record<string, FieldDraft>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const names = Object.keys(draft).sort();
  const managed = mode === "managed";

  function getFieldDraft(entityName: string): FieldDraft {
    return fieldDrafts[entityName] ?? blankFieldDraft();
  }

  function setFieldDraft(entityName: string, patch: Partial<FieldDraft>) {
    setFieldDrafts((prev) => ({ ...prev, [entityName]: { ...getFieldDraft(entityName), ...patch } }));
  }

  function handleAddEntity() {
    const name = newEntityName.trim();
    if (name.length === 0) {
      setEntityError("Entity name is required.");
      return;
    }
    if (name in draft) {
      setEntityError(`Entity "${name}" already exists.`);
      return;
    }
    setDraft((prev) => ({ ...prev, [name]: { fields: {}, permissions: {}, permissionRules: {}, pluginOwned: false } }));
    setNewEntityName("");
    setEntityError(null);
  }

  function handleAddField(entityName: string) {
    const fieldDraft = getFieldDraft(entityName);
    const name = fieldDraft.name.trim();
    const entity = draft[entityName];
    if (!entity) return;

    if (name.length === 0) {
      setFieldErrors((prev) => ({ ...prev, [entityName]: "Field name is required." }));
      return;
    }
    if (name in entity.fields) {
      setFieldErrors((prev) => ({ ...prev, [entityName]: `Field "${name}" already exists.` }));
      return;
    }

    const field: FieldSchemaSummary = { type: fieldDraft.type, required: fieldDraft.required };
    if (fieldDraft.unique) field.unique = true;
    if (fieldDraft.hidden) field.hidden = true;
    if (fieldDraft.readonly) field.readonly = true;

    if (fieldDraft.type === "select") {
      const options = fieldDraft.options
        .split(",")
        .map((o) => o.trim())
        .filter((o) => o.length > 0);
      if (options.length === 0) {
        setFieldErrors((prev) => ({ ...prev, [entityName]: "A select field needs at least one option." }));
        return;
      }
      field.options = options;
    }

    if (fieldDraft.type === "ref") {
      const target = fieldDraft.target.trim();
      if (target.length === 0) {
        setFieldErrors((prev) => ({ ...prev, [entityName]: "A ref field needs a target entity." }));
        return;
      }
      field.target = target;
    }

    setDraft((prev) => ({
      ...prev,
      [entityName]: { ...prev[entityName]!, fields: { ...prev[entityName]!.fields, [name]: field } },
    }));
    setFieldDrafts((prev) => ({ ...prev, [entityName]: blankFieldDraft() }));
    setFieldErrors((prev) => ({ ...prev, [entityName]: "" }));
  }

  function handleRemoveField(entityName: string, fieldName: string) {
    setDraft((prev) => {
      const entity = prev[entityName];
      if (!entity) return prev;
      const fields = { ...entity.fields };
      delete fields[fieldName];
      return { ...prev, [entityName]: { ...entity, fields } };
    });
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      const config = buildSchemaUpdateConfig(draft);
      const res = await client.schema.update(config);
      const nextEntities = res.data.entities as Record<string, EntitySchemaSummary>;
      setDraft(nextEntities);
      onSchemaUpdated(nextEntities);
    } catch (err) {
      setSaveError(err instanceof FrogClientError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-foreground">Schema</h1>
        {managed && (
          <Button type="button" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save schema"}
          </Button>
        )}
      </div>

      {!managed && <p className="text-sm text-muted-foreground">Editing requires managed mode.</p>}

      {saveError && (
        <p role="alert" className="text-sm text-destructive">
          {saveError}
        </p>
      )}

      {managed && (
        <Card className="gap-0 py-4">
          <CardHeader className="px-4">
            <h2 className="text-sm font-semibold text-foreground">Add entity</h2>
          </CardHeader>
          <CardContent className="px-4 pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="text"
                placeholder="entity name"
                aria-label="New entity name"
                className="w-56"
                value={newEntityName}
                onChange={(event) => setNewEntityName(event.target.value)}
              />
              <Button type="button" variant="outline" onClick={handleAddEntity}>
                Add entity
              </Button>
            </div>
            {entityError && (
              <p role="alert" className="mt-2 text-xs text-destructive">
                {entityError}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {names.length === 0 ? (
        <p className="text-sm text-muted-foreground">No entities.</p>
      ) : (
        names.map((name) => {
          const entity = draft[name];
          if (!entity) return null;
          const fieldNames = Object.keys(entity.fields);
          const fieldDraft = getFieldDraft(name);
          // Plugin-owned entities are code-defined, so the field editor never
          // renders its controls for one in either mode.
          const editable = managed && !entity.pluginOwned;
          return (
            <Card key={name} className="gap-0 py-4">
              <CardHeader className="px-4">
                <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
                  <span className="font-mono">{name}</span>
                  {entity.pluginOwned && (
                    <Badge variant="outline" title="Code-defined by a plugin, not editable here">
                      plugin
                    </Badge>
                  )}
                </h2>
              </CardHeader>
              <CardContent className="px-4 pt-3">
                <div className="overflow-hidden rounded-lg border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>field</TableHead>
                        <TableHead>type</TableHead>
                        <TableHead>flags</TableHead>
                        <TableHead>details</TableHead>
                        {editable && <TableHead />}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {fieldNames.map((fieldName) => {
                        const field = entity.fields[fieldName];
                        if (!field) return null;
                        const flags = fieldFlags(field);
                        return (
                          <TableRow key={fieldName}>
                            <TableCell className="font-mono text-foreground">{fieldName}</TableCell>
                            <TableCell className="font-mono text-muted-foreground">{field.type}</TableCell>
                            <TableCell>
                              {flags.length === 0 ? (
                                <span className="text-muted-foreground">-</span>
                              ) : (
                                <span className="flex flex-wrap gap-1">
                                  {flags.map((flag) => (
                                    <Badge key={flag} variant="secondary">
                                      {flag}
                                    </Badge>
                                  ))}
                                </span>
                              )}
                            </TableCell>
                            <TableCell className="font-mono text-xs text-muted-foreground">
                              {field.type === "ref" && field.target ? <span>target: {field.target}</span> : null}
                              {field.type === "select" && field.options ? (
                                <span>options: {field.options.join(", ")}</span>
                              ) : null}
                            </TableCell>
                            {editable && (
                              <TableCell className="text-right">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                  onClick={() => handleRemoveField(name, fieldName)}
                                  aria-label={`Remove field ${fieldName}`}
                                >
                                  Remove
                                </Button>
                              </TableCell>
                            )}
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>

                {editable && (
                  <div className="mt-4 flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-3">
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="flex flex-col gap-1">
                        <Label htmlFor={`new-field-name-${name}`} className="text-[11px] tracking-wide text-muted-foreground uppercase">
                          Field
                        </Label>
                        <Input
                          id={`new-field-name-${name}`}
                          type="text"
                          placeholder="field name"
                          aria-label={`New field name for ${name}`}
                          className="min-w-[10rem]"
                          value={fieldDraft.name}
                          onChange={(event) => setFieldDraft(name, { name: event.target.value })}
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <Label htmlFor={`new-field-type-${name}`} className="text-[11px] tracking-wide text-muted-foreground uppercase">
                          Type
                        </Label>
                        <Select
                          id={`new-field-type-${name}`}
                          aria-label={`New field type for ${name}`}
                          className="min-w-[8rem]"
                          value={fieldDraft.type}
                          onChange={(event) => setFieldDraft(name, { type: event.target.value as FieldType })}
                        >
                          {FIELD_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </Select>
                      </div>
                      {FLAG_TOGGLES.map(({ key, label }) => (
                        <div key={key} className="flex items-center gap-2 pb-1.5">
                          <Switch
                            id={`new-field-${key}-${name}`}
                            checked={fieldDraft[key]}
                            onCheckedChange={(checked) => setFieldDraft(name, { [key]: checked } as Partial<FieldDraft>)}
                          />
                          <Label htmlFor={`new-field-${key}-${name}`} className="text-xs font-normal text-muted-foreground">
                            {label}
                          </Label>
                        </div>
                      ))}
                      {fieldDraft.type === "select" && (
                        <div className="flex flex-col gap-1">
                          <Label
                            htmlFor={`new-field-options-${name}`}
                            className="text-[11px] tracking-wide text-muted-foreground uppercase"
                          >
                            Options
                          </Label>
                          <Input
                            id={`new-field-options-${name}`}
                            type="text"
                            placeholder="options (comma-separated)"
                            aria-label={`Options for new field on ${name}`}
                            className="min-w-[12rem]"
                            value={fieldDraft.options}
                            onChange={(event) => setFieldDraft(name, { options: event.target.value })}
                          />
                        </div>
                      )}
                      {fieldDraft.type === "ref" && (
                        <div className="flex flex-col gap-1">
                          <Label htmlFor={`new-field-target-${name}`} className="text-[11px] tracking-wide text-muted-foreground uppercase">
                            Target
                          </Label>
                          <Select
                            id={`new-field-target-${name}`}
                            aria-label={`Target entity for new field on ${name}`}
                            className="min-w-[10rem]"
                            value={fieldDraft.target}
                            onChange={(event) => setFieldDraft(name, { target: event.target.value })}
                          >
                            <option value="">-- target entity --</option>
                            {names.map((targetName) => (
                              <option key={targetName} value={targetName}>
                                {targetName}
                              </option>
                            ))}
                          </Select>
                        </div>
                      )}
                      <Button type="button" variant="outline" onClick={() => handleAddField(name)}>
                        Add field
                      </Button>
                    </div>
                    {fieldErrors[name] && (
                      <p role="alert" className="text-xs text-destructive">
                        {fieldErrors[name]}
                      </p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}
