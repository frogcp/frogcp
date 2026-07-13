import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ApiError, type DataEngine } from "../data/engine";
import { deserializeConfig } from "../managed/serialize";
import type { Logger } from "../observability/logger";
import type { Ctx } from "../permissions/engine";
import type { RuleExpr } from "../permissions/rules";
import type { ActionName, BackendConfig, EntityDef, FieldDef, FieldType } from "../schema/types";
import { parseListQuery } from "./query";

/** The two schema-authority modes `createBackend` supports (see
 * `CreateBackendOptions.mode` in `kernel.ts`). Re-declared here as a literal
 * union rather than imported, to avoid a circular type import (`kernel.ts`
 * imports `buildApiRoutes` from this module). */
export type BackendMode = "code" | "managed";

/**
 * Hono context variables set by the kernel's middleware chain: `ctx` by the
 * identity middleware, `requestId`/`logger` by the correlation-id middleware
 * (see `kernel.ts`). `logger` is already a per-request child logger, so any
 * route or plugin can log request-scoped context via `c.get("logger")`.
 */
export interface ApiVariables {
  ctx: Ctx;
  logger: Logger;
  requestId: string;
}

type ApiContext = Context<{ Variables: ApiVariables }>;

/** Public alias of the internal `ApiContext`, re-exported (as `RequestContext`)
 * from `index.ts` for plugin authors writing a `FrogPlugin.middleware` as a
 * standalone named function, so they can type the `c` parameter without
 * importing `Context` from `hono` or hand-rolling the generic. */
export type RequestContext = ApiContext;

function getEntityOrThrow(config: BackendConfig, name: string): EntityDef {
  const entity = config.entities[name];
  if (!entity) throw new ApiError(404, "unknown_entity", `Unknown entity "${name}"`);
  return entity;
}

/** Reads and JSON-parses the request body, surfacing malformed JSON as a 422 (never a raw crash). */
async function readJsonBody(c: ApiContext): Promise<unknown> {
  const raw = await c.req.text();
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(422, "validation", "Malformed JSON body");
  }
}

/**
 * Renders a `RuleExpr` as a short human-readable string (`role(admin)`,
 * `owner(field)`, `authenticated`, `public`, or a flattened `A OR B` /
 * `A AND B`) for the schema introspection endpoint and anywhere a rule is shown
 * rather than evaluated. A nested combinator of a different kind than its
 * parent is parenthesized so precedence stays legible.
 */
export function describeRuleExpr(expr: RuleExpr): string {
  switch (expr.kind) {
    case "role":
      return `role(${expr.role})`;
    case "owner":
      return `owner(${expr.field})`;
    case "authenticated":
      return "authenticated";
    case "public":
      return "public";
    case "or":
      return expr.rules.map((r) => describeNested(r, "or")).join(" OR ");
    case "and":
      return expr.rules.map((r) => describeNested(r, "and")).join(" AND ");
  }
}

function describeNested(expr: RuleExpr, parentKind: "or" | "and"): string {
  const rendered = describeRuleExpr(expr);
  if ((expr.kind === "or" || expr.kind === "and") && expr.kind !== parentKind) {
    return `(${rendered})`;
  }
  return rendered;
}

/** Per-field metadata returned by `GET /api/system/schema`: every `FieldDef`
 * key actually set on the field (omitting anything `undefined`), so the JSON
 * output stays clean rather than padded with nulls. */
export interface FieldSchemaSummary {
  type: FieldType;
  required: boolean;
  default?: unknown;
  auto?: boolean;
  options?: readonly string[];
  target?: string;
  onDelete?: "cascade" | "set null" | "restrict";
  unique?: boolean;
  hidden?: boolean;
  readonly?: boolean;
}

export interface EntitySchemaSummary {
  fields: Record<string, FieldSchemaSummary>;
  /** A human-readable rule summary per declared action, e.g.
   * `"owner(id) OR role(admin)"`. An action with no rule is omitted; that means
   * default-deny (admin-only), so the omission itself is the signal. */
  permissions: Partial<Record<ActionName, string>>;
  /**
   * `true` when this entity was contributed by a plugin (e.g. `frogcp/auth`'s
   * `users`) rather than the user/stored config. Plugin entities are
   * code-defined and never editable via `POST /api/system/schema`, so admin UIs
   * should render them read-only and omit them from a posted config (the server
   * also strips plugin-owned entities defensively; see that route).
   *
   * Optional so hand-built fixtures that predate this flag keep typechecking;
   * `buildSchemaSummary` always sets it explicitly.
   */
  pluginOwned?: boolean;
  /**
   * The structured `RuleExpr` tree per declared action (the same set of actions
   * as `permissions`). This is the re-sendable source of truth for the admin
   * schema editor: it round-trips a rule through `POST /api/system/schema`
   * verbatim, including rules the UI's OR-only builder can't represent (an
   * `and`, a nested combinator), which render read-only but are re-sent as-is
   * rather than regenerated from the lossy `permissions` summary string.
   */
  permissionRules: Partial<Record<ActionName, RuleExpr>>;
}

