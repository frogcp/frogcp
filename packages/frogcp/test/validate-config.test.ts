import { describe, it, expect } from "vitest";
import { defineBackend, entity, text, number, rule } from "../src/index";

describe("validateConfig (run from defineBackend)", () => {
  it("rejects a field named \"id\"", () => {
    expect(() =>
      defineBackend({
        entities: { notes: entity({ id: text() }) },
      }),
    ).toThrow(/field "id".*notes.*reserved/is);
  });

  it("rejects a field named \"expand\"", () => {
    expect(() =>
      defineBackend({
        entities: { notes: entity({ expand: text() }) },
      }),
    ).toThrow(/field "expand".*notes.*reserved/is);
  });

  it("rejects a field name starting with \"__frogcp\"", () => {
    expect(() =>
      defineBackend({
        entities: { notes: entity({ __frogcp_internal: text() }) },
      }),
    ).toThrow(/field "__frogcp_internal".*reserved/is);
  });

  it("rejects an entity name starting with \"__frogcp\"", () => {
    expect(() =>
      defineBackend({
        entities: { __frogcp_secret: entity({ title: text() }) },
      }),
    ).toThrow(/entity name "__frogcp_secret".*reserved/is);
  });

  it("rejects an owner() rule referencing a field that doesn't exist on the entity", () => {
    expect(() =>
      defineBackend({
        entities: {
          notes: entity({ title: text().required() }).permissions({
            read: rule.owner("missingField"),
          }),
        },
      }),
    ).toThrow(/owner\("missingField"\).*notes.*"missingField" does not exist/is);
  });

  it('accepts rule.owner("id"): the self-ownership pattern for a users-style entity (the row is the user)', () => {
    expect(() =>
      defineBackend({
        entities: {
          users: entity({ name: text().required() }).permissions({
            read: rule.owner("id"),
          }),
        },
      }),
    ).not.toThrow();
  });

  it("rejects an owner() rule referencing a field with a non-text-compatible type", () => {
    expect(() =>
      defineBackend({
        entities: {
          notes: entity({ title: text().required(), priority: number() }).permissions({
            read: rule.owner("priority"),
          }),
        },
      }),
    ).toThrow(/owner\("priority"\).*type "number".*text-compatible/is);
  });

  it("rejects an owner() rule referencing a hidden field (would make permissions unobservable)", () => {
    expect(() =>
      defineBackend({
        entities: {
          accounts: entity({
            secretOwnerId: text().hidden(),
          }).permissions({
            read: rule.owner("secretOwnerId"),
          }),
        },
      }),
    ).toThrow(/owner\("secretOwnerId"\).*accounts.*hidden/is);
  });

  it("accepts an optional resources declaration (type -> binding -> options) and round-trips it", () => {
    const config = defineBackend({
      entities: { notes: entity({ title: text().required() }) },
      resources: { d1: { DB: {} }, kv: { CACHE: {} }, ai: { AI: {} } },
    });
    expect(config.resources).toEqual({ d1: { DB: {} }, kv: { CACHE: {} }, ai: { AI: {} } });
  });

  it("omits resources entirely when not declared (zero by default)", () => {
    const config = defineBackend({ entities: { notes: entity({ title: text().required() }) } });
    expect(config.resources).toBeUndefined();
  });

  it("rejects a malformed resources block (binding not mapped to an options object)", () => {
    expect(() =>
      defineBackend({
        entities: { notes: entity({ title: text().required() }) },
        // @ts-expect-error deliberately malformed for the runtime check
        resources: { d1: { DB: "nope" } },
      }),
    ).toThrow(/resources\.d1\.DB.*options object/is);
  });

  it("rejects a resources type not mapped to a bindings object", () => {
    expect(() =>
      defineBackend({
        entities: { notes: entity({ title: text().required() }) },
        // @ts-expect-error deliberately malformed for the runtime check
        resources: { d1: [] },
      }),
    ).toThrow(/resources\.d1.*bindingName/is);
  });

  it("accepts a well-formed config with a valid owner() rule and no reserved names", () => {
    expect(() =>
      defineBackend({
        entities: {
          users: entity({ name: text().required() }),
          notes: entity({
            title: text().required(),
            owner: text().required(),
          }).permissions({
            read: rule.owner("owner"),
          }),
        },
      }),
    ).not.toThrow();
  });
});
