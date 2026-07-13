import { Miniflare } from "miniflare";

export interface MiniflareEnv {
  mf: Miniflare;
  d1: D1Database;
  r2: R2Bucket;
  kv: KVNamespace;
}

/**
 * Spins up a real Workers runtime (workerd, via Miniflare) with D1, R2, and KV
 * bindings, and returns the bound objects directly, so tests exercise the same
 * D1Database/R2Bucket/KVNamespace shapes a deployed Worker's env carries rather
 * than a hand-rolled mock.
 *
 * Returns null (with a console.log naming the reason) if workerd can't start in
 * this environment, so callers can describe.skipIf the suite rather than report
 * a false pass. This mirrors the postgres adapter's startEphemeralPostgres
 * honesty gate. workerd builds fine on GitHub Actions ubuntu; this fallback is
 * only for environments that can't spawn it.
 */
export async function tryStartMiniflareEnv(): Promise<MiniflareEnv | null> {
  try {
    const mf = new Miniflare({
      modules: true,
      script: `export default { async fetch() { return new Response("ok"); } }`,
      d1Databases: { DB: "frogcp-test-db" },
      r2Buckets: { BUCKET: "frogcp-test-bucket" },
      kvNamespaces: { KV: "frogcp-test-kv" },
    });
    const d1 = await mf.getD1Database("DB");
    // getR2Bucket/getKVNamespace return Miniflare's ReplaceWorkersTypes<T>
    // wrapper, which does not structurally unify with the ambient
    // R2Bucket/KVNamespace under this repo's strict tsconfig even though the
    // runtime objects implement the real binding behavior. getD1Database needs
    // no cast: it returns a plain D1Database.
    const r2 = (await mf.getR2Bucket("BUCKET")) as unknown as R2Bucket;
    const kv = (await mf.getKVNamespace("KV")) as unknown as KVNamespace;
    return { mf, d1, r2, kv };
  } catch (error) {
    console.log(
      "[adapter-cloudflare] Skipping Miniflare/workerd-backed test suite: workerd could not be " +
        `started in this environment (${error instanceof Error ? error.message : String(error)}). ` +
        "Verify manually with `wrangler dev` against a Worker with real D1/R2/KV bindings.",
    );
    return null;
  }
}

/**
 * Drops every user table on d1, keeping sqlite's own sqlite_% catalog tables
 * and D1's internal _cf_% bookkeeping table (D1 refuses to drop _cf_METADATA,
 * failing with SQLITE_AUTH). Lets one Miniflare instance's D1 binding be reused,
 * isolated, across many test cases without a fresh workerd process per test.
 * D1 bindings are declared statically in Miniflare's constructor, so we wipe
 * between tests rather than creating a fresh database each time.
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
