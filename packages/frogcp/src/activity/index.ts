import type { AuditEvent, AuditSink, DataEvent, DataEventPayload, FrogPlugin, KernelContext } from "frogcp";
import { buildAuditEntity, DEFAULT_AUDIT_ENTITY } from "./entities";

export const VERSION = "0.0.1";

export { DEFAULT_AUDIT_ENTITY, buildAuditEntity } from "./entities";

const DEFAULT_EVENTS: DataEvent[] = ["record.created", "record.updated", "record.deleted"];

export interface ActivityPluginOptions {
  /** The entity name audit rows are stored under. Defaults to `"audit_log"`. */
  entityName?: string;
  /** The role permitted to read/list audit rows. Defaults to `"admin"`. Note
   * that `role === "admin"` always bypasses every rule regardless of this
   * option, so it only matters when you want some other role name, in addition
   * to `"admin"`, to read the audit trail. */
  adminRole?: string;
  /** Which `DataEvent`s to bridge onto the audit sink. Defaults to all three. */
  events?: DataEvent[];
}

/** Maps each event-bus verb to the human-readable action recorded on the row.
 * The mapping is total and 1:1, so it loses no information. */
const ACTION_BY_EVENT: Record<DataEvent, string> = {
  "record.created": "create",
  "record.updated": "update",
  "record.deleted": "delete",
};

// Internal-only erasure for the direct-adapter write below (same rationale as
// core's `data/engine.ts`: the SQLite and Postgres table/column types are not
// mutually assignable, but the `insert(table).values(row)` chain is the same
// across both dialects). Never appears in an exported signature.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTable = any;

/**
 * JSON-serializes `value` for the `before`/`after` columns, or `null` when
 * `value` is `undefined` (an event that does not carry that side, e.g.
 * `record.created` has no `before`). `JSON.stringify` can throw on a cyclic
 * structure or a `BigInt`; guarded so a pathological payload never takes down
 * the sink (the never-throw contract `writeAudit` requires).
 */
