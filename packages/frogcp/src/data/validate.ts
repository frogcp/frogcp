import { z } from "zod";
import type { EntityDef, FieldDef } from "../schema/types";

/** Converts a FieldDef to a zod schema. */
function fieldToZod(field: FieldDef): z.ZodTypeAny {
  let schema: z.ZodTypeAny;

  switch (field.type) {
    case "text":
    case "media":
    case "ref":
      schema = z.string();
      break;
    case "select":
      if (!field.options) throw new Error("select field missing options");
      schema = z.enum(field.options as [string, ...string[]]);
      break;
    case "number":
      schema = z.number();
      break;
    case "boolean":
      schema = z.boolean();
      break;
    case "date":
    case "timestamp":
      schema = z.coerce.date();
      break;
    case "json":
      schema = z.unknown();
      break;
    default:
      throw new Error(`Unknown field type: ${String((field as { type: string }).type)}`);
  }

  return schema;
}

/**
 * Builds a zod schema for insert operations. Required fields are non-optional;
 * fields with a default or auto are optional; the `id` field is excluded.
 * Hidden fields are excluded from the shape entirely, so zod's unknown-key
 * stripping silently drops any client-supplied value for them.
 */
export function buildInsertSchema(entity: EntityDef): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [fieldName, field] of Object.entries(entity.fields)) {
    if (fieldName === "id") continue;
    if (field.hidden) continue;

    const fieldSchema = fieldToZod(field);

    // Check `field.default === undefined`, not `!field.default`: a falsy but
    // present default (e.g. `.required().default(0)` or `.default(false)`)
    // would otherwise stay mandatory even though the engine supplies it.
    if (field.required && field.default === undefined && !field.auto) {
      shape[fieldName] = fieldSchema;
    } else {
      shape[fieldName] = fieldSchema.optional();
    }
  }

  return z.object(shape);
}

/**
 * Builds a zod schema for patch operations. All fields are optional; the `id`
 * field and hidden fields are excluded (see buildInsertSchema).
 */
export function buildPatchSchema(entity: EntityDef): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [fieldName, field] of Object.entries(entity.fields)) {
    if (fieldName === "id") continue;
    if (field.hidden) continue;

    const fieldSchema = fieldToZod(field);
    shape[fieldName] = fieldSchema.optional();
  }

  return z.object(shape);
}
