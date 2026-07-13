import type { KvStore, KvPutOptions } from "frogcp";

// KV's documented minimum expirationTtl. A shorter TTL is clamped up to this
// floor, since KV rejects anything below it.
const KV_MIN_TTL_SECONDS = 60;

/**
 * Builds a frogCP KvStore backed by a Cloudflare KVNamespace binding, the
 * production backend for frogcp/kv. Usable standalone, without the kernel.
 *
 * A put with no expirationTtl stores a persistent entry; a sub-60s TTL is
 * clamped up to KV's 60s floor. KV is eventually consistent across colos (a
 * write can take up to ~60s to be globally visible), so use D1 for anything
 * needing strong consistency.
 */
export function cloudflareKv(kv: KVNamespace): KvStore {
  return {
    async get(key: string): Promise<string | null> {
      return await kv.get(key, "text");
    },
    async put(key: string, value: string, opts?: KvPutOptions): Promise<void> {
      if (opts?.expirationTtl === undefined) {
        await kv.put(key, value);
        return;
      }
      await kv.put(key, value, { expirationTtl: Math.max(opts.expirationTtl, KV_MIN_TTL_SECONDS) });
    },
    async delete(key: string): Promise<void> {
      await kv.delete(key);
    },
    async list(prefix: string): Promise<string[]> {
      // Single page, best-effort. A prefix spanning more than one page is
      // truncated; callers needing exhaustive listing must paginate via the
      // binding directly.
      const result = await kv.list({ prefix });
      return result.keys.map((k) => k.name);
    },
  };
}
