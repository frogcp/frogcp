import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundleWorker, deployCommand } from "../../src/cli/commands/deploy";
import { CliError } from "../../src/cli/errors";

const FIXTURE_ENTRY = `export default {
  async fetch(request: Request): Promise<Response> {
    return new Response("hello from the fixture worker");
  },
};
`;

function writeEntry(dir: string, filename = "worker.ts"): string {
  const path = join(dir, filename);
  writeFileSync(path, FIXTURE_ENTRY, "utf8");
  return path;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("bundleWorker", () => {
  it("bundles a real entry file with esbuild into non-empty ESM bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "frogcp-cli-deploy-"));
    const entryPath = writeEntry(dir);

    const bytes = await bundleWorker(entryPath);

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBeGreaterThan(0);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("fetch");
  });

  it("a missing entry file yields a clear CliError, not a raw esbuild crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "frogcp-cli-deploy-missing-"));
    await expect(bundleWorker(join(dir, "nope.ts"))).rejects.toThrow(CliError);
    await expect(bundleWorker(join(dir, "nope.ts"))).rejects.toThrow(/entry file not found/);
  });
});

describe("deployCommand", () => {
  it("bundles the entry, POSTs multipart with the bundle + slug + Authorization, and returns the live URL (owned deploy)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "frogcp-cli-deploy-owned-"));
    const entryPath = writeEntry(dir);

    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
      capturedUrl = url.toString();
      capturedInit = init;
      return jsonResponse({
        data: { project: { slug: "my-app", url: "https://my-app.frogcp.app", status: "active" } },
      });
    }) as typeof fetch;

    const result = await deployCommand({
      entry: entryPath,
      slug: "my-app",
      apiKey: "frogcp_test-key",
      controlPlane: "https://cp.example.test",
      fetchImpl,
    });

    expect(result).toEqual({ slug: "my-app", url: "https://my-app.frogcp.app", status: "active" });
    expect(capturedUrl).toBe("https://cp.example.test/api/deploy");
    expect(capturedInit?.method).toBe("POST");

    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer frogcp_test-key");

    expect(capturedInit?.body).toBeInstanceOf(FormData);
    const form = capturedInit?.body as FormData;
    expect(form.get("slug")).toBe("my-app");
    const bundlePart = form.get("bundle");
    expect(bundlePart).toBeInstanceOf(File);
    expect(await (bundlePart as File).text()).toContain("fetch");
  });

  it("forwards the config's resources declaration as a `resources` JSON manifest part", async () => {
    const dir = mkdtempSync(join(tmpdir(), "frogcp-cli-deploy-res-"));
    const entryPath = writeEntry(dir);
    const configPath = join(dir, "frogcp.config.ts");
    writeFileSync(
      configPath,
      `import { defineBackend, entity, text } from "frogcp";
export default defineBackend({
  entities: { notes: entity({ title: text().required() }) },
  resources: { d1: { DB: {} }, kv: { CACHE: {} }, ai: { AI: {} } },
});
`,
      "utf8",
    );

    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit): Promise<Response> => {
      capturedInit = init;
      return jsonResponse({ data: { project: { slug: "r", url: "https://r.frogcp.app", status: "active" } } });
    }) as typeof fetch;

    await deployCommand({ entry: entryPath, config: configPath, controlPlane: "https://cp.example.test", fetchImpl });

    const form = capturedInit?.body as FormData;
    const resourcesPart = form.get("resources");
    expect(resourcesPart).toBeInstanceOf(Blob);
    const parsed = JSON.parse(await (resourcesPart as Blob).text());
    expect(parsed).toEqual({ d1: { DB: {} }, kv: { CACHE: {} }, ai: { AI: {} } });
  });

  it("sends NO resources part when the config declares none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "frogcp-cli-deploy-nores-"));
    const entryPath = writeEntry(dir);
    const configPath = join(dir, "frogcp.config.ts");
    writeFileSync(
      configPath,
      `import { defineBackend, entity, text } from "frogcp";
export default defineBackend({ entities: { notes: entity({ title: text().required() }) } });
`,
      "utf8",
    );

    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit): Promise<Response> => {
      capturedInit = init;
      return jsonResponse({ data: { project: { slug: "n", url: "https://n.frogcp.app", status: "active" } } });
    }) as typeof fetch;

    await deployCommand({ entry: entryPath, config: configPath, controlPlane: "https://cp.example.test", fetchImpl });

    const form = capturedInit?.body as FormData;
    expect(form.get("resources")).toBeNull();
  });

  it("an anonymous deploy (no api key) prints the claim link and returns claimToken/claimUrl", async () => {
    const dir = mkdtempSync(join(tmpdir(), "frogcp-cli-deploy-anon-"));
    const entryPath = writeEntry(dir);

    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit): Promise<Response> => {
      capturedInit = init;
      return jsonResponse({
        data: {
          project: { slug: "anon-123abc", url: "https://anon-123abc.frogcp.app", status: "provisioning" },
          claimToken: "clm_abc123",
        },
      });
    }) as typeof fetch;

    const logLines: string[] = [];
    const originalLog = console.log;
    console.log = (msg?: unknown): void => {
      logLines.push(String(msg));
    };
    let result: Awaited<ReturnType<typeof deployCommand>>;
    try {
      result = await deployCommand({ entry: entryPath, controlPlane: "https://cp.example.test", fetchImpl });
    } finally {
      console.log = originalLog;
    }

    expect(result.claimToken).toBe("clm_abc123");
    expect(result.claimUrl).toBe("https://cp.example.test/claim/clm_abc123");
    expect(logLines.some((line) => line.includes("Claim this deployment:"))).toBe(true);
    expect(logLines.some((line) => line.includes(result.claimUrl as string))).toBe(true);

    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("authorization")).toBeNull();
  });

  it("a non-2xx response from the control plane yields a clean CliError showing {error.code, error.message}", async () => {
    const dir = mkdtempSync(join(tmpdir(), "frogcp-cli-deploy-4xx-"));
    const entryPath = writeEntry(dir);

    const fetchImpl = (async (): Promise<Response> =>
      jsonResponse({ error: { code: "validation", message: 'slug "www" is reserved' } }, 422)) as typeof fetch;

    await expect(
      deployCommand({ entry: entryPath, slug: "www", controlPlane: "https://cp.example.test", fetchImpl }),
    ).rejects.toThrow(CliError);
    await expect(
      deployCommand({ entry: entryPath, slug: "www", controlPlane: "https://cp.example.test", fetchImpl }),
    ).rejects.toThrow(/validation.*reserved/);
  });

  it("a provisioning failure carrying a recovery claim token surfaces the claim link (F2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "frogcp-cli-deploy-recover-"));
    const entryPath = writeEntry(dir);

    // The control plane returns 502 with the anonymous deploy's one-time claim
    // token so the stranded slug is recoverable: the CLI must show the link,
    // not swallow it.
    const fetchImpl = (async (): Promise<Response> =>
      jsonResponse(
        {
          error: { code: "provisioning_failed", message: "cloudflare exploded" },
          data: { project: { slug: "doomed-app", status: "failed" }, claimToken: "clm_recover123" },
        },
        502,
      )) as typeof fetch;

    await expect(
      deployCommand({ entry: entryPath, controlPlane: "https://cp.example.test", fetchImpl }),
    ).rejects.toThrow(/provisioning_failed/);
    await expect(
      deployCommand({ entry: entryPath, controlPlane: "https://cp.example.test", fetchImpl }),
    ).rejects.toThrow(/claim\/clm_recover123/);
  });
});

