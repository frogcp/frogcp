import type { SessionStore } from "frogcp";

// KV's documented minimum expirationTtl. A shorter ttlSeconds is clamped up to
// this floor, since KV rejects anything below it.
const KV_MIN_TTL_SECONDS = 60;

/**
 * Builds a frogCP SessionStore backed by a Cloudflare KVNamespace binding.
 *
 * KV enforces a 60-second minimum expirationTtl, so a set() asking for a
 * shorter-lived value still stores, but expires no sooner than 60s from now.
 * Callers relying on sub-minute expiry precision should use a different
 * SessionStore. KV is also eventually consistent across edge locations (a write
 * can take up to ~60s to be visible elsewhere); reads and writes from the same
 * location are immediately consistent.
 */
export function kvSessionStore(kv: KVNamespace): SessionStore {
  return {
    async get(key: string): Promise<string | null> {
      return await kv.get(key);
    },
    async set(key: string, value: string, ttlSeconds: number): Promise<void> {
      await kv.put(key, value, { expirationTtl: Math.max(ttlSeconds, KV_MIN_TTL_SECONDS) });
    },
    async delete(key: string): Promise<void> {
      await kv.delete(key);
    },
  };
}
