/**
 * Files for `frogcp create <name> --template cloudflare`. A trimmed-down mirror
 * of `examples/cloudflare/` (same entity) with `workspace:*` dependencies
 * replaced by real semver ranges and the D1/R2/KV IDs left as placeholders for
 * the user to fill in after running the resource-creation `wrangler` commands
 * noted in the generated README.
 */
export function cloudflareTemplate(name: string): Record<string, string> {
  return {
    "package.json":
      JSON.stringify(
        {
          name,
          version: "0.0.1",
          private: true,
          type: "module",
          scripts: {
            dev: "wrangler dev",
            deploy: "wrangler deploy",
            typecheck: "tsc -p tsconfig.json --noEmit",
          },
          dependencies: {
            frogcp: "^0.0.1",
          },
          devDependencies: {
            "@cloudflare/workers-types": "^5.20260706.1",
            typescript: "^6.0.3",
            wrangler: "^4.107.0",
          },
        },
        null,
        2,
      ) + "\n",

    "tsconfig.json":
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2023",
            module: "Preserve",
            moduleResolution: "Bundler",
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            types: ["@cloudflare/workers-types"],
          },
          include: ["frogcp.config.ts", "src"],
        },
        null,
        2,
      ) + "\n",

    "wrangler.jsonc": `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": ${JSON.stringify(name)},
  "main": "src/worker.ts",
  "compatibility_date": "2026-07-01",

  // Placeholders: run \`wrangler d1 create\`, \`wrangler r2 bucket create\`, and
  // \`wrangler kv namespace create\` (see README) and paste the real IDs here
  // before \`wrangler deploy\`. \`wrangler dev\` works fine with these
  // placeholders since Miniflare simulates the bindings locally.
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": ${JSON.stringify(`${name}-db`)},
      "database_id": "REPLACE_WITH_YOUR_D1_DATABASE_ID"
    }
  ],
  "r2_buckets": [
    {
      "binding": "BUCKET",
      "bucket_name": ${JSON.stringify(`${name}-media`)}
    }
  ],
  "kv_namespaces": [
    {
      "binding": "SESSIONS",
      "id": "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"
    }
  ]
}
`,

    "frogcp.config.ts": `import { defineBackend, entity, text, select, timestamp, ref, rule, role } from "frogcp";

// \`users\` is NOT declared here: \`authPlugin()\` (see src/worker.ts)
// contributes its own \`users\` entity, and the kernel merges plugin
// entities into this config at boot.
export default defineBackend({
  entities: {
    notes: entity({
      title: text().required(),
      body: text(),
      status: select(["draft", "published"]).default("draft"),
      owner: ref("users").onDelete("cascade"),
      createdAt: timestamp().auto(),
    }).permissions({
      read: rule.owner("owner"),
      list: rule.owner("owner").or(role("admin")),
      create: rule.authenticated(),
      update: rule.owner("owner"),
      delete: rule.owner("owner").or(role("admin")),
    }),
  },
  // Deploy resources the frogCP control plane should provision for this app
  // (\`frogcp deploy\`). Declare exactly what you use (a D1 database bound as
  // \`env.DB\` here) and add \`kv\`/\`r2\`/\`ai\` bindings alongside as needed.
  // (This is separate from \`wrangler.jsonc\`, which wires bindings for
  // \`wrangler deploy\`/\`wrangler dev\`.)
  resources: { d1: { DB: {} } },
});
`,

    "src/worker.ts": `import { createWorkerHandler, d1Adapter, r2Storage, kvSessionStore, type WorkerHandler } from "frogcp/adapter/cloudflare";
import { authPlugin } from "frogcp/auth";
import config from "../frogcp.config";

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  SESSIONS: KVNamespace;
  /** Set via \`wrangler secret put AUTH_SECRET\` (>=32 chars) before deploying. */
  AUTH_SECRET: string;
}

// The Workers runtime only hands \`env\` (and so AUTH_SECRET) over on the
// first \`fetch()\` call, never at module-eval time, so the handler is
// built lazily per distinct \`env\`, cached by reference.
const handlerByEnv = new WeakMap<object, WorkerHandler<Env>>();

function getHandler(env: Env): WorkerHandler<Env> {
  let handler = handlerByEnv.get(env);
  if (!handler) {
    handler = createWorkerHandler<Env>({
      config,
      plugins: [authPlugin({ secret: env.AUTH_SECRET })],
      resolve: (e) => ({
        adapter: d1Adapter(e.DB),
        storage: r2Storage(e.BUCKET),
        sessions: kvSessionStore(e.SESSIONS),
      }),
    });
    handlerByEnv.set(env, handler);
  }
  return handler;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return getHandler(env).fetch(request, env, ctx);
  },
};
`,

    "README.md": `# ${name}

Scaffolded with \`frogcp create ${name} --template cloudflare\`.

## Setup

1. \`wrangler d1 create ${name}-db\`, \`wrangler r2 bucket create ${name}-media\`,
   \`wrangler kv namespace create SESSIONS\`: paste the resulting IDs into
   \`wrangler.jsonc\`.
2. \`wrangler secret put AUTH_SECRET\` (a random string, >=32 characters).
3. \`npm install\` (or pnpm/yarn).
4. \`npm run dev\` to run locally, \`npm run deploy\` to ship.

## What's here

- \`frogcp.config.ts\`: your schema (entities, fields, permissions).
- \`src/worker.ts\`: the Worker entry point, wiring D1/R2/KV bindings to
  frogCP's Cloudflare adapters.
- \`wrangler.jsonc\`: bindings + deploy config.
`,
  };
}
