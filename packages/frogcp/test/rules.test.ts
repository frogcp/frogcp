import { describe, it, expect } from "vitest";
import { role, rule } from "../src/index";

describe("rule combinators", () => {
  it("builds primitive expressions", () => {
    expect(role("admin").expr).toEqual({ kind: "role", role: "admin" });
    expect(rule.owner("owner").expr).toEqual({ kind: "owner", field: "owner" });
    expect(rule.authenticated().expr).toEqual({ kind: "authenticated" });
    expect(rule.public().expr).toEqual({ kind: "public" });
  });

  it("combines and flattens or/and", () => {
    const r = rule.owner("owner").or(role("admin")).or(role("editor"));
    expect(r.expr).toEqual({
      kind: "or",
      rules: [
        { kind: "owner", field: "owner" },
        { kind: "role", role: "admin" },
        { kind: "role", role: "editor" },
      ],
    });
    const a = rule.authenticated().and(rule.owner("owner"));
    expect(a.expr.kind).toBe("and");
  });
});
