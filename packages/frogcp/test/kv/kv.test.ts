import { describe, expect, test } from "vitest";
import type { KernelContext, KvStore } from "frogcp";
import { nodeKv } from "frogcp/adapter/node";
import { kvPlugin, getJSON, putJSON } from "../../src/kv/index";

describe("kvPlugin", () => {
  test("is a named FrogPlugin whose onBoot sets ctx.kv to the store", async () => {
    const store = nodeKv(":memory:");
    const plugin = kvPlugin(store);
    expect(plugin.name).toBe("kv");

    const ctx = {} as KernelContext;
    await plugin.onBoot!(ctx);
    expect(ctx.kv).toBe(store);
  });

  test("self-skips (returns false) when given no store, so callers need no guard", () => {
    const store: KvStore | undefined = undefined;
    // The whole point: `kvPlugin(store)` where `store` may be undefined can go
    // straight into a `plugins` array; the kernel drops the falsy entry.
    expect(kvPlugin(store)).toBe(false);
  });
});

describe("getJSON / putJSON", () => {
  const store = (): KvStore => nodeKv(":memory:");

  test("getJSON returns null for a missing key", async () => {
    expect(await getJSON(store(), "nope")).toBeNull();
  });

  test("putJSON then getJSON round-trips a structured value", async () => {
    const kv = store();
    await putJSON(kv, "route:app", { slug: "blue", version: 2 });
    expect(await getJSON<{ slug: string; version: number }>(kv, "route:app")).toEqual({ slug: "blue", version: 2 });
  });

  test("putJSON writes valid JSON that raw get can read", async () => {
    const kv = store();
    await putJSON(kv, "k", { a: 1 });
    expect(await kv.get("k")).toBe('{"a":1}');
  });

  test("getJSON returns null (not throw) on a malformed JSON value", async () => {
    const kv = store();
    await kv.put("k", "not json{");
    expect(await getJSON(kv, "k")).toBeNull();
  });

  test("putJSON forwards TTL options", async () => {
    let seenTtl: number | undefined;
    const spyKv: KvStore = {
      get: async () => null,
      put: async (_k, _v, opts) => {
        seenTtl = opts?.expirationTtl;
      },
      delete: async () => {},
    };
    await putJSON(spyKv, "k", { a: 1 }, { expirationTtl: 42 });
    expect(seenTtl).toBe(42);
  });
});
