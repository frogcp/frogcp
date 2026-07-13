import type { StorageAdapter } from "frogcp";

/**
 * Builds a frogCP StorageAdapter backed by a Cloudflare R2Bucket binding.
 *
 * get normalizes R2's R2ObjectBody to Uint8Array by reading the whole object
 * into memory via arrayBuffer(), matching every other StorageAdapter here.
 *
 * url() is left undefined: R2 objects have no public URL of their own. Serving
 * one needs a bucket bound to a custom domain, or a signed URL minted through
 * R2's S3-compatible API with credentials this binding does not carry, both of
 * which are deployment-specific. Front the bucket with a Worker route or a
 * bound custom domain instead.
 */
export function r2Storage(bucket: R2Bucket): StorageAdapter {
  return {
    async put(key: string, data: Uint8Array, meta?: { contentType?: string }): Promise<void> {
      await bucket.put(key, data, meta?.contentType ? { httpMetadata: { contentType: meta.contentType } } : undefined);
    },
    async get(key: string): Promise<Uint8Array | null> {
      const object = await bucket.get(key);
      if (!object) return null;
      const buffer = await object.arrayBuffer();
      return new Uint8Array(buffer);
    },
    async delete(key: string): Promise<void> {
      await bucket.delete(key);
    },
  };
}
