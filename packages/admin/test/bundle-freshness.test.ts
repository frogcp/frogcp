import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeSourceHash } from "../scripts/spa-source-hash.mjs";
import { SPA_SOURCE_HASH } from "../src/generated/assets";

const packageRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const spaSourceDir = resolve(packageRoot, "spa");

/**
 * Catches a spa/ edit that was never followed by a rebuild, which would ship a
 * stale UI while every other test stayed green: the jsdom suites exercise the
 * spa/ source directly and never the embedded bundle, and `serving.test.ts`
 * only checks the embedded map against itself.
 */
describe("SPA bundle freshness", () => {
  it("the committed embedded bundle's SPA_SOURCE_HASH matches the current spa/ source tree", async () => {
    const actual = await computeSourceHash(spaSourceDir);
    expect(
      actual,
      "SPA source changed but the embedded bundle was not rebuilt. Run `pnpm --filter @frogcp/admin build` and commit src/generated/.",
    ).toBe(SPA_SOURCE_HASH);
  });
});
