/**
 * Files for `frogcp create <name> --template basic-node` (also the default
 * template). A trimmed-down mirror of `examples/basic-node/` (same entity, same
 * plugin wiring) but with `workspace:*` dependencies replaced by real semver
 * ranges so the scaffolded project is installable standalone.
 */
export function basicNodeTemplate(name: string): Record<string, string> {
  return {
    "package.json":
      JSON.stringify(
        {
          name,
          version: "0.0.1",
          private: true,
          type: "module",
          scripts: {
            dev: "tsx server.ts",
            typecheck: "tsc -p tsconfig.json --noEmit",
          },
          dependencies: {
            "@frogcp/admin": "^0.0.1",
            "@hono/node-server": "^2.0.8",
            frogcp: "^0.0.1",
            hono: "^4.12.27",
          },
          devDependencies: {
            "@types/node": "^26.1.0",
            tsx: "^4.23.0",
            typescript: "^6.0.3",
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
            types: ["node"],
          },
          include: ["frogcp.config.ts", "server.ts"],
        },
        null,
        2,
      ) + "\n",

    "frogcp.config.ts": `import { defineBackend, entity, text, select, timestamp, ref, rule, role } from "frogcp";

// \`users\` is NOT declared here: \`authPlugin()\` (see server.ts) contributes
// its own \`users\` entity (email/password + role), and the kernel merges
// plugin entities into this config at boot. \`owner: ref("users")\` below
// resolves against that plugin-provided entity.
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
  resources: { d1: { DB: {} } },
});
`,

    "server.ts": `import { serve } from "@hono/node-server";
import { adminPlugin } from "@frogcp/admin";
import { memoryStorage, nodeSqliteAdapter } from "frogcp/adapter/node";
import { authPlugin } from "frogcp/auth";
import { createBackend } from "frogcp";
import config from "./frogcp.config";

async function main(): Promise<void> {
  const adapter = nodeSqliteAdapter("data.sqlite");
  const backend = await createBackend({
    config,
    adapter,
    storage: memoryStorage(),
    plugins: [
      authPlugin({
        // A real deployment MUST set FROGCP_SECRET (>=32 chars) itself. The
        // fallback below only exists so \`pnpm dev\` works out of the box; it is
        // NOT a secret suitable for production.
        secret: process.env.FROGCP_SECRET ?? "dev-secret-do-not-use-in-production!!",
        emailPassword: true,
      }),
      adminPlugin(), // GET /admin: data browser / users / permissions / schema / media UI
    ],
  });

  serve({ fetch: backend.fetch, port: 3000 }, (info) => {
    console.log(\`${name} listening on http://localhost:\${info.port}\`);
  });
}

void main();
`,

    "README.md": `# ${name}

Scaffolded with \`frogcp create ${name} --template basic-node\`.

## Get started

\`\`\`sh
cd ${name}
npm install   # or pnpm install / yarn install
npm run dev   # runs server.ts with tsx
\`\`\`

Then open http://localhost:3000/admin.

## What's here

- \`frogcp.config.ts\`: your schema (entities, fields, permissions). Edit this,
  then run \`frogcp generate\` to refresh \`frogcp.gen.d.ts\` and see the pending
  migration.
- \`server.ts\`: boots the backend on Node with a local SQLite file
  (\`data.sqlite\`) and the admin UI mounted at \`/admin\`.

## Next steps

- Set a real \`FROGCP_SECRET\` (>=32 chars) before deploying.
- Run \`frogcp generate --apply --db data.sqlite\` to apply schema changes.
- Swap \`memoryStorage()\` for a persistent \`StorageAdapter\` before deploying.
`,
  };
}
