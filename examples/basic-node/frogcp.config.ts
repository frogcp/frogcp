import { defineBackend, entity, ref, role, rule, select, text, timestamp } from "frogcp";

// No `users` entity here: `authPlugin()` contributes its own (see server.ts)
// and the kernel merges plugin entities into this config at boot, so
// `ref("users")` below resolves against that one.
export default defineBackend({
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
