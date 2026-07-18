import { createClient } from "frogcp/client";

/**
 * The one `frogcp/client` instance the whole SPA shares. An empty `baseUrl`
 * means same-origin, which is always correct: this plugin serves the admin
 * shell and `/api/*` from the same Hono app (see `src/routes.ts`). The
 * client's default `credentials: "include"` is what carries the session
 * cookie `frogcp/auth` issues on login.
 */
export const client = createClient("");
