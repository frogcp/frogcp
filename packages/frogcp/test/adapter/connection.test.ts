import { describe, expect, it } from "vitest";
import { resolveConnection, type Connection } from "../../src/adapter/connection";
import { nodeSqliteAdapter } from "../../src/adapter/node";

describe("resolveConnection", () => {
  it("resolves a bare `:memory:` string to a node:sqlite adapter", async () => {
    const adapter = await resolveConnection(":memory:");
    expect(adapter.dialect).toBe("sqlite");
    // usable end-to-end (a trivial DDL round-trips)
    await adapter.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
  });

  it("resolves a `file:` URL to node:sqlite (default sqlite family), stripping the scheme", async () => {
    const adapter = await resolveConnection("file::memory:");
    expect(adapter.dialect).toBe("sqlite");
    await adapter.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
  });

  it("passes a resolved DatabaseAdapter straight through", async () => {
    const existing = nodeSqliteAdapter(":memory:");
    const adapter = await resolveConnection(existing);
    expect(adapter).toBe(existing);
  });

  it("invokes a () => DatabaseAdapter resolver", async () => {
    const existing = nodeSqliteAdapter(":memory:");
    let calls = 0;
    const resolver: Connection = () => {
      calls += 1;
      return existing;
    };
    const adapter = await resolveConnection(resolver);
    expect(adapter).toBe(existing);
    expect(calls).toBe(1);
  });

  it("wraps a Cloudflare D1 binding (structural detection) with d1Adapter", async () => {
    // A structural D1 stand-in: `prepare` plus `batch` distinguish it from a
    // DatabaseAdapter. We only assert the resolver selects the D1 path and
    // returns a sqlite-dialect adapter, no query is issued against the stub.
    const d1Stub = {
      prepare: () => ({}),
      batch: () => [],
      dump: () => ({}),
      exec: () => ({}),
    } as unknown as Connection;
    const adapter = await resolveConnection(d1Stub);
    expect(adapter.dialect).toBe("sqlite");
  });

  it("throws on an unrecognized connection", async () => {
    await expect(resolveConnection({} as unknown as Connection)).rejects.toThrow(/unrecognized connection/);
  });
});
