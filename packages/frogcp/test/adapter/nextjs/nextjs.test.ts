import { describe, expect, it } from "vitest";
import { nodeSqliteAdapter } from "../../../src/adapter/node";
import { defineBackend, entity, rule, text } from "../../../src/index";
import { getApp, serve, type NextjsApp, type RuntimeContext } from "../../../src/adapter/nextjs/index";

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

/** A minimal app whose adapter is given explicitly (so the test never hits the
 * Cloudflare / node:sqlite-path default resolver). */
function makeApp(overrides: Partial<NextjsApp> = {}): NextjsApp {
  return { config, adapter: nodeSqliteAdapter(":memory:"), plugins: [], ...overrides };
}

describe("frogcp/adapter/nextjs", () => {
  it("serve() returns Route Handlers that dispatch to the backend", async () => {
    const { GET, POST } = serve(makeApp());

    const created = await POST(
      new Request("http://frog.local/api/entity/notes", {
        method: "POST",
        body: JSON.stringify({ title: "hi" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(created.status).toBe(201);

    const listed = await GET(new Request("http://frog.local/api/entity/notes"));
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { data: { title: string }[] };
    expect(body.data.map((r) => r.title)).toEqual(["hi"]);
  });

  it("getApp() memoizes one backend per app object", async () => {
    const app = makeApp();
    const a = await getApp(app);
    const b = await getApp(app);
    expect(a).toBe(b); // same instance, built once
    // a different app object builds a distinct backend
    const other = await getApp(makeApp());
    expect(other).not.toBe(a);
  });

  it("plugins can be a function of the resolved runtime (env)", async () => {
    let seen: RuntimeContext | undefined;
    const app = makeApp({
      plugins: (ctx) => {
        seen = ctx;
        return [];
      },
    });
    await getApp(app);
    expect(seen).toBeDefined();
    // off Workers in a plain test: no CF context resolvable
    expect(seen!.onCloudflare).toBe(false);
    expect(seen!.cloudflareEnv).toBeUndefined();
    expect(seen!.env).toBe(process.env);
  });

  it("adapter/storage/migrate accept a value or a resolver, and all HTTP verbs are handlers", () => {
    const handlers = serve(makeApp());
    for (const verb of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const) {
      expect(typeof handlers[verb]).toBe("function");
    }
    // resolver form typechecks and is accepted
    const app = makeApp({ migrate: (ctx) => !ctx.onCloudflare, adapter: () => nodeSqliteAdapter(":memory:") });
    expect(app).toBeDefined();
  });
});
