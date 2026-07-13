import { CliError } from "../errors";

/** Same placeholder default control-plane URL as `frogcp deploy`; every real
 * invocation overrides it via `--control-plane` / `FROGCP_CONTROL_PLANE`. */
const DEFAULT_CONTROL_PLANE = "https://api.frogcp.app";

/** Options common to `frogcp resources ls` / `rm`: which project (by slug), the
 * API key authorizing the owner-only resource endpoints, and the control plane
 * to talk to. `fetchImpl` is the test seam, mirroring `deployCommand`. */
export interface ResourcesOptions {
  /** The project's subdomain slug (resolved to its id via the entity API). */
  slug: string;
  /** API key for the owner (`Authorization: Bearer <key>`); falls back to
   *  `FROGCP_API_KEY`. Required, since the resource endpoints are owner-only. */
  apiKey?: string;
  controlPlane?: string;
  fetchImpl?: typeof fetch;
}

/** One resource row as the control plane returns it over
 * `GET /api/projects/:id/resources`. */
export interface ResourceRow {
  id: string;
  type: string;
  binding: string;
  status: "active" | "orphaned";
  createdAt?: unknown;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** Parses the framework's standard `{ error: { code, message } }` envelope into
 * a display string, tolerating a malformed/absent body. Mirrors
 * `deployCommand`'s own `parseErrorBody`. */
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

interface ResolvedTarget {
  controlPlane: string;
  headers: Record<string, string>;
  fetchImpl: typeof fetch;
  projectId: string;
}

/** Resolves shared request context (base URL + auth headers + fetch) and looks
 * up the project id for `slug` via the entity API. The resource endpoints are
 * keyed by id, but a terminal user only knows the slug. An unknown slug (or one
 * the caller cannot see) yields a clear `CliError`. */
async function resolveTarget(options: ResourcesOptions): Promise<ResolvedTarget> {
  const controlPlane = stripTrailingSlash(
    options.controlPlane ?? process.env.FROGCP_CONTROL_PLANE ?? DEFAULT_CONTROL_PLANE,
  );
  const apiKey = options.apiKey ?? process.env.FROGCP_API_KEY;
  if (!apiKey) {
    throw new CliError(
      "frogcp resources: an API key is required (managing resources is owner-only). " +
        "Pass --api-key <key> or set FROGCP_API_KEY.",
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = { authorization: `Bearer ${apiKey}` };

  let res: Response;
  try {
    res = await fetchImpl(
      `${controlPlane}/api/entity/projects?filter[slug]=${encodeURIComponent(options.slug)}`,
      { headers },
    );
  } catch (error) {
    throw new CliError(
      `frogcp resources: could not reach the control plane at ${controlPlane}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  const body = (await res.json().catch(() => undefined)) as { data?: Array<{ id?: string }> } | undefined;
  if (!res.ok) throw new CliError(`frogcp resources: ${parseErrorBody(body, res.status)}`);
  const projectId = body?.data?.[0]?.id;
  if (!projectId) {
    throw new CliError(`frogcp resources: no project found for slug "${options.slug}" (or you don't own it).`);
  }
  return { controlPlane, headers, fetchImpl, projectId };
}

/**
 * `frogcp resources ls --slug <slug>` lists a project's declared/tracked
 * resources (both `active` and `orphaned`), wrapping
 * `GET /api/projects/:id/resources`. Prints one line per resource and returns
 * the rows.
 */
export async function resourcesLsCommand(options: ResourcesOptions): Promise<ResourceRow[]> {
  const { controlPlane, headers, fetchImpl, projectId } = await resolveTarget(options);
  const res = await fetchImpl(`${controlPlane}/api/projects/${encodeURIComponent(projectId)}/resources`, { headers });
  const body = (await res.json().catch(() => undefined)) as { data?: ResourceRow[] } | undefined;
  if (!res.ok) throw new CliError(`frogcp resources: ${parseErrorBody(body, res.status)}`);

  const rows = body?.data ?? [];
  if (rows.length === 0) {
    console.log(`No resources for "${options.slug}".`);
  } else {
    console.log(`Resources for "${options.slug}":`);
    for (const r of rows) {
      console.log(`  ${r.binding.padEnd(16)} ${r.type.padEnd(8)} ${r.status}`);
    }
  }
  return rows;
}

/**
 * `frogcp resources rm <binding> --slug <slug>` tears down an ORPHANED resource
 * and removes its record, wrapping
 * `DELETE /api/projects/:id/resources/:binding`. The control plane refuses to
 * delete a still-bound (`active`) resource (remove it from `frogcp.config.ts`
 * and redeploy first), and this surfaces that error verbatim.
 */
export async function resourcesRmCommand(options: ResourcesOptions & { binding: string }): Promise<void> {
  const { controlPlane, headers, fetchImpl, projectId } = await resolveTarget(options);
  const res = await fetchImpl(
    `${controlPlane}/api/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(options.binding)}`,
    { method: "DELETE", headers },
  );
  const body = (await res.json().catch(() => undefined)) as { data?: unknown; error?: unknown } | undefined;
  if (!res.ok) throw new CliError(`frogcp resources: ${parseErrorBody(body, res.status)}`);
  console.log(`Removed resource "${options.binding}" from "${options.slug}".`);
}
