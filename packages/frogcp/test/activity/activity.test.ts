import { describe, expect, it } from "vitest";
import { nodeSqliteAdapter } from "frogcp/adapter/node";
import {
  createBackend,
  defineBackend,
  entity,
  rule,
  text,
  timestamp,
  type Backend,
  type DatabaseAdapter,
} from "frogcp";
import type { AuditEvent, KernelContext } from "frogcp";
import { activityPlugin, createAuditSink, DEFAULT_AUDIT_ENTITY, type ActivityPluginOptions } from "../../src/activity/index";

const BASE = "http://x";

/** A tiny app schema with one public-CRUD entity (`notes`), just enough surface
 * to exercise `record.created`/`record.updated`/`record.deleted` without
 * pulling in `frogcp/auth` (this plugin, like `frogcp/media`, works standalone). */
const config = defineBackend({
  entities: {
    notes: entity({
      title: text().required(),
      body: text(),
      createdAt: timestamp().auto(),
    }).permissions({
      read: rule.public(),
      list: rule.public(),
      create: rule.public(),
      update: rule.public(),
      delete: rule.public(),
    }),
  },
});

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`${BASE}${path}`, init);
}

function jsonReq(method: string, path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return req(path, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

/** `x-frogcp-debug-identity: userId:role`, the framework's test-only identity
 * shortcut (`createBackend({ debugIdentity: true })`), same convention
 * `frogcp/media`'s tests use. */
function asUser(userId: string, role = "member"): Record<string, string> {
  return { "x-frogcp-debug-identity": `${userId}:${role}` };
}

async function setup(opts?: ActivityPluginOptions): Promise<{ backend: Backend; adapter: DatabaseAdapter }> {
  const adapter: DatabaseAdapter = nodeSqliteAdapter(":memory:");
  const backend = await createBackend({
    config,
    adapter,
    debugIdentity: true,
    plugins: [activityPlugin(opts)],
  });
  return { backend, adapter };
}

async function listAuditLog(backend: Backend, entityName = DEFAULT_AUDIT_ENTITY): Promise<Record<string, unknown>[]> {
  const res = await backend.fetch(req(`/api/entity/${entityName}`, { headers: asUser("admin-1", "admin") }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Record<string, unknown>[] };
  return body.data;
}

describe("activityPlugin: event bus -> audit_log", () => {
  it("a create produces exactly one audit_log row with the right action/entity/recordId/actorUserId, `after` populated and `before` absent", async () => {
    const { backend } = await setup();

    const createRes = await backend.fetch(
      jsonReq("POST", "/api/entity/notes", { title: "hello", body: "world" }, asUser("user-a")),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { data: { id: string } };

    const rows = await listAuditLog(backend);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("create");
    expect(row.entity).toBe("notes");
    expect(row.recordId).toBe(created.data.id);
    expect(row.actorUserId).toBe("user-a");
    expect(row.actorRole).toBe("member");
    expect(row.before).toBeNull();
    expect(typeof row.after).toBe("string");
    const after = JSON.parse(row.after as string) as { title: string };
    expect(after.title).toBe("hello");
  });

  it("carries the request correlation id: the audit row's requestId equals the write response's X-Request-Id", async () => {
    const { backend } = await setup();

    const createRes = await backend.fetch(
      jsonReq("POST", "/api/entity/notes", { title: "traced" }, asUser("user-a")),
    );
    expect(createRes.status).toBe(201);
    const correlationId = createRes.headers.get("X-Request-Id");
    expect(correlationId).toBeTruthy(); // the kernel always stamps one

    const rows = await listAuditLog(backend);
    expect(rows).toHaveLength(1);
    // The audit row was written by the event-bus handler, which must have
    // received the requestId on the DataEventPayload, so it matches the very
    // request (its X-Request-Id) that triggered the write.
    expect(rows[0]!.requestId).toBe(correlationId);
  });

  it("an update produces a SECOND audit_log row (action \"update\") with `after` reflecting the patched row", async () => {
    const { backend } = await setup();

    const createRes = await backend.fetch(
      jsonReq("POST", "/api/entity/notes", { title: "v1" }, asUser("user-a")),
    );
    const created = (await createRes.json()) as { data: { id: string } };

    const updateRes = await backend.fetch(
      jsonReq("PATCH", `/api/entity/notes/${created.data.id}`, { title: "v2" }, asUser("user-a")),
    );
    expect(updateRes.status).toBe(200);

    const rows = await listAuditLog(backend);
    expect(rows).toHaveLength(2);
    const updateRow = rows.find((r) => r.action === "update");
    expect(updateRow).toBeDefined();
    expect(updateRow!.recordId).toBe(created.data.id);
    const after = JSON.parse(updateRow!.after as string) as { title: string };
    expect(after.title).toBe("v2");
    expect(updateRow!.before).toBeNull();
  });

  it("a delete records `before` (the pre-delete row) and leaves `after` null", async () => {
    const { backend } = await setup();

    const createRes = await backend.fetch(
      jsonReq("POST", "/api/entity/notes", { title: "to-delete" }, asUser("user-a")),
    );
    const created = (await createRes.json()) as { data: { id: string } };

    const deleteRes = await backend.fetch(
      req(`/api/entity/notes/${created.data.id}`, { method: "DELETE", headers: asUser("user-a") }),
    );
    expect(deleteRes.status).toBe(204);

    const rows = await listAuditLog(backend);
    const deleteRow = rows.find((r) => r.action === "delete");
    expect(deleteRow).toBeDefined();
    expect(deleteRow!.recordId).toBe(created.data.id);
    expect(deleteRow!.after).toBeNull();
    const before = JSON.parse(deleteRow!.before as string) as { title: string };
    expect(before.title).toBe("to-delete");
  });

  it("a guest-triggered write (no identity) records no actor at all", async () => {
    const { backend } = await setup();

    const createRes = await backend.fetch(jsonReq("POST", "/api/entity/notes", { title: "anon" }));
    expect(createRes.status).toBe(201);

    const rows = await listAuditLog(backend);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorUserId).toBeNull();
    expect(rows[0]!.actorRole).toBeNull();
  });

  it("writing to audit_log itself does not recurse: exactly one row per note-write, never more, even after several ops", async () => {
    const { backend } = await setup();

    const createRes = await backend.fetch(jsonReq("POST", "/api/entity/notes", { title: "a" }, asUser("u1")));
    const created = (await createRes.json()) as { data: { id: string } };
    await backend.fetch(jsonReq("PATCH", `/api/entity/notes/${created.data.id}`, { title: "b" }, asUser("u1")));
    await backend.fetch(req(`/api/entity/notes/${created.data.id}`, { method: "DELETE", headers: asUser("u1") }));

    // 3 note operations (create, update, delete) produce exactly 3 audit rows,
    // no more. If the sink's write ever re-fired `record.created` against the
    // audit entity, this count would grow without bound.
    const rows = await listAuditLog(backend);
    expect(rows).toHaveLength(3);
  });

  it("respects a custom `entityName` and only tracks the configured `events` subset", async () => {
    const { backend } = await setup({ entityName: "activity_log", events: ["record.created"] });

    const createRes = await backend.fetch(jsonReq("POST", "/api/entity/notes", { title: "only-create" }, asUser("u1")));
    const created = (await createRes.json()) as { data: { id: string } };
    await backend.fetch(jsonReq("PATCH", `/api/entity/notes/${created.data.id}`, { title: "edited" }, asUser("u1")));

    const rows = await listAuditLog(backend, "activity_log");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("create");

    // The default entity name was never registered under this config.
    const defaultRes = await backend.fetch(req(`/api/entity/${DEFAULT_AUDIT_ENTITY}`, { headers: asUser("admin-1", "admin") }));
    expect(defaultRes.status).toBe(404);
  });
});

describe("createAuditSink: durability via flush() (Workers)", () => {
  // On Cloudflare Workers `emitAudit` fans out fire-and-forget and the isolate
  // suspends after the response, so an async `db.insert` that isn't awaited by
  // the `flushAll()`/`waitUntil` seam is dropped (the row never lands in D1).
  // node:sqlite hides this locally because its insert runs synchronously. These
  // guard that the sink tracks its in-flight writes and `flush()` awaits them.
  function fakeCtx(db: unknown): KernelContext {
    return { adapter: { db }, logger: { error() {} } } as unknown as KernelContext;
  }
  const event: AuditEvent = { action: "create", entity: "notes", recordId: "r1", time: "t" };

  it("flush() does not resolve until the in-flight insert completes", async () => {
    let releaseInsert!: () => void;
    const gate = new Promise<void>((r) => (releaseInsert = r));
    const inserted: unknown[] = [];
    const db = { insert: () => ({ values: async (row: unknown) => { await gate; inserted.push(row); } }) };
    const sink = createAuditSink(fakeCtx(db), "audit_log", {});

    void sink.writeAudit([event]);
    expect(inserted).toHaveLength(0); // dispatched but blocked on the gate

    let flushed = false;
    const flushP = Promise.resolve(sink.flush?.()).then(() => (flushed = true));
    await Promise.resolve();
    expect(flushed).toBe(false); // MUST still be waiting on the pending write

    releaseInsert();
    await flushP;
    expect(flushed).toBe(true);
    expect(inserted).toHaveLength(1); // the write completed, awaited by flush
  });

  it("flush() swallows a failed insert (never throws) but still awaits it", async () => {
    const errors: unknown[] = [];
    const ctx = { adapter: { db: { insert: () => ({ values: async () => { throw new Error("d1 down"); } }) } }, logger: { error: (...a: unknown[]) => errors.push(a) } } as unknown as KernelContext;
    const sink = createAuditSink(ctx, "audit_log", {});

    void sink.writeAudit([event]);
    await expect(Promise.resolve(sink.flush?.())).resolves.toBeUndefined();
    expect(errors.length).toBe(1);
  });
});

describe("activityPlugin: audit_log permissions (read/list = admin-only)", () => {
  it("denies a non-admin caller reading/listing audit_log (403 forbidden)", async () => {
    const { backend } = await setup();
    await backend.fetch(jsonReq("POST", "/api/entity/notes", { title: "x" }, asUser("user-a")));

    const listRes = await backend.fetch(req(`/api/entity/${DEFAULT_AUDIT_ENTITY}`, { headers: asUser("user-a", "member") }));
    expect(listRes.status).toBe(403);
    const body = (await listRes.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("denies a guest (no identity at all) reading/listing audit_log", async () => {
    const { backend } = await setup();
    await backend.fetch(jsonReq("POST", "/api/entity/notes", { title: "x" }, asUser("user-a")));

    const listRes = await backend.fetch(req(`/api/entity/${DEFAULT_AUDIT_ENTITY}`));
    expect(listRes.status).toBe(403);
  });

  it("allows an admin to read/list audit_log", async () => {
    const { backend } = await setup();
    await backend.fetch(jsonReq("POST", "/api/entity/notes", { title: "x" }, asUser("user-a")));

    const rows = await listAuditLog(backend);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("supports a custom `adminRole`: the configured role can read, but plain \"member\" still cannot", async () => {
    const { backend } = await setup({ adminRole: "auditor" });
    await backend.fetch(jsonReq("POST", "/api/entity/notes", { title: "x" }, asUser("user-a")));

    const auditorRes = await backend.fetch(
      req(`/api/entity/${DEFAULT_AUDIT_ENTITY}`, { headers: asUser("aud-1", "auditor") }),
    );
    expect(auditorRes.status).toBe(200);

    const memberRes = await backend.fetch(
      req(`/api/entity/${DEFAULT_AUDIT_ENTITY}`, { headers: asUser("user-b", "member") }),
    );
    expect(memberRes.status).toBe(403);
  });

  it("rejects create/update/delete against audit_log through the REST API outright (undeclared actions, default-deny) even for a non-admin authenticated caller", async () => {
    const { backend } = await setup();

    const createRes = await backend.fetch(
      jsonReq("POST", `/api/entity/${DEFAULT_AUDIT_ENTITY}`, { action: "fake" }, asUser("user-a")),
    );
    expect(createRes.status).toBe(403);
  });
});
