import { describe, it, expect } from "vitest";
import {
  defineBackend,
  entity,
  text,
  number,
  boolean,
  date,
  timestamp,
  json,
  select,
  media,
  ref,
  rule,
  role,
  serializeConfig,
  deserializeConfig,
} from "../src/index";

/** A config exercising every field type + every flag, and every permission combinator. */
function buildFullConfig() {
  return defineBackend({
    entities: {
      users: entity({
        name: text().required().unique(),
        email: text().unique(),
        passwordHash: text().hidden(),
        bio: text().readonly(),
      }).permissions({
        read: rule.owner("id"),
        list: rule.public(),
        create: rule.authenticated(),
        update: rule.owner("id").or(role("admin")),
        delete: rule.owner("id").and(rule.authenticated()),
      }),
      posts: entity({
        title: text().required(),
        views: number().default(0),
        published: boolean().default(false),
        publishDate: date(),
        createdAt: timestamp().auto(),
        metadata: json(),
        status: select(["draft", "published", "archived"]).default("draft"),
        cover: media(),
        author: ref("users").onDelete("cascade").required(),
        reviewer: ref("users").onDelete("set null"),
      }).permissions({
        read: role("editor").or(rule.owner("author")).or(rule.authenticated()),
        list: rule.public(),
      }),
    },
  });
}

describe("serializeConfig / deserializeConfig round-trip", () => {
  it("round-trips every field type + flag + permission combinator, deep-equal to the original resolved config", () => {
    const config = buildFullConfig();
    const json = serializeConfig(config);
    const restored = deserializeConfig(json);

    expect(restored.entities).toEqual(config.entities);
  });

  it("produces the documented JSON shape: entities.<name>.{fields,permissions.<action>: RuleExpr}", () => {
    const config = defineBackend({
      entities: {
        notes: entity({ title: text().required() }).permissions({ read: rule.owner("id") }),
      },
    });
    const parsed = JSON.parse(serializeConfig(config));
    expect(parsed).toEqual({
      entities: {
        notes: {
          fields: { title: { type: "text", required: true } },
          permissions: { read: { kind: "owner", field: "id" } },
        },
      },
    });
  });

  it("round-trips an empty-entities config", () => {
    const config = defineBackend({ entities: {} });
    expect(deserializeConfig(serializeConfig(config)).entities).toEqual({});
  });

  it("revives a timestamp() Date default across the JSON boundary (not left as an ISO string)", () => {
    const fixed = new Date("2026-01-01T00:00:00.000Z");
    const config = defineBackend({
      entities: {
        events: entity({ title: text().required(), createdAt: timestamp().default(fixed) }),
      },
    });
    const restored = deserializeConfig(serializeConfig(config));

    const revivedDefault = restored.entities.events!.fields.createdAt!.default;
    expect(revivedDefault).toBeInstanceOf(Date);
    expect((revivedDefault as Date).getTime()).toBe(fixed.getTime());
    // Whole-config deep-equal: the revived Date must match the original Date.
    expect(restored.entities).toEqual(config.entities);
  });

  it("revives a date() Date default the same way", () => {
    const fixed = new Date("2026-06-15T12:30:00.000Z");
    const config = defineBackend({
      entities: { holidays: entity({ name: text().required(), on: date().default(fixed) }) },
    });
    const restored = deserializeConfig(serializeConfig(config));
    expect(restored.entities).toEqual(config.entities);
  });
});

