import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import * as esbuild from "esbuild";
import { CliError } from "../errors";
import { loadBackendConfig } from "./generate";

/** A placeholder default control-plane URL for a self-hosted/pre-launch setup;
 * every real deploy overrides it via `--control-plane` or `FROGCP_CONTROL_PLANE`. */
const DEFAULT_CONTROL_PLANE = "https://api.frogcp.app";

/** The conventional Worker entry point bundled by default; override with `--entry`. */
const DEFAULT_ENTRY = "./src/worker.ts";

/** Files/dirs whose presence marks a folder as a BACKEND project (a
 * Worker/Node/Deno app) rather than a plain static site, so `frogcp deploy <dir>`
 * does not silently treat it as static. `src/worker.ts` is checked separately
 * since it is nested. */
const BACKEND_MARKERS = [
  "package.json",
  "deno.json",
  "deno.jsonc",
  "node_modules",
  "wrangler.toml",
  "wrangler.json",
  "wrangler.jsonc",
];

/**
 * Heuristic: does `dir` look like a plain static site (no backend)? True when
 * none of the `BACKEND_MARKERS` (nor a `src/worker.ts` entry) are present. The
 * CLI uses this to guess `type: "static"` and confirm; an explicit
 * `--static`/`--worker` flag overrides the guess entirely.
 */
export function detectStaticSite(dir: string): boolean {
  for (const marker of BACKEND_MARKERS) {
    if (existsSync(join(dir, marker))) return false;
  }
  if (existsSync(join(dir, "src", "worker.ts"))) return false;
  return true;
}

/**
 * Recursively collects every file under `dir` as `{ path, bytes }`, where
 * `path` is the POSIX-style relative path (`assets/app.js`, never a backslash)
 * the control plane maps to `/<path>` in the asset manifest.
 */
export function collectStaticFiles(dir: string): { path: string; bytes: Uint8Array }[] {
  const files: { path: string; bytes: Uint8Array }[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const rel = relative(dir, full).split(sep).join("/");
        files.push({ path: rel, bytes: new Uint8Array(readFileSync(full)) });
      }
    }
  };
  walk(dir);
  return files;
}

export interface DeployOptions {
  /** Path to `frogcp.config.ts`, resolved against `process.cwd()`. Only
   * validated (via `loadBackendConfig`) when the resolved file exists, since
   * bundling is entry-file-only; a missing config never blocks a deploy.
   * Defaults to `./frogcp.config.ts`. */
  config?: string;
  /** Path to the Worker entry file to bundle, resolved against
   * `process.cwd()`. Defaults to `./src/worker.ts`. */
  entry?: string;
  /** Positional target: the directory to deploy as a static site (resolved
   * against `process.cwd()`, defaults to `.`). Only used when `type` is
   * `"static"`. */
  path?: string;
  /** Deploy kind. `"static"` uploads the `path` folder as a static site (no
   * Worker bundle, no D1); `"worker"` (the default) bundles `entry`. The CLI
   * resolves this from `--static`/`--worker` or the `detectStaticSite` guess. */
  type?: "static" | "worker";
  /** For a static deploy: serve `index.html` for unmatched routes (SPA
   * fallback) instead of a 404. */
  spa?: boolean;
  /** Requested subdomain slug; the control plane mints one when omitted. */
  slug?: string;
  /** API key for an OWNED deploy (`Authorization: Bearer <key>`). Falls back to
   * `FROGCP_API_KEY`. Omitted entirely means an anonymous deploy (the control
   * plane returns a claim token/link instead). */
  apiKey?: string;
  /** The control plane's base URL. Falls back to `FROGCP_CONTROL_PLANE`, then
   * `DEFAULT_CONTROL_PLANE`. */
  controlPlane?: string;
  /** Injected `fetch` implementation, the seam tests mock to prove the request
   * shape without real network traffic. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

export interface DeployResult {
  slug: string;
  url: string;
  status: string;
  /** Present only for an anonymous (unclaimed) deploy. */
  claimToken?: string;
  /** `<controlPlane>/claim/<claimToken>`, present alongside `claimToken`. */
  claimUrl?: string;
}

/**
 * Bundles `entryPath` into a single ESM Worker module with esbuild:
 * `bundle: true` (inlines every import), `format: "esm"` (CF's multipart upload
 * expects an ES module), `platform: "browser"` (no Node built-ins polyfilled,
 * so a worker entry pulling in a `node:` import fails loudly at bundle time
 * here, not at runtime on Cloudflare), `write: false` (bytes stay in memory).
 *
 * A missing entry file is a clear `CliError`, not a raw esbuild stack; it is
 * the most likely first-run mistake.
 */
export async function bundleWorker(entryPath: string): Promise<Uint8Array> {
  if (!existsSync(entryPath)) {
    throw new CliError(
      `frogcp deploy: entry file not found at "${entryPath}". Pass --entry <path>, or create ` +
        `${DEFAULT_ENTRY} (the default Worker entry point).`,
    );
  }

  let result: esbuild.BuildResult;
  try {
    result = await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
      logLevel: "silent",
    });
  } catch (error) {
    throw new CliError(
      `frogcp deploy: failed to bundle "${entryPath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const output = result.outputFiles?.[0];
  if (!output) {
    throw new Error("unreachable: esbuild.build with write:false and one entryPoint always returns an outputFile");
  }
  return output.contents;
}

/** Strips a trailing slash so `${controlPlane}/api/deploy` never ends up with a doubled `//`. */
function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** The shape of a non-2xx `/api/deploy` response body. `error.code`/`error.message`
 * mirror every other error response in the framework. Tolerates a
 * malformed/absent envelope with a generic fallback. */
function parseErrorBody(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error?: unknown }).error;
    if (err && typeof err === "object") {
      const code = "code" in err && typeof err.code === "string" ? err.code : "error";
      const message = "message" in err && typeof err.message === "string" ? err.message : `request failed (${status})`;
      return `${code}: ${message}`;
    }
  }
  return `request failed with status ${status}`;
}

