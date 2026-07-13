import { DatabaseSync } from "node:sqlite";
import type { KvStore, KvPutOptions } from "frogcp";

export interface NodeKvOptions {
  /** Clock, in epoch-ms, injectable so TTL behavior is testable without real
   * time. Defaults to `Date.now`. */
  now?: () => number;
}

/** Escapes the LIKE wildcards (`%`, `_`) and the escape char itself in a
 * prefix, so a key prefix containing them is matched literally under
 * `LIKE ? ESCAPE '\'`. */
function escapeLike(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * A `KvStore` backed by Node's builtin `node:sqlite`, the CF-free local-dev and
 * test backend for `frogcp/kv` and the KV sibling of this package's
 * `nodeSqliteAdapter` data layer. Node-only (Workers use the Cloudflare KV
 * binding instead).
 *
 * One table `kv (key PRIMARY KEY, value, expires_at)`. TTL is enforced on read
 * (an expired row reads as absent and is lazily deleted) and swept
 * opportunistically on every write, so expired rows don't accumulate without a
 * background timer. Use `":memory:"` for an ephemeral store.
 */
export function nodeKv(path: string, opts: NodeKvOptions = {}): KvStore {
  const now = opts.now ?? Date.now;
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)");

  const sweep = () => {
    db.prepare("DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?").run(now());
  };

  return {
    async get(key: string): Promise<string | null> {
      const row = db.prepare("SELECT value, expires_at FROM kv WHERE key = ?").get(key) as
        | { value: string; expires_at: number | null }
        | undefined;
      if (!row) return null;
      if (row.expires_at !== null && row.expires_at <= now()) {
        db.prepare("DELETE FROM kv WHERE key = ?").run(key); // lazy delete of an expired row
        return null;
      }
      return row.value;
    },

    async put(key: string, value: string, putOpts?: KvPutOptions): Promise<void> {
      sweep();
      const expiresAt = putOpts?.expirationTtl !== undefined ? now() + putOpts.expirationTtl * 1000 : null;
      db.prepare(
        "INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
      ).run(key, value, expiresAt);
    },

    async delete(key: string): Promise<void> {
      db.prepare("DELETE FROM kv WHERE key = ?").run(key);
    },

    async list(prefix: string): Promise<string[]> {
      const rows = db
        .prepare("SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\' AND (expires_at IS NULL OR expires_at > ?)")
        .all(`${escapeLike(prefix)}%`, now()) as { key: string }[];
      return rows.map((r) => r.key);
    },
  };
}