function serializeField(field: FieldDef): FieldSchemaSummary {
  const summary: FieldSchemaSummary = { type: field.type, required: field.required };
  if (field.default !== undefined) summary.default = field.default;
  if (field.auto !== undefined) summary.auto = field.auto;
  if (field.options !== undefined) summary.options = field.options;
  if (field.target !== undefined) summary.target = field.target;
  if (field.onDelete !== undefined) summary.onDelete = field.onDelete;
  if (field.unique !== undefined) summary.unique = field.unique;
  if (field.hidden !== undefined) summary.hidden = field.hidden;
  if (field.readonly !== undefined) summary.readonly = field.readonly;
  return summary;
}

/**
 * Builds the per-entity schema summary for `GET /api/system/schema`: every
 * field's metadata (hidden fields are included, flagged `hidden: true`, since
 * this endpoint is admin-only and admins configure hidden fields) plus a
 * human-readable rule summary per declared action.
 *
 * `pluginEntityNames` (default empty) flags each entity's `pluginOwned`; omit
 * it for a plain code-config summary with no plugins involved.
 */
export function buildSchemaSummary(
  config: BackendConfig,
  pluginEntityNames: ReadonlySet<string> = new Set(),
): Record<string, EntitySchemaSummary> {
  const entities: Record<string, EntitySchemaSummary> = {};
  for (const [name, entityDef] of Object.entries(config.entities)) {
    const fields: Record<string, FieldSchemaSummary> = {};
    for (const [fieldName, fieldDef] of Object.entries(entityDef.fields)) {
      fields[fieldName] = serializeField(fieldDef);
    }
    const permissions: Partial<Record<ActionName, string>> = {};
    const permissionRules: Partial<Record<ActionName, RuleExpr>> = {};
    for (const [action, rule] of Object.entries(entityDef.permissions)) {
      if (rule) {
        permissions[action as ActionName] = describeRuleExpr(rule.expr);
        permissionRules[action as ActionName] = rule.expr;
      }
    }
    entities[name] = { fields, permissions, permissionRules, pluginOwned: pluginEntityNames.has(name) };
  }
  return entities;
}

/**
 * Builds the `/entity/*` and `/system/*` REST routes over a `DataEngine`.
 * Mounted under `/api` by the kernel.
 *
 * `getConfig` is a closure, not a snapshot, so managed mode's
 * `Backend.applySchema` hot-swap (which reassigns `KernelContext.config` after
 * an online migration) is visible to routes registered at boot: every handler
 * calls `getConfig()` fresh per request, so a newly-added entity is immediately
 * routable and a removed one 404s just as promptly.
 *
 * `mode` and `applySchema` back `POST /system/schema` (admin schema editing,
 * managed mode only). `applySchema` is the kernel's own hot-swap closure,
 * passed in because `buildApiRoutes` runs before the `Backend` object exists;
 * the kernel's `applySchema` declaration is hoisted within `createBackend`, so
 * it is already callable here.
 *
 * `pluginEntityNames` is the set of entity names contributed by plugins. Used
 * to flag `pluginOwned` and to defensively strip any plugin-owned entity from a
 * posted config before it reaches `applySchema`.
 */
