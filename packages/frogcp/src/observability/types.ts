/**
 * The four observability signals frogCP's kernel and plugins emit, aligned
 * with OTel's signal shapes (log record / metric point / span, plus audit,
 * which is frogCP-specific since OTel has no first-class audit-log signal).
 * These are pure data (no methods, no `node:` imports) so any sink on any
 * runtime can serialize them however it likes. See
 * `docs/superpowers/specs/2026-07-11-observability-design.md` §2 for the
 * contract this mirrors.
 */

import type { LogLevel } from "./logger";

/** One structured log line, as `Logger`'s internal `makeLogger` builds per call, handed to `LogSink`s via `ObservabilityRegistry.emitLog`. */
export interface LogRecord {
  level: LogLevel;
  time: string;
  message: string;
  fields: Record<string, unknown>;
}

/** One metric observation. `kind` mirrors the three OTel instrument shapes: a monotonic `counter`, a point-in-time `gauge`, or a `histogram` value (a sink decides how to bucket, if at all). */
export interface MetricPoint {
  name: string;
  value: number;
  kind: "counter" | "gauge" | "histogram";
  unit?: string;
  attributes?: Record<string, string | number | boolean>;
  time: string;
}

/** One completed trace span. `parentSpanId` is absent for a root span. */
export interface SpanData {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTime: string;
  endTime: string;
  status: "ok" | "error";
  attributes?: Record<string, string | number | boolean>;
}

/** One audit-worthy action against the data layer (or anything else a plugin considers audit-worthy). Core never emits this itself in OBS1; `frogcp/activity` (a later PR) bridges the event bus to it, while core only provides the contract plus `registry.emitAudit`. */
export interface AuditEvent {
  action: string;
  entity?: string;
  recordId?: string;
  actor?: { userId?: string; role?: string };
  before?: unknown;
  after?: unknown;
  requestId?: string;
  time: string;
}