describe("deserializeConfig rejects malformed input", () => {
  it("rejects invalid JSON", () => {
    expect(() => deserializeConfig("{ not json")).toThrow(/invalid JSON/i);
  });

  it("rejects a non-object payload", () => {
    expect(() => deserializeConfig(JSON.stringify(["nope"]))).toThrow(/malformed config/i);
  });

  it("rejects an unknown field type", () => {
    const bad = JSON.stringify({
      entities: { notes: { fields: { title: { type: "bogus", required: false } }, permissions: {} } },
    });
    expect(() => deserializeConfig(bad)).toThrow(/unknown field type "bogus"/i);
  });

  it("rejects a RuleExpr with an unknown kind", () => {
    const bad = JSON.stringify({
      entities: {
        notes: {
          fields: { title: { type: "text", required: true } },
          permissions: { read: { kind: "wizardry" } },
        },
      },
    });
    expect(() => deserializeConfig(bad)).toThrow(/unknown rule kind "wizardry"/i);
  });

  it("rejects a nested RuleExpr (inside or/and) with an unknown kind", () => {
    const bad = JSON.stringify({
      entities: {
        notes: {
          fields: { title: { type: "text", required: true } },
          permissions: { read: { kind: "or", rules: [{ kind: "public" }, { kind: "nope" }] } },
        },
      },
    });
    expect(() => deserializeConfig(bad)).toThrow(/unknown rule kind "nope"/i);
  });

  it("rejects (via validateConfig) a reserved field name surviving into stored JSON", () => {
    const bad = JSON.stringify({
      entities: {
        notes: { fields: { id: { type: "text", required: false } }, permissions: {} },
      },
    });
    expect(() => deserializeConfig(bad)).toThrow(/reserved/i);
  });

  it("rejects a ref() field targeting an entity that doesn't exist", () => {
    const bad = JSON.stringify({
      entities: {
        posts: {
          fields: { author: { type: "ref", required: false, target: "missingEntity" } },
          permissions: {},
        },
      },
    });
    expect(() => deserializeConfig(bad)).toThrow(/unknown ref target "missingEntity"/i);
  });

  function selectFieldConfig(options: unknown): string {
    return JSON.stringify({
      entities: {
        posts: {
          fields: { status: { type: "select", required: false, options } },
          permissions: {},
        },
      },
    });
  }

  it("rejects a select field with missing options", () => {
    expect(() => deserializeConfig(selectFieldConfig(undefined))).toThrow(
      /select requires a non-empty string\[\] options/i,
    );
  });

  it("rejects a select field with an empty options array", () => {
    expect(() => deserializeConfig(selectFieldConfig([]))).toThrow(
      /select requires a non-empty string\[\] options/i,
    );
  });

  it("rejects a select field whose options contains non-string items", () => {
    expect(() => deserializeConfig(selectFieldConfig(["ok", 42]))).toThrow(
      /select requires a non-empty string\[\] options/i,
    );
  });

  it("rejects a date/timestamp default that isn't a valid date string", () => {
    const bad = JSON.stringify({
      entities: {
        events: {
          fields: { createdAt: { type: "timestamp", required: false, default: "not-a-date" } },
          permissions: {},
        },
      },
    });
    expect(() => deserializeConfig(bad)).toThrow(/default "not-a-date" is not a valid timestamp value/i);
  });

  function ruleConfig(rule: unknown): string {
    return JSON.stringify({
      entities: {
        notes: { fields: { title: { type: "text", required: true } }, permissions: { read: rule } },
      },
    });
  }

  it("rejects an `and` combinator with an empty rules array (corrupt combinator)", () => {
    expect(() => deserializeConfig(ruleConfig({ kind: "and", rules: [] }))).toThrow(
      /requires at least one sub-rule/i,
    );
  });

  it("rejects an `or` combinator with an empty rules array (corrupt combinator)", () => {
    expect(() => deserializeConfig(ruleConfig({ kind: "or", rules: [] }))).toThrow(
      /requires at least one sub-rule/i,
    );
  });

  it("rejects a role rule with an empty-string role", () => {
    expect(() => deserializeConfig(ruleConfig({ kind: "role", role: "" }))).toThrow(
      /rule "role" requires a non-empty string/i,
    );
  });

  it("rejects a role rule with a whitespace-only role", () => {
    expect(() => deserializeConfig(ruleConfig({ kind: "role", role: "   " }))).toThrow(
      /rule "role" requires a non-empty string/i,
    );
  });

  it("rejects an owner rule with an empty-string field", () => {
    expect(() => deserializeConfig(ruleConfig({ kind: "owner", field: "" }))).toThrow(
      /rule "owner" requires a non-empty string/i,
    );
  });

  it("rejects a nested empty combinator (the `role(admin) AND ()` corrupt state)", () => {
    const bad = ruleConfig({ kind: "and", rules: [{ kind: "role", role: "admin" }, { kind: "or", rules: [] }] });
    expect(() => deserializeConfig(bad)).toThrow(/requires at least one sub-rule/i);
  });
});
