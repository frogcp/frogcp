import type { StorageAdapter } from "frogcp";

/**
 * An in-process, `Map`-backed reference implementation of `StorageAdapter`,
 * useful for tests and local dev, not for production (nothing here survives a
 * process restart, and it isn't shared across workers/processes). No `url()` is
 * implemented: an in-memory store has no externally-servable address, so the
 * field is left absent (callers should treat a missing `url()` the same as one
 * that returns `undefined`).
 */
export function memoryStorage(): StorageAdapter {
  const store = new Map<string, Uint8Array>();

  return {
    async put(key: string, data: Uint8Array): Promise<void> {
      store.set(key, data);
    },
    async get(key: string): Promise<Uint8Array | null> {
      return store.get(key) ?? null;
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
  };
}
