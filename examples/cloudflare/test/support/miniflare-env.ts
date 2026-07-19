import { Miniflare } from "miniflare";

export interface MiniflareEnv {
  mf: Miniflare;
  d1: D1Database;
  r2: R2Bucket;
  kv: KVNamespace;
}

/**
 * Starts a real Workers runtime (workerd, through Miniflare) with the same
 * D1/R2/KV binding names this example declares in `wrangler.jsonc`, so the e2e
 * suite drives the worker against genuine bindings rather than mocks.
 *
 * Returns `null`, and says why, when workerd cannot start here, so the suite
 * can skip honestly instead of reporting a false pass.
 */
export async function tryStartMiniflareEnv(): Promise<MiniflareEnv | null> {
  try {
    const mf = new Miniflare({
      modules: true,
      script: `export default { async fetch() { return new Response("ok"); } }`,
      d1Databases: { DB: "frogcp-example-db" },
      r2Buckets: { BUCKET: "frogcp-example-bucket" },
      kvNamespaces: { SESSIONS: "frogcp-example-sessions" },
    });
    const d1 = await mf.getD1Database("DB");
    // Miniflare returns its own `ReplaceWorkersTypes<T>` wrappers for R2 and
    // KV, which do not structurally match the ambient binding types the worker
    // is written against even though the runtime objects behave identically.
    // `getD1Database` already returns a plain `D1Database`.
    const r2 = (await mf.getR2Bucket("BUCKET")) as unknown as R2Bucket;
    const kv = (await mf.getKVNamespace("SESSIONS")) as unknown as KVNamespace;
    return { mf, d1, r2, kv };
  } catch (error) {
    console.log(
      "[example-cloudflare] Skipping the Miniflare-backed e2e tests: workerd could not start here " +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        "Verify manually with `wrangler dev` instead, see the README's local dev section.",
    );
    return null;
  }
}

/**
 * Drops every user table so one Miniflare instance can be reused across tests
 * without paying for a fresh workerd process each time. Sqlite's own catalog
 * and D1's `_cf_%` bookkeeping tables are left alone.
 */
export async function resetD1(d1: D1Database): Promise<void> {
  const { results } = await d1
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`,
    )
    .all<{ name: string }>();
  for (const { name } of results) {
    await d1.exec(`DROP TABLE "${name}"`);
  }
}
