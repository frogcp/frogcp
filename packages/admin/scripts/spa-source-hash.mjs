// Shared by `scripts/embed.mjs`, which stamps the digest into the generated
// assets module, and `test/bundle-freshness.test.ts`, which recomputes it.
// Keeping the hashing in one module means the two call sites cannot drift
// apart and produce a false pass.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

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

/**
 * Computes a deterministic sha256 hex digest over every file under
 * `sourceDir`, recursively. Files are visited sorted by posix-normalized
 * relative path, so the digest does not depend on the host OS separator or on
 * directory-listing order. Both the path and the content are folded in, so a
 * rename alone still changes the digest.
 */
export async function computeSourceHash(sourceDir) {
  const files = await walk(sourceDir);
  const entries = files
    .map((absPath) => ({ absPath, relPath: relative(sourceDir, absPath).split(sep).join("/") }))
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  const hash = createHash("sha256");
  for (const { absPath, relPath } of entries) {
    const content = await readFile(absPath);
    hash.update(relPath);
    hash.update("\0");
    hash.update(content);
  }
  return hash.digest("hex");
}
