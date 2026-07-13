/**
 * The Cloudflare Pipelines observability sink: streams frogCP's four signals
 * (log, metric, span, audit) into a Cloudflare Pipelines binding as JSON
 * records (pipeline.send([...])), which the pipeline batches and lands in R2.
 * Unlike analyticsEngineSink, which flattens each signal into Analytics
 * Engine's { indexes, blobs, doubles } for cheap SQL queries, Pipelines keeps
 * the full nested record (a metric's attributes, an audit event's
 * before/after), so it suits archival and downstream ETL rather than live
 * metric dashboards. Pick AE for querying, Pipelines for retention; a caller
 * can register both.
 *
 * Each write sends its whole batch in one send() call, tagging every record
 * with a signal discriminator. The never-throw contract holds: a rejected send
 * is caught and dropped. No flush(), since the batch is handed off per write.
 */

import type { AuditSink, LogSink, MetricSink, SpanSink } from "../../observability/sinks";
import type { AuditEvent, LogRecord, MetricPoint, SpanData } from "../../observability/types";

/**
 * The minimal shape of a Cloudflare Pipelines binding this sink needs. Declared
 * structurally rather than imported from @cloudflare/workers-types so the sink
 * builds regardless of the workers-types version's Pipelines coverage.
 */
export interface PipelineBinding {
  send(records: Record<string, unknown>[]): Promise<void>;
}

/**
 * Builds { log, metric, span, audit } sinks backed by a Cloudflare Pipelines
 * binding. Wire any subset via createBackend({ sinks: { ... } }) or a plugin's
 * onBoot.
 */
export function pipelinesSink(pipeline: PipelineBinding): {
  log: LogSink;
  metric: MetricSink;
  span: SpanSink;
  audit: AuditSink;
} {
  // Send one batch, swallowing any rejection. Skips an empty batch so an idle
  // signal makes no pipeline call.
  const send = async (signal: string, rows: Record<string, unknown>[]): Promise<void> => {
    if (rows.length === 0) return;
    try {
      await pipeline.send(rows.map((r) => ({ signal, ...r })));
    } catch {
      // A failed pipeline send must never fail the request.
    }
  };

  return {
    metric: { writeMetrics: (points: MetricPoint[]) => send("metric", points as unknown as Record<string, unknown>[]) },
    audit: { writeAudit: (events: AuditEvent[]) => send("audit", events as unknown as Record<string, unknown>[]) },
    log: { writeLogs: (records: LogRecord[]) => send("log", records as unknown as Record<string, unknown>[]) },
    span: { writeSpans: (spans: SpanData[]) => send("span", spans as unknown as Record<string, unknown>[]) },
  };
}
