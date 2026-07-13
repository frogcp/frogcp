import { describe, it, expect, vi } from "vitest";
import { cloudflareKv } from "../../../src/adapter/cloudflare/kv";

/**
 * A minimal in-memory stand-in for a KVNamespace binding, enough for
 * cloudflareKv's get/put/delete/list plus TTL logic. Records the exact
 * expirationTtl passed so the clamp/omit behavior is assertable; does not
 * expire anything itself (that is KV's behavior, not this adapter's).
 */
function mockKVNamespace() {
  const store = new Map<string, { value: string; expirationTtl?: number }>();
  return {
    async get(key: string, _type?: "text") {
      return store.get(key)?.value ?? null;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      store.set(key, { value, ...(options?.expirationTtl !== undefined ? { expirationTtl: options.expirationTtl } : {}) });
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(options?: { prefix?: string }) {
      const prefix = options?.prefix ?? "";
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cacheStatus: null };
    },
  } as unknown as KVNamespace;
}

describe("cloudflareKv", () => {
  it("put/get/delete round-trips the value", async () => {
    const kv = cloudflareKv(mockKVNamespace());
    await kv.put("route:app", '{"slug":"blue"}');
    expect(await kv.get("route:app")).toBe('{"slug":"blue"}');
    await kv.delete("route:app");
    expect(await kv.get("route:app")).toBeNull();
  });

  it("get on a missing key returns null", async () => {
    const kv = cloudflareKv(mockKVNamespace());
    expect(await kv.get("nope")).toBeNull();
  });

  it("reads in text mode", async () => {
    const binding = mockKVNamespace();
    const getSpy = vi.spyOn(binding, "get");
    const kv = cloudflareKv(binding);
    await kv.get("k");
    expect(getSpy).toHaveBeenCalledWith("k", "text");
  });

  it("put with no TTL omits expirationTtl entirely", async () => {
    const binding = mockKVNamespace();
    const putSpy = vi.spyOn(binding, "put");
    const kv = cloudflareKv(binding);
    await kv.put("k", "v");
    expect(putSpy).toHaveBeenCalledWith("k", "v");
  });

  it("put with a TTL >= 60 passes it through", async () => {
    const binding = mockKVNamespace();
    const putSpy = vi.spyOn(binding, "put");
    const kv = cloudflareKv(binding);
    await kv.put("k", "v", { expirationTtl: 3600 });
    expect(putSpy).toHaveBeenCalledWith("k", "v", { expirationTtl: 3600 });
  });

  it("clamps a sub-60s TTL up to KV's 60s floor", async () => {
    const binding = mockKVNamespace();
    const putSpy = vi.spyOn(binding, "put");
    const kv = cloudflareKv(binding);
    await kv.put("k", "v", { expirationTtl: 10 });
    expect(putSpy).toHaveBeenCalledWith("k", "v", { expirationTtl: 60 });
  });

  it("list returns the flattened key names under a prefix", async () => {
    const kv = cloudflareKv(mockKVNamespace());
    await kv.put("route:app", "1");
    await kv.put("route:api", "2");
    await kv.put("other:x", "3");
    expect((await kv.list!("route:")).sort()).toEqual(["route:api", "route:app"]);
  });
});
