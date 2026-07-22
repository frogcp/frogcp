import { defineApp, defineBackend, entity, ref, role, rule, select, text, timestamp } from "frogcp";
import { authPlugin } from "frogcp/auth";
import { mediaPlugin } from "frogcp/media";
import { resolveAuthSecret } from "./src/env";

// No `users` entity here: `authPlugin()` contributes its own and the kernel
// merges plugin entities into this config at boot, so `ref("users")` below
// resolves against that one.
const config = defineBackend({
  entities: {
    notes: entity({
      title: text().required(),
      body: text(),
      status: select(["draft", "published"]).default("draft"),
      owner: ref("users").onDelete("cascade"),
      createdAt: timestamp().auto(),
    }).permissions({
      read: rule.owner("owner"),
      list: rule.owner("owner").or(role("admin")),
      create: rule.authenticated(),
      update: rule.owner("owner"),
      delete: rule.owner("owner").or(role("admin")),
    }),
  },
});

/**
 * The whole app, config plus plugins, in one declaration. `src/worker.ts` boots
 * it and `frogcp schema` reads it, so the DDL applied to D1 can never drift
 * from what the Worker actually serves.
 *
 * Both indirections here exist for the same reason: on Workers the session
 * secret lives on `env`, which only exists once a request arrives. `plugins` is
 * a function of the runtime so it can reach `env` at all, and the secret itself
 * is a resolver so `frogcp schema` can build this plugin list purely to collect
 * entities, with no secret set anywhere.
 */
export default defineApp({
  config,
  // `mediaPlugin()` keeps its defaults: uploads require a logged-in caller and
  // read/delete are owner scoped, so files stay private. It stores bytes through
  // the `r2Storage` adapter `src/worker.ts` wires, exercising the R2 binding.
  plugins: (ctx) => [authPlugin({ secret: () => resolveAuthSecret(ctx.env) }), mediaPlugin()],
});
