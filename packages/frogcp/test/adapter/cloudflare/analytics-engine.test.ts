/// <reference types="@cloudflare/workers-types" />
import { describe, expect, it } from "vitest";
import { analyticsEngineSink } from "../../../src/adapter/cloudflare/analytics-engine";
import type { AuditEvent, LogRecord, MetricPoint, SpanData } from "../../../src/observability/types";

// A stand-in for the AnalyticsEngineDataset binding. Analytics Engine is
// write-only and unqueryable locally, so a sink is tested by capturing the
// writeDataPoint payloads it emits.
function fakeDataset(): { dataset: AnalyticsEngineDataset; points: AnalyticsEngineDataPoint[] } {
  const points: AnalyticsEngineDataPoint[] = [];
  const dataset = {
    writeDataPoint(point?: AnalyticsEngineDataPoint) {
      if (point) points.push(point);
    },
  } as AnalyticsEngineDataset;
  return { dataset, points };
}

describe("analyticsEngineSink", () => {
  it("maps a metric point to one data point: name as the index, [value] doubles, blobs carry kind/unit/attrs", () => {
    const { dataset, points } = fakeDataset();
    const sink = analyticsEngineSink(dataset);

    const metric: MetricPoint = {
      name: "http.request.duration",
      value: 12.5,
      kind: "histogram",
      unit: "ms",
      attributes: { route: "/api/entity/notes", status: 200 },
      time: "2026-07-12T00:00:00.000Z",
    };
    sink.metric.writeMetrics([metric]);

    expect(points).toHaveLength(1);
    const p = points[0]!;
    expect(p.indexes).toEqual(["http.request.duration"]);
    expect(p.doubles).toEqual([12.5]);
    // blobs: [name, kind, unit, JSON(attributes)]
    expect(p.blobs?.[0]).toBe("http.request.duration");
    expect(p.blobs?.[1]).toBe("histogram");
    expect(p.blobs?.[2]).toBe("ms");
    expect(JSON.parse(p.blobs?.[3] as string)).toEqual({ route: "/api/entity/notes", status: 200 });
  });

  it("maps an audit event to one data point: action as the index, identity/requestId in blobs", () => {
    const { dataset, points } = fakeDataset();
    const sink = analyticsEngineSink(dataset);

    const event: AuditEvent = {
      action: "create",
      entity: "notes",
      recordId: "n-1",
      actor: { userId: "u-1", role: "member" },
      requestId: "req-abc",
      after: { title: "hi" },
      time: "2026-07-12T00:00:00.000Z",
    };
    sink.audit.writeAudit([event]);

    expect(points).toHaveLength(1);
    const p = points[0]!;
    expect(p.indexes).toEqual(["create"]);
    // blobs carry the audit fields so they're queryable via the AE SQL API
    expect(p.blobs).toContain("notes");
    expect(p.blobs).toContain("n-1");
    expect(p.blobs).toContain("u-1");
    expect(p.blobs).toContain("member");
    expect(p.blobs).toContain("req-abc");
  });

  it("writes one data point per record in a batch (log + span sinks included)", () => {
    const { dataset, points } = fakeDataset();
    const sink = analyticsEngineSink(dataset);

    const log: LogRecord = { level: "info", time: "2026-07-12T00:00:00.000Z", message: "hi", fields: { a: 1 } };
    const span: SpanData = {
      name: "db.query",
      traceId: "t1",
      spanId: "s1",
      startTime: "2026-07-12T00:00:00.000Z",
      endTime: "2026-07-12T00:00:00.010Z",
      status: "ok",
    };
    sink.log.writeLogs([log, log]);
    sink.span.writeSpans([span]);
    expect(points).toHaveLength(3);
  });

  it("never throws even if the binding's writeDataPoint throws", () => {
    const dataset = {
      writeDataPoint() {
        throw new Error("AE unavailable");
      },
    } as unknown as AnalyticsEngineDataset;
    const sink = analyticsEngineSink(dataset);
    // The sink contract is a hard must-not-throw.
    expect(() =>
      sink.metric.writeMetrics([{ name: "x", value: 1, kind: "counter", time: "2026-07-12T00:00:00.000Z" }]),
    ).not.toThrow();
  });
});
