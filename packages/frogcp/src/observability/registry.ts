/**
 * The fan-out hub for all four observability signals; lives on
 * `KernelContext.observability` (see `kernel.ts`). Plugins register sinks in
 * `onBoot` (`ctx.observability.addMetricSink(myAeSink)`), like entities/routes;
 * `CreateBackendOptions.sinks` is the no-plugin-needed convenience for the same
 * thing, wired at boot in `createBackend`.
 *
 * Guarded fan-out is the key property: observability must never break a
 * request. Every sink call (`write*` and `flush`) is wrapped in its own
 * try/catch. A throwing sink is logged once (via a base `consoleLogger`,
 * deliberately not the request/backend logger, so a broken log sink can't
 * recursively break logging) and otherwise ignored; every other registered
 * sink for that signal still runs. `emit*` with no sinks registered for that
 * signal is a silent no-op (the zero-config default; see the design spec §8).
 */

import { consoleLogger } from "./logger";
import type { AuditSink, LogSink, MetricSink, SpanSink } from "./sinks";
import type { AuditEvent, LogRecord, MetricPoint, SpanData } from "./types";

type Signal = "log" | "metric" | "span" | "audit";

/** The base logger sink failures are reported through, independent of any
 * backend-configured logger (which could itself be misbehaving), so a broken
 * sink is always at least visible somewhere. */
const baseLogger = consoleLogger();

/** Runs `fn`, swallowing (and logging) any synchronous throw or rejected promise: the one place the never-throw guarantee is enforced. */
async function guardedCall(signal: Signal, sinkLabel: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    baseLogger.error("observability sink failed", { sink: sinkLabel, signal, error });
  }
}

/** A sink's constructor name (or `"sink"` if anonymous/unavailable), enough to identify which sink failed in the guard log line without requiring sinks to self-report a name. */
function labelOf(sink: object): string {
  return sink.constructor?.name || "sink";
}

export class ObservabilityRegistry {
  private readonly logSinks: LogSink[] = [];
  private readonly metricSinks: MetricSink[] = [];
  private readonly spanSinks: SpanSink[] = [];
  private readonly auditSinks: AuditSink[] = [];

  addLogSink(sink: LogSink): void {
    this.logSinks.push(sink);
  }

  addMetricSink(sink: MetricSink): void {
    this.metricSinks.push(sink);
  }

  addSpanSink(sink: SpanSink): void {
    this.spanSinks.push(sink);
  }

  addAuditSink(sink: AuditSink): void {
    this.auditSinks.push(sink);
  }

  /** Fans `record` out to every registered `LogSink`, guarded. No-op if none are registered. */
  emitLog(record: LogRecord): void {
    for (const sink of this.logSinks) {
      void guardedCall("log", labelOf(sink), () => sink.writeLogs([record]));
    }
  }

  /** Fans `point` out to every registered `MetricSink`, guarded. No-op if none are registered. */
  recordMetric(point: MetricPoint): void {
    for (const sink of this.metricSinks) {
      void guardedCall("metric", labelOf(sink), () => sink.writeMetrics([point]));
    }
  }

  /** Fans `span` out to every registered `SpanSink`, guarded. No-op if none are registered. */
  emitSpan(span: SpanData): void {
    for (const sink of this.spanSinks) {
      void guardedCall("span", labelOf(sink), () => sink.writeSpans([span]));
    }
  }

  /** Fans `event` out to every registered `AuditSink`, guarded. No-op if none are registered. */
  emitAudit(event: AuditEvent): void {
    for (const sink of this.auditSinks) {
      void guardedCall("audit", labelOf(sink), () => sink.writeAudit([event]));
    }
  }

  /**
   * Awaits every registered sink's `flush?.()` (guarded, in parallel) across
   * all four signals. This is the seam the built-in request-metric middleware
   * calls via `c.executionCtx?.waitUntil(...)` on Workers, or inline on
   * runtimes without one (see `kernel.ts`). Sinks without a `flush` are
   * skipped.
   */
  async flushAll(): Promise<void> {
    const all: { sink: LogSink | MetricSink | SpanSink | AuditSink; signal: Signal }[] = [
      ...this.logSinks.map((sink) => ({ sink, signal: "log" as const })),
      ...this.metricSinks.map((sink) => ({ sink, signal: "metric" as const })),
      ...this.spanSinks.map((sink) => ({ sink, signal: "span" as const })),
      ...this.auditSinks.map((sink) => ({ sink, signal: "audit" as const })),
    ];
    await Promise.all(
      all
        .filter(({ sink }) => typeof sink.flush === "function")
        .map(({ sink, signal }) => guardedCall(signal, labelOf(sink), () => sink.flush?.())),
    );
  }
}
