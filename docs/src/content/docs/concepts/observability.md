---
title: Observability
description: The four signals, the sink contracts, the registry that fans out to them, the shipped sinks, and the flush seam.
sidebar:
  order: 5
---

frogCP emits four observability signals and owns none of the destinations.
Where signals go is a sink's job. The framework owns the signal shapes, the
sink contracts, and the registry that fans out to whatever sinks you register.

## The four signals

Three of them mirror OpenTelemetry's signal shapes. Audit is frogCP-specific,
since OTel has no first-class audit-log signal. All four are pure data with no
methods and no `node:` imports, so any sink on any runtime can serialize them
however it likes.

```ts
interface LogRecord {
  level: LogLevel;
  time: string;
  message: string;
  fields: Record<string, unknown>;
}

interface MetricPoint {
  name: string;
  value: number;
  kind: "counter" | "gauge" | "histogram";
  unit?: string;
  attributes?: Record<string, string | number | boolean>;
  time: string;
}

interface SpanData {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTime: string;
  endTime: string;
  status: "ok" | "error";
  attributes?: Record<string, string | number | boolean>;
}

interface AuditEvent {
  action: string;
  entity?: string;
  recordId?: string;
  actor?: { userId?: string; role?: string };
  before?: unknown;
  after?: unknown;
  requestId?: string;
  time: string;
}
```

`parentSpanId` is absent on a root span. `MetricPoint.kind` maps to the three
OTel instrument shapes: a monotonic `counter`, a point-in-time `gauge`, or a
`histogram` value a sink decides how to bucket.

## The sink contracts

One interface per signal, each with a single write method and an optional
`flush`:

```ts
interface LogSink {
  writeLogs(records: LogRecord[]): void | Promise<void>;
  flush?(): Promise<void>;
}

interface MetricSink {
  writeMetrics(points: MetricPoint[]): void | Promise<void>;
  flush?(): Promise<void>;
}

interface SpanSink {
  writeSpans(spans: SpanData[]): void | Promise<void>;
  flush?(): Promise<void>;
}

interface AuditSink {
  writeAudit(events: AuditEvent[]): void | Promise<void>;
  flush?(): Promise<void>;
}
```

Every write method must not throw, and neither must `flush`. Batching is the
sink's own concern: the registry calls the write method once per emitted
record, and a buffering sink accumulates internally and drains on `flush`.

The interfaces are independent, so a sink implementation is free to cover only
the signals it cares about. The shipped sink factories return one object per
signal, and you register whichever subset you want.

## The registry

`ObservabilityRegistry` is the fan-out hub. It lives on
`KernelContext.observability`.

```ts
class ObservabilityRegistry {
  addLogSink(sink: LogSink): void;
  addMetricSink(sink: MetricSink): void;
  addSpanSink(sink: SpanSink): void;
  addAuditSink(sink: AuditSink): void;

  emitLog(record: LogRecord): void;
  recordMetric(point: MetricPoint): void;
  emitSpan(span: SpanData): void;
  emitAudit(event: AuditEvent): void;

  flushAll(): Promise<void>;
}
```

Guarded fan-out is the key property: observability must never break a request.
Every sink call, write and flush alike, is wrapped in its own `try`/`catch`. A
throwing sink is logged once through a base console logger, deliberately not
the request or backend logger so a broken log sink cannot recursively break
logging, and is otherwise ignored. Every other sink registered for that signal
still runs.

Emitting a signal with no sinks registered for it is a silent no-op. That is
the zero-config default: console logging works out of the box, and metrics,
spans, and audit cost nothing until you wire a destination.

There are two ways to register a sink. `CreateBackendOptions.sinks` is the
no-plugin-needed convenience, wired at boot before anything can emit:

```ts
import { createBackend } from "frogcp";
import { sqliteObservabilitySink } from "frogcp/sink/sqlite";

const sink = sqliteObservabilitySink({ db: "obs.sqlite" });

const backend = await createBackend({
  config,
  adapter,
  sinks: { log: [sink.log], metric: [sink.metric], audit: [sink.audit] },
});
```

Or a plugin registers its own in `onBoot`, the same way it contributes entities
or routes:

