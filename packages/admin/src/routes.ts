import type { Hono } from "hono";
import type { ApiVariables } from "frogcp";
import { ASSETS } from "./generated/assets";

/** Uses the `atob` global rather than Node's `Buffer` so the handler stays
 * usable in every runtime the plugin runs in, Workers included. */
function decodeBase64(body: string): Uint8Array {
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** `nosniff` is unconditional, same rationale as the media plugin's serve
 * route: never let a browser sniff an asset body into another content type. */
function assetToResponse(asset: (typeof ASSETS)[string]): Response {
  const body = asset.encoding === "utf8" ? asset.body : (decodeBase64(asset.body) as BodyInit);
  return new Response(body, {
    headers: {
      "content-type": asset.contentType,
      "x-content-type-options": "nosniff",
    },
  });
}

function indexResponse(): Response {
  const asset = ASSETS["index.html"];
  if (!asset) {
    // Only reachable if the SPA was never built before the plugin was, which
    // is a packaging mistake rather than a request-time condition.
    throw new Error(
      "frogcp/admin: the embedded ASSETS map has no index.html, run `pnpm build:spa && pnpm embed` before building the plugin",
    );
  }
  return assetToResponse(asset);
}

/** A real 404 for a request that looks like an asset but has no embedded
 * match, typically a browser holding a cached shell asking for a chunk this
 * build no longer emits. Serving the HTML shell there would surface as a
 * confusing MIME-type error and mask the broken reference. */
function notFoundResponse(): Response {
  return new Response(null, {
    status: 404,
    headers: { "x-content-type-options": "nosniff" },
  });
}

/**
 * Registers the SPA's serving routes: `{route}` and `{route}/` serve the
 * shell, `{route}/assets/*` serves the matching embedded asset or a real 404,
 * and any other path under `{route}` falls back to the shell so the SPA's own
 * router owns routing within it.
 *
 * There is no auth gate here by design, see `adminPlugin`.
 */
export function registerAdminRoutes(app: Hono<{ Variables: ApiVariables }>, route: string): void {
  const prefix = `${route}/`;

  app.get(route, () => indexResponse());

  app.get(`${route}/*`, (c) => {
    const pathname = new URL(c.req.url).pathname;
    const subPath = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : "";
    if (subPath.length === 0) {
      return indexResponse();
    }
    const asset = ASSETS[subPath];
    if (asset) {
      return assetToResponse(asset);
    }
    // Under `assets/` an unmatched request is a stale reference, so 404.
    // Anything else is an SPA client-side route, so serve the shell.
    return subPath.startsWith("assets/") ? notFoundResponse() : indexResponse();
  });
}
