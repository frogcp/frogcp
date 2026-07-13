import { FieldBuilder } from "./fields";
import type { ActionName, BackendConfig, EntityDef, ResourceDeclaration, Rule } from "./types";
import { validateConfig } from "./validate-config";

export class EntityBuilder {
  private perms: Partial<Record<ActionName, Rule>> = {};
  constructor(private fields: Record<string, FieldBuilder>) {}
  permissions(map: Partial<Record<ActionName, Rule>>): this { this.perms = map; return this; }
  build(): EntityDef {
    return {
      fields: Object.fromEntries(Object.entries(this.fields).map(([k, b]) => [k, b.build()])),
      permissions: this.perms,
    };
  }
}

export const entity = (fields: Record<string, FieldBuilder>) => new EntityBuilder(fields);

/**
 * Resolves a map of `EntityBuilder`s into plain `EntityDef`s, without the
 * config-level validation and freezing `defineBackend` also does. Exported so
 * plugins can define entities the same way a user's config does; the kernel
 * merges the resolved defs in and runs `validateConfig` over the combined result.
 */
export function resolveEntities(input: Record<string, EntityBuilder>): Record<string, EntityDef> {
  return Object.fromEntries(Object.entries(input).map(([k, b]) => [k, b.build()]));
}

export function defineBackend(input: {
  entities: Record<string, EntityBuilder>;
  /** Declarative deploy resources for the control plane to provision (see
   *  `ResourceDeclaration`). Optional; forwarded verbatim by `frogcp deploy`. */
  resources?: ResourceDeclaration;
}): BackendConfig {
  const entities = resolveEntities(input.entities);
  // exactOptionalPropertyTypes: only add `resources` when it was declared.
  const config: BackendConfig = { entities, ...(input.resources ? { resources: input.resources } : {}) };
  validateConfig(config);
  for (const entity of Object.values(entities)) Object.freeze(entity);
  return Object.freeze({
    entities: Object.freeze(entities),
    ...(input.resources ? { resources: input.resources } : {}),
  });
}
