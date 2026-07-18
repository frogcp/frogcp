import { nodeSqliteAdapter } from "frogcp/adapter/node";
import { createBackend, defineBackend, entity, rule, text, type FrogPlugin } from "frogcp";
import { describe, expect, it } from "vitest";
import { sqliteObservabilitySink } from "../../../src/sink/sqlite/index";

const BASE = "http://x";

const config = defineBackend({
  entities: {
    notes: entity({
      title: text().required(),
    }).permissions({
      read: rule.public(),
      list: rule.public(),
      create: rule.public(),
      update: rule.public(),
      delete: rule.public(),
    }),
  },
});

/**
 * Emits one request-scoped log line via c.get("logger"). Core's own middleware
 * never logs on a plain successful request (only the built-in http.request
 * metric fires), so this stands in for a plugin or route logging request
 * context, which is what c.get("logger") is for.
 */
const breadcrumbPlugin: FrogPlugin = {
  name: "breadcrumb",
  middleware: async (c, next) => {
    c.get("logger").info("handling request", { path: c.req.path });
    await next();
  },
};

describe("sqliteObservabilitySink: wired into a real backend (Node path)", () => {
  it("drives one request through frogcp/adapter/node and lands an http.request metric row + the request log line, sharing the same request_id", async () => {
    const sink = sqliteObservabilitySink({ db: ":memory:" });

    const backend = await createBackend({
      config,
      adapter: nodeSqliteAdapter(":memory:"),
      plugins: [breadcrumbPlugin],
      sinks: { log: [sink.log], metric: [sink.metric] },
    });

    const res = await backend.fetch(new Request(`${BASE}/api/entity/notes`));
    expect(res.status).toBe(200);
    const requestId = res.headers.get("X-Request-Id");
    expect(requestId).toBeTruthy();

    // Node has no ExecutionContext, so the built-in request-metric middleware
    // awaits observability.flushAll() inline before the response is returned.
    // By the time backend.fetch resolves, both buffers are already drained.
    const metricRows = sink.readRecent("metric", 10);
    const httpRequestRow = metricRows.find((r) => r.name === "http.request");
    expect(httpRequestRow).toBeDefined();
    expect(httpRequestRow!.kind).toBe("counter");
    expect(httpRequestRow!.attributes).toMatchObject({ method: "GET", path: "/api/entity/notes", status: 200 });

    const logRows = sink.readRecent("log", 10);
    const requestLogRow = logRows.find((r) => r.message === "handling request");
    expect(requestLogRow).toBeDefined();
    expect(requestLogRow!.request_id).toBe(requestId);
  });
});
