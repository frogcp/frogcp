import { describe, it, expect } from "vitest";
import { buildInsertSchema, buildPatchSchema } from "../src/data/validate";
import { defineBackend, entity, text, number, boolean, select } from "../src/index";

const e = defineBackend({
  entities: { notes: entity({ title: text().required(), status: select(["draft", "published"]).default("draft") }) },
}).entities.notes!;

describe("validation", () => {
  it("requires required fields on insert", () => {
    expect(buildInsertSchema(e).safeParse({}).success).toBe(false);
    expect(buildInsertSchema(e).safeParse({ title: "hi" }).success).toBe(true);
  });
  it("enforces select options", () => {
    expect(buildInsertSchema(e).safeParse({ title: "x", status: "nope" }).success).toBe(false);
  });
  it("strips id and unknown keys", () => {
    const out = buildInsertSchema(e).parse({ title: "x", id: "evil", extra: 1 });
    expect(out).toEqual({ title: "x" });
  });
  it("patch schema is fully optional", () => {
    expect(buildPatchSchema(e).safeParse({}).success).toBe(true);
  });

  it("a required field with a falsy default (0 / false) is optional on insert", () => {
    // Regression: `field.required && !field.default` treats a falsy-but-present
    // default as "no default", wrongly keeping the field mandatory.
    const withFalsyDefaults = defineBackend({
      entities: {
        widgets: entity({
          title: text().required(),
          count: number().required().default(0),
          active: boolean().required().default(false),
        }),
      },
    }).entities.widgets!;

    const result = buildInsertSchema(withFalsyDefaults).safeParse({ title: "x" });
    expect(result.success).toBe(true);
  });

  it("hidden fields are excluded entirely from the insert schema shape, so a client value is silently dropped", () => {
    const withHidden = defineBackend({
      entities: {
        accounts: entity({
          email: text().required(),
          passwordHash: text().hidden(),
        }),
      },
    }).entities.accounts!;

    const out = buildInsertSchema(withHidden).parse({
      email: "a@example.com",
      passwordHash: "attacker-supplied",
    });
    expect(out).toEqual({ email: "a@example.com" });
    expect("passwordHash" in out).toBe(false);
  });

  it("hidden fields are excluded entirely from the patch schema shape, so a client value is silently dropped", () => {
    const withHidden = defineBackend({
      entities: {
        accounts: entity({
          email: text().required(),
          passwordHash: text().hidden(),
        }),
      },
    }).entities.accounts!;

    const out = buildPatchSchema(withHidden).parse({ passwordHash: "attacker-supplied" });
    expect(out).toEqual({});
  });
});
