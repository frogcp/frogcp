import type { BackendConfig } from "../schema/types";

/**
 * Validates that every `ref` field's `target` names an entity that exists in
 * `config`. Both dialect compilers build ref columns with drizzle's lazy
 * `references(() => target.id, ...)` callback so tables can be declared in a
 * single pass regardless of order. That callback only resolves the target at
 * query time, so without this eager check a bad ref target would surface as a
 * confusing runtime error far from its cause.
 */
export function validateRefTargets(config: BackendConfig): void {
  for (const [entityName, entityDef] of Object.entries(config.entities)) {
    for (const field of Object.values(entityDef.fields)) {
      if (field.type === "ref" && !config.entities[field.target as string]) {
        throw new Error(`Unknown ref target "${field.target}" in entity "${entityName}"`);
      }
    }
  }
}
