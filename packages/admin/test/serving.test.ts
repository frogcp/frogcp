import { nodeSqliteAdapter } from "frogcp/adapter/node";
import { createBackend, defineBackend, entity, rule, text, type Backend } from "frogcp";
import { beforeAll, describe, expect, it } from "vitest";
import { adminPlugin } from "../src/index";
import { ASSETS } from "../src/generated/assets";

const BASE = "http://x";

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`${BASE}${path}`, init);
}

/** Discovered from the generated map rather than hardcoded, since the hashed
 * filename changes on every Vite build. */
function findEmittedAssetKey(): string {
  const key = Object.keys(ASSETS).find((k) => k !== "index.html" && k.startsWith("assets/") && k.endsWith(".js"));
  if (!key) {
    throw new Error("no JS asset found in ASSETS, did `pnpm build:spa && pnpm embed` run?");
  }
  return key;
}

describe("adminPlugin: serving", () => {
  let backend: Backend;

  beforeAll(async () => {
    // One entity is enough to prove the admin routes coexist with the normal
    // entity routes and do not shadow them.
    const config = defineBackend({
      entities: {
        notes: entity({ title: text() }).permissions({ list: rule.public() }),
      },
    });
    backend = await createBackend({
      config,
      adapter: nodeSqliteAdapter(":memory:"),
      debugIdentity: true,
      plugins: [adminPlugin()],
    });
  });

  it("GET /admin serves the SPA shell as text/html", async () => {
    const res = await backend.fetch(req("/admin"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('id="root"');
    expect(body).toMatch(/<script[^>]+src="\/admin\/assets\/[^"]+\.js"/);
  });

  it("GET /admin/ (trailing slash) also serves the shell", async () => {
    const res = await backend.fetch(req("/admin/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });

  it("GET /admin/assets/<real emitted asset> serves it with the right content-type + nosniff", async () => {
    const key = findEmittedAssetKey();
    const res = await backend.fetch(req(`/admin/${key}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });

  it("GET /admin/assets/<unknown> returns a real 404 rather than the HTML shell, so stale chunk refs fail honestly", async () => {
    const res = await backend.fetch(req("/admin/assets/does-not-exist.js"));
    expect(res.status).toBe(404);
    // Must not be the 200 text/html shell, which would surface as a confusing
    // MIME error and mask a broken asset ref during a deploy. Carrying no
    // content-type at all is fine, the point is only that it is not html.
    expect(res.headers.get("content-type") ?? "").not.toMatch(/text\/html/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("");
  });

  it("GET /admin/some-spa-route still falls back to index.html (SPA client-side routing)", async () => {
    const res = await backend.fetch(req("/admin/some-spa-route"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('id="root"');
  });

  it("a non-/admin path is unaffected by the admin plugin", async () => {
    const res = await backend.fetch(req("/api/entity/notes"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("a truly unknown path still 404s", async () => {
    const res = await backend.fetch(req("/totally/unknown/path"));
    expect(res.status).toBe(404);
  });

  it("every asset URL referenced in the served index.html (script src + link href) resolves to a real 200 with the right content-type", async () => {
    // Rather than execute the Vite bundle, parse the same URLs a browser would
    // load out of the served shell and confirm each round-trips through the
    // asset route. This is what catches `embed.mjs` or `routes.ts` falling out
    // of sync with what Vite emits; the test above only proves one asset works.
    const shellRes = await backend.fetch(req("/admin"));
    expect(shellRes.status).toBe(200);
    const html = await shellRes.text();

    const srcUrls = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    const hrefUrls = [...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]);
    const assetUrls = [...srcUrls, ...hrefUrls].filter((u): u is string => typeof u === "string");

    // The build always emits at least a JS entry chunk, so an empty list means
    // the regexes above or the served HTML broke.
    expect(assetUrls.length).toBeGreaterThan(0);

    for (const url of assetUrls) {
      const assetRes = await backend.fetch(req(url));
      expect(assetRes.status).toBe(200);
      const contentType = assetRes.headers.get("content-type") ?? "";
      if (url.endsWith(".js")) {
        expect(contentType).toMatch(/javascript/);
      } else if (url.endsWith(".css")) {
        expect(contentType).toMatch(/css/);
      } else {
        expect(contentType.length).toBeGreaterThan(0);
      }
      expect((await assetRes.text()).length).toBeGreaterThan(0);
    }
  });
});

describe("adminPlugin: custom route guard", () => {
  it("throws at construction for a non-default route, since the SPA is built with base /admin/", () => {
    expect(() => adminPlugin({ route: "/panel" })).toThrow(/custom route is not supported yet/i);
  });

  it("accepts the default route explicitly", () => {
    expect(() => adminPlugin({ route: "/admin" })).not.toThrow();
  });
});