/**
 * `frogcp deploy` bundles the user's Worker entry point and posts it to the
 * control plane's `POST /api/deploy` (multipart: a `bundle` file part plus an
 * optional `slug` field), then prints the live URL and, for an anonymous
 * deploy, the claim link.
 *
 * No Cloudflare calls happen here: the control plane decides whether to
 * provision; this command only talks to the control plane's HTTP API.
 */
export async function deployCommand(options: DeployOptions = {}): Promise<DeployResult> {
  const isStatic = options.type === "static";

  const controlPlane = stripTrailingSlash(options.controlPlane ?? process.env.FROGCP_CONTROL_PLANE ?? DEFAULT_CONTROL_PLANE);
  const apiKey = options.apiKey ?? process.env.FROGCP_API_KEY;
  const fetchImpl = options.fetchImpl ?? fetch;

  const form = new FormData();
  if (isStatic) {
    // Static deploy: upload the folder's files (no esbuild bundle, no config).
    // Each file becomes a `file:<posix-relpath>` part the control plane maps
    // into the Static-Assets manifest.
    const dir = resolve(process.cwd(), options.path ?? ".");
    const files = collectStaticFiles(dir);
    if (files.length === 0) {
      throw new CliError(`frogcp deploy: no files found in "${dir}" to deploy as a static site.`);
    }
    form.append("type", "static");
    if (options.spa) form.append("spa", "true");
    for (const file of files) {
      // `bytes as BlobPart`: a real `Uint8Array` is a valid `BlobPart`
      // regardless of its `ArrayBufferLike` type parameter.
      form.append(`file:${file.path}`, new Blob([file.bytes as BlobPart]), file.path);
    }
  } else {
    const configPath = resolve(process.cwd(), options.config ?? "./frogcp.config.ts");
    if (existsSync(configPath)) {
      // Best-effort: surfaces an obviously broken config early. Also carries the
      // `resources` declaration forward as the deploy manifest: the control
      // plane provisions exactly what is declared here. A config with no
      // `resources` sends no manifest, so the control plane provisions nothing.
      const config = await loadBackendConfig(configPath);
      if (config.resources !== undefined) {
        form.append(
          "resources",
          new Blob([JSON.stringify(config.resources)], { type: "application/json" }),
        );
      }
    }

    const entryPath = resolve(process.cwd(), options.entry ?? DEFAULT_ENTRY);
    const bundle = await bundleWorker(entryPath);
    // `bundle as BlobPart`: same narrow-generic cast as the static files above.
    form.append("bundle", new Blob([bundle as BlobPart], { type: "application/javascript+module" }), "worker.mjs");
  }
  if (options.slug) form.append("slug", options.slug);

  const headers: Record<string, string> = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  let res: Response;
  try {
    res = await fetchImpl(`${controlPlane}/api/deploy`, { method: "POST", body: form, headers });
  } catch (error) {
    throw new CliError(
      `frogcp deploy: could not reach the control plane at ${controlPlane}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new CliError(`frogcp deploy: the control plane returned a non-JSON response (status ${res.status}).`);
  }

  if (!res.ok) {
    // A provisioning failure on an anonymous deploy returns the one-time claim
    // token so the otherwise-stranded slug stays recoverable; surface the claim
    // link instead of swallowing it.
    const recovery = (body as { data?: { claimToken?: string } }).data;
    let message = `frogcp deploy: ${parseErrorBody(body, res.status)}`;
    if (recovery?.claimToken) {
      const claimUrl = `${controlPlane}/claim/${encodeURIComponent(recovery.claimToken)}`;
      message +=
        "\n\nThis deployment FAILED but is recoverable. Claim it, then redeploy:\n" +
        `  ${claimUrl}`;
    }
    throw new CliError(message);
  }

  const data = (
    body as {
      data?: { project?: { slug?: string; url?: string; status?: string }; claimToken?: string };
    }
  ).data;
  const slug = data?.project?.slug;
  const url = data?.project?.url;
  const status = data?.project?.status;
  if (!slug || !url || !status) {
    throw new CliError("frogcp deploy: the control plane's response was missing project.slug/url/status.");
  }

  const result: DeployResult = { slug, url, status };
  if (data?.claimToken) {
    result.claimToken = data.claimToken;
    result.claimUrl = `${controlPlane}/claim/${encodeURIComponent(data.claimToken)}`;
  }

  console.log(`Deployed: ${url}`);
  console.log(`Status: ${status}`);
  if (result.claimToken && result.claimUrl) {
    console.log("");
    console.log("This deployment is UNCLAIMED. No API key was used.");
    console.log(`Claim this deployment: ${result.claimUrl}`);
    console.log("(sign up or log in, then visit the link above, or POST { claimToken } to /api/claim.)");
  }

  return result;
}
