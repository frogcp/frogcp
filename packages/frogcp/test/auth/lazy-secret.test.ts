import { describe, it, expect } from "vitest";
import { nodeSqliteAdapter } from "frogcp/adapter/node";
import { createBackend, defineBackend, type DatabaseAdapter } from "frogcp";
import { authPlugin } from "../../src/auth/index";

const BASE = "http://x";
const TEST_SECRET = "test-secret-at-least-32-bytes-long!!";

const emptyConfig = defineBackend({ entities: {} });

function boot(secret: string | (() => string)): Promise<unknown> {
  return createBackend({
    config: emptyConfig,
    adapter: nodeSqliteAdapter(":memory:"),
    plugins: [authPlugin({ secret })],
  });
}

describe("authPlugin with a lazy secret", () => {
  it("does not call the resolver at construction, so a plugin can be built before its env exists", () => {
    let calls = 0;
    authPlugin({
      secret: () => {
        calls += 1;
        return TEST_SECRET;
      },
    });
    expect(calls).toBe(0);
  });

  it("still exposes its entities before the secret is resolved, which is what `frogcp schema` reads", () => {
    const plugin = authPlugin({
      secret: () => {
        throw new Error("unreachable: schema generation must never resolve the secret");
      },
    });
    expect(Object.keys(plugin.entities ?? {})).toEqual(expect.arrayContaining(["users", "oauthAccounts"]));
  });

  it("resolves the secret at boot, once, and issues sessions that verify against it", async () => {
    let calls = 0;
    const backend = await createBackend({
      config: emptyConfig,
      adapter: nodeSqliteAdapter(":memory:") as DatabaseAdapter,
      plugins: [
        authPlugin({
          secret: () => {
            calls += 1;
            return TEST_SECRET;
          },
        }),
      ],
    });
    expect(calls).toBe(1);

    const registered = await backend.fetch(
      new Request(`${BASE}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "lazy@example.com", password: "a-good-password" }),
      }),
    );
    expect(registered.status).toBe(201);

    const cookie = registered.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();

    const me = await backend.fetch(new Request(`${BASE}/api/auth/me`, { headers: { cookie: cookie! } }));
    expect(me.status).toBe(200);
  });

  it("validates the resolved secret's length at boot, so a weak lazy secret fails as loudly as a weak literal", async () => {
    await expect(boot(() => "too-short")).rejects.toThrow(/32/);
  });

  it("propagates a throwing resolver at boot, so a missing secret fails on the first request", async () => {
    await expect(boot(() => {
      throw new Error("AUTH_SECRET is not set");
    })).rejects.toThrow(/AUTH_SECRET is not set/);
  });
});
