import { describe, expect, it } from "vitest";
import { pipelinesSink, type PipelineBinding } from "../../../src/adapter/cloudflare/pipelines";
import type { AuditEvent, MetricPoint } from "../../../src/observability/types";

// A stand-in for a Cloudflare Pipelines binding: captures each send batch so
// the sink's mapping can be asserted (a pipeline is write-only).
function fakePipeline(): { pipeline: PipelineBinding; batches: Record<string, unknown>[][] } {
  const batches: Record<string, unknown>[][] = [];
  const pipeline: PipelineBinding = {
    async send(records) {
      batches.push(records);
    },
  };
  return { pipeline, batches };
}

describe("pipelinesSink", () => {
  it("sends one batch per write call, one JSON record per signal, tagged with `signal`", async () => {
    const { pipeline, batches } = fakePipeline();
    const sink = pipelinesSink(pipeline);

    const metrics: MetricPoint[] = [
      { name: "a", value: 1, kind: "counter", time: "2026-07-12T00:00:00.000Z" },
      { name: "b", value: 2, kind: "gauge", time: "2026-07-12T00:00:00.000Z" },
    ];
    await sink.metric.writeMetrics(metrics);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    expect(batches[0]![0]).toMatchObject({ signal: "metric", name: "a", value: 1, kind: "counter" });
  });

  it("preserves the audit event's nested shape (before/after/actor) as JSON, unlike AE's flat blobs", async () => {
    const { pipeline, batches } = fakePipeline();
    const sink = pipelinesSink(pipeline);

    const event: AuditEvent = {
      action: "update",
      entity: "notes",
      recordId: "n-1",
      actor: { userId: "u-1", role: "member" },
      requestId: "req-9",
      before: { title: "old" },
      after: { title: "new" },
      time: "2026-07-12T00:00:00.000Z",
    };
    await sink.audit.writeAudit([event]);

    expect(batches[0]![0]).toMatchObject({
      signal: "audit",
      action: "update",
      actor: { userId: "u-1", role: "member" },
      before: { title: "old" },
      after: { title: "new" },
      requestId: "req-9",
    });
  });

  it("does not call send for an empty batch", async () => {
    const { pipeline, batches } = fakePipeline();
    const sink = pipelinesSink(pipeline);
    await sink.metric.writeMetrics([]);
    expect(batches).toHaveLength(0);
  });

  it("never throws even if the pipeline's send rejects", async () => {
    const pipeline: PipelineBinding = {
      async send() {
        throw new Error("pipeline unavailable");
      },
    };
    const sink = pipelinesSink(pipeline);
    await expect(
      sink.metric.writeMetrics([{ name: "x", value: 1, kind: "counter", time: "2026-07-12T00:00:00.000Z" }]),
    ).resolves.toBeUndefined();
  });
});
