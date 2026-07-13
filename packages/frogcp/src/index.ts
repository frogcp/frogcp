export const VERSION = "0.0.1";

// Schema exports
export type {
  FieldType,
  FieldDef,
  EntityDef,
  ActionName,
  BackendConfig,
  ResourceOptions,
  ResourceDeclaration,
} from "./schema/types";
export { FieldBuilder } from "./schema/fields";
export { text, number, boolean, date, timestamp, json, select, media, ref } from "./schema/fields";
export { EntityBuilder, entity, defineBackend, resolveEntities } from "./schema/entity";
export { validateConfig } from "./schema/validate-config";

// Permission exports
export { Rule, role, rule } from "./permissions/rules";
export type { RuleExpr } from "./permissions/rules";
export { decide, checkRow } from "./permissions/engine";
export type { Identity, Ctx, Decision } from "./permissions/engine";

// Compile exports
export { compileTables } from "./compile/drizzle";
export type { CompiledTables } from "./compile/drizzle";

// Adapter contract
export type { DatabaseAdapter, SqliteDatabaseAdapter, PostgresDatabaseAdapter, StorageAdapter, SessionStore, KvStore, KvPutOptions } from "./adapter";

// Migration exports
export { generateSqliteMigration, generatePostgresMigration, migrateToConfig } from "./migrate/index";

// Managed mode exports (config serialization + schema store)
export { serializeConfig, deserializeConfig } from "./managed/serialize";
export { ensureSchemaTable, readStoredSchema, writeStoredSchema } from "./managed/store";

// Validation exports
export { buildInsertSchema, buildPatchSchema } from "./data/validate";

// Data engine exports
export { DataEngine, ApiError, isUniqueViolation } from "./data/engine";
export type { ListQuery, Row, ExpandedRow, FilterOp } from "./data/engine";

// Query grammar exports
export { parseListQuery } from "./api/query";

// Event bus exports
export { EventBus } from "./events";
export type { DataEvent, DataEventPayload } from "./events";

// Observability exports (structured logger + request correlation, pluggable
// signal contracts + the fan-out registry)
export { consoleLogger, silentLogger } from "./observability/logger";
export type { Logger, LogLevel } from "./observability/logger";
export { ObservabilityRegistry } from "./observability/registry";
export type { LogSink, MetricSink, SpanSink, AuditSink } from "./observability/sinks";
export type { LogRecord, MetricPoint, SpanData, AuditEvent } from "./observability/types";

// Kernel / REST API exports
export { createBackend } from "./kernel";
export type { Backend, CreateBackendOptions, FrogPlugin, FrogMiddleware, KernelContext } from "./kernel";
export type { ApiVariables } from "./api/routes";

// App descriptor plus shared serve core (bknd-style `defineApp` and connection
// auto-resolution). `createBackend` stays the low-level escape hatch; these
// remove the per-runtime boot ceremony, see `frogcp/adapter/*`.
export { resolveConnection } from "./adapter/connection";
export type { Connection, ConnectionResolver, D1Binding } from "./adapter/connection";
export {
  defineApp,
  buildBackend,
  createBackendMemo,
  createServeHandler,
} from "./adapter/serve";
export type { App, RuntimeContext, OrResolver } from "./adapter/serve";

// Ergonomic middleware-authoring alias, so plugin authors writing a
// `FrogPlugin.middleware` don't have to hand-roll the `{ Variables: ApiVariables }`
// generic or import `Context` from `hono`. `RequestContext` is the `c`
// parameter's type, useful when a middleware is a named function.
export type { RequestContext } from "./api/routes";

// Schema introspection exports
export { buildSchemaSummary, describeRuleExpr } from "./api/routes";
export type { FieldSchemaSummary, EntitySchemaSummary } from "./api/routes";
