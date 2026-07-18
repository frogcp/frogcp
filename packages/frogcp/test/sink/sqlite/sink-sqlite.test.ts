import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { AuditEvent, LogRecord, MetricPoint, SpanData } from "frogcp";
import { sqliteObservabilitySink } from "../../../src/sink/sqlite/index";

function nowIso(): string {
  return new Date().toISOString();
}

describe("sqliteObservabilitySink: logs", () => {
  it("emits + flushes a couple of log records and lands them with the right columns", async () => {
    const sink = sqliteObservabilitySink({ db: ":memory:" });

    const a: LogRecord = { level: "info", time: nowIso(), message: "hello", fields: { requestId: "req-1" } };
    const b: LogRecord = { level: "error", time: nowIso(), message: "boom", fields: { foo: "bar" } };
    sink.log.writeLogs([a, b]);
    await sink.log.flush?.();

    const rows = sink.readRecent("log", 10);
    expect(rows).toHaveLength(2);
    const infoRow = rows.find((r) => r.message === "hello");
    expect(infoRow).toBeDefined();
    expect(infoRow!.level).toBe("info");
    expect(infoRow!.request_id).toBe("req-1");
    expect(infoRow!.fields).toEqual({ requestId: "req-1" });

    const errorRow = rows.find((r) => r.message === "boom");
    expect(errorRow!.level).toBe("error");
    expect(errorRow!.request_id).toBeNull();
    expect(errorRow!.fields).toEqual({ foo: "bar" });
  });
});

describe("sqliteObservabilitySink: metrics", () => {
  it("emits + flushes metric points and lands them with the right columns", async () => {
    const sink = sqliteObservabilitySink({ db: ":memory:" });

    const point: MetricPoint = {
      name: "http.request",
      value: 12.5,
      kind: "counter",
      unit: "ms",
      attributes: { method: "GET", path: "/x", status: 200 },
      time: nowIso(),
    };
    sink.metric.writeMetrics([point]);
    await sink.metric.flush?.();

    const rows = sink.readRecent("metric", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("http.request");
    expect(rows[0]!.value).toBe(12.5);
    expect(rows[0]!.kind).toBe("counter");
    expect(rows[0]!.unit).toBe("ms");
    expect(rows[0]!.attributes).toEqual({ method: "GET", path: "/x", status: 200 });
  });
});

describe("sqliteObservabilitySink: spans", () => {
  it("emits + flushes a span and lands it with the right columns", async () => {
    const sink = sqliteObservabilitySink({ db: ":memory:" });

    const span: SpanData = {
      name: "handle-request",
      traceId: "trace-1",
      spanId: "span-1",
      startTime: nowIso(),
      endTime: nowIso(),
      status: "ok",
      attributes: { route: "/x" },
    };
    sink.span.writeSpans([span]);
    await sink.span.flush?.();

    const rows = sink.readRecent("span", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.trace_id).toBe("trace-1");
    expect(rows[0]!.span_id).toBe("span-1");
    expect(rows[0]!.status).toBe("ok");
    expect(rows[0]!.parent_span_id).toBeNull();
  });
});

describe("sqliteObservabilitySink: audit", () => {
  it("emits + flushes an audit event and lands it with the right columns", async () => {
    const sink = sqliteObservabilitySink({ db: ":memory:" });

    const event: AuditEvent = {
      action: "create",
      entity: "notes",
      recordId: "note-1",
      actor: { userId: "user-1", role: "member" },
      after: { title: "hi" },
      time: nowIso(),
    };
    sink.audit.writeAudit([event]);
    await sink.audit.flush?.();

    const rows = sink.readRecent("audit", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("create");
    expect(rows[0]!.entity).toBe("notes");
    expect(rows[0]!.actor_user_id).toBe("user-1");
    expect(rows[0]!.actor_role).toBe("member");
    expect(rows[0]!.before).toBeNull();
    expect(rows[0]!.after).toEqual({ title: "hi" });
  });
});

describe("sqliteObservabilitySink: flush drains the buffer", () => {
  it("a second flush with no new records is a no-op (no duplicate rows)", async () => {
    const sink = sqliteObservabilitySink({ db: ":memory:" });
    sink.log.writeLogs([{ level: "info", time: nowIso(), message: "once", fields: {} }]);
    await sink.log.flush?.();
    await sink.log.flush?.();

    const rows = sink.readRecent("log", 10);
    expect(rows).toHaveLength(1);
  });
});

describe("sqliteObservabilitySink: reuses an already-open DatabaseSync", () => {
  it("writes land on the exact connection passed in", async () => {
    const db = new DatabaseSync(":memory:");
    const sink = sqliteObservabilitySink({ db });
    expect(sink.db).toBe(db);

    sink.log.writeLogs([{ level: "info", time: nowIso(), message: "shared-conn", fields: {} }]);
    await sink.log.flush?.();

    const row = db.prepare("SELECT message FROM obs_logs").get() as { message: string } | undefined;
    expect(row?.message).toBe("shared-conn");
  });
});

describe("sqliteObservabilitySink: never-throw guarantee", () => {
  it("a record whose attributes contain a BigInt doesn't throw; the row still lands with null for that column", async () => {
    const sink = sqliteObservabilitySink({ db: ":memory:" });

    const point: MetricPoint = {
      name: "weird",
      value: 1,
      kind: "gauge",
      // A BigInt inside `attributes` makes JSON.stringify throw. The attributes
      // column must fall back to null without losing the row or throwing out of
      // write/flush.
      attributes: { big: 1n as unknown as number },
      time: nowIso(),
    };

    expect(() => sink.metric.writeMetrics([point])).not.toThrow();
    await expect(sink.metric.flush?.()).resolves.not.toThrow();

    const rows = sink.readRecent("metric", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("weird");
    expect(rows[0]!.attributes).toBeNull();
  });
});

describe("sqliteObservabilitySink: tablePrefix override", () => {
  it("lands rows under a custom prefix's tables", async () => {
    const db = new DatabaseSync(":memory:");
    const sink = sqliteObservabilitySink({ db, tablePrefix: "custom_" });

    sink.log.writeLogs([{ level: "info", time: nowIso(), message: "prefixed", fields: {} }]);
    await sink.log.flush?.();

    const row = db.prepare("SELECT message FROM custom_logs").get() as { message: string } | undefined;
    expect(row?.message).toBe("prefixed");

    // Default-prefixed table was never created.
    expect(() => db.prepare("SELECT * FROM obs_logs")).toThrow();
  });
});