function serializeSnapshot(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/**
 * Builds the DB-backed `AuditSink` this plugin registers. It writes each event
 * immediately, one row per event, and tracks in-flight writes so `flush()` can
 * await them.
 *
 * `emitAudit` fans out fire-and-forget (it returns `void` and never awaits a
 * sink), and on Cloudflare Workers the isolate suspends the moment the response
 * is sent, so an un-awaited async `db.insert` is abandoned and the row never
 * lands in D1. The kernel defers `observability.flushAll()` via
 * `c.executionCtx.waitUntil(...)` after every request; `flush()` here hooks
 * these writes into that seam, keeping the isolate alive until they persist.
 * node:sqlite runs the insert synchronously, which is why this only bit on D1.
 */
export function createAuditSink(ctx: KernelContext, entityName: string, table: AnyTable): AuditSink {
  const db: AnyDb = ctx.adapter.db;
  const pending = new Set<Promise<void>>();

  function persist(event: AuditEvent): Promise<void> {
    const p = (async () => {
      try {
        await db.insert(table).values({
          id: crypto.randomUUID(),
          action: event.action,
          entity: event.entity ?? null,
          recordId: event.recordId ?? null,
          actorUserId: event.actor?.userId ?? null,
          actorRole: event.actor?.role ?? null,
          before: serializeSnapshot(event.before),
          after: serializeSnapshot(event.after),
          requestId: event.requestId ?? null,
          // `createdAt` is `.auto()`, engine-stamped at insert time. This sink
          // bypasses `DataEngine.create` entirely, so it stamps it manually
          // here, the same way `DataEngine.create`'s auto-field loop does.
          createdAt: new Date(),
        });
      } catch (error) {
        // Defense in depth: `emitAudit` already guards every sink call, but
        // `writeAudit`'s contract is MUST NOT throw. This keeps that true even
        // when the sink is driven directly, and lets one bad event not stop the
        // rest.
        ctx.logger.error(`"${entityName}" audit sink failed to persist a row`, { error, action: event.action });
      }
    })();
    pending.add(p);
    void p.finally(() => pending.delete(p));
    return p;
  }

  return {
    // Dispatch each event's write and track it; the returned promise settles
    // when this batch's writes do (callers who await get durability inline).
    writeAudit(events: AuditEvent[]): Promise<void> {
      return Promise.all(events.map(persist)).then(() => undefined);
    },
    // The durability seam: await every write still in flight.
    async flush(): Promise<void> {
      await Promise.all([...pending]);
    },
  };
}

/**
 * Builds the activity `FrogPlugin`. It contributes the audit-log entity and, in
 * `onBoot`:
 *
 * 1. Registers a DB-backed `AuditSink` that persists every `AuditEvent` handed
 *    to `emitAudit` as a row on the audit entity, written directly through
 *    `ctx.adapter` and the compiled table in `ctx.tables`, not
 *    `ctx.engine.create`. So the write needs no `Ctx` (audit rows are
 *    system-authored) and does not re-emit `record.created`, which would
 *    recurse straight back into this same sink.
 *
 *    The sink writes immediately, one row per event, with no buffering. A
 *    buffering sink would save round trips, but an unflushed batch in memory
 *    when an isolate is recycled (Workers) or the process exits (Node) is audit
 *    data silently lost, exactly the signal this plugin exists to make durable.
 *    A high-volume deployment that wants batching can wrap this same table
 *    write in its own buffering `AuditSink` and register that instead.
 *
 * 2. Subscribes to the event bus for every event in `opts.events` (default: all
 *    three `DataEvent`s), mapping each `DataEventPayload` to an `AuditEvent`:
 *      - `action`: the event's verb via `ACTION_BY_EVENT`.
 *      - `entity`/`recordId`: `payload.entity` / `payload.row.id`.
 *      - `actor`: `{ userId, role }` from `payload.ctx`, or omitted for a
 *        guest-triggered write (`payload.ctx === null`).
 *      - `after` is `payload.row` for created/updated; `before` is
 *        `payload.row` for deleted (the only row a delete's payload carries),
 *        never both, since the event bus hands this plugin one side.
 *      - `requestId` is `payload.requestId` when the write came from an HTTP
 *        request, so the audit row ties back to the request that caused it, and
 *        is omitted for writes with no request in scope.
 *
 * Infinite-loop guard: every handler ignores an event whose `payload.entity`
 * equals this plugin's own audit entity name. The direct-adapter write above
 * already never fires `record.created`, so this guard is currently unreachable,
 * but it exists so a future change (or a second plugin writing to the same
 * entity name through `engine.create`) can never spiral into a write loop.
 */
export function activityPlugin(opts: ActivityPluginOptions = {}): FrogPlugin {
  const entityName = opts.entityName ?? DEFAULT_AUDIT_ENTITY;
  const adminRole = opts.adminRole ?? "admin";
  const trackedEvents = opts.events ?? DEFAULT_EVENTS;

  return {
    name: "activity",
    entities: buildAuditEntity(entityName, adminRole),
    onBoot(ctx) {
      const table = ctx.tables[entityName];
      if (!table) {
        throw new Error(`unreachable: activityPlugin always registers a "${entityName}" entity`);
      }

      ctx.observability.addAuditSink(createAuditSink(ctx, entityName, table));

      for (const eventName of trackedEvents) {
        ctx.events.on(eventName, (payload: DataEventPayload) => {
          // Loop guard: never audit a write to the audit entity itself.
          if (payload.entity === entityName) return;

          const recordId = typeof payload.row.id === "string" ? payload.row.id : undefined;
          const isDelete = eventName === "record.deleted";

          const auditEvent: AuditEvent = {
            action: ACTION_BY_EVENT[eventName],
            entity: payload.entity,
            ...(recordId !== undefined ? { recordId } : {}),
            ...(payload.ctx ? { actor: { userId: payload.ctx.userId, role: payload.ctx.role } } : {}),
            ...(payload.requestId !== undefined ? { requestId: payload.requestId } : {}),
            ...(isDelete ? { before: payload.row } : { after: payload.row }),
            time: new Date().toISOString(),
          };

          ctx.observability.emitAudit(auditEvent);
        });
      }
    },
  };
}