import { mkdirSync } from "node:fs";
import { detectStaticSite, collectStaticFiles } from "../../src/cli/commands/deploy";

function staticDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "frogcp-cli-static-"));
  writeFileSync(join(dir, "index.html"), "<h1>hi</h1>", "utf8");
  return dir;
}

describe("detectStaticSite", () => {
  it("true for a folder with only static files (no backend markers)", () => {
    expect(detectStaticSite(staticDir())).toBe(true);
  });

  it.each([
    ["package.json", () => "{}"],
    ["deno.json", () => "{}"],
    ["wrangler.toml", () => 'name = "x"'],
  ])("false when %s is present", (marker, contents) => {
    const dir = staticDir();
    writeFileSync(join(dir, marker), contents(), "utf8");
    expect(detectStaticSite(dir)).toBe(false);
  });

  it("false when node_modules/ is present", () => {
    const dir = staticDir();
    mkdirSync(join(dir, "node_modules"));
    expect(detectStaticSite(dir)).toBe(false);
  });

  it("false when src/worker.ts is present", () => {
    const dir = staticDir();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "worker.ts"), "export default {}", "utf8");
    expect(detectStaticSite(dir)).toBe(false);
  });
});

describe("collectStaticFiles", () => {
  it("collects files recursively with POSIX relative paths", () => {
    const dir = staticDir();
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "app.js"), "console.log(1)", "utf8");

    const files = collectStaticFiles(dir);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(["assets/app.js", "index.html"]);
    const index = files.find((f) => f.path === "index.html")!;
    expect(new TextDecoder().decode(index.bytes)).toBe("<h1>hi</h1>");
  });
});

describe("deployCommand (static)", () => {
  it("POSTs a type=static multipart with file:<path> parts + spa, returns the URL", async () => {
    const dir = staticDir();
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit): Promise<Response> => {
      capturedInit = init;
      return jsonResponse({ data: { project: { slug: "s", url: "https://s.frogcp.dev", status: "active" } } });
    }) as typeof fetch;

    const result = await deployCommand({
      path: dir,
      type: "static",
      spa: true,
      controlPlane: "https://cp.example.test",
      fetchImpl,
    });

    expect(result).toEqual({ slug: "s", url: "https://s.frogcp.dev", status: "active" });
    const form = capturedInit?.body as FormData;
    expect(form.get("type")).toBe("static");
    expect(form.get("spa")).toBe("true");
    const filePart = form.get("file:index.html");
    expect(filePart).toBeInstanceOf(File);
    expect(await (filePart as File).text()).toBe("<h1>hi</h1>");
  });
});
