import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createCommand } from "../../src/cli/commands/create";

let cwd: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  // `realpathSync` matters on macOS: `tmpdir()` returns a `/var/folders/...`
  // path that's actually a symlink to `/private/var/folders/...`, and
  // `process.cwd()` after `chdir` reports the resolved (real) path, so
  // comparing the un-resolved mkdtemp path against `result.dir` (built from
  // `process.cwd()`) would spuriously fail.
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "frogcp-cli-create-")));
  process.chdir(cwd);
});

afterEach(() => {
  process.chdir(originalCwd);
});

describe("createCommand", () => {
  it("scaffolds the basic-node template (default) with the given package name", async () => {
    const result = await createCommand("my-app");

    expect(result.dir).toBe(join(cwd, "my-app"));
    expect(result.files.sort()).toEqual(
      ["README.md", "frogcp.config.ts", "package.json", "server.ts", "tsconfig.json"].sort(),
    );

    for (const file of ["frogcp.config.ts", "server.ts", "package.json"]) {
      expect(existsSync(join(result.dir, file))).toBe(true);
    }

    const pkg = JSON.parse(readFileSync(join(result.dir, "package.json"), "utf8")) as {
      name: string;
    };
    expect(pkg.name).toBe("my-app");

    const config = readFileSync(join(result.dir, "frogcp.config.ts"), "utf8");
    expect(config).toContain("defineBackend");
  });

  it("scaffolds the cloudflare template when requested", async () => {
    const result = await createCommand("my-worker", { template: "cloudflare" });

    expect(result.files).toContain("wrangler.jsonc");
    expect(result.files).toContain("src/worker.ts");
    expect(existsSync(join(result.dir, "src", "worker.ts"))).toBe(true);

    const pkg = JSON.parse(readFileSync(join(result.dir, "package.json"), "utf8")) as {
      name: string;
    };
    expect(pkg.name).toBe("my-worker");
  });

  it("refuses to scaffold into an existing non-empty directory", async () => {
    const dir = join(cwd, "taken");
    mkdirSync(dir);
    writeFileSync(join(dir, "existing.txt"), "hello", "utf8");

    await expect(createCommand("taken")).rejects.toThrow(/already exists and is not empty/);
  });

  it("allows scaffolding into an existing but EMPTY directory", async () => {
    const dir = join(cwd, "empty-dir");
    mkdirSync(dir);

    const result = await createCommand("empty-dir");
    expect(existsSync(join(result.dir, "package.json"))).toBe(true);
  });

  it("rejects a name that escapes the current directory (path traversal)", async () => {
    await expect(createCommand("../evil")).rejects.toThrow(/simple directory name/);
    await expect(createCommand("../../foo")).rejects.toThrow(/simple directory name/);
    // Nothing was written outside cwd.
    expect(existsSync(join(cwd, "..", "evil"))).toBe(false);
  });

  it("rejects an absolute path as the project name", async () => {
    await expect(createCommand(join(cwd, "abs-name"))).rejects.toThrow(/simple directory name/);
  });
});
