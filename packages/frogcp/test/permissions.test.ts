import { describe, it, expect } from "vitest";
import { isSQLWrapper } from "drizzle-orm";
import {
  compileTables,
  defineBackend,
  entity,
  text,
  role,
  rule,
  decide,
  checkRow,
  type Ctx,
  type EntityDef,
  type ActionName,
} from "../src/index";

describe("permission engine", () => {
  const config = defineBackend({
    entities: {
      posts: entity({
        title: text().required(),
        owner: text().required(),
      }).permissions({
        read: rule.owner("owner").or(role("admin")),
        list: rule.owner("owner"),
        create: rule.authenticated(),
        // update intentionally omitted -> default-deny for non-admin
        // delete intentionally omitted -> default-deny for non-admin
      }),
    },
  });
  const tables = compileTables(config);
  const postsEntity: EntityDef = config.entities.posts!;
  const postsTable = tables.posts!;

  const guest: Ctx = null;
  const member: Ctx = { userId: "u1", role: "member" };
  const otherMember: Ctx = { userId: "u2", role: "member" };
  const admin: Ctx = { userId: "u9", role: "admin" };

  describe("decide", () => {
    it("denies guest for read/create/delete", () => {
      expect(decide(postsEntity, "read", guest, postsTable)).toEqual({ allow: false });
      expect(decide(postsEntity, "create", guest, postsTable)).toEqual({ allow: false });
      expect(decide(postsEntity, "delete", guest, postsTable)).toEqual({ allow: false });
    });

    it("allows member read with a row-scoped filter", () => {
      const d = decide(postsEntity, "read", member, postsTable);
      expect(d.allow).toBe(true);
      if (d.allow) {
        expect(d.filter).toBeDefined();
        expect(isSQLWrapper(d.filter)).toBe(true);
      }
    });

    it("allows admin read with no filter (static prune via or)", () => {
      const d = decide(postsEntity, "read", admin, postsTable);
      expect(d).toEqual({ allow: true, filter: undefined });
      if (d.allow) {
        expect(d.filter).toBeUndefined();
      }
    });

    it("allows guest with no filter when a static-true branch prunes an or() (rule.public().or(owner))", () => {
      // A guest ctx can't resolve owner() (ctx is null), so the static public()
      // branch must prune the or() first, giving a clean filter-less allow
      // rather than a throw or a deny.
      const openEntity: EntityDef = {
        fields: postsEntity.fields,
        permissions: {
          read: rule.public().or(rule.owner("owner")),
        },
      };
      const d = decide(openEntity, "read", guest, postsTable);
      expect(d).toEqual({ allow: true, filter: undefined });
    });

    it("allows member create with no filter (authenticated is a static rule)", () => {
      const d = decide(postsEntity, "create", member, postsTable);
      expect(d.allow).toBe(true);
      if (d.allow) {
        expect(d.filter).toBeUndefined();
      }
    });

    it("default-denies member for delete (no rule defined, not admin)", () => {
      expect(decide(postsEntity, "delete", member, postsTable)).toEqual({ allow: false });
    });

    it("allows admin for delete (missing rule => admin only, admin always allowed)", () => {
      const d = decide(postsEntity, "delete", admin, postsTable);
      expect(d).toEqual({ allow: true, filter: undefined });
    });

    it("allows admin for every action regardless of rules present", () => {
      const actions: ActionName[] = ["read", "list", "create", "update", "delete"];
      for (const action of actions) {
        expect(decide(postsEntity, action, admin, postsTable)).toEqual({ allow: true, filter: undefined });
      }
    });

    it("gives member a row-scoped filter for list (owner-only rule)", () => {
      const d = decide(postsEntity, "list", member, postsTable);
      expect(d.allow).toBe(true);
      if (d.allow) {
        expect(d.filter).toBeDefined();
      }
    });

    it("denies guest for list (owner-only rule with no static true branch)", () => {
      expect(decide(postsEntity, "list", guest, postsTable)).toEqual({ allow: false });
    });
  });

  describe("checkRow", () => {
    const ownedRow = { id: "p1", title: "hi", owner: "u1" };

    it("allows member who owns the row", () => {
      expect(checkRow(postsEntity, "read", member, ownedRow)).toBe(true);
    });

    it("denies member who does not own the row", () => {
      expect(checkRow(postsEntity, "read", otherMember, ownedRow)).toBe(false);
    });

    it("allows admin for any row regardless of ownership", () => {
      expect(checkRow(postsEntity, "read", admin, ownedRow)).toBe(true);
      expect(checkRow(postsEntity, "delete", admin, ownedRow)).toBe(true);
    });

    it("denies guest", () => {
      expect(checkRow(postsEntity, "read", guest, ownedRow)).toBe(false);
    });

    it("default-denies for missing rule when not admin", () => {
      expect(checkRow(postsEntity, "delete", member, ownedRow)).toBe(false);
    });
  });

  describe("and combinator", () => {
    const gate: EntityDef = {
      fields: postsEntity.fields,
      permissions: {
        update: rule.authenticated().and(rule.owner("owner")),
      },
    };

    it("behaves like owner for authenticated members (SQL filter present)", () => {
      const d = decide(gate, "update", member, postsTable);
      expect(d.allow).toBe(true);
      if (d.allow) expect(d.filter).toBeDefined();
    });

    it("checkRow: member owns -> true, doesn't own -> false", () => {
      expect(checkRow(gate, "update", member, { owner: "u1" })).toBe(true);
      expect(checkRow(gate, "update", otherMember, { owner: "u1" })).toBe(false);
    });

    it("is false for guests (authenticated branch is statically false)", () => {
      expect(decide(gate, "update", guest, postsTable)).toEqual({ allow: false });
      expect(checkRow(gate, "update", guest, { owner: "u1" })).toBe(false);
    });
  });

  describe("public rule", () => {
    const openEntity: EntityDef = {
      fields: postsEntity.fields,
      permissions: {
        read: rule.public(),
      },
    };

    it("allows guest read with no filter", () => {
      const d = decide(openEntity, "read", guest, postsTable);
      expect(d).toEqual({ allow: true, filter: undefined });
    });
  });

  describe("lazy short-circuiting (evalSql matches evalRow's semantics)", () => {
    // role("editor") is statically false for a "member" ctx, so the `and`
    // settles without ever resolving owner("missingField") (a typo'd field
    // that would otherwise throw). For an "editor" ctx, role("editor") is
    // statically true, so the `and` needs the owner branch and must throw.
    const gate: EntityDef = {
      fields: postsEntity.fields,
      permissions: {
        update: role("editor").and(rule.owner("missingField")),
      },
    };
    const editor: Ctx = { userId: "u3", role: "editor" };

    it("decide denies a member without throwing (static role branch already decides)", () => {
      expect(() => decide(gate, "update", member, postsTable)).not.toThrow();
      expect(decide(gate, "update", member, postsTable)).toEqual({ allow: false });
    });

    it("checkRow denies a member without throwing (static role branch already decides)", () => {
      expect(() => checkRow(gate, "update", member, { owner: "u1" })).not.toThrow();
      expect(checkRow(gate, "update", member, { owner: "u1" })).toBe(false);
    });

    it("decide throws the clear missing-column error for an editor (owner branch must resolve)", () => {
      expect(() => decide(gate, "update", editor, postsTable)).toThrow(
        'owner() rule references unknown field "missingField" on table',
      );
    });
  });

  describe("unresolvable owner field in read permission", () => {
    // Regression test: a plainly stated owner() rule with a bad field name
    // must throw even when evaluated by a member (not statically pruned).
    const badOwnerEntity: EntityDef = {
      fields: postsEntity.fields,
      permissions: {
        read: rule.owner("badField"),
      },
    };

    it("decide throws for owner() with unresolvable field, no static prune", () => {
      expect(() => decide(badOwnerEntity, "read", member, postsTable)).toThrow(
        /badField/,
      );
    });
  });
});
