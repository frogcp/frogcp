import { describe, expect, it } from "vitest";
import { encodeListQuery } from "../../src/client/query";

describe("encodeListQuery", () => {
  it("returns an empty string for an absent/empty query", () => {
    expect(encodeListQuery()).toBe("");
    expect(encodeListQuery({})).toBe("");
  });

  it("encodes a bare scalar filter as the eq shorthand (no [op] suffix)", () => {
    expect(encodeListQuery({ filter: { status: "draft" } })).toBe("?filter[status]=draft");
  });

  it("encodes an explicit single-op filter", () => {
    expect(encodeListQuery({ filter: { age: { gte: 18 } } })).toBe("?filter[age][gte]=18");
  });

  it("encodes a complex list query exactly: filter gte + like + in, multi-sort, with, limit/offset", () => {
    const qs = encodeListQuery({
      filter: {
        age: { gte: 18 },
        name: { like: "%foo%" },
        status: { in: ["draft", "published"] },
      },
      sort: ["-createdAt", "title"],
      limit: 10,
      offset: 20,
      with: ["owner", "reviewer"],
    });

    expect(qs).toBe(
      "?filter[age][gte]=18" +
        "&filter[name][like]=%25foo%25" +
        "&filter[status][in]=draft&filter[status][in]=published" +
        "&sort=-createdAt,title" +
        "&limit=10" +
        "&offset=20" +
        "&with=owner,reviewer",
    );
  });

  it("emits an `in` filter as repeated params, percent-encoding a comma WITHIN an item", () => {
    // `in: ["a,b", "c"]` must NOT become `filter[status][in]=a,b,c` (which the
    // server would split into THREE items). Each item is its own repeated
    // param, and the literal comma inside "a,b" is percent-encoded (%2C) so it
    // survives `URLSearchParams` decoding as one atomic item server-side.
    const qs = encodeListQuery({ filter: { status: { in: ["a,b", "c"] } } });
    expect(qs).toBe("?filter[status][in]=a%2Cb&filter[status][in]=c");

    const url = new URL(`http://x/api/entity/notes${qs}`);
    expect(url.searchParams.getAll("filter[status][in]")).toEqual(["a,b", "c"]);
  });

  it("emits a SINGLE-item `in` filter TWICE, so a comma embedded in that one item survives the server's legacy single-value comma-split fallback", () => {
    // The server's `coerceInValues` only takes the "already repeated" path
    // (raw items kept verbatim) when `getAll(...)` returns MORE than one
    // value. With exactly one item, it instead falls back to splitting that
    // lone value on `,`, so a single `in: ["a,b"]` naively encoded as one
    // param would come back server-side as TWO items ("a", "b"), silently
    // corrupting the filter. Emitting the lone item twice forces the
    // repeated-param path (`getAll(...).length === 2`); SQL `IN (...)` dedupes
    // the repeated value, so the filter semantics are unchanged.
    const qs = encodeListQuery({ filter: { status: { in: ["a,b"] } } });
    expect(qs).toBe("?filter[status][in]=a%2Cb&filter[status][in]=a%2Cb");

    const url = new URL(`http://x/api/entity/notes${qs}`);
    expect(url.searchParams.getAll("filter[status][in]")).toEqual(["a,b", "a,b"]);
  });

  it("ANDs multiple conditions on the same field in a deterministic op order (gte before lte)", () => {
    const qs = encodeListQuery({ filter: { priority: { lte: 5, gte: 2 } } });
    expect(qs).toBe("?filter[priority][gte]=2&filter[priority][lte]=5");
  });

  it("serializes a Date filter value to its ISO string", () => {
    const d = new Date("2026-01-01T00:00:00.000Z");
    const qs = encodeListQuery({ filter: { createdAt: { gte: d } } });
    expect(qs).toBe(`?filter[createdAt][gte]=${encodeURIComponent(d.toISOString())}`);
  });

  it("round-trips through the server's own parseListQuery grammar", () => {
    // `parseListQuery` reads off a `URL`'s `searchParams`, which
    // percent-decodes both keys and values regardless of how they were
    // escaped. This is the same shape assertion as the "complex" test above,
    // phrased against the actual consumer instead of a hardcoded string, so a
    // change to either side's grammar is caught either way.
    const qs = encodeListQuery({
      filter: { status: { in: ["draft", "published"] } },
      sort: ["-createdAt"],
      with: ["owner"],
    });
    const url = new URL(`http://x/api/entity/notes${qs}`);
    expect(url.searchParams.getAll("filter[status][in]")).toEqual(["draft", "published"]);
    expect(url.searchParams.get("sort")).toBe("-createdAt");
    expect(url.searchParams.get("with")).toBe("owner");
  });
});
