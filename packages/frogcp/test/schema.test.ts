import { describe, it, expect } from "vitest";
import { defineBackend, entity, text, timestamp, select, ref } from "../src/index";

describe("entity DSL", () => {
  const config = defineBackend({
    entities: {
      notes: entity({
        title: text().required(),
        status: select(["draft", "published"]).default("draft"),
        createdAt: timestamp().auto(),
        owner: ref("users").onDelete("cascade"),
      }),
    },
  });

  it("resolves field definitions", () => {
    const f = config.entities.notes!.fields;
    expect(f.title).toEqual({ type: "text", required: true });
    expect(f.status).toEqual({ type: "select", required: false, options: ["draft", "published"], default: "draft" });
    expect(f.createdAt).toEqual({ type: "timestamp", required: false, auto: true });
    expect(f.owner).toEqual({ type: "ref", required: false, target: "users", onDelete: "cascade" });
  });

  it("freezes the config", () => {
    expect(Object.isFrozen(config.entities)).toBe(true);
  });

  it("rejects select without options", () => {
    // @ts-expect-error select requires options
    expect(() => select()).toThrow();
  });

  it(".unique(), .hidden(), and .readonly() are chainable on any field type, in any order", () => {
    const withFlags = defineBackend({
      entities: {
        accounts: entity({
          email: text().required().unique(),
          secret: text().hidden(),
          rank: timestamp().unique().hidden(),
          tier: text().required().default("free").readonly(),
        }),
      },
    });
    const f = withFlags.entities.accounts!.fields;
    expect(f.email).toEqual({ type: "text", required: true, unique: true });
    expect(f.secret).toEqual({ type: "text", required: false, hidden: true });
    expect(f.rank).toEqual({ type: "timestamp", required: false, unique: true, hidden: true });
    expect(f.tier).toEqual({ type: "text", required: true, default: "free", readonly: true });
  });
});
