import type { SessionStore } from "frogcp";

interface Entry {
  value: string;
  expiresAt: number; // epoch ms
}

/**
 * An in-process, `Map`-backed reference implementation of `SessionStore`,
 * useful for tests and local dev, not for production (nothing here survives a
 * process restart, and it isn't shared across workers/processes). Expiry is
 * checked lazily on `get` against `Date.now()`; an expired entry is evicted the
 * first time it's looked up rather than via a background timer, so entries that
 * are never read again accumulate until read or deleted, which is fine for the
 * dev/test use case this targets.
 */
export function memorySessionStore(): SessionStore {
  const store = new Map<string, Entry>();

  return {
    async get(key: string): Promise<string | null> {
      const entry = store.get(key);
      if (!entry) return null;
      if (Date.now() >= entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key: string, value: string, ttlSeconds: number): Promise<void> {
      store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
  };
}
