/// <reference types="node" />
/**
 * The Node/self-host observability sink: persists frogCP's four signals (log,
 * metric, span, audit) to a SQLite database. It imports node:sqlite directly,
 * so it is Node-only and will not run on Cloudflare Workers; the Workers
 * equivalent is analyticsEngineSink in frogcp/adapter/cloudflare.
 *
 * sqliteObservabilitySink(opts) returns one sink per signal, so a caller wires
 * any subset via createBackend({ sinks: { log: [s.log], metric: [s.metric] } }).
 * Each write buffers its batch in memory; nothing touches SQLite until flush().
 * All four sinks share one flush that drains all four buffers inside a single
 * BEGIN/COMMIT (ROLLBACK on error), so whichever subset a caller registered,
 * ObservabilityRegistry.flushAll() still commits a request's signals together.
 *
 * Calling that shared flush concurrently is safe: every DatabaseSync call here
 * is synchronous, so an invocation runs to completion before control returns to
 * the event loop, and a second caller always sees emptied buffers.
 *
 * Writes and flushes never throw, per the sink contract: a failed flush logs
 * once and swallows the error, and a value that cannot be serialized is caught
 * per field and stored as NULL so the rest of the batch still lands.
 */

import { DatabaseSync } from "node:sqlite";
import type { AuditSink, LogSink, MetricSink, SpanSink } from "../../observability/sinks";
import type { AuditEvent, LogRecord, MetricPoint, SpanData } from "../../observability/types";

const DEFAULT_TABLE_PREFIX = "obs_";

/** The signal names readRecent accepts, matching the four sinks this module returns. */
export type ObservabilitySignal = "log" | "metric" | "span" | "audit";

export interface SqliteObservabilitySinkOptions {
  /**
   * A filesystem path (or ":memory:"), in which case this sink opens its own
   * connection, or an already-open DatabaseSync, which is reused as-is. This
   * sink never closes a connection it did not open.
   */
  db: string | DatabaseSync;
  /** Prefix for every table and index this sink creates. Defaults to "obs_". */
  tablePrefix?: string;
}

/** The four sink contracts, plus the underlying connection and a read helper. */
export interface SqliteObservabilitySink {
  log: LogSink;
  metric: MetricSink;
  span: SpanSink;
  audit: AuditSink;
  /** The connection this sink writes through: the instance passed in, or the one opened here. */
  db: DatabaseSync;
  /** The `limit` (default 50) most recent rows for `signal`, newest first, with JSON columns parsed back into objects. */
  readRecent(signal: ObservabilitySignal, limit?: number): Record<string, unknown>[];
}

const TABLE_SUFFIX: Record<ObservabilitySignal, string> = {
  log: "logs",
  metric: "metrics",
  span: "spans",
  audit: "audit",
};

// Spans have no `time` column (a span carries startTime/endTime), so they order
// by start_time instead.
const TIME_COLUMN: Record<ObservabilitySignal, string> = {
  log: "time",
  metric: "time",
  span: "start_time",
  audit: "time",
};

const JSON_COLUMNS: Record<ObservabilitySignal, string[]> = {
  log: ["fields"],
  metric: ["attributes"],
  span: ["attributes"],
  audit: ["before", "after"],
};

