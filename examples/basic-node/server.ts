import { serve } from "@hono/node-server";
import { adminPlugin } from "@frogcp/admin";
import { memoryStorage, nodeSqliteAdapter } from "frogcp/adapter/node";
import { authPlugin } from "frogcp/auth";
import { mediaPlugin } from "frogcp/media";
import { createBackend } from "frogcp";
import config from "./frogcp.config";

const PORT = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  const backend = await createBackend({
    config,
    adapter: nodeSqliteAdapter("data.sqlite"),
    // Uploaded bytes live in memory and do not survive a restart. Swap in a
    // filesystem or R2 backed StorageAdapter for a real deployment.
    storage: memoryStorage(),
    plugins: [
      authPlugin({
        // Set FROGCP_SECRET in any real deployment. The fallback only exists so
        // `pnpm dev` works out of the box.
        secret: process.env.FROGCP_SECRET ?? "dev-secret-do-not-use-in-production!!",
        emailPassword: true,
        // Set secureCookies once this is served over HTTPS.
      }),
      mediaPlugin(),
      adminPlugin(),
    ],
  });

  serve({ fetch: backend.fetch, port: PORT }, (info) => {
    console.log(`frogCP basic-node example listening on http://localhost:${info.port}`);
    console.log(`admin UI: http://localhost:${info.port}/admin`);
  });
}

void main();
