import { defineBackend, entity, ref, role, rule, select, text, timestamp } from "frogcp";

// No `users` entity here: `authPlugin()` contributes its own (see src/worker.ts)
// and the kernel merges plugin entities into this config at boot, so
// `ref("users")` below resolves against that one.
//
// This file is identical to the basic-node example's. Only the adapter wiring
// in the entry point differs between the two.
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
