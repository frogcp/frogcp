import { describe, it, expect, vi } from "vitest";
import { r2Storage } from "../../../src/adapter/cloudflare/storage";

/**
 * A minimal in-memory stand-in for the R2Bucket binding shape, enough for
 * r2Storage's put/get/delete logic to run without a real Workers runtime. This
 * is the coverage that holds without workerd: it verifies r2Storage's own logic
 * (byte round-tripping, httpMetadata wiring, null-on-missing-key) in isolation.
 * miniflare-integration.test.ts covers the same adapter against a real R2Bucket
 * binding; this file keeps the logic covered even where workerd can't run.
 */
function mockR2Bucket(): R2Bucket {
  const store = new Map<string, { data: Uint8Array; httpMetadata?: { contentType?: string } }>();

  return {
    async put(key: string, value: unknown, options?: { httpMetadata?: { contentType?: string } }) {
      const data = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
      store.set(key, { data, ...(options?.httpMetadata ? { httpMetadata: options.httpMetadata } : {}) });
      return undefined as never;
    },
    async get(key: string) {
      const entry = store.get(key);
      if (!entry) return null;
      return {
        httpMetadata: entry.httpMetadata,
        async arrayBuffer() {
          return entry.data.buffer.slice(
            entry.data.byteOffset,
            entry.data.byteOffset + entry.data.byteLength,
          ) as ArrayBuffer;
        },
      } as unknown as R2ObjectBody;
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as R2Bucket;
}

describe("r2Storage", () => {
  it("put/get round-trips the exact bytes written", async () => {
    const storage = r2Storage(mockR2Bucket());
    const data = new TextEncoder().encode("hello frogcp");

    await storage.put("greeting.txt", data);
    expect(await storage.get("greeting.txt")).toEqual(data);
  });

  it("delete removes the object; a subsequent get returns null", async () => {
    const storage = r2Storage(mockR2Bucket());
    await storage.put("k", new Uint8Array([1, 2, 3]));
    await storage.delete("k");
    expect(await storage.get("k")).toBeNull();
  });

  it("get on a key that was never written returns null", async () => {
    const storage = r2Storage(mockR2Bucket());
    expect(await storage.get("never-written")).toBeNull();
  });

  it("put overwrites an existing value at the same key", async () => {
    const storage = r2Storage(mockR2Bucket());
    await storage.put("k", new Uint8Array([1, 2, 3]));
    await storage.put("k", new Uint8Array([4, 5]));
    expect(await storage.get("k")).toEqual(new Uint8Array([4, 5]));
  });

  it("delete on a missing key is a harmless no-op", async () => {
    const storage = r2Storage(mockR2Bucket());
    await expect(storage.delete("missing")).resolves.toBeUndefined();
  });

  it("passes contentType through as R2 httpMetadata", async () => {
    const bucket = mockR2Bucket();
    const putSpy = vi.spyOn(bucket, "put");
    const storage = r2Storage(bucket);

    await storage.put("k", new Uint8Array([1]), { contentType: "image/png" });
    expect(putSpy).toHaveBeenCalledWith("k", expect.any(Uint8Array), {
      httpMetadata: { contentType: "image/png" },
    });
  });

  it("omits httpMetadata entirely when no contentType is given", async () => {
    const bucket = mockR2Bucket();
    const putSpy = vi.spyOn(bucket, "put");
    const storage = r2Storage(bucket);

    await storage.put("k", new Uint8Array([1]));
    expect(putSpy).toHaveBeenCalledWith("k", expect.any(Uint8Array), undefined);
  });

  it("url() is not implemented: R2 has no servable URL without external setup", () => {
    const storage = r2Storage(mockR2Bucket());
    expect(storage.url).toBeUndefined();
  });
});