```ts
onBoot(ctx) {
  ctx.observability.addMetricSink(sink.metric);
}
```

## The flush seam

`flushAll()` awaits every registered sink's `flush`, guarded and in parallel,
across all four signals. Sinks without a `flush` are skipped.

This exists because a buffering sink on a serverless runtime will otherwise
lose writes. The runtime tears the isolate down when the response is returned,
before an unawaited async write completes.

The kernel's own request-metric middleware drives the seam. After the whole
middleware onion unwinds, it records an `http.request` metric with the real
final status, then flushes. On Workers it defers the flush through
`c.executionCtx.waitUntil(...)` so it never delays the response; on runtimes
without an execution context it awaits inline. The feature detection is a
`try`/`catch`, because Hono's `c.executionCtx` is a getter that throws rather
than returning `undefined` when the runtime has no execution context.

If you write a buffering sink, implement `flush`. If you write a sink that
hands each record straight to the platform, do not: `analyticsEngineSink` and
`pipelinesSink` both omit it for exactly that reason.

## The sinks that ship

- **SQLite**, `frogcp/sink/sqlite`. `sqliteObservabilitySink({ db, tablePrefix? })`
  returns `{ log, metric, span, audit }` plus the underlying `DatabaseSync` and
  a `readRecent(signal, limit?)` helper. `db` is a path, `":memory:"`, or an
  already-open `DatabaseSync`. Each write buffers in memory and nothing touches
  SQLite until `flush`, which drains all four buffers inside a single
  `BEGIN`/`COMMIT`. It imports `node:sqlite` directly, so it is Node-only.
- **Cloudflare Analytics Engine**, `frogcp/adapter/cloudflare`.
  `analyticsEngineSink(dataset)` returns `{ log, metric, span, audit }` backed
  by an Analytics Engine dataset binding, one `writeDataPoint()` per record.
  This is the Workers counterpart to the SQLite sink: a write-only,
  high-cardinality store queried later through the SQL API. There is no client
  buffer, so no `flush`.
- **Cloudflare Pipelines**, `frogcp/adapter/cloudflare`.
  `pipelinesSink(pipeline)` returns the same four sinks, streaming records as
  JSON into a Pipelines binding. Where Analytics Engine flattens each signal
  into indexes, blobs, and doubles for cheap SQL queries, Pipelines keeps the
  full nested record, so it suits archival and downstream ETL. Pick Analytics
  Engine for querying and Pipelines for retention; you can register both.

## Tracing

`frogcp/otel` is a small runtime-agnostic tracer. There is no OTLP or HTTP
dependency in it: a finished span becomes a `SpanData` handed to
`observability.emitSpan`, and where it goes from there is a `SpanSink`'s job.
Tracing is therefore gated by sink registration. With no `SpanSink` registered,
`emitSpan` is a no-op and the tracer costs only id generation.

```ts
import { createTracer, trace } from "frogcp/otel";

const tracer = createTracer(ctx.observability);
const span = tracer.startSpan("import.batch", { attributes: { source: "csv" } });
span.setAttribute("rows", 240);
span.end({ status: "ok" });

// Or wrap a function: an ok span on success, an error span and a rethrow on failure.
const result = await trace(ctx.observability, "import.batch", async (span) => {
  span.setAttribute("rows", 240);
  return runImport();
});
```

Ids are W3C trace context shaped, a 16-byte trace id and an 8-byte span id in
lowercase hex, so an OTLP exporter can forward them verbatim.

## Logging

`consoleLogger` and `silentLogger` ship from `frogcp`. The backend's default
logger tees every record it emits to `observability.emitLog`, including through
every per-request child logger, so registering a `LogSink` captures the
backend's own logging with no extra wiring. A logger you supply through
`CreateBackendOptions.logger` is used as-is; it is an opaque `Logger`, so there
is no generic way to retrofit the tee onto it.

The kernel's first middleware generates a fresh request id with
`crypto.randomUUID()` and puts a child logger carrying it on the context. An
incoming `X-Request-Id` header is never trusted as the correlation id; if
present and well-formed it is recorded as a separate `clientRequestId` field on
the request logger only.
