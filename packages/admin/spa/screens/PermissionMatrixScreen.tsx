import { FrogClientError } from "frogcp/client";
import type { ActionName, EntitySchemaSummary, FieldDef, RuleExpr } from "frogcp";
import { X } from "lucide-react";
import { useState } from "react";
import {
  Badge,
  Button,
  Input,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import { client } from "../api";
import {
  ACTIONS,
  describeRuleLeaf,
  fieldSummaryToFieldDef,
  leavesToRuleExpr,
  permissionSummary,
  ruleExprToLeaves,
  type RuleLeaf,
} from "../lib/schema";

export interface PermissionMatrixScreenProps {
  /** The full per-entity schema summary from `GET /api/system/schema`. This
   * screen reads only `.permissions`, but takes the whole map so the prop
   * stays a direct mirror of what the endpoint returns. */
  entities: Record<string, EntitySchemaSummary>;
  /** From `GET /api/system/schema`'s `mode` field. The matrix is editable
   * only in `"managed"`; `"code"` stays read-only. */
  mode: "code" | "managed";
  /** Called with the fresh entity map after a successful save. */
  onSchemaUpdated: (entities: Record<string, EntitySchemaSummary>) => void;
}

/** A cell's editable state: a list of OR'd `RuleLeaf`s (empty means "admin
 * only", i.e. no declared rule), or `"opaque"` for an existing rule the
 * builder can't faithfully represent, such as an `and`. Opaque cells render
 * read-only and pass through unchanged on save. */
type CellState = RuleLeaf[] | "opaque";

type EntityDraft = Partial<Record<ActionName, CellState>>;

interface BuiltDraft {
  draft: Record<string, EntityDraft>;
  /** The structured `RuleExpr` for every declared action, verbatim from
   * `permissionRules`. Kept so an `"opaque"` cell can be resubmitted
   * unchanged on save, and never regenerated from the lossy summary string. */
  originals: Record<string, Partial<Record<ActionName, RuleExpr>>>;
}

function buildDraft(entities: Record<string, EntitySchemaSummary>): BuiltDraft {
  const draft: Record<string, EntityDraft> = {};
  const originals: Record<string, Partial<Record<ActionName, RuleExpr>>> = {};
  for (const [name, entity] of Object.entries(entities)) {
    const entityDraft: EntityDraft = {};
    const entityOriginals: Partial<Record<ActionName, RuleExpr>> = {};
    const rules = entity.permissionRules ?? {};
    for (const action of ACTIONS) {
      const expr = rules[action];
      if (expr === undefined) {
        entityDraft[action] = [];
        continue;
      }
      // The structured expr is the source of truth: keep it verbatim for the
      // opaque round-trip, and let the builder edit it only for shapes it can
      // faithfully represent (a leaf, or a flat OR of leaves).
      entityOriginals[action] = expr;
      entityDraft[action] = ruleExprToLeaves(expr) ?? "opaque";
    }
    draft[name] = entityDraft;
    originals[name] = entityOriginals;
  }
  return { draft, originals };
}

const LEAF_KINDS: readonly RuleLeaf["kind"][] = ["public", "authenticated", "role", "owner"];

interface PendingCondition {
  kind: RuleLeaf["kind"];
  value: string;
}

function blankPending(): PendingCondition {
  return { kind: "public", value: "" };
}

function cellKey(entity: string, action: ActionName): string {
  return `${entity}::${action}`;
}

/**
 * The entity by action grid of permission rules. Code mode renders a
 * human-readable string per cell and stays read-only. Managed mode turns each
 * cell into a small builder over public / authenticated / role / owner leaves,
 * OR-combined, where removing every leaf means "admin only" again.
 *
 * Saving posts the full config with every entity's fields preserved, since the
 * update endpoint replaces rather than merges.
 */
export function PermissionMatrixScreen({ entities, mode, onSchemaUpdated }: PermissionMatrixScreenProps) {
  const [built, setBuilt] = useState<BuiltDraft>(() => buildDraft(entities));
  const [pending, setPending] = useState<Record<string, PendingCondition>>({});
  const [cellErrors, setCellErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const names = Object.keys(entities).sort();
  const managed = mode === "managed";

  function getPending(key: string): PendingCondition {
    return pending[key] ?? blankPending();
  }

  function setCell(entityName: string, action: ActionName, next: RuleLeaf[]) {
    setBuilt((prev) => ({
      ...prev,
      draft: { ...prev.draft, [entityName]: { ...prev.draft[entityName], [action]: next } },
    }));
  }

  function handleAddCondition(entityName: string, action: ActionName) {
    const key = cellKey(entityName, action);
    const draftCondition = getPending(key);
    const current = built.draft[entityName]?.[action];
    const currentLeaves = current === "opaque" || current === undefined ? [] : current;

    if ((draftCondition.kind === "role" || draftCondition.kind === "owner") && draftCondition.value.trim().length === 0) {
      setCellErrors((prev) => ({ ...prev, [key]: `${draftCondition.kind} needs a value.` }));
      return;
    }

    const leaf: RuleLeaf =
      draftCondition.kind === "role"
        ? { kind: "role", role: draftCondition.value.trim() }
        : draftCondition.kind === "owner"
          ? { kind: "owner", field: draftCondition.value.trim() }
          : { kind: draftCondition.kind };

    setCell(entityName, action, [...currentLeaves, leaf]);
    setPending((prev) => ({ ...prev, [key]: blankPending() }));
    setCellErrors((prev) => ({ ...prev, [key]: "" }));
  }

  function handleRemoveCondition(entityName: string, action: ActionName, index: number) {
    const current = built.draft[entityName]?.[action];
    if (current === "opaque" || current === undefined) return;
    setCell(
      entityName,
      action,
      current.filter((_, i) => i !== index),
    );
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      const configEntities: Record<string, { fields: Record<string, FieldDef>; permissions: Partial<Record<ActionName, RuleExpr>> }> = {};
      for (const [name, entity] of Object.entries(entities)) {
        // Plugin-owned entities (e.g. `frogcp/auth`'s "users") are
        // code-defined, so they are never posted back. The server strips them
        // defensively too.
        if (entity.pluginOwned) continue;
        const fields: Record<string, FieldDef> = {};
        for (const [fieldName, field] of Object.entries(entity.fields)) {
          fields[fieldName] = fieldSummaryToFieldDef(field);
        }

        const permissions: Partial<Record<ActionName, RuleExpr>> = {};
        for (const action of ACTIONS) {
          const cell = built.draft[name]?.[action] ?? [];
          if (cell === "opaque") {
            const original = built.originals[name]?.[action];
            if (original) permissions[action] = original;
            continue;
          }
          const expr = leavesToRuleExpr(cell);
          if (expr) permissions[action] = expr;
        }

        configEntities[name] = { fields, permissions };
      }

      const res = await client.schema.update({ entities: configEntities });
      const nextEntities = res.data.entities as Record<string, EntitySchemaSummary>;
      setBuilt(buildDraft(nextEntities));
      onSchemaUpdated(nextEntities);
    } catch (err) {
      setSaveError(err instanceof FrogClientError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-foreground">Permission matrix</h1>
        {managed && (
          <Button type="button" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save schema"}
          </Button>
        )}
      </div>
      {!managed && <p className="text-sm text-muted-foreground italic">Editing permissions requires managed mode.</p>}
      {saveError && (
        <p role="alert" className="text-sm text-destructive">
          {saveError}
        </p>
      )}
      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>entity</TableHead>
              {ACTIONS.map((action) => (
                <TableHead key={action} className="uppercase">
                  {action}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {names.length === 0 ? (
              <TableRow>
                <TableCell colSpan={ACTIONS.length + 1} className="text-muted-foreground">
                  No entities.
                </TableCell>
              </TableRow>
            ) : (
              names.map((name) => {
                const entity = entities[name];
                if (!entity) return null;
                // Plugin-owned entities are code-defined, so their permissions
                // stay read-only regardless of mode.
                const readOnly = !managed || entity.pluginOwned;
                return (
                  <TableRow key={name}>
                    <TableCell className="align-top">
                      <span className="inline-flex items-center gap-2">
                        <span className="font-mono text-foreground">{name}</span>
                        {entity.pluginOwned && (
                          <Badge variant="outline" title="Code-defined by a plugin, not editable here">
                            plugin
                          </Badge>
                        )}
                      </span>
                    </TableCell>
                    {ACTIONS.map((action) => {
                      if (readOnly) {
                        const declared = Boolean(entity.permissions[action]);
                        return (
                          <TableCell
                            key={action}
                            className={
                              declared
                                ? "align-top font-mono text-xs text-foreground"
                                : "align-top font-mono text-xs text-muted-foreground italic"
                            }
                          >
                            {permissionSummary(entity, action)}
                          </TableCell>
                        );
                      }

                      const cell = built.draft[name]?.[action] ?? [];
                      const key = cellKey(name, action);
                      const pendingCondition = getPending(key);

                      if (cell === "opaque") {
                        return (
                          <TableCell key={action} className="align-top font-mono text-xs text-muted-foreground italic">
                            {permissionSummary(entity, action)}
                            <span className="text-muted-foreground"> (too complex to edit here)</span>
                          </TableCell>
                        );
                      }

                      return (
                        <TableCell key={action} className="min-w-[11rem] align-top">
                          {cell.length === 0 ? (
                            <span className="font-mono text-xs text-muted-foreground italic">admin only</span>
                          ) : (
                            <ul className="mb-1.5 flex flex-col gap-1">
                              {cell.map((leaf, index) => (
                                <li key={`${leaf.kind}-${index}`} className="flex items-center gap-1.5">
                                  <Badge variant="outline" className="font-mono text-[11px]">
                                    {describeRuleLeaf(leaf)}
                                  </Badge>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-xs"
                                    className="text-muted-foreground hover:text-destructive"
                                    aria-label={`Remove condition ${describeRuleLeaf(leaf)} from ${name} ${action}`}
                                    onClick={() => handleRemoveCondition(name, action, index)}
                                  >
                                    <X />
                                  </Button>
                                </li>
                              ))}
                            </ul>
                          )}
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Select
                              aria-label={`New condition kind for ${name} ${action}`}
                              className="h-8 w-auto min-w-[7rem] text-xs"
                              value={pendingCondition.kind}
                              onChange={(event) =>
                                setPending((prev) => ({ ...prev, [key]: { ...getPending(key), kind: event.target.value as RuleLeaf["kind"] } }))
                              }
                            >
                              {LEAF_KINDS.map((kind) => (
                                <option key={kind} value={kind}>
                                  {kind}
                                </option>
                              ))}
                            </Select>
                            {(pendingCondition.kind === "role" || pendingCondition.kind === "owner") && (
                              <Input
                                type="text"
                                aria-label={`New condition value for ${name} ${action}`}
                                className="h-8 w-auto min-w-[7rem] text-xs"
                                placeholder={pendingCondition.kind === "role" ? "role name" : "field name"}
                                value={pendingCondition.value}
                                onChange={(event) => setPending((prev) => ({ ...prev, [key]: { ...getPending(key), value: event.target.value } }))}
                              />
                            )}
                            <Button type="button" variant="outline" size="sm" onClick={() => handleAddCondition(name, action)}>
                              + OR
                            </Button>
                          </div>
                          {cellErrors[key] && (
                            <p role="alert" className="mt-1.5 text-xs text-destructive">
                              {cellErrors[key]}
                            </p>
                          )}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
