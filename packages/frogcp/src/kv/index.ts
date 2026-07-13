import type { FrogPlugin, KernelContext, KvStore, KvPutOptions } from "frogcp";

// The pluggable key/value primitive. The `KvStore` interface lives in core
// (alongside `StorageAdapter`); `nodeKv` and `cloudflareKv` are its backends.
// This module is the kernel integration plus the JSON ergonomics.

/**
 * A plugin that exposes `store` on `KernelContext.kv` in `onBoot`, which runs
 * before any plugin's routes register, so every route can rely on `ctx.kv`.
 *
 * `store` is optional. With nothing to bind, `kvPlugin` returns `false`, a
 * falsy entry the kernel skips, so a caller can pass `kvPlugin(maybeStore)`
 * straight into a `plugins` array with no guard. The overloads keep
 * `kvPlugin(realStore)` typed as a plain `FrogPlugin` for callers that always
 * have one.
 */
export function kvPlugin(store: KvStore): FrogPlugin;
export function kvPlugin(store: KvStore | undefined): FrogPlugin | false;
export function kvPlugin(store: KvStore | undefined): FrogPlugin | false {
  if (!store) return false;
  return {
    name: "kv",
    onBoot(ctx: KernelContext) {
      ctx.kv = store;
    },
  };
}

/**
 * Reads `key` and JSON-parses it, returning `null` when the key is absent or
 * the stored value is not valid JSON. Never throws on a malformed value, so a
 * corrupt or legacy entry degrades to "missing" rather than crashing the caller.
 */
export async function getJSON<T = unknown>(kv: KvStore, key: string): Promise<T | null> {
  const raw = await kv.get(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** JSON-encodes `value` and stores it under `key`, forwarding any TTL options. */
export async function putJSON(kv: KvStore, key: string, value: unknown, opts?: KvPutOptions): Promise<void> {
  await kv.put(key, JSON.stringify(value), opts);
}
