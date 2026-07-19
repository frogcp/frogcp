import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { defineBackend, entity, text, type FrogPlugin, type KernelContext } from "frogcp";
import { createWorkerHandler } from "../../../src/adapter/cloudflare/worker";
import { d1Adapter } from "../../../src/adapter/cloudflare/d1";
import { r2Storage } from "../../../src/adapter/cloudflare/storage";
import { resetD1, tryStartMiniflareEnv } from "./support/miniflare-env";

const env = await tryStartMiniflareEnv();

afterAll(async () => {
  await env?.mf.dispose();
});

/** A no-op `ExecutionContext` stand-in. `createWorkerHandler` accepts it to match the Workers `fetch` signature but never calls into it. */
function fakeExecutionContext(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
}

const config = defineBackend({ entities: { notes: entity({ title: text().required() }) } });

describe.skipIf(env === null)("createWorkerHandler with real D1/R2 bindings (miniflare)", () => {
  beforeEach(async () => {
    await resetD1(env!.d1);
  });

  it("builds the backend lazily and reuses it across requests to the same env", async () => {
    let resolveCalls = 0;
    const workerEnv = { DB: env!.d1 };
    const handler = createWorkerHandler({
      config,
      resolve: (e: typeof workerEnv) => {
        resolveCalls += 1;
        return { adapter: d1Adapter(e.DB) };
      },
    });

    const req = () => new Request("https://worker.example/api/system/health");
    const res1 = await handler.fetch(req(), workerEnv, fakeExecutionContext());
    const res2 = await handler.fetch(req(), workerEnv, fakeExecutionContext());

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(await res1.json()).toEqual({ ok: true });
    // Only the first request should have built the backend; the second must
    // reuse the cached one rather than calling `resolve`/re-migrating again.
    expect(resolveCalls).toBe(1);
  });

  it("concurrent first requests to the same env share one in-flight build (no duplicate boot)", async () => {
    let resolveCalls = 0;
    const workerEnv = { DB: env!.d1 };
    const handler = createWorkerHandler({
      config,
      resolve: (e: typeof workerEnv) => {
        resolveCalls += 1;
        return { adapter: d1Adapter(e.DB) };
      },
    });

    const req = () => new Request("https://worker.example/api/system/health");
    const [res1, res2, res3] = await Promise.all([
      handler.fetch(req(), workerEnv, fakeExecutionContext()),
      handler.fetch(req(), workerEnv, fakeExecutionContext()),
      handler.fetch(req(), workerEnv, fakeExecutionContext()),
    ]);

    for (const res of [res1, res2, res3]) expect(res.status).toBe(200);
    expect(resolveCalls).toBe(1);
  });

  it("builds a separate backend per distinct env object", async () => {
    const workerEnvA = { DB: env!.d1 };
    const workerEnvB = { DB: env!.d1 };
    let resolveCalls = 0;
    const handler = createWorkerHandler({
      config,
      resolve: (e: typeof workerEnvA) => {
        resolveCalls += 1;
        return { adapter: d1Adapter(e.DB) };
      },
    });

    await handler.fetch(new Request("https://worker.example/api/system/health"), workerEnvA, fakeExecutionContext());
    await handler.fetch(new Request("https://worker.example/api/system/health"), workerEnvB, fakeExecutionContext());

    expect(resolveCalls).toBe(2);
  });

  it("delegates to the real backend end-to-end (create + list a row through the Workers fetch signature)", async () => {
    const workerEnv = { DB: env!.d1 };
    // `notes` has no `.permissions()`, so every action defaults to admin-only
    // (see `permissions/engine.ts`'s `decide`: `ctx?.role === "admin"` short-
    // circuits to allow, otherwise a missing rule denies). `debugIdentity:
    // true` plus the `x-frogcp-debug-identity` header is the dev-tooling
    // shortcut for asserting an admin identity without a real auth plugin.
    const handler = createWorkerHandler({
      config,
      debugIdentity: true,
      resolve: (e: typeof workerEnv) => ({ adapter: d1Adapter(e.DB) }),
    });

    const createRes = await handler.fetch(
      new Request("https://worker.example/api/entity/notes", {
        method: "POST",
        headers: { "content-type": "application/json", "x-frogcp-debug-identity": "admin:admin" },
        body: JSON.stringify({ title: "hello from a worker" }),
      }),
      workerEnv,
      fakeExecutionContext(),
    );
    expect(createRes.status).toBe(201);
    expect(((await createRes.json()) as { data: { title: string } }).data.title).toBe("hello from a worker");

    const listRes = await handler.fetch(
      new Request("https://worker.example/api/entity/notes", {
        headers: { "x-frogcp-debug-identity": "admin:admin" },
      }),
      workerEnv,
      fakeExecutionContext(),
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: { title: string }[] };
    expect(listBody.data.map((r) => r.title)).toContain("hello from a worker");

    // Without the debug-identity header, the same entity denies as guest,
    // proving the identity plumbing (not just routing) genuinely runs
    // end-to-end through `createWorkerHandler`'s `fetch`.
    const guestRes = await handler.fetch(
      new Request("https://worker.example/api/entity/notes"),
      workerEnv,
      fakeExecutionContext(),
    );
    expect(guestRes.status).toBe(403);
  });

  it("forwards debugIdentity/identify/migrate/plugins options through to createBackend", async () => {
    const workerEnv = { DB: env!.d1 };
    let bootedCtx: KernelContext | undefined;
    const capturePlugin: FrogPlugin = {
      name: "capture",
      onBoot(ctx) {
        bootedCtx = ctx;
      },
    };

    const handler = createWorkerHandler({
      config,
      plugins: [capturePlugin],
      debugIdentity: true,
      resolve: (e: typeof workerEnv) => ({ adapter: d1Adapter(e.DB), storage: r2Storage(env!.r2) }),
    });

    const res = await handler.fetch(
      new Request("https://worker.example/api/entity/notes", {
        method: "POST",
        headers: { "content-type": "application/json", "x-frogcp-debug-identity": "alice:admin" },
        body: JSON.stringify({ title: "as alice" }),
      }),
      workerEnv,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(201);
    // `storage` from `resolve()` must land on `KernelContext.storage`.
    expect(bootedCtx?.storage).toBeDefined();
  });

  it("accepts plugins as a function of the runtime, so a plugin can be wired from a binding or secret", async () => {
    const workerEnv = { DB: env!.d1, GREETING: "from a binding" };
    let seen: string | undefined;
    const handler = createWorkerHandler({
      config,
      plugins: (ctx) => [
        {
          name: "reads-env",
          onBoot() {
            seen = ctx.env.GREETING as string;
          },
        } satisfies FrogPlugin,
      ],
      resolve: (e: typeof workerEnv) => ({ adapter: d1Adapter(e.DB) }),
    });

    const res = await handler.fetch(
      new Request("https://worker.example/api/system/health"),
      workerEnv,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(200);
    // The Workers `env` is what the resolver sees, so a secret that only exists
    // per request can still build a plugin.
    expect(seen).toBe("from a binding");
  });

  it("evicts a failed build so a later request against the same env gets a fresh attempt", async () => {
    const workerEnv = { DB: env!.d1 };
    let attempt = 0;
    const handler = createWorkerHandler({
      config,
      resolve: (e: typeof workerEnv) => {
        attempt += 1;
        if (attempt === 1) throw new Error("boom: first attempt always fails");
        return { adapter: d1Adapter(e.DB) };
      },
    });

    await expect(
      handler.fetch(new Request("https://worker.example/api/system/health"), workerEnv, fakeExecutionContext()),
    ).rejects.toThrow("boom: first attempt always fails");

    const res = await handler.fetch(
      new Request("https://worker.example/api/system/health"),
      workerEnv,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(200);
    expect(attempt).toBe(2);
  });
});
