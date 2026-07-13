import { describe, it, expect, afterAll } from "vitest";
import { r2Storage } from "../../../src/adapter/cloudflare/storage";
import { kvSessionStore } from "../../../src/adapter/cloudflare/session";
import { tryStartMiniflareEnv } from "./support/miniflare-env";

/**
 * r2Storage and kvSessionStore against real R2Bucket/KVNamespace bindings (via
 * Miniflare/workerd), on top of storage.test.ts and session.test.ts's
 * mock-based unit tests (which cover the adapters' own logic and stay green
 * even where workerd can't run).
 */
const env = await tryStartMiniflareEnv();

afterAll(async () => {
  await env?.mf.dispose();
});

describe.skipIf(env === null)("r2Storage real R2Bucket binding (miniflare)", () => {
  it("put/get/delete round-trips the exact bytes written", async () => {
    const storage = r2Storage(env!.r2);
    const data = new TextEncoder().encode("hello real r2");

    await storage.put("greeting.txt", data);
    expect(await storage.get("greeting.txt")).toEqual(data);

    await storage.delete("greeting.txt");
    expect(await storage.get("greeting.txt")).toBeNull();
  });

  it("get on a key that was never written returns null", async () => {
    const storage = r2Storage(env!.r2);
    expect(await storage.get("never-written-real")).toBeNull();
  });
});

describe.skipIf(env === null)("kvSessionStore real KVNamespace binding (miniflare)", () => {
  it("set/get/delete round-trips the value", async () => {
    const store = kvSessionStore(env!.kv);
    await store.set("real-session", "the-value", 3600);
    expect(await store.get("real-session")).toBe("the-value");

    await store.delete("real-session");
    expect(await store.get("real-session")).toBeNull();
  });

  it("a ttlSeconds below KV's 60s floor is accepted (clamped), not rejected", async () => {
    // The real binding is the only place that proves the clamp is necessary:
    // KV rejects an expirationTtl below 60 outright, so this would throw here
    // if kvSessionStore forwarded the raw ttlSeconds instead of clamping it.
    const store = kvSessionStore(env!.kv);
    await expect(store.set("short-lived", "v", 5)).resolves.toBeUndefined();
    expect(await store.get("short-lived")).toBe("v");
  });
});
