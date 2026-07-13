import type { Row } from "./data/engine";
import { consoleLogger, type Logger } from "./observability/logger";
import type { Ctx } from "./permissions/engine";

/**
 * The three lifecycle events the `DataEngine` emits for every entity. Each
 * fires only after a successful DB operation: a no-op patch (an update whose
 * effective change set is empty) performs no DB write and so does not emit
 * `record.updated`.
 */
export type DataEvent = "record.created" | "record.updated" | "record.deleted";

/**
 * Payload delivered to every `DataEvent` handler. `row` is the
 * hidden-field-stripped post-operation row (for `record.deleted`, the
 * pre-delete row), identical to what the REST API would have returned for the
 * same operation. Plugins that need privileged (unstripped) data query
 * `KernelContext.tables` / `adapter.db` directly instead.
 */
export interface DataEventPayload {
  entity: string;
  row: Row;
  ctx: Ctx;
  /**
   * The request correlation id (the response's `X-Request-Id`) of the write
   * that triggered this event, when it originated from an HTTP request, so
   * event handlers (e.g. `@frogcp/activity` audit rows) can tie the change back
   * to the request. Absent for writes not driven by a request (e.g. a plugin
   * seeding data at boot, or a direct `engine.create` call with no requestId).
   */
  requestId?: string;
}

type Handler = (payload: DataEventPayload) => void | Promise<void>;

/**
 * A tiny synchronous-registration, async-emission pub/sub bus scoped to one
 * backend instance. `emit` awaits every subscribed handler sequentially (in
 * subscription order) so handlers can rely on running after any previously
 * registered handler for the same event has settled. A handler that throws (or
 * rejects) is caught and logged via the bus's `logger` (`error` level,
 * `{ event, error }` fields); it never fails the triggering DB operation or the
 * HTTP response built on top of it.
 */
export class EventBus {
  private readonly handlers: Record<DataEvent, Set<Handler>> = {
    "record.created": new Set(),
    "record.updated": new Set(),
    "record.deleted": new Set(),
  };

  /**
   * `logger` defaults to a plain `consoleLogger()` (still `console.error` under
   * the hood for a handler failure) so every existing direct `new EventBus()`
   * call site (tests, `test/conformance.ts`) keeps working unchanged;
   * `kernel.ts`'s `createBackend` threads the backend's own configured logger
   * through instead, so plugin event handlers registered via
   * `KernelContext.events` get request-appropriate log routing too.
   */
  constructor(private readonly logger: Logger = consoleLogger()) {}

  /** Subscribes `handler` to `event`; returns a function that unsubscribes it. */
  on(event: DataEvent, handler: Handler): () => void {
    const set = this.handlers[event];
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  /**
   * Runs every handler currently subscribed to `event`, sequentially, awaiting
   * each in turn. Never throws: a handler error is caught and logged via
   * `this.logger.error` and the remaining handlers still run.
   */
  async emit(event: DataEvent, payload: DataEventPayload): Promise<void> {
    for (const handler of this.handlers[event]) {
      try {
        await handler(payload);
      } catch (error) {
        this.logger.error(`"${event}" event handler threw`, { event, error });
      }
    }
  }
}
