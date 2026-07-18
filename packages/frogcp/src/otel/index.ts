/**
 * A small, runtime-agnostic tracer that produces spans into frogCP's
 * observability registry. There is no OTLP or HTTP dependency here: a finished
 * span becomes a SpanData handed to observability.emitSpan, and where those
 * spans go is a SpanSink's job (analyticsEngineSink, frogcp/sink/sqlite, or an
 * OTLP exporter). So tracing is gated by sink registration: with no SpanSink
 * registered, emitSpan is a no-op and the tracer costs only id generation.
 *
 * Ids are W3C trace context shaped (16-byte trace id, 8-byte span id, lowercase
 * hex) so an OTLP exporter can forward them verbatim.
 */

import type { SpanData } from "../observability/types";

/** The one method a tracer needs from KernelContext.observability. */
export interface SpanEmitter {
  emitSpan(span: SpanData): void;
}

/** An in-flight span. Mutate attributes, then end() to emit it. */
export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  setAttribute(key: string, value: string | number | boolean): void;
  end(opts?: { status?: "ok" | "error"; attributes?: Record<string, string | number | boolean> }): void;
}

export interface StartSpanOptions {
  /** Parent span. The child inherits its traceId and records it as parentSpanId. */
  parent?: Span;
  /** Initial attributes. More can be added via setAttribute. */
  attributes?: Record<string, string | number | boolean>;
}

export interface Tracer {
  startSpan(name: string, opts?: StartSpanOptions): Span;
}

/** Lowercase-hex id of `bytes` random bytes (8 for a span id, 16 for a trace id). */
function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Builds a Tracer that emits finished spans to observability.emitSpan. Pass
 * KernelContext.observability, or anything with an emitSpan.
 */
export function createTracer(observability: SpanEmitter): Tracer {
  return {
    startSpan(name: string, opts: StartSpanOptions = {}): Span {
      const traceId = opts.parent?.traceId ?? randomHex(16);
      const spanId = randomHex(8);
      const parentSpanId = opts.parent?.spanId;
      const startTime = new Date().toISOString();
      const attributes: Record<string, string | number | boolean> = { ...opts.attributes };
      let ended = false;

      return {
        traceId,
        spanId,
        setAttribute(key, value) {
          attributes[key] = value;
        },
        end(endOpts = {}) {
          if (ended) return; // ending twice must not emit twice
          ended = true;
          Object.assign(attributes, endOpts.attributes ?? {});
          const span: SpanData = {
            name,
            traceId,
            spanId,
            ...(parentSpanId !== undefined ? { parentSpanId } : {}),
            startTime,
            endTime: new Date().toISOString(),
            status: endOpts.status ?? "ok",
            ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
          };
          observability.emitSpan(span);
        },
      };
    },
  };
}

/**
 * Runs `fn` inside a span: emits an ok span and returns the result on success,
 * emits an error span and re-throws on failure. `parent` nests it under an
 * in-flight span.
 */
export async function trace<T>(
  observability: SpanEmitter,
  name: string,
  fn: (span: Span) => Promise<T> | T,
  parent?: Span,
): Promise<T> {
  const span = createTracer(observability).startSpan(name, parent ? { parent } : {});
  try {
    const result = await fn(span);
    span.end({ status: "ok" });
    return result;
  } catch (error) {
    span.end({ status: "error" });
    throw error;
  }
}
