import { describe, it, expect, vi } from "vitest";
import { nodeSqliteAdapter } from "frogcp/adapter/node";
import {
  createBackend,
  defineBackend,
  entity,
  text,
  resolveEntities,
  rule,
  type DatabaseAdapter,
  type FrogPlugin,
  type Ctx,
  type DataEventPayload,
  type Logger,
} from "../src/index";

interface CapturedLine {
  level: string;
  message: string;
  fields?: Record<string, unknown>;
}

// A minimal Logger that records every call (level/message/fields) into sink,
// for asserting on the kernel's structured logging without spying on console.
function makeCapturingLogger(sink: CapturedLine[], bindings: Record<string, unknown> = {}): Logger {
  const record = (level: string, message: string, fields?: Record<string, unknown>) => {
    sink.push({ level, message, fields: { ...bindings, ...fields } });
  };
  return {
    debug: (message, fields) => record("debug", message, fields),
    info: (message, fields) => record("info", message, fields),
    warn: (message, fields) => record("warn", message, fields),
    error: (message, fields) => record("error", message, fields),
    child: (childBindings) => makeCapturingLogger(sink, { ...bindings, ...childBindings }),
  };
}

const BASE = "http://x";

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`${BASE}${path}`, init);
}

function postJson(path: string, body: unknown): Request {
  return req(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
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

describe("plugin entities", () => {
  it("merges a plugin's entities into the backend; CRUD works on the plugin entity through fetch", async () => {
    const widgets: FrogPlugin = {
      name: "widgets",
      entities: resolveEntities({
        widgets: entity({ label: text().required() }).permissions(publicPerms),
      }),
    };

    const backend = await createBackend({ config: baseConfig, adapter: makeAdapter(), plugins: [widgets] });

    const createRes = await backend.fetch(postJson("/api/entity/widgets", { label: "gizmo" }));
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { data: { id: string; label: string } };
    expect(created.data.label).toBe("gizmo");

    const listRes = await backend.fetch(req("/api/entity/widgets"));
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { data: { label: string }[] };
    expect(list.data.map((r) => r.label)).toEqual(["gizmo"]);

    const patchRes = await backend.fetch(
      req(`/api/entity/widgets/${created.data.id}`, {
        method: "PATCH",
        body: JSON.stringify({ label: "gizmo2" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(patchRes.status).toBe(200);

    const deleteRes = await backend.fetch(req(`/api/entity/widgets/${created.data.id}`, { method: "DELETE" }));
    expect(deleteRes.status).toBe(204);
  });

  it("skips falsy plugin entries (false/null/undefined) so optional plugins need no conditional spread", async () => {
    const widgets: FrogPlugin = {
      name: "widgets",
      entities: resolveEntities({
        widgets: entity({ label: text().required() }).permissions(publicPerms),
      }),
    };

    // A caller wiring optional plugins inline (an off feature flag and some
    // not-configured slots) with no `...(x ? [x] : [])` gymnastics. The kernel
    // must accept the falsy entries and simply skip them.
    const enableExtra = false;
    const backend = await createBackend({
      config: baseConfig,
      adapter: makeAdapter(),
      plugins: [enableExtra && widgets, widgets, undefined, null],
    });

    // The one real plugin is still fully registered; the falsy entries were
    // skipped rather than crashing boot.
    const createRes = await backend.fetch(postJson("/api/entity/widgets", { label: "gizmo" }));
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { data: { label: string } };
    expect(created.data.label).toBe("gizmo");
  });

  it("the merged config handed to plugins is frozen at every level (config, entities map, plugin entity)", async () => {
    const widgetEntities = resolveEntities({
      widgets: entity({ label: text().required() }).permissions(publicPerms),
    });
    let observed: { config: boolean; entities: boolean; pluginEntity: boolean } | undefined;
    let mutationError: unknown;

    const widgets: FrogPlugin = {
      name: "widgets",
      entities: widgetEntities,
      onBoot(ctx) {
        observed = {
          config: Object.isFrozen(ctx.config),
          entities: Object.isFrozen(ctx.config.entities),
          pluginEntity: Object.isFrozen(ctx.config.entities.widgets),
        };
        try {
          // Strict mode (ESM): assigning to a frozen object throws TypeError.
          (ctx.config.entities as Record<string, unknown>).injected = {};
        } catch (error) {
          mutationError = error;
        }
      },
    };

    const backend = await createBackend({ config: baseConfig, adapter: makeAdapter(), plugins: [widgets] });

    expect(observed).toEqual({ config: true, entities: true, pluginEntity: true });
    expect(mutationError).toBeInstanceOf(TypeError);
    // And the attempted mutation is not observable afterward.
    const res = await backend.fetch(req("/api/entity/injected"));
    expect(res.status).toBe(404);
  });

  it("throws the exact collision message when a plugin entity collides with a config entity", async () => {
    const clashing: FrogPlugin = {
      name: "clash",
      entities: resolveEntities({ notes: entity({ title: text().required() }) }),
    };

    await expect(
      createBackend({ config: baseConfig, adapter: makeAdapter(), plugins: [clashing] }),
    ).rejects.toThrow('Entity "notes" already defined (plugin "clash")');
  });

  it("throws (naming the losing plugin) when two plugins define the same entity name", async () => {
    const pluginA: FrogPlugin = {
      name: "pluginA",
      entities: resolveEntities({ shared: entity({ label: text().required() }) }),
    };
    const pluginB: FrogPlugin = {
      name: "pluginB",
      entities: resolveEntities({ shared: entity({ label: text().required() }) }),
    };

    await expect(
      createBackend({ config: baseConfig, adapter: makeAdapter(), plugins: [pluginA, pluginB] }),
    ).rejects.toThrow('Entity "shared" already defined (plugin "pluginB")');
  });
});

describe("identify precedence", () => {
  function whoamiPlugin(): FrogPlugin {
    return {
      name: "whoami",
      routes(app) {
        app.get("/api/whoami", (c) => c.json({ ctx: c.get("ctx") }));
      },
    };
  }

  it("options.identify wins over every plugin's identify", async () => {
    const pluginIdentify = vi.fn(async (): Promise<Ctx> => ({ userId: "plugin-user", role: "member" }));
    const plugin: FrogPlugin = { name: "auth", identify: pluginIdentify };

    const backend = await createBackend({
      config: baseConfig,
      adapter: makeAdapter(),
      identify: async () => ({ userId: "explicit-user", role: "admin" }),
      plugins: [plugin, whoamiPlugin()],
    });

    const res = await backend.fetch(req("/api/whoami"));
    const body = (await res.json()) as { ctx: Ctx };
    expect(body.ctx).toEqual({ userId: "explicit-user", role: "admin" });
    expect(pluginIdentify).not.toHaveBeenCalled();
  });

  it("the first plugin providing identify wins; a later plugin's identify is never invoked", async () => {
    const first = vi.fn(async (): Promise<Ctx> => ({ userId: "first-user", role: "member" }));
    const second = vi.fn(async (): Promise<Ctx> => ({ userId: "second-user", role: "member" }));

    const backend = await createBackend({
      config: baseConfig,
      adapter: makeAdapter(),
      plugins: [
        { name: "first", identify: first },
        { name: "second", identify: second },
        whoamiPlugin(),
      ],
    });

    const res = await backend.fetch(req("/api/whoami"));
    const body = (await res.json()) as { ctx: Ctx };
    expect(body.ctx).toEqual({ userId: "first-user", role: "member" });
    expect(second).not.toHaveBeenCalled();
  });

  it("a first plugin identify returning null (guest) is final: a later plugin's identify is not consulted", async () => {
    const first = vi.fn(async (): Promise<Ctx> => null);
    const second = vi.fn(async (): Promise<Ctx> => ({ userId: "second-user", role: "member" }));

    const backend = await createBackend({
      config: baseConfig,
      adapter: makeAdapter(),
      plugins: [
        { name: "first", identify: first },
        { name: "second", identify: second },
        whoamiPlugin(),
      ],
    });

    const res = await backend.fetch(req("/api/whoami"));
    const body = (await res.json()) as { ctx: Ctx };
    expect(body.ctx).toBeNull();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("falls back to guest when no explicit identify or plugin identify is configured", async () => {
    const backend = await createBackend({
      config: baseConfig,
      adapter: makeAdapter(),
      plugins: [whoamiPlugin()],
    });

    const res = await backend.fetch(req("/api/whoami"));
    const body = (await res.json()) as { ctx: Ctx };
    expect(body.ctx).toBeNull();
  });

  it("a throwing plugin identify resolves to guest (never a 500) and logs a warning via the kernel logger", async () => {
    const lines: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
    const testLogger = makeCapturingLogger(lines);
    const throwing: FrogPlugin = {
      name: "throws",
      identify: () => {
        throw new Error("boom");
      },
    };

    const backend = await createBackend({
      config: baseConfig,
      adapter: makeAdapter(),
      logger: testLogger,
      plugins: [throwing, whoamiPlugin()],
    });

    const res = await backend.fetch(req("/api/whoami"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ctx: Ctx };
    expect(body.ctx).toBeNull();

    const warnLine = lines.find((l) => l.message === "plugin identify threw");
    expect(warnLine).toBeDefined();
    expect(warnLine?.level).toBe("warn");
    expect(warnLine?.fields?.plugin).toBe("throws");
  });

  it("debugIdentity overrides plugin identify (dev tooling wins over plugin-provided identity)", async () => {
    const pluginIdentify = vi.fn(async (): Promise<Ctx> => ({ userId: "plugin-user", role: "member" }));

    const backend = await createBackend({
      config: baseConfig,
      adapter: makeAdapter(),
      debugIdentity: true,
      plugins: [{ name: "auth", identify: pluginIdentify }, whoamiPlugin()],
    });

    const res = await backend.fetch(
      req("/api/whoami", { headers: { "x-frogcp-debug-identity": "debug-user:admin" } }),
    );
    const body = (await res.json()) as { ctx: Ctx };
    expect(body.ctx).toEqual({ userId: "debug-user", role: "admin" });
    expect(pluginIdentify).not.toHaveBeenCalled();
  });
});

describe("events", () => {
  const eventsConfig = defineBackend({
    entities: {
      accounts: entity({
        name: text().required(),
        secret: text().hidden(),
      }).permissions(publicPerms),
    },
  });

  it("record.created fires after a successful create, with a hidden-stripped row and ctx", async () => {
    const backend = await createBackend({ config: eventsConfig, adapter: makeAdapter() });
    const received: DataEventPayload[] = [];
    backend.events.on("record.created", (p) => {
      received.push(p);
    });

    const res = await backend.fetch(postJson("/api/entity/accounts", { name: "Alice", secret: "shh" }));
    expect(res.status).toBe(201);

    expect(received).toHaveLength(1);
    expect(received[0]?.entity).toBe("accounts");
    expect(received[0]?.row.name).toBe("Alice");
    expect("secret" in (received[0]?.row ?? {})).toBe(false);
    expect(received[0]?.ctx).toBeNull();
  });

  it("record.updated fires with the post-update row", async () => {
    const backend = await createBackend({ config: eventsConfig, adapter: makeAdapter() });
    const createRes = await backend.fetch(postJson("/api/entity/accounts", { name: "Alice" }));
    const created = (await createRes.json()) as { data: { id: string } };

    const received: DataEventPayload[] = [];
    backend.events.on("record.updated", (p) => {
      received.push(p);
    });

    const patchRes = await backend.fetch(
      req(`/api/entity/accounts/${created.data.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "Alice2" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(patchRes.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.entity).toBe("accounts");
    expect(received[0]?.row.name).toBe("Alice2");
  });

  it("record.deleted fires with the pre-delete row", async () => {
    const backend = await createBackend({ config: eventsConfig, adapter: makeAdapter() });
    const createRes = await backend.fetch(postJson("/api/entity/accounts", { name: "Alice" }));
    const created = (await createRes.json()) as { data: { id: string } };

    const received: DataEventPayload[] = [];
    backend.events.on("record.deleted", (p) => {
      received.push(p);
    });

    const deleteRes = await backend.fetch(req(`/api/entity/accounts/${created.data.id}`, { method: "DELETE" }));
    expect(deleteRes.status).toBe(204);
    expect(received).toHaveLength(1);
    expect(received[0]?.row.name).toBe("Alice");
    expect(received[0]?.row.id).toBe(created.data.id);
  });

  it("a throwing event handler is caught, logged via the kernel logger (not bare console), and does not affect the API response", async () => {
    const lines: CapturedLine[] = [];
    const testLogger = makeCapturingLogger(lines);
    const backend = await createBackend({ config: eventsConfig, adapter: makeAdapter(), logger: testLogger });
    backend.events.on("record.created", () => {
      throw new Error("handler boom");
    });

    const res = await backend.fetch(postJson("/api/entity/accounts", { name: "Alice" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { name: string } };
    expect(body.data.name).toBe("Alice");

    const errorLine = lines.find((l) => l.message === '"record.created" event handler threw');
    expect(errorLine).toBeDefined();
    expect(errorLine?.level).toBe("error");
    expect(errorLine?.fields?.event).toBe("record.created");
  });

  it("the unsubscribe function returned by on() stops further delivery", async () => {
    const backend = await createBackend({ config: eventsConfig, adapter: makeAdapter() });
    const received: DataEventPayload[] = [];
    const off = backend.events.on("record.created", (p) => {
      received.push(p);
    });
    off();

    await backend.fetch(postJson("/api/entity/accounts", { name: "Alice" }));
    expect(received).toHaveLength(0);
  });
});

describe("boot ordering", () => {
  it("runs every plugin's onBoot, in array order, before any plugin's routes are registered", async () => {
    const order: string[] = [];
    const pluginA: FrogPlugin = {
      name: "a",
      onBoot: async () => {
        order.push("onBoot:a");
      },
      routes: () => {
        order.push("routes:a");
      },
    };
    const pluginB: FrogPlugin = {
      name: "b",
      onBoot: async () => {
        order.push("onBoot:b");
      },
      routes: () => {
        order.push("routes:b");
      },
    };

    await createBackend({ config: baseConfig, adapter: makeAdapter(), plugins: [pluginA, pluginB] });

    expect(order).toEqual(["onBoot:a", "onBoot:b", "routes:a", "routes:b"]);
  });
});
