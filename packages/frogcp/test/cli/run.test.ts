import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCommand, devCommand, type RunResult } from "../../src/cli/commands/run";
import { defineBackend, entity, rule, text } from "../../src/index";

const CONFIG = `import { defineBackend, entity, text, rule } from "frogcp";

export default defineBackend({
  entities: {
    // Explicit public list/read: the default is deny-all-but-admin (see the
    // permission engine's spec), and this suite runs unauthenticated
    // requests to prove the server actually serves the entity API, not
    // just that it boots.
    notes: entity({ title: text().required() }).permissions({
      list: rule.public(),
      read: rule.public(),
    }),
  },
});
`;

let cwd: string;
let originalCwd: string;
/** Any server booted by a test is tracked here so afterEach can always shut it down, even if an assertion throws first. */
let booted: RunResult | undefined;

beforeEach(() => {
  originalCwd = process.cwd();
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "frogcp-cli-run-")));
  process.chdir(cwd);
  writeFileSync(join(cwd, "frogcp.config.ts"), CONFIG, "utf8");
  booted = undefined;
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (booted) await booted.close();
});

describe("runCommand", () => {
  it("boots a real standalone server on an OS-assigned port and serves /api/system/health", async () => {
    booted = await runCommand({ db: ":memory:", port: 0 });

    expect(booted.port).toBeGreaterThan(0);
    expect(booted.url).toBe(`http://localhost:${booted.port}`);

    const response = await fetch(`${booted.url}/api/system/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("also serves the entity API for the loaded config (code mode)", async () => {
    booted = await runCommand({ db: ":memory:", port: 0 });

    const response = await fetch(`${booted.url}/api/entity/notes`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: unknown[]; meta: { total: number } };
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
  });

  it("--managed boots managed mode (schema editing endpoint enabled)", async () => {
    booted = await runCommand({ db: ":memory:", port: 0, managed: true });

    // In code mode POST /api/system/schema is disabled (409); managed mode
    // accepts schema edits (though this smoke test just proves the server is
    // live and reachable in managed mode, not the full editing flow, which is
    // covered by the frogcp/managed-mode test suite).
    const response = await fetch(`${booted.url}/api/system/health`);
    expect(response.status).toBe(200);
  });

  it("close() shuts the server down, a second request then fails to connect", async () => {
    const result = await runCommand({ db: ":memory:", port: 0 });
    const { url } = result;
    await result.close();

    await expect(fetch(`${url}/api/system/health`)).rejects.toThrow();
  });
});

describe("runCommand: zero-config (no frogcp.config.ts)", () => {
  it("boots an empty managed-mode backend when no config file is present", async () => {
    // The beforeEach wrote a config; a zero-config first run has none.
    rmSync(join(cwd, "frogcp.config.ts"));

    booted = await runCommand({ db: ":memory:", port: 0 });

    // Live server, no config authored, an instant empty backend.
    const health = await fetch(`${booted.url}/api/system/health`);
    expect(health.status).toBe(200);

    // Proof it booted in MANAGED mode: `applySchema` hot-swaps the live user
    // schema at runtime (it throws `not_managed` in code mode). Define an
    // entity, then use it over HTTP, the "shape it live" first-run flow.
    await booted.backend.applySchema(
      defineBackend({
        entities: {
          widgets: entity({ name: text().required() }).permissions({ list: rule.public(), read: rule.public() }),
        },
      }),
    );

    const listed = await fetch(`${booted.url}/api/entity/widgets`);
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { data: unknown[] };
    expect(body.data).toEqual([]);
  });

  it("still errors loudly when --config points at a missing file", async () => {
    await expect(runCommand({ db: ":memory:", port: 0, config: "./does-not-exist.config.ts" })).rejects.toThrow();
  });
});

describe("devCommand", () => {
  it("boots without error against a dev database and serves /api/system/health", async () => {
    booted = await devCommand({ db: ":memory:", port: 0 });

    const response = await fetch(`${booted.url}/api/system/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
