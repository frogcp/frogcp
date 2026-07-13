import { describe, it, expect, vi } from "vitest";
import { kvSessionStore } from "../../../src/adapter/cloudflare/session";

/**
 * A minimal in-memory stand-in for the KVNamespace binding shape, enough for
 * kvSessionStore's get/set/delete/TTL-clamping logic to run without a real
 * Workers runtime. Ignores actual TTL expiry (that behavior is KV's own); the
 * adapter's job is to compute and pass the right expirationTtl, which is what
 * these tests check.
 */
function mockKVNamespace(): KVNamespace {
  const store = new Map<string, { value: string; expirationTtl?: number }>();

  return {
    async get(key: string) {
      return store.get(key)?.value ?? null;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      store.set(key, { value, ...(options?.expirationTtl !== undefined ? { expirationTtl: options.expirationTtl } : {}) });
    },
    async delete(key: string) {
      store.delete(key);
    },
    _peekTtl(key: string) {
      return store.get(key)?.expirationTtl;
    },
  } as unknown as KVNamespace & { _peekTtl(key: string): number | undefined };
}

describe("kvSessionStore", () => {
  it("set/get/delete round-trips the value", async () => {
    const store = kvSessionStore(mockKVNamespace());
    await store.set("session-1", "the-value", 3600);
    expect(await store.get("session-1")).toBe("the-value");

    await store.delete("session-1");
    expect(await store.get("session-1")).toBeNull();
  });

  it("get on a key that was never set returns null", async () => {
    const store = kvSessionStore(mockKVNamespace());
    expect(await store.get("never-set")).toBeNull();
  });

  it("delete on a missing key is a harmless no-op", async () => {
    const store = kvSessionStore(mockKVNamespace());
    await expect(store.delete("missing")).resolves.toBeUndefined();
  });

  it("passes ttlSeconds through unchanged when it's already >= KV's 60s floor", async () => {
    const kv = mockKVNamespace() as ReturnType<typeof mockKVNamespace> & { _peekTtl(key: string): number | undefined };
    const putSpy = vi.spyOn(kv, "put");
    const store = kvSessionStore(kv);

    await store.set("k", "v", 3600);
    expect(putSpy).toHaveBeenCalledWith("k", "v", { expirationTtl: 3600 });
  });

  it("clamps a shorter ttlSeconds up to KV's 60s minimum", async () => {
    const kv = mockKVNamespace() as ReturnType<typeof mockKVNamespace> & { _peekTtl(key: string): number | undefined };
    const putSpy = vi.spyOn(kv, "put");
    const store = kvSessionStore(kv);

    await store.set("k", "v", 10);
    expect(putSpy).toHaveBeenCalledWith("k", "v", { expirationTtl: 60 });
  });
});
