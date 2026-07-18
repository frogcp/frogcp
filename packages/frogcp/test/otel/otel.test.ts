import { describe, expect, it } from "vitest";
import { createTracer, trace } from "../../src/otel/index";
import type { SpanData } from "../../src/observability/types";

/** Captures spans a tracer emits, standing in for ctx.observability. */
function fakeSink(): { observability: { emitSpan(s: SpanData): void }; spans: SpanData[] } {
  const spans: SpanData[] = [];
  return { observability: { emitSpan: (s) => spans.push(s) }, spans };
}

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;

describe("createTracer", () => {
  it("startSpan().end() emits one OK span with W3C-shaped ids and monotonic times", () => {
    const { observability, spans } = fakeSink();
    const tracer = createTracer(observability);

    const span = tracer.startSpan("db.query");
    span.end();

    expect(spans).toHaveLength(1);
    const s = spans[0]!;
    expect(s.name).toBe("db.query");
    expect(s.traceId).toMatch(HEX32); // 16-byte trace id
    expect(s.spanId).toMatch(HEX16); // 8-byte span id
    expect(s.parentSpanId).toBeUndefined(); // root span
    expect(s.status).toBe("ok");
    expect(Date.parse(s.endTime)).toBeGreaterThanOrEqual(Date.parse(s.startTime));
  });

  it("a child span shares the parent's traceId and records parentSpanId", () => {
    const { observability, spans } = fakeSink();
    const tracer = createTracer(observability);

    const parent = tracer.startSpan("request");
    const child = tracer.startSpan("db.query", { parent });
    child.end();
    parent.end();

    const [childSpan, parentSpan] = spans;
    expect(childSpan!.traceId).toBe(parentSpan!.traceId);
    expect(childSpan!.parentSpanId).toBe(parentSpan!.spanId);
    expect(parentSpan!.parentSpanId).toBeUndefined();
  });

  it("setAttribute + end({status}) surface on the emitted span", () => {
    const { observability, spans } = fakeSink();
    const tracer = createTracer(observability);

    const span = tracer.startSpan("op");
    span.setAttribute("db.system", "sqlite");
    span.setAttribute("rows", 3);
    span.end({ status: "error" });

    expect(spans[0]!.status).toBe("error");
    expect(spans[0]!.attributes).toEqual({ "db.system": "sqlite", rows: 3 });
  });

  it("distinct spans get distinct ids", () => {
    const { observability, spans } = fakeSink();
    const tracer = createTracer(observability);
    tracer.startSpan("a").end();
    tracer.startSpan("b").end();
    expect(spans[0]!.spanId).not.toBe(spans[1]!.spanId);
    expect(spans[0]!.traceId).not.toBe(spans[1]!.traceId);
  });
});

describe("trace() helper", () => {
  it("wraps a fn in a span, emits OK on success and returns the value", async () => {
    const { observability, spans } = fakeSink();
    const result = await trace(observability, "work", async () => 42);
    expect(result).toBe(42);
    expect(spans[0]!.status).toBe("ok");
  });

  it("emits an error span and re-throws when the fn throws", async () => {
    const { observability, spans } = fakeSink();
    await expect(trace(observability, "boom", async () => {
      throw new Error("nope");
    })).rejects.toThrow("nope");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status).toBe("error");
  });
});
