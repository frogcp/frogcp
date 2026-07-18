// Codegen step between this package's two builds: reads the Vite output in
// `dist-spa/` and writes `src/generated/assets.ts`, a plain TS module holding
// every asset as a string constant (base64 for binary, utf8 for text). That
// is what lets the plugin serve the SPA with no filesystem access at runtime,
// so the tsup build stays Workers-compatible and downstream consumers never
// need a browser toolchain.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { computeSourceHash } from "./spa-source-hash.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = resolve(here, "..");
const distSpaDir = resolve(packageRoot, "dist-spa");
const spaSourceDir = resolve(packageRoot, "spa");
const outFile = resolve(packageRoot, "src/generated/assets.ts");

// Text formats, embedded as UTF-8 string literals. Everything else (fonts,
// images) is treated as binary and base64-encoded.
const TEXT_EXTENSIONS = new Set([".html", ".js", ".mjs", ".css", ".svg", ".json", ".map", ".txt"]);

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".otf": "font/otf",
};

/** Lists every file under `dir`, recursively, as absolute paths. */
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

async function main() {
  let files;
  try {
    files = await walk(distSpaDir);
  } catch (err) {
    throw new Error(`admin embed: dist-spa not found at ${distSpaDir}, run \`pnpm build:spa\` first`, { cause: err });
  }
  if (files.length === 0) {
    throw new Error(`admin embed: dist-spa at ${distSpaDir} is empty, run \`pnpm build:spa\` first`);
  }

  /** @type {Record<string, { contentType: string; body: string; encoding: "utf8" | "base64" }>} */
  const assets = {};
  for (const file of files) {
    // Posix-normalize the key: the plugin matches these against a URL
    // subpath, which always uses `/` whatever the host OS separator is.
    const key = relative(distSpaDir, file).split(sep).join("/");
    const ext = extname(file).toLowerCase();
    const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";

    if (TEXT_EXTENSIONS.has(ext)) {
      const body = await readFile(file, "utf8");
      assets[key] = { contentType, body, encoding: "utf8" };
    } else {
      const buf = await readFile(file);
      assets[key] = { contentType, body: buf.toString("base64"), encoding: "base64" };
    }
  }

  // Hashes the spa/ source tree, not the dist-spa output, so
  // `test/bundle-freshness.test.ts` can recompute the same digest and catch a
  // spa/ edit that was never followed by a rebuild.
  const spaSourceHash = await computeSourceHash(spaSourceDir);

  const lines = [
    "// GENERATED FILE, do not edit by hand.",
    "// Produced by `pnpm --filter @frogcp/admin embed` from the Vite build in dist-spa/.",
    "// Committed on purpose: it lets tsup build the plugin, and downstream consumers use",
    "// @frogcp/admin, without a browser toolchain. Only `pnpm build:spa && pnpm embed`",
    "// needs Vite.",
    "",
    "// A sha256 digest of the spa/ source tree (see scripts/spa-source-hash.mjs), stamped",
    "// on every embed run. `test/bundle-freshness.test.ts` recomputes it and asserts they",
    "// still agree, which is how a spa/ edit without a rebuild gets caught.",
    `export const SPA_SOURCE_HASH = ${JSON.stringify(spaSourceHash)};`,
    "",
    "export const ASSETS: Record<string, { contentType: string; body: string; encoding: \"utf8\" | \"base64\" }> = {",
  ];
  for (const key of Object.keys(assets).sort()) {
    const asset = assets[key];
    lines.push(
      `  ${JSON.stringify(key)}: { contentType: ${JSON.stringify(asset.contentType)}, body: ${JSON.stringify(asset.body)}, encoding: ${JSON.stringify(asset.encoding)} },`,
    );
  }
  lines.push("};", "");

  await writeFile(outFile, lines.join("\n"), "utf8");
  console.log(`admin embed: wrote ${Object.keys(assets).length} asset(s) to ${relative(packageRoot, outFile)}`);
}

await main();
