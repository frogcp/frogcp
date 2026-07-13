/// <reference types="@cloudflare/workers-types" />
/**
 * The Cloudflare-native observability sink: fans frogCP's four signals (log,
 * metric, span, audit) into a Cloudflare Analytics Engine dataset binding, one
 * writeDataPoint() per record. Analytics Engine is the right sink for a Workers
 * deployment (no node:sqlite): a write-only, high-cardinality store queried
 * later via the SQL API. The Node/self-host equivalent is frogcp/sink/sqlite.
 *
 * A data point is { indexes, blobs, doubles }: one index (the sampling key),
 * up to 20 string blobs, up to 20 numeric doubles. Each signal maps to one
 * point:
 *
 * - metric: index [name], doubles [value], blobs [name, kind, unit, JSON(attributes)]
 * - audit:  index [action], blobs [action, entity, recordId, userId, role, requestId, JSON(before), JSON(after)]
 * - log:    index [level], blobs [level, message, JSON(fields)]
 * - span:   index [name], doubles [durationMs], blobs [name, traceId, spanId, parentSpanId, status, JSON(attributes)]
 *
 * There is no client buffer to flush: writeDataPoint hands the point to the
 * runtime immediately (the platform batches and samples), so no flush() is
 * provided. Every write honors the sink's never-throw contract: a throwing
 * binding or an unserializable field is caught per record and dropped.
 */

import type { AuditSink, LogSink, MetricSink, SpanSink } from "../../observability/sinks";
import type { AuditEvent, LogRecord, MetricPoint, SpanData } from "../../observability/types";

// JSON-encode, or "" if the value can't be serialized (e.g. a BigInt), so one
// bad field never drops the whole data point or throws.
function safeJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

// Milliseconds between two ISO timestamps, or 0 if either is unparseable.
function durationMs(start: string, end: string): number {
  const a = Date.parse(start);
  const b = Date.parse(end);
  return Number.isNaN(a) || Number.isNaN(b) ? 0 : Math.max(0, b - a);
}

/**
 * Builds { log, metric, span, audit } sinks backed by a Cloudflare Analytics
 * Engine dataset binding. Wire any subset via createBackend({ sinks: { ... } })
 * or a plugin's onBoot calling ctx.observability.addMetricSink(s.metric).
 */
export function analyticsEngineSink(dataset: AnalyticsEngineDataset): {
  log: LogSink;
  metric: MetricSink;
  span: SpanSink;
  audit: AuditSink;
} {
  const write = (point: AnalyticsEngineDataPoint): void => {
    try {
      dataset.writeDataPoint(point);
    } catch {
      // A failed AE write must never fail the request.
    }
  };

  return {
    metric: {
      writeMetrics(points: MetricPoint[]): void {
        for (const m of points) {
          write({
            indexes: [m.name],
            doubles: [m.value],
            blobs: [m.name, m.kind, m.unit ?? "", safeJson(m.attributes ?? {})],
          });
        }
      },
    },

    audit: {
      writeAudit(events: AuditEvent[]): void {
        for (const e of events) {
          write({
            indexes: [e.action],
            blobs: [
              e.action,
              e.entity ?? "",
              e.recordId ?? "",
              e.actor?.userId ?? "",
              e.actor?.role ?? "",
              e.requestId ?? "",
              safeJson(e.before),
              safeJson(e.after),
            ],
          });
        }
      },
    },

    log: {
      writeLogs(records: LogRecord[]): void {
        for (const r of records) {
          write({ indexes: [r.level], blobs: [r.level, r.message, safeJson(r.fields)] });
        }
      },
    },

    span: {
      writeSpans(spans: SpanData[]): void {
        for (const s of spans) {
          write({
            indexes: [s.name],
            doubles: [durationMs(s.startTime, s.endTime)],
            blobs: [s.name, s.traceId, s.spanId, s.parentSpanId ?? "", s.status, safeJson(s.attributes ?? {})],
          });
        }
      },
    },
  };
}
