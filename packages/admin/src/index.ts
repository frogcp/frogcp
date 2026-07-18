import type { FrogPlugin } from "frogcp";
import { registerAdminRoutes } from "./routes";

export const VERSION = "0.0.1";

const DEFAULT_ROUTE = "/admin";

export interface AdminPluginOptions {
  /** Base path the SPA shell and its assets are served under. Must be
   * `"/admin"` for now: the SPA is built with a hardcoded Vite `base`, so its
   * emitted asset URLs are absolute and would 404 under any other mount point.
   * Supporting a custom route means a matching `--base` at build time. */
  route?: string;
}

/**
 * The admin plugin: serves the pre-built React SPA, embedded as string
 * constants in `src/generated/assets.ts`, at `opts.route`.
 *
 * It contributes no entities and no `identify`. The shell itself is public,
 * and every read and write the SPA performs goes through the normal `/api/*`
 * routes, which the permission engine already gates.
 */
export function adminPlugin(opts: AdminPluginOptions = {}): FrogPlugin {
  const route = opts.route ?? DEFAULT_ROUTE;

  // Fail at construction rather than serve a shell that cannot load its own
  // chunks, which shows up as a silent blank page.
  if (route !== DEFAULT_ROUTE) {
    throw new Error(
      `adminPlugin custom route is not supported yet, the SPA is built with base "/admin/". Use the default route (got "${route}").`,
    );
  }

  return {
    name: "admin",
    routes(app) {
      registerAdminRoutes(app, route);
    },
  };
}