// JSON-encode, or NULL for an unset field and for anything JSON.stringify
// throws on (a cycle, a BigInt), so a pathological payload never takes down a
// sink.
function safeJson(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

// The requestId a request-scoped child logger bound, if there is one.
function requestIdFromFields(fields: Record<string, unknown>): string | null {
  const value = fields.requestId;
  return typeof value === "string" ? value : null;
}

function createTables(client: DatabaseSync, prefix: string): void {
  client.exec(`
    CREATE TABLE IF NOT EXISTS ${prefix}logs (
      id TEXT PRIMARY KEY,
      time TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      fields TEXT,
      request_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_${prefix}logs_time ON ${prefix}logs (time);
    CREATE INDEX IF NOT EXISTS idx_${prefix}logs_level ON ${prefix}logs (level);

    CREATE TABLE IF NOT EXISTS ${prefix}metrics (
      id TEXT PRIMARY KEY,
      time TEXT NOT NULL,
      name TEXT NOT NULL,
      value REAL NOT NULL,
      kind TEXT NOT NULL,
      unit TEXT,
      attributes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_${prefix}metrics_time ON ${prefix}metrics (time);
    CREATE INDEX IF NOT EXISTS idx_${prefix}metrics_name ON ${prefix}metrics (name);

    CREATE TABLE IF NOT EXISTS ${prefix}spans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      span_id TEXT NOT NULL,
      parent_span_id TEXT,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      status TEXT NOT NULL,
      attributes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_${prefix}spans_time ON ${prefix}spans (start_time);
    CREATE INDEX IF NOT EXISTS idx_${prefix}spans_trace_id ON ${prefix}spans (trace_id);

    CREATE TABLE IF NOT EXISTS ${prefix}audit (
      id TEXT PRIMARY KEY,
      time TEXT NOT NULL,
      action TEXT NOT NULL,
      entity TEXT,
      record_id TEXT,
      actor_user_id TEXT,
      actor_role TEXT,
      before TEXT,
      after TEXT,
      request_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_${prefix}audit_time ON ${prefix}audit (time);
  `);
}

/**
 * Opens (or reuses) a connection, creates the four prefixed tables if they do
 * not exist, and returns the four buffering sinks plus readRecent and db.
 */
export function sqliteObservabilitySink(opts: SqliteObservabilitySinkOptions): SqliteObservabilitySink {
  const client = typeof opts.db === "string" ? new DatabaseSync(opts.db) : opts.db;
  const prefix = opts.tablePrefix ?? DEFAULT_TABLE_PREFIX;

  // The prefix is interpolated into identifiers below (SQLite cannot
  // parameterize a table name). It is normally a trusted constant, but validate
  // anyway so a stray value can never become an injection vector.
  if (!/^[A-Za-z0-9_]+$/.test(prefix)) {
    throw new Error(
      `frogcp/sink/sqlite: tablePrefix must match /^[A-Za-z0-9_]+$/ (got ${JSON.stringify(prefix)})`,
    );
  }

  createTables(client, prefix);

  const insertLog = client.prepare(
    `INSERT INTO ${prefix}logs (id, time, level, message, fields, request_id) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertMetric = client.prepare(
    `INSERT INTO ${prefix}metrics (id, time, name, value, kind, unit, attributes) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSpan = client.prepare(
    `INSERT INTO ${prefix}spans (id, name, trace_id, span_id, parent_span_id, start_time, end_time, status, attributes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertAudit = client.prepare(
    `INSERT INTO ${prefix}audit (id, time, action, entity, record_id, actor_user_id, actor_role, before, after, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let logBuffer: LogRecord[] = [];
  let metricBuffer: MetricPoint[] = [];
  let spanBuffer: SpanData[] = [];
  let auditBuffer: AuditEvent[] = [];

  /**
   * Drains all four buffers in one transaction. Never throws: a failed
   * transaction is rolled back and logged rather than re-thrown, so this
   * flush's signals are lost (there is no safe way to know what partially
   * applied), the same best-effort trade-off the other sinks make.
   */
  async function drainAll(): Promise<void> {
    const logs = logBuffer;
    const metrics = metricBuffer;
    const spans = spanBuffer;
    const audits = auditBuffer;
    logBuffer = [];
    metricBuffer = [];
    spanBuffer = [];
    auditBuffer = [];

    if (logs.length === 0 && metrics.length === 0 && spans.length === 0 && audits.length === 0) return;

    try {
      client.exec("BEGIN");
      try {
        for (const record of logs) {
          insertLog.run(
            crypto.randomUUID(),
            record.time,
            record.level,
            record.message,
            safeJson(record.fields),
            requestIdFromFields(record.fields),
          );
        }
        for (const point of metrics) {
          insertMetric.run(
            crypto.randomUUID(),
            point.time,
            point.name,
            point.value,
            point.kind,
            point.unit ?? null,
            safeJson(point.attributes),
          );
        }
        for (const span of spans) {
          insertSpan.run(
            crypto.randomUUID(),
            span.name,
            span.traceId,
            span.spanId,
            span.parentSpanId ?? null,
            span.startTime,
            span.endTime,
            span.status,
            safeJson(span.attributes),
          );
        }
        for (const event of audits) {
          insertAudit.run(
            crypto.randomUUID(),
            event.time,
            event.action,
            event.entity ?? null,
            event.recordId ?? null,
            event.actor?.userId ?? null,
            event.actor?.role ?? null,
            safeJson(event.before),
            safeJson(event.after),
            event.requestId ?? null,
          );
        }
        client.exec("COMMIT");
      } catch (error) {
        try {
          client.exec("ROLLBACK");
        } catch {
          // The transaction may already be gone (the error above could have
          // come from BEGIN itself), and there is nothing more to do either way.
        }
        throw error;
      }
    } catch (error) {
      console.error("[frogcp/sink/sqlite] flush failed, batch dropped", error);
    }
  }

  const log: LogSink = {
    writeLogs(records) {
      try {
        logBuffer.push(...records);
      } catch (error) {
        console.error("[frogcp/sink/sqlite] writeLogs failed", error);
      }
    },
    flush: drainAll,
  };

  const metric: MetricSink = {
    writeMetrics(points) {
      try {
        metricBuffer.push(...points);
      } catch (error) {
        console.error("[frogcp/sink/sqlite] writeMetrics failed", error);
      }
    },
    flush: drainAll,
  };

  const span: SpanSink = {
    writeSpans(spans) {
      try {
        spanBuffer.push(...spans);
      } catch (error) {
        console.error("[frogcp/sink/sqlite] writeSpans failed", error);
      }
    },
    flush: drainAll,
  };

  const audit: AuditSink = {
    writeAudit(events) {
      try {
        auditBuffer.push(...events);
      } catch (error) {
        console.error("[frogcp/sink/sqlite] writeAudit failed", error);
      }
    },
    flush: drainAll,
  };

  function readRecent(signal: ObservabilitySignal, limit = 50): Record<string, unknown>[] {
    const table = `${prefix}${TABLE_SUFFIX[signal]}`;
    const timeColumn = TIME_COLUMN[signal];
    const jsonColumns = JSON_COLUMNS[signal];
    const rows: Record<string, unknown>[] = client
      .prepare(`SELECT * FROM ${table} ORDER BY ${timeColumn} DESC, id DESC LIMIT ?`)
      .all(limit);

    return rows.map((row) => {
      const parsed: Record<string, unknown> = { ...row };
      for (const column of jsonColumns) {
        const raw = parsed[column];
        if (typeof raw === "string") {
          try {
            parsed[column] = JSON.parse(raw);
          } catch {
            // Leave the raw string in place rather than losing the value.
          }
        }
      }
      return parsed;
    });
  }

  return { log, metric, span, audit, db: client, readRecent };
}
