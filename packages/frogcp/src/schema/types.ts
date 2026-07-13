import type { Rule } from "../permissions/rules";

export type FieldType =
  | "text" | "number" | "boolean" | "date" | "timestamp"
  | "json" | "select" | "media" | "ref";

export interface FieldDef {
  type: FieldType;
  required: boolean;
  default?: unknown;
  auto?: boolean;                      // timestamp().auto()
  options?: readonly string[];         // select
  target?: string;                     // ref target entity name
  onDelete?: "cascade" | "set null" | "restrict";
  unique?: boolean;
  hidden?: boolean;
  readonly?: boolean;
}

export type ActionName = "read" | "list" | "create" | "update" | "delete";

export interface EntityDef {
  fields: Record<string, FieldDef>;
  permissions: Partial<Record<ActionName, Rule>>;
}

/**
 * Per-resource options for a declared deploy resource, keyed by binding name.
 * Empty at launch (room for `{ migrations, ttl, ... }` later); a plain object
 * so the CLI can round-trip the `resources` block to the control plane as a
 * JSON deploy manifest untouched.
 */
export type ResourceOptions = Record<string, unknown>;

/**
 * A tenant's declared deploy resources: resource type (`"d1"`, `"kv"`, `"r2"`,
 * `"ai"`, ...) to binding name (`"DB"`, `"CACHE"`) to per-resource options.
 * The control plane provisions exactly what is declared here. The framework
 * never provisions anything itself; it only carries this shape so
 * `frogcp deploy` can forward it.
 */
export type ResourceDeclaration = Record<string, Record<string, ResourceOptions>>;

export interface BackendConfig {
  entities: Record<string, EntityDef>;
  /** Declarative deploy resources for the control plane to provision (see
   *  `ResourceDeclaration`). Omitted means zero resources provisioned. */
  resources?: ResourceDeclaration;
}

export type { Rule };
export type { RuleExpr } from "../permissions/rules";
