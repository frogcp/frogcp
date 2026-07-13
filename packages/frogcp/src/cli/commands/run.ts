import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { buildBackend, type App, type Backend, type BackendConfig, type RuntimeContext } from "frogcp";
import { loadBackendConfig } from "./generate";

export interface RunOptions {
  /** Path to the user's `frogcp.config.ts`, resolved against `process.cwd()`. Defaults to `./frogcp.config.ts`. */
  config?: string;
  /**
   * SQLite database file, resolved against `process.cwd()`. Defaults to
   * `./data.sqlite` for `run` / `./dev.sqlite` for `dev`. Pass `:memory:` for
   * an ephemeral in-process database.
   */
  db?: string;
  /**
   * Port to listen on. Defaults to 3000. Pass `0` to let the OS assign a free
   * port; the actual port is reported back on `RunResult`.
   */
  port?: number;
  /**
   * Boot in managed mode (schema lives in the `__frogcp_schema` table, editable
   * at runtime) instead of the default code mode (`frogcp.config.ts` is
   * authoritative).
   */
  managed?: boolean;
}

/** What `runCommand`/`devCommand` hand back: enough to test against a live server and shut it down deterministically. */
export interface RunResult {
  backend: Backend;
  /** The actual port the server is listening on (relevant when `RunOptions.port` was `0`). */
  port: number;
  /** `http://localhost:<port>`, the base URL the server is reachable at. */
  url: string;
  /** The underlying `@hono/node-server` handle, exposed for callers that need lower-level access. */
  server: ServerType;
  /** Stops accepting new connections and resolves once the server has fully closed. */
  close: () => Promise<void>;
}

/**
 * The core REST routes every frogCP backend exposes, printed as a quick
 * reference on `run`/`dev` boot. Static rather than introspected: it is the
 * same shape for every backend (per-entity routes live under the `:name`
 * wildcard), so keeping it static means it never goes stale.
 */
const CORE_ROUTES = [
  "GET    /api/entity/:name          list (filter/sort/paginate/relations)",
  "POST   /api/entity/:name          create",
  "GET    /api/entity/:name/:id      read one (?with=rel1,rel2)",
  "PATCH  /api/entity/:name/:id      update",
  "DELETE /api/entity/:name/:id      delete",
  "GET    /api/system/schema         entities + fields",
  "GET    /api/system/health         liveness check",
];

interface BootDefaults {
  /** Default db file relative to cwd when `RunOptions.db` is not given. */
  dbFile: string;
  label: "run" | "dev";
}

/**
 * Shared boot logic behind `frogcp run` and `frogcp dev`: loads the user's
 * `frogcp.config.ts` (or, when none exists, falls back to an empty managed-mode
 * schema for a zero-config first run), boots a backend over a `node:sqlite`
 * database through the shared serve core (`buildBackend`), and serves it with
 * `@hono/node-server`. Returns a `close()` handle instead of blocking forever:
 * the entrypoint wires `SIGINT` around the result, and tests call `close()`
 * directly so a server never leaks past its own test.
 *
 * Deliberately loads no plugins (auth/media/admin): `frogcp.config.ts` is only
 * ever a `BackendConfig` (entities), never a plugin list, so the CLI has no way
 * to know which plugins an app wants. `run`/`dev` boot the plain entity CRUD +
 * permissions core, which is the fastest way to try a schema; a project that
 * needs auth/media/admin wires and runs its own entry point instead.
 */
async function boot(options: RunOptions, defaults: BootDefaults): Promise<RunResult> {
  const explicitConfig = options.config !== undefined;
  const configPath = resolve(process.cwd(), options.config ?? "./frogcp.config.ts");

  // Zero-config first run: with no `frogcp.config.ts` present and no explicit
  // `--config`, boot an empty schema in managed mode (editable at runtime via
  // `POST /api/system/schema`) so `npx frogcp run` yields an instant,
  // shape-it-live backend. An explicit `--config` pointing at a missing file is
  // still a loud error via `loadBackendConfig`.
  const zeroConfig = !explicitConfig && !existsSync(configPath);
  const config: BackendConfig = zeroConfig ? { entities: {} } : await loadBackendConfig(configPath);

  const dbOption = options.db ?? defaults.dbFile;
  const dbPath = dbOption === ":memory:" ? dbOption : resolve(process.cwd(), dbOption);
  const connection = dbOption === ":memory:" ? ":memory:" : `file:${dbPath}`;

  // Zero-config implies managed mode (there is no code schema to be authoritative).
  const mode = options.managed || zeroConfig ? "managed" : "code";

  // Route the boot through the shared serve core, the one place a backend is
  // assembled from an App descriptor. The node runtime context has no
  // Cloudflare env; `process.env` is the effective env.
  const ctx: RuntimeContext = {
    onCloudflare: false,
    cloudflareEnv: undefined,
    env: process.env as unknown as Record<string, unknown>,
  };
  const app: App = { config, connection, mode };
  const backend = await buildBackend(app, ctx);

  const requestedPort = options.port ?? 3000;
  const { server, port } = await new Promise<{ server: ServerType; port: number }>((resolvePromise) => {
    const s = serve({ fetch: backend.fetch, port: requestedPort }, (info) => {
      resolvePromise({ server: s, port: info.port });
    });
  });

  const url = `http://localhost:${port}`;

  console.log(`frogcp ${defaults.label}: serving ${url}  (db: ${dbPath}, mode: ${mode})`);
  if (zeroConfig) {
    console.log(
      "No frogcp.config.ts found. Booting an EMPTY schema in managed mode. Define entities " +
        "at runtime via POST /api/system/schema (or add a frogcp.config.ts for code mode).",
    );
  }
  if (defaults.label === "dev") {
    console.log(
      "Dev mode: edit frogcp.config.ts, then stop (Ctrl-C) and re-run `frogcp dev` to apply " +
        "changes. There is no file-watch/auto-restart yet (a documented v1 limitation).",
    );
  }
  console.log("Routes:");
  for (const route of CORE_ROUTES) console.log(`  ${route}`);
  if (mode === "managed") {
    console.log(
      "  (managed mode: schema is stored in __frogcp_schema and editable via " +
        "POST /api/system/schema)",
    );
  }

  const close = (): Promise<void> =>
    new Promise((resolveClose, rejectClose) => {
      server.close((err) => (err ? rejectClose(err) : resolveClose()));
    });

  return { backend, port, url, server, close };
}

/**
 * `frogcp run` boots `frogcp.config.ts` against a real `node:sqlite` file
 * (default `./data.sqlite`) and serves it on `--port` (default 3000). Meant for
 * production/staging use of the plain entity API; see `boot` for why plugins
 * are not loaded here.
 */
export async function runCommand(options: RunOptions = {}): Promise<RunResult> {
  return boot(options, { dbFile: "./data.sqlite", label: "run" });
}

/**
 * `frogcp dev` is identical to `runCommand`, except it defaults to a separate
 * `./dev.sqlite` database (so a dev run never touches `./data.sqlite`) and
 * prints a dev-mode banner. There is no file-watcher in this v1: a flaky
 * watcher would be worse than none, so `dev` is honestly "restart required".
 */
export async function devCommand(options: RunOptions = {}): Promise<RunResult> {
  return boot(options, { dbFile: "./dev.sqlite", label: "dev" });
}
