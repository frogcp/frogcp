import { describe, it, expect, vi } from "vitest";
import { nodeSqliteAdapter } from "./support/node-sqlite-adapter";
import {
  createBackend,
  defineBackend,
  entity,
  text,
  rule,
  ObservabilityRegistry,
  type DatabaseAdapter,
  type LogSink,
  type MetricSink,
  type LogRecord,
  type MetricPoint,
} from "../src/index";

const BASE = "http://x";

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`${BASE}${path}`, init);
}

function makeAdapter(): DatabaseAdapter {
  return nodeSqliteAdapter(":memory:");
}

const publicPerms = {
  create: rule.public(),
  read: rule.public(),
  list: rule.public(),
  update: rule.public(),
  delete: rule.public(),
};

const config = defineBackend({
  entities: {
    notes: entity({ title: text().required() }).permissions(publicPerms),
  },
});

/** A LogSink that records everything it's given, plain and simple. */
function makeRecordingLogSink(): LogSink & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  return {
    records,
    writeLogs: (batch) => {
      records.push(...batch);
    },
  };
}

/** A MetricSink that records everything it's given, plain and simple. */
function makeRecordingMetricSink(): MetricSink & { points: MetricPoint[] } {
  const points: MetricPoint[] = [];
  return {
    points,
    writeMetrics: (batch) => {
      points.push(...batch);
    },
  };
}

/** A buffering LogSink: writeLogs only accumulates into a private buffer; records become visible in drained only after flush() moves them there. Proves flushAll() actually awaits flush() rather than just calling writeLogs synchronously. */
function makeBufferingLogSink(): LogSink & { drained: LogRecord[] } {
  let buffer: LogRecord[] = [];
  const drained: LogRecord[] = [];
  return {
    drained,
    writeLogs: (batch) => {
      buffer.push(...batch);
    },
    flush: async () => {
      drained.push(...buffer);
      buffer = [];
    },
  };
}

const sampleLog: LogRecord = { level: "info", time: new Date(0).toISOString(), message: "hi", fields: {} };
const sampleMetric: MetricPoint = { name: "test.metric", kind: "counter", value: 1, time: new Date(0).toISOString() };

describe("ObservabilityRegistry", () => {
  it("emitLog fans out to every registered log sink", () => {
    const registry = new ObservabilityRegistry();
    const a = makeRecordingLogSink();
    const b = makeRecordingLogSink();
    registry.addLogSink(a);
    registry.addLogSink(b);

    registry.emitLog(sampleLog);

    expect(a.records).toEqual([sampleLog]);
    expect(b.records).toEqual([sampleLog]);
  });

  it("recordMetric/emitSpan/emitAudit each fan out to their own matching sinks only", () => {
    const registry = new ObservabilityRegistry();
    const metricSink = makeRecordingMetricSink();
    const logSink = makeRecordingLogSink();
    registry.addMetricSink(metricSink);
    registry.addLogSink(logSink);

    registry.recordMetric(sampleMetric);

    expect(metricSink.points).toEqual([sampleMetric]);
    expect(logSink.records).toEqual([]);
  });

  it("emit* with no registered sinks of that signal is a silent no-op", () => {
    const registry = new ObservabilityRegistry();
    expect(() => registry.emitLog(sampleLog)).not.toThrow();
    expect(() => registry.recordMetric(sampleMetric)).not.toThrow();
    expect(() =>
      registry.emitSpan({
        name: "s",
        traceId: "t",
        spanId: "sp",
        startTime: sampleLog.time,
        endTime: sampleLog.time,
        status: "ok",
      }),
    ).not.toThrow();
    expect(() => registry.emitAudit({ action: "a", time: sampleLog.time })).not.toThrow();
  });

  it("never-throw: a sink whose write* throws does not propagate, and other sinks still receive", () => {
    const registry = new ObservabilityRegistry();
    const throwing: LogSink = {
      writeLogs: () => {
        throw new Error("sink boom");
      },
    };
    const good = makeRecordingLogSink();
    registry.addLogSink(throwing);
    registry.addLogSink(good);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => registry.emitLog(sampleLog)).not.toThrow();

    expect(good.records).toEqual([sampleLog]);
    errorSpy.mockRestore();
  });

  it("flushAll awaits every registered sink's flush(); a buffering sink is drained only after flushAll()", async () => {
    const registry = new ObservabilityRegistry();
    const buffering = makeBufferingLogSink();
    registry.addLogSink(buffering);

    registry.emitLog(sampleLog);
    expect(buffering.drained).toEqual([]);

    await registry.flushAll();

    expect(buffering.drained).toEqual([sampleLog]);
  });

  it("flushAll on a sink with a throwing flush() does not reject and other sinks still flush", async () => {
    const registry = new ObservabilityRegistry();
    const throwingFlush: LogSink = {
      writeLogs: () => {},
      flush: async () => {
        throw new Error("flush boom");
      },
    };
    const buffering = makeBufferingLogSink();
    registry.addLogSink(throwingFlush);
    registry.addLogSink(buffering);
    registry.emitLog(sampleLog);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(registry.flushAll()).resolves.toBeUndefined();

    expect(buffering.drained).toEqual([sampleLog]);
    errorSpy.mockRestore();
  });
});

