import { describe, it, expect, vi } from "vitest";
import { memoryStorage, memorySessionStore } from "../../../src/adapter/node/index";

describe("memoryStorage", () => {
  it("put/get/delete round-trips the exact bytes written", async () => {
    const storage = memoryStorage();
    const data = new TextEncoder().encode("hello frogcp");

    await storage.put("greeting.txt", data);
    expect(await storage.get("greeting.txt")).toEqual(data);

    await storage.delete("greeting.txt");
    expect(await storage.get("greeting.txt")).toBeNull();
  });

  it("get on a key that was never written returns null", async () => {
    const storage = memoryStorage();
    expect(await storage.get("never-written")).toBeNull();
  });

  it("put overwrites an existing value at the same key", async () => {
    const storage = memoryStorage();
    await storage.put("k", new Uint8Array([1, 2, 3]));
    await storage.put("k", new Uint8Array([4, 5]));
    expect(await storage.get("k")).toEqual(new Uint8Array([4, 5]));
  });

  it("delete on a missing key is a harmless no-op", async () => {
    const storage = memoryStorage();
    await expect(storage.delete("missing")).resolves.toBeUndefined();
  });
});

describe("memorySessionStore", () => {
  it("set/get/delete round-trips the value", async () => {
    const store = memorySessionStore();
    await store.set("session-1", "the-value", 60);
    expect(await store.get("session-1")).toBe("the-value");

    await store.delete("session-1");
    expect(await store.get("session-1")).toBeNull();
  });

  it("get on a key that was never set returns null", async () => {
    const store = memorySessionStore();
    expect(await store.get("never-set")).toBeNull();
  });

  it("a value is gone once its TTL has elapsed", async () => {
    vi.useFakeTimers();
    try {
      const store = memorySessionStore();
      await store.set("expiring", "value", 10);
      expect(await store.get("expiring")).toBe("value");

      vi.advanceTimersByTime(10_001);
      expect(await store.get("expiring")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("delete on a missing key is a harmless no-op", async () => {
    const store = memorySessionStore();
    await expect(store.delete("missing")).resolves.toBeUndefined();
  });
});
