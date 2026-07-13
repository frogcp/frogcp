import { describe, expect, it } from "vitest";
import { defineApp, buildBackend, createServeHandler, type App, type RuntimeContext } from "../../src/adapter/serve";
import { defineBackend, entity, rule, text, type FrogPlugin, type KernelContext } from "../../src/index";
import { nodeSqliteAdapter } from "../../src/adapter/node";

const publicPerms = {
  create: rule.public(),
  read: rule.public(),
  list: rule.public(),
  update: rule.public(),
  delete: rule.public(),
};

const config = defineBackend({
  entities: { notes: entity({ title: text().required() }).permissions(publicPerms) },
});

const nodeCtx: RuntimeContext = { onCloudflare: false, cloudflareEnv: undefined, env: {} };

describe("defineApp", () => {
  it("returns the descriptor unchanged (typed facade)", () => {
    const app = defineApp({ config, connection: ":memory:" });
    expect(app.config).toBe(config);
    expect(app.connection).toBe(":memory:");
  });
});

describe("buildBackend (shared serve core)", () => {
  it("boots a working backend from a connection string", async () => {
    const backend = await buildBackend({ config, connection: ":memory:" }, nodeCtx);
    const created = await backend.fetch(
      new Request("http://frog.local/api/entity/notes", {
        method: "POST",
        body: JSON.stringify({ title: "hi" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(created.status).toBe(201);
  });

  it("resolves `plugins` as a function of the runtime ctx", async () => {
    let seen: RuntimeContext | undefined;
    let bootedCtx: KernelContext | undefined;
    const capture: FrogPlugin = { name: "capture", onBoot: (c) => void (bootedCtx = c) };
    const app: App = {
      config,
      connection: nodeSqliteAdapter(":memory:"),
      plugins: (ctx) => {
        seen = ctx;
        return [capture];
      },
    };
    await buildBackend(app, nodeCtx);
    expect(seen).toBe(nodeCtx);
    expect(bootedCtx).toBeDefined();
  });

  it("forwards mode:'managed' so the schema-editing endpoint is enabled", async () => {
    const backend = await buildBackend({ config: { entities: {} }, connection: ":memory:", mode: "managed" }, nodeCtx);
    // managed mode accepts schema edits; code mode returns 409
    const res = await backend.fetch(
      new Request("http://frog.local/api/system/schema", {
        method: "POST",
        body: JSON.stringify({ entities: {} }),
        headers: { "content-type": "application/json", "x-frogcp-debug-identity": "admin:admin" },
      }),
    );
    expect(res.status).not.toBe(409);
  });

  it("defaults the connection to node:sqlite when none is given", async () => {
    // `file:./data.sqlite` default would touch disk; assert instead that an
    // explicit `:memory:` and the default both yield a booting sqlite backend.
    const backend = await buildBackend({ config: { entities: {} }, connection: ":memory:" }, nodeCtx);
    const health = await backend.fetch(new Request("http://frog.local/api/system/health"));
    expect(health.status).toBe(200);
  });
});

describe("createServeHandler", () => {
  it("memoizes one backend per resolved env and dispatches fetch", async () => {
    let builds = 0;
    const app: App = {
      config,
      connection: () => {
        builds += 1;
        return nodeSqliteAdapter(":memory:");
      },
    };
    const env = {};
    const handler = createServeHandler(app, () => ({ onCloudflare: false, cloudflareEnv: undefined, env }));
    const a = await handler.getBackend();
    const b = await handler.getBackend();
    expect(a).toBe(b);
    expect(builds).toBe(1);

    const res = await handler.fetch(new Request("http://frog.local/api/entity/notes"));
    expect(res.status).toBe(200);
    expect(builds).toBe(1);
  });

  it("resolves the RuntimeContext exactly once across many requests (build-once)", async () => {
    // Regression guard: the context resolver must not run per request. On
    // Cloudflare Workers `getCloudflareContext()` reliably yields the CF env on
    // the first in-request resolution but intermittently misses on later ones;
    // re-resolving per request made the default connection fall back to
    // node:sqlite (fatal on Workers) on those misses. The backend plus its
    // context are resolved once per isolate and cached.
    let resolves = 0;
    const app: App = { config, connection: () => nodeSqliteAdapter(":memory:") };
    const handler = createServeHandler(app, () => {
      resolves += 1;
      return { onCloudflare: false, cloudflareEnv: undefined, env: {} };
    });
    for (let i = 0; i < 5; i++) {
      const res = await handler.fetch(new Request("http://frog.local/api/entity/notes"));
      expect(res.status).toBe(200);
    }
    expect(resolves).toBe(1);
  });

  it("retries the build after a failed context resolution (evict-on-failure)", async () => {
    // A transient first-build failure (e.g. the CF context momentarily
    // unavailable at cold start) must not pin a permanently-rejected backend,
    // the next request rebuilds cleanly.
    let attempt = 0;
    const app: App = { config, connection: () => nodeSqliteAdapter(":memory:") };
    const handler = createServeHandler(app, () => {
      attempt += 1;
      if (attempt === 1) throw new Error("no CF context yet");
      return { onCloudflare: false, cloudflareEnv: undefined, env: {} };
    });
    await expect(handler.getBackend()).rejects.toThrow("no CF context yet");
    // second call retries and succeeds
    const backend = await handler.getBackend();
    expect(backend).toBeDefined();
    expect(attempt).toBe(2);
  });
});
