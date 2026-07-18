import { execFileSync, execSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const binPath = join(packageRoot, "dist", "cli", "index.js");

const RUN_CONFIG = `import { defineBackend, entity, text } from "frogcp";

export default defineBackend({
  entities: {
    notes: entity({ title: text().required() }),
  },
});
`;

describe("frogcp bin", () => {
  beforeAll(() => {
    // Build fresh so this smoke test always reflects current source,
    // regardless of whether `pnpm -r build` already ran in this invocation.
    execSync("pnpm build", { cwd: packageRoot, stdio: "pipe" });
  }, 120_000);

  it("starts with a #!/usr/bin/env node shebang", () => {
    const built = readFileSync(binPath, "utf8");
    expect(built.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("`node dist/cli.js --help` exits 0 and prints usage", () => {
    const output = execFileSync(process.execPath, [binPath, "--help"], { encoding: "utf8" });
    expect(output).toContain("frogcp");
    expect(output).toContain("create");
    expect(output).toContain("generate");
  });

  it("`node dist/cli.js` with no args also prints usage and exits 0", () => {
    const output = execFileSync(process.execPath, [binPath], { encoding: "utf8" });
    expect(output).toContain("Usage:");
  });

  it("an unknown command exits non-zero", () => {
    expect(() => execFileSync(process.execPath, [binPath, "bogus"], { encoding: "utf8" })).toThrow();
  });

  it(
    "`node dist/cli.js run --port 0 --db :memory:` boots a real server, serves it, and shuts " +
      "down cleanly on SIGINT (exit 0)",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "frogcp-cli-bin-run-"));
      writeFileSync(join(dir, "frogcp.config.ts"), RUN_CONFIG, "utf8");

      const child = spawn(process.execPath, [binPath, "run", "--port", "0", "--db", ":memory:"], {
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const url = await new Promise<string>((resolvePromise, rejectPromise) => {
        const timeout = setTimeout(() => {
          rejectPromise(new Error(`timed out waiting for server to start.\nstdout: ${stdout}\nstderr: ${stderr}`));
        }, 15_000);
        const check = (): void => {
          const match = /serving (http:\/\/localhost:\d+)/.exec(stdout);
          if (match?.[1]) {
            clearTimeout(timeout);
            resolvePromise(match[1]);
          }
        };
        child.stdout.on("data", check);
        check();
      });

      const health = await fetch(`${url}/api/system/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });

      const exitCode = await new Promise<number | null>((resolvePromise) => {
        child.on("exit", (code) => resolvePromise(code));
        child.kill("SIGINT");
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Shutting down");
    },
    20_000,
  );
});
