import { FrogClientError } from "frogcp/client";
import type { FieldSchemaSummary } from "frogcp";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { client } from "../api";
import { formEligibleFields, fromDatetimeLocalValue, isMandatory, toWidgetValue } from "../lib/schema";

export interface EntityFormProps {
  entityName: string;
  mode: "create" | "edit";
  /** The entity's full field map, same shape `DataBrowser` was given. This
   * component derives its own eligible-field list via `formEligibleFields`
   * rather than taking a pre-filtered list, so it stays usable standalone. */
  fields: Record<string, FieldSchemaSummary>;
  /** The existing row: required for `mode: "edit"` (pre-fills every widget
   * and supplies the id the `PATCH` targets), absent for `mode: "create"`. */
  initial?: Record<string, unknown>;
  onCancel: () => void;
  /** Called after a successful create/update, so the caller can close the
   * form and refetch the list. */
  onSuccess: () => void;
}

type WidgetValue = string | boolean;

function buildInitialValues(
  eligible: Array<[string, FieldSchemaSummary]>,
  mode: "create" | "edit",
  initial: Record<string, unknown> | undefined,
): Record<string, WidgetValue> {
  const values: Record<string, WidgetValue> = {};
  for (const [name, field] of eligible) {
    const raw = mode === "edit" ? initial?.[name] : field.default;
    values[name] = toWidgetValue(raw, field);
  }
  return values;
}

/**
 * The generic create/edit dialog: one widget per field type, with the fields
 * themselves taken from the entity's own schema via `formEligibleFields`.
 *
 * `readonly` fields render disabled and are omitted from the payload entirely
 * rather than sent back unchanged. An absent key is a server-side no-op, so
 * the two behave identically and omitting is simpler.
 *
 * Validation is two-layered: a required-but-empty field is caught client-side
 * and shown inline, while anything the server rejects becomes a form-level
 * banner. The error envelope carries a single `message`, not a per-field
 * breakdown, so that is the finest grain available.
 */
export function EntityForm({ entityName, mode, fields, initial, onCancel, onSuccess }: EntityFormProps) {
  const eligible = formEligibleFields(fields);
  const [values, setValues] = useState<Record<string, WidgetValue>>(() => buildInitialValues(eligible, mode, initial));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function setValue(name: string, value: WidgetValue) {
    setValues((prev) => ({ ...prev, [name]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const errors: Record<string, string> = {};
    const payload: Record<string, unknown> = {};

    for (const [name, field] of eligible) {
      // The widget is disabled, so there is never a client-initiated change
      // to round-trip.
      if (field.readonly) continue;

      if (field.type === "boolean") {
        payload[name] = Boolean(values[name]);
        continue;
      }

      const raw = typeof values[name] === "string" ? (values[name] as string).trim() : "";
      if (raw.length === 0) {
        if (isMandatory(field)) errors[name] = "This field is required.";
        continue; // optional + empty: omit the key entirely (server default/null applies)
      }

      switch (field.type) {
        case "number": {
          const n = Number(raw);
          if (Number.isNaN(n)) errors[name] = "Must be a number.";
          else payload[name] = n;
          break;
        }
        case "json":
          try {
            payload[name] = JSON.parse(raw);
          } catch {
            errors[name] = "Invalid JSON.";
          }
          break;
        case "date":
        case "timestamp":
          payload[name] = fromDatetimeLocalValue(raw);
          break;
        default:
          // text, select, media and ref are all plain strings on the wire.
          payload[name] = raw;
      }
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setFieldErrors({});
    setSubmitting(true);
    try {
      const entityClient = client.entity(entityName);
      if (mode === "create") {
        await entityClient.create(payload);
      } else {
        await entityClient.update(String(initial?.id), payload);
      }
      onSuccess();
    } catch (err) {
      if (err instanceof FrogClientError) {
        setFormError(err.status === 403 ? "You do not have permission to do this." : err.message);
      } else {
        setFormError("Something went wrong. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  function renderWidget(name: string, field: FieldSchemaSummary) {
    const id = `field-${name}`;
    const disabled = field.readonly === true;
    switch (field.type) {
      case "boolean":
        return (
          <Switch
            id={id}
            checked={Boolean(values[name])}
            disabled={disabled}
            onCheckedChange={(checked) => setValue(name, checked)}
          />
        );
      case "select":
        return (
          <Select id={id} value={String(values[name] ?? "")} disabled={disabled} onChange={(event) => setValue(name, event.target.value)}>
            <option value="">-- select --</option>
            {(field.options ?? []).map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </Select>
        );
      case "number":
        return (
          <Input
            id={id}
            type="number"
            value={String(values[name] ?? "")}
            disabled={disabled}
            onChange={(event) => setValue(name, event.target.value)}
          />
        );
      case "json":
        return (
          <textarea
            id={id}
            value={String(values[name] ?? "")}
            disabled={disabled}
            onChange={(event) => setValue(name, event.target.value)}
            className="min-h-24 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
          />
        );
      case "date":
      case "timestamp":
        return (
          <Input
            id={id}
            type="datetime-local"
            value={String(values[name] ?? "")}
            disabled={disabled}
            onChange={(event) => setValue(name, event.target.value)}
          />
        );
      default:
        // A media or ref widget is just a key/id string input here. Picking a
        // file interactively is the media library's job.
        return (
          <Input
            id={id}
            type="text"
            value={String(values[name] ?? "")}
            disabled={disabled}
            onChange={(event) => setValue(name, event.target.value)}
          />
        );
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "New" : "Edit"} {entityName}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {mode === "create" ? `Create a new ${entityName} record.` : `Edit this ${entityName} record.`}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {eligible.map(([name, field]) => {
            const id = `field-${name}`;
            const isBoolean = field.type === "boolean";
            return (
              <div className="flex flex-col gap-1.5" key={name}>
                <div className={isBoolean ? "flex items-center gap-2" : "flex flex-col gap-1.5"}>
                  {isBoolean && renderWidget(name, field)}
                  <Label htmlFor={id}>
                    {name}
                    {isMandatory(field) ? " *" : ""}
                  </Label>
                  {!isBoolean && renderWidget(name, field)}
                </div>
                {fieldErrors[name] && (
                  <p role="alert" className="text-xs text-destructive">
                    {fieldErrors[name]}
                  </p>
                )}
              </div>
            );
          })}
          {formError && (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
