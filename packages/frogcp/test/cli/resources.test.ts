import { describe, expect, it } from "vitest";
import { resourcesLsCommand, resourcesRmCommand } from "../../src/cli/commands/resources";
import { CliError } from "../../src/cli/errors";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fake control plane that resolves the project id from the entity list and
 * then answers the resource endpoints, recording every request URL/method. */
function fakeCp(opts: {
  projectId?: string;
  resources?: unknown;
  rmStatus?: number;
  rmBody?: unknown;
}): { fetchImpl: typeof fetch; calls: Array<{ url: string; method: string }> } {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = url.toString();
    calls.push({ url: u, method: init?.method ?? "GET" });
    if (u.includes("/api/entity/projects")) {
      const data = opts.projectId ? [{ id: opts.projectId }] : [];
      return jsonResponse({ data });
    }
    if (u.includes("/resources/")) {
      return jsonResponse(opts.rmBody ?? { data: { binding: "CACHE", deleted: true } }, opts.rmStatus ?? 200);
    }
    if (u.endsWith("/resources")) {
      return jsonResponse({ data: opts.resources ?? [] });
    }
    return jsonResponse({ error: { code: "not_found", message: "?" } }, 404);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("resourcesLsCommand", () => {
  it("resolves the project id from the slug then GETs its resources", async () => {
    const { fetchImpl, calls } = fakeCp({
      projectId: "proj-1",
      resources: [
        { id: "r1", type: "d1", binding: "DB", status: "active" },
        { id: "r2", type: "kv", binding: "CACHE", status: "orphaned" },
      ],
    });

    const rows = await resourcesLsCommand({
      slug: "my-app",
      apiKey: "frogcp_k",
      controlPlane: "https://cp.example.test",
      fetchImpl,
    });

    expect(rows.map((r) => r.binding)).toEqual(["DB", "CACHE"]);
    expect(calls[0]?.url).toContain("/api/entity/projects?filter[slug]=my-app");
    expect(calls[1]?.url).toBe("https://cp.example.test/api/projects/proj-1/resources");
  });

  it("an unknown slug yields a clear CliError", async () => {
    const { fetchImpl } = fakeCp({});
    await expect(
      resourcesLsCommand({ slug: "nope", apiKey: "frogcp_k", controlPlane: "https://cp.example.test", fetchImpl }),
    ).rejects.toThrow(/no project found for slug "nope"/);
  });

  it("requires an API key", async () => {
    const { fetchImpl } = fakeCp({ projectId: "p" });
    const prev = process.env.FROGCP_API_KEY;
    delete process.env.FROGCP_API_KEY;
    try {
      await expect(
        resourcesLsCommand({ slug: "x", controlPlane: "https://cp.example.test", fetchImpl }),
      ).rejects.toThrow(/API key is required/);
    } finally {
      if (prev !== undefined) process.env.FROGCP_API_KEY = prev;
    }
  });
});

describe("resourcesRmCommand", () => {
  it("DELETEs the binding under the resolved project id", async () => {
    const { fetchImpl, calls } = fakeCp({ projectId: "proj-9" });
    await resourcesRmCommand({
      slug: "my-app",
      binding: "CACHE",
      apiKey: "frogcp_k",
      controlPlane: "https://cp.example.test",
      fetchImpl,
    });
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.url).toBe("https://cp.example.test/api/projects/proj-9/resources/CACHE");
  });

  it("surfaces the control plane's refusal to delete an active resource", async () => {
    const { fetchImpl } = fakeCp({
      projectId: "proj-9",
      rmStatus: 409,
      rmBody: { error: { code: "conflict", message: "still in use, remove it from frogcp.config.ts and redeploy first" } },
    });
    await expect(
      resourcesRmCommand({
        slug: "my-app",
        binding: "DB",
        apiKey: "frogcp_k",
        controlPlane: "https://cp.example.test",
        fetchImpl,
      }),
    ).rejects.toThrow(/still in use/);
  });

  it("surfaces a refusal as a CliError type", async () => {
    const { fetchImpl } = fakeCp({ projectId: "p", rmStatus: 404, rmBody: { error: { code: "not_found", message: "x" } } });
    await expect(
      resourcesRmCommand({ slug: "s", binding: "B", apiKey: "frogcp_k", controlPlane: "https://cp.example.test", fetchImpl }),
    ).rejects.toBeInstanceOf(CliError);
  });
});