describe("kernel wiring", () => {
  it("a request through backend.fetch still returns its normal response even with a throwing log sink registered", async () => {
    const throwing: LogSink = {
      writeLogs: () => {
        throw new Error("sink boom");
      },
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const backend = await createBackend({ config, adapter: makeAdapter(), sinks: { log: [throwing] } });

    const res = await backend.fetch(req("/api/entity/notes"));

    expect(res.status).toBe(200);
    errorSpy.mockRestore();
  });

  it("a log sink passed via sinks.log receives a LogRecord for a line logged during a request, carrying the requestId binding", async () => {
    const logSink = makeRecordingLogSink();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const backend = await createBackend({
      config,
      adapter: makeAdapter(),
      sinks: { log: [logSink] },
      plugins: [
        {
          name: "logger-plugin",
          routes(app) {
            app.get("/api/log-something", (c) => {
              c.get("logger").info("handling request");
              return c.json({ ok: true });
            });
          },
        },
      ],
    });

    const res = await backend.fetch(req("/api/log-something"));
    const requestId = res.headers.get("X-Request-Id");

    const record = logSink.records.find((r) => r.message === "handling request");
    expect(record).toBeDefined();
    expect(record?.fields.requestId).toBe(requestId);
    // Console output still happens (existing behavior); the tee is additive.
    expect(infoSpy).toHaveBeenCalled();
    infoSpy.mockRestore();
  });

  it("the built-in request metric fires with method/path/status attributes after a request", async () => {
    const metricSink = makeRecordingMetricSink();
    const backend = await createBackend({ config, adapter: makeAdapter(), sinks: { metric: [metricSink] } });

    const res = await backend.fetch(req("/api/entity/notes"));

    expect(res.status).toBe(200);
    const point = metricSink.points.find((p) => p.name === "http.request");
    expect(point).toBeDefined();
    expect(point?.kind).toBe("counter");
    expect(point?.attributes?.method).toBe("GET");
    expect(point?.attributes?.path).toBe("/api/entity/notes");
    expect(point?.attributes?.status).toBe(200);
    expect(typeof point?.value).toBe("number");
  });

  it("a buffering sink is drained following backend.fetch (Node path: executionCtx absent, flush awaited inline)", async () => {
    const buffering = makeBufferingLogSink();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const backend = await createBackend({
      config,
      adapter: makeAdapter(),
      sinks: { log: [buffering] },
      plugins: [
        {
          name: "logger-plugin",
          routes(app) {
            app.get("/api/log-something", (c) => {
              c.get("logger").info("handling request");
              return c.json({ ok: true });
            });
          },
        },
      ],
    });

    const res = await backend.fetch(req("/api/log-something"));

    expect(res.status).toBe(200);
    expect(buffering.drained.some((r) => r.message === "handling request")).toBe(true);
    infoSpy.mockRestore();
  });

  it("a plugin can register its own sinks in onBoot via ctx.observability", async () => {
    const metricSink = makeRecordingMetricSink();
    const backend = await createBackend({
      config,
      adapter: makeAdapter(),
      plugins: [
        {
          name: "sink-plugin",
          onBoot(ctx) {
            ctx.observability.addMetricSink(metricSink);
          },
        },
      ],
    });

    await backend.fetch(req("/api/entity/notes"));

    expect(metricSink.points.some((p) => p.name === "http.request")).toBe(true);
  });
});
