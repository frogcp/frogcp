/**
 * The four sink contracts: where each signal in `types.ts` actually goes
 * (console, an OTLP collector, Cloudflare Analytics Engine, a database table,
 * Datadog, and so on). Where signals are stored is a plugin/user decision; the
 * framework only owns these contracts plus the `ObservabilityRegistry`
 * (`registry.ts`) that fans out to them. See
 * `docs/superpowers/specs/2026-07-11-observability-design.md` §3.
 *
 * Every `write*` method documents a must-not-throw contract, enforced from
 * both sides: a well-behaved sink shouldn't throw, and `ObservabilityRegistry`
 * also wraps every call in its own try/catch (logging the failure once via a
 * base console logger, never propagating) so a misbehaving third-party sink
 * still can't take down a request. See `registry.ts`'s `guardedCall`.
 */

import type { AuditEvent, LogRecord, MetricPoint, SpanData } from "./types";

/**
 * Receives log lines. `writeLogs` must not throw. Batching, if any, is the
 * sink's own concern: the registry calls `writeLogs` once per emitted record
 * (`writeLogs([record])`), and a buffering sink accumulates internally and
 * drains on `flush()`. `flush()`, if provided, is awaited by
 * `ObservabilityRegistry.flushAll()` and must not throw either.
 */
export interface LogSink {
  writeLogs(records: LogRecord[]): void | Promise<void>;
  flush?(): Promise<void>;
}

/** Receives metric points. Same never-throw / sink-owns-batching contract as `LogSink`. */
export interface MetricSink {
  writeMetrics(points: MetricPoint[]): void | Promise<void>;
  flush?(): Promise<void>;
}

/** Receives spans. Same never-throw / sink-owns-batching contract as `LogSink`. */
export interface SpanSink {
  writeSpans(spans: SpanData[]): void | Promise<void>;
  flush?(): Promise<void>;
}

/** Receives audit events. Same never-throw / sink-owns-batching contract as `LogSink`. */
export interface AuditSink {
  writeAudit(events: AuditEvent[]): void | Promise<void>;
  flush?(): Promise<void>;
}
