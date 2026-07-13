import { describe, it, expect } from "vitest";
import { nodeSqliteAdapter } from "./support/node-sqlite-adapter";
import {
  createBackend,
  defineBackend,
  entity,
  text,
  rule,
  type DatabaseAdapter,
  type FrogPlugin,
} from "../src/index";

const BASE = "http://x";

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`${BASE}${path}`, init);
}

const publicPerms = {
  create: rule.public(),
  read: rule.public(),
  list: rule.public(),
  update: rule.public(),
  delete: rule.public(),
};

const baseConfig = defineBackend({
  entities: {
    notes: entity({ title: text().required() }).permissions(publicPerms),
  },
});

function makeAdapter(): DatabaseAdapter {
  return nodeSqliteAdapter(":memory:");
}

describe("plugin middleware", () => {
  it("runs and can mutate the response (set a header) before returning it", async () => {
    const stamped: FrogPlugin = {
      name: "stamped",
      middleware: async (c, next) => {
        await next();
        c.header("X-Stamped", "yes");
      },
    };

    const backend = await createBackend({ config: baseConfig, adapter: makeAdapter(), plugins: [stamped] });
    const res = await backend.fetch(req("/api/entity/notes"));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Stamped")).toBe("yes");
  });

  it("onion order: two plugins push to a shared array, in A,B then out B,A", async () => {
    const order: string[] = [];
    const pluginA: FrogPlugin = {
      name: "a",
      middleware: async (_c, next) => {
        order.push("in:a");
        await next();
        order.push("out:a");
      },
    };
    const pluginB: FrogPlugin = {
      name: "b",
      middleware: async (_c, next) => {
        order.push("in:b");
        await next();
        order.push("out:b");
      },
    };

    const backend = await createBackend({
      config: baseConfig,
      adapter: makeAdapter(),
      plugins: [pluginA, pluginB],
    });

    const res = await backend.fetch(req("/api/entity/notes"));
    expect(res.status).toBe(200);
    expect(order).toEqual(["in:a", "in:b", "out:b", "out:a"]);
  });

  it("short-circuit: a middleware returning a Response without next() aborts routing (the route never runs)", async () => {
    let routeRan = false;
    const blocking: FrogPlugin = {
      name: "blocking",
      middleware: async (c, _next) => c.text("service unavailable", 503),
      routes(app) {
        app.get("/api/entity/notes", (c) => {
          routeRan = true;
          return c.json({ data: [] });
        });
      },
    };

    const backend = await createBackend({ config: baseConfig, adapter: makeAdapter(), plugins: [blocking] });
    const res = await backend.fetch(req("/api/entity/notes"));
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("service unavailable");
    expect(routeRan).toBe(false);
  });

  it("short-circuit still unwinds outer middlewares around the aborted inner one", async () => {
    const order: string[] = [];
    const outer: FrogPlugin = {
      name: "outer",
      middleware: async (_c, next) => {
        order.push("in:outer");
        await next();
        order.push("out:outer");
      },
    };
    const inner: FrogPlugin = {
      name: "inner",
      middleware: async (c, _next) => {
        order.push("in:inner");
        return c.text("nope", 503);
      },
    };

    const backend = await createBackend({ config: baseConfig, adapter: makeAdapter(), plugins: [outer, inner] });
    const res = await backend.fetch(req("/api/entity/notes"));
    expect(res.status).toBe(503);
    expect(order).toEqual(["in:outer", "in:inner", "out:outer"]);
  });

  it("reads identity: middleware sees c.get(\"ctx\") already resolved (runs after identity middleware)", async () => {
    const echoRole: FrogPlugin = {
      name: "echo-role",
      middleware: async (c, next) => {
        await next();
        const ctx = c.get("ctx");
        c.header("X-Resolved-Role", ctx?.role ?? "none");
      },
    };

    const backend = await createBackend({
      config: baseConfig,
      adapter: makeAdapter(),
      debugIdentity: true,
      plugins: [echoRole],
    });

    const res = await backend.fetch(
      req("/api/entity/notes", { headers: { "x-frogcp-debug-identity": "u1:admin" } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Resolved-Role")).toBe("admin");
  });

  it("reads request-scoped id: c.get(\"requestId\") is a non-empty string inside the middleware", async () => {
    let seenRequestId: string | undefined;
    const idReader: FrogPlugin = {
      name: "id-reader",
      middleware: async (c, next) => {
        seenRequestId = c.get("requestId");
        await next();
      },
    };

    const backend = await createBackend({ config: baseConfig, adapter: makeAdapter(), plugins: [idReader] });
    const res = await backend.fetch(req("/api/entity/notes"));
    expect(res.status).toBe(200);
    expect(typeof seenRequestId).toBe("string");
    expect(seenRequestId?.length).toBeGreaterThan(0);
  });

  it("a throwing middleware propagates to the kernel's 500 envelope and does not leak the error message", async () => {
    const throwing: FrogPlugin = {
      name: "throws",
      middleware: async (_c, _next) => {
        throw new Error("secret internal detail");
      },
    };

    const backend = await createBackend({ config: baseConfig, adapter: makeAdapter(), plugins: [throwing] });
    const res = await backend.fetch(req("/api/entity/notes"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("internal");
    expect(JSON.stringify(body)).not.toContain("secret internal detail");
  });
});