export function buildApiRoutes(
  engine: DataEngine,
  getConfig: () => BackendConfig,
  mode: BackendMode,
  applySchema: (newUserConfig: BackendConfig, ctx?: Ctx) => Promise<void>,
  pluginEntityNames: ReadonlySet<string>,
): Hono<{ Variables: ApiVariables }> {
  const app = new Hono<{ Variables: ApiVariables }>();

  app.get("/entity/:name", async (c) => {
    const name = c.req.param("name");
    const entity = getEntityOrThrow(getConfig(), name);
    const ctx = c.get("ctx");
    const query = parseListQuery(new URL(c.req.url), entity);
    const result = await engine.list(name, ctx, query);
    return c.json(result, 200);
  });

  app.post("/entity/:name", async (c) => {
    const name = c.req.param("name");
    const ctx = c.get("ctx");
    const body = await readJsonBody(c);
    const row = await engine.create(name, body, ctx, c.get("requestId"));
    return c.json({ data: row }, 201);
  });

  app.get("/entity/:name/:id", async (c) => {
    const name = c.req.param("name");
    const id = c.req.param("id");
    const ctx = c.get("ctx");
    const withRaw = c.req.query("with");
    const withRels = withRaw && withRaw.length > 0 ? withRaw.split(",") : undefined;
    const row = await engine.read(name, id, ctx, withRels);
    return c.json({ data: row }, 200);
  });

  app.patch("/entity/:name/:id", async (c) => {
    const name = c.req.param("name");
    const id = c.req.param("id");
    const ctx = c.get("ctx");
    const body = await readJsonBody(c);
    const row = await engine.update(name, id, body, ctx, c.get("requestId"));
    return c.json({ data: row }, 200);
  });

  app.delete("/entity/:name/:id", async (c) => {
    const name = c.req.param("name");
    const id = c.req.param("id");
    const ctx = c.get("ctx");
    await engine.delete(name, id, ctx, c.get("requestId"));
    return c.body(null, 204);
  });

  app.get("/system/health", (c) => c.json({ ok: true }, 200));

  app.get("/system/schema", (c) => {
    const ctx = c.get("ctx");
    if (!ctx || ctx.role !== "admin") {
      throw new ApiError(403, "forbidden", "Only admins may read the schema");
    }
    return c.json({ data: { entities: buildSchemaSummary(getConfig(), pluginEntityNames) }, mode }, 200);
  });

  /**
   * Admin-only schema editing (managed mode). Body: a full user-entity config,
   * the shape `serializeConfig` emits, not the merged config `GET` returns
   * (which also includes plugin entities); callers send only the entities they
   * own.
   *
   * - Non-admin (including guest): 403, before anything else is inspected.
   * - Malformed JSON or a structurally invalid config: 422 with
   *   `deserializeConfig`'s own descriptive message (it never touches the
   *   database, so nothing driver-specific leaks).
   * - Any posted entity whose name is plugin-owned is silently stripped before
   *   `applySchema` runs, since plugin entities are re-merged from the backend's
   *   own `plugins` regardless; keeping a client copy would only collide with
   *   that re-merge. Defensive: a well-behaved client already omits them.
   * - A structurally valid config that fails to apply (migrateToConfig or the
   *   merged-config validateConfig rejecting it): 422 `migration_failed` with a
   *   curated, driver-agnostic message. The raw error carries adapter/driver
   *   text and is never returned to the client; it is logged server-side via
   *   the per-request logger. `applySchema` throws `ApiError(409, "not_managed")`
   *   in code mode, which is rethrown as-is.
   * - Success: 200 with the same shape `GET` returns (the post-hot-swap live
   *   schema, including plugin entities).
   */
  app.post("/system/schema", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx || ctx.role !== "admin") {
      throw new ApiError(403, "forbidden", "Only admins may edit the schema");
    }

    const raw = await c.req.text();
    let newConfig: BackendConfig;
    try {
      newConfig = deserializeConfig(raw);
    } catch (error) {
      throw new ApiError(422, "validation", error instanceof Error ? error.message : "Malformed schema");
    }

    // Defensive strip (see doc above): a plugin-owned entity in the posted body
    // is dropped here, never forwarded to `applySchema`.
    for (const entityName of Object.keys(newConfig.entities)) {
      if (pluginEntityNames.has(entityName)) {
        delete newConfig.entities[entityName];
      }
    }

    try {
      await applySchema(newConfig, ctx);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // A real migration/DDL failure's message carries raw driver text, so log
      // it server-side and return a curated, driver-agnostic message instead.
      c.get("logger").error("POST /api/system/schema: applySchema failed", { error });
      throw new ApiError(
        422,
        "migration_failed",
        "Schema migration failed. The requested change could not be applied. Check for incompatible column changes.",
      );
    }

    return c.json({ data: { entities: buildSchemaSummary(getConfig(), pluginEntityNames) }, mode }, 200);
  });

  return app;
}

/**
 * Renders any thrown error as the frogCP error envelope; never leaks
 * non-ApiError details to the client. An unexpected non-`ApiError` (the generic
 * 500 path) is logged server-side via the request's own logger before the
 * generic response is built, so the real error is never silently lost.
 */
export function apiErrorResponse(err: unknown, c: ApiContext): Response {
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status as ContentfulStatusCode);
  }
  c.get("logger").error("unhandled error", { error: err, path: c.req.path });
  return c.json({ error: { code: "internal", message: "internal error" } }, 500);
}

/** Renders the standard 404 envelope for unmatched routes. */
export function apiNotFoundResponse(c: ApiContext): Response {
  return c.json({ error: { code: "not_found", message: "Not found" } }, 404);
}
