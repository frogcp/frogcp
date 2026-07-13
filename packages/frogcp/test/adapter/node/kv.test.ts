import { describe, expect, test } from "vitest";
import { nodeKv } from "../../../src/adapter/node/kv";

/** A mutable clock so TTL behavior is deterministic without real time. */
function fakeClock(startMs = 1_000_000) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("nodeKv", () => {
  test("get returns null for a missing key", async () => {
    const kv = nodeKv(":memory:");
    expect(await kv.get("nope")).toBeNull();
  });

  test("put then get round-trips a value", async () => {
    const kv = nodeKv(":memory:");
    await kv.put("route:app", '{"slug":"blue","version":1}');
    expect(await kv.get("route:app")).toBe('{"slug":"blue","version":1}');
  });

  test("put overwrites an existing value", async () => {
    const kv = nodeKv(":memory:");
    await kv.put("k", "one");
    await kv.put("k", "two");
    expect(await kv.get("k")).toBe("two");
  });

  test("delete removes a key and is a no-op when absent", async () => {
    const kv = nodeKv(":memory:");
    await kv.put("k", "v");
    await kv.delete("k");
    expect(await kv.get("k")).toBeNull();
    await kv.delete("k"); // no throw on already-absent
  });

  test("a value with no TTL never expires", async () => {
    const clock = fakeClock();
    const kv = nodeKv(":memory:", { now: clock.now });
    await kv.put("k", "v");
    clock.advance(1_000 * 60 * 60 * 24 * 365);
    expect(await kv.get("k")).toBe("v");
  });

  test("a value expires after its expirationTtl", async () => {
    const clock = fakeClock();
    const kv = nodeKv(":memory:", { now: clock.now });
    await kv.put("k", "v", { expirationTtl: 60 });
    clock.advance(59_000);
    expect(await kv.get("k")).toBe("v");
    clock.advance(2_000); // now 61s elapsed
    expect(await kv.get("k")).toBeNull();
  });

  test("list returns keys under a prefix, excluding expired ones", async () => {
    const clock = fakeClock();
    const kv = nodeKv(":memory:", { now: clock.now });
    await kv.put("route:app", "1");
    await kv.put("route:api", "2");
    await kv.put("other:x", "3");
    await kv.put("route:temp", "4", { expirationTtl: 10 });

    expect((await kv.list!("route:")).sort()).toEqual(["route:api", "route:app", "route:temp"]);

    clock.advance(11_000);
    expect((await kv.list!("route:")).sort()).toEqual(["route:api", "route:app"]);
  });
});
