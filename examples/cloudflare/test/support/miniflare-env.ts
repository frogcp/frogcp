import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

const exampleDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const frogcpBin = join(exampleDir, "..", "..", "packages", "frogcp", "dist", "cli", "index.js");

/**
 * Runs the real `frogcp schema` binary against this example's config, exactly
 * as the README's deploy steps do, and applies the DDL to `d1`. The Worker
 * ships with `migrate: false` because D1 cannot migrate itself, so this is the
 * only way its schema ever gets created, in tests, in local dev, and in
 * production alike.
 *
 * `AUTH_SECRET` is deliberately cleared: generating schema must never need a
 * secret, and this asserts that stays true.
 */
export async function applyExampleSchema(d1: D1Database): Promise<void> {
  const env = { ...process.env };
  delete env.AUTH_SECRET;
  const sql = execFileSync(process.execPath, [frogcpBin, "schema"], { cwd: exampleDir, encoding: "utf8", env });

  // D1's `exec` splits on newlines, and drizzle-kit emits multi-line CREATE
  // TABLE, so each statement goes through `prepare` instead.
  for (const statement of sql.split(/;\s*\n/)) {
    const trimmed = statement.trim().replace(/;$/, "");
    if (trimmed) await d1.prepare(trimmed).run();
  }
}

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
