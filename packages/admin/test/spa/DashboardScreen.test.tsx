// @vitest-environment jsdom
import { FrogClientError } from "frogcp/client";
import { render, screen, within } from "@testing-library/react";
import type { EntitySchemaSummary } from "frogcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardScreen } from "../../spa/screens/DashboardScreen";

const listMock = vi.fn();

// This mock forwards the entity NAME as the first arg, unlike the
// single-entity screens' mocks: the dashboard queries several entities in one
// render, so the fixture below has to tell them apart.
vi.mock("../../spa/api", () => ({
  client: {
    entity: (name: string) => ({
      list: (query?: unknown) => listMock(name, query),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    }),
  },
}));

// "posts" has a `select` field (status breakdown) and an `auto` timestamp
// (recent records + trend chart); "comments" has neither and always rejects,
// standing in for a 403 to exercise the allSettled failure path; "tags" is a
// plain always-succeeding entity.
const ENTITIES: Record<string, EntitySchemaSummary> = {
  posts: {
    fields: {
      title: { type: "text", required: true },
      status: { type: "select", required: false, options: ["draft", "published"] },
      createdAt: { type: "timestamp", required: false, auto: true },
    },
    permissions: {},
    permissionRules: {},
  },
  comments: {
    fields: { body: { type: "text", required: true } },
    permissions: {},
    permissionRules: {},
  },
  tags: {
    fields: { name: { type: "text", required: true } },
    permissions: {},
    permissionRules: {},
  },
};

// Relative to the real "now" rather than hardcoded, so these always land
// inside the dashboard's trailing trend window whenever the suite runs.
const now = Date.now();
const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString();
const POSTS_RECENT = [
  { id: "p1", title: "Hello world", createdAt: daysAgo(0) },
  { id: "p2", title: "Second post", createdAt: daysAgo(1) },
];

function defaultListImpl(name: string, query: any) {
  if (name === "comments") {
    return Promise.reject(new FrogClientError(403, "forbidden", "no read access"));
  }
  if (name === "tags") {
    // Deliberately not equal to the entity count (3) or the total (11) below:
    // every asserted number must be unique on the page, or `getByText`
    // collides across the stat tile, magnitude bar, and status breakdown.
    return Promise.resolve({ data: [], meta: { total: 4, limit: 1, offset: 0 } });
  }
  if (query?.filter) {
    const value = Object.values(query.filter)[0] as string;
    const counts: Record<string, number> = { draft: 2, published: 5 };
    return Promise.resolve({ data: [], meta: { total: counts[value] ?? 0, limit: 1, offset: 0 } });
  }
  if (query?.sort) {
    return Promise.resolve({ data: POSTS_RECENT, meta: { total: 7, limit: 5, offset: 0 } });
  }
  return Promise.resolve({ data: [], meta: { total: 7, limit: 1, offset: 0 } });
}

afterEach(() => {
  vi.restoreAllMocks();
  listMock.mockReset();
});

describe("DashboardScreen", () => {
  it("shows a loading state before any query resolves", () => {
    listMock.mockImplementation(() => new Promise(() => {})); // never resolves
    render(<DashboardScreen entities={ENTITIES} />);

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("renders per-entity record counts and the total, running counts in parallel", async () => {
    listMock.mockImplementation(defaultListImpl);
    render(<DashboardScreen entities={ENTITIES} />);

    // "posts" also appears in the recent-records list and the status breakdown
    // once those load, so scope to the "Records per entity" section.
    const recordsHeading = await screen.findByText("Records per entity");
    const recordsSection = recordsHeading.closest("section") as HTMLElement;
    expect(within(recordsSection).getByText("posts")).toBeInTheDocument();
    expect(within(recordsSection).getByText("tags")).toBeInTheDocument();
    expect(within(recordsSection).getByText("comments")).toBeInTheDocument();

    // posts: 7, tags: 4 -> total 11 (comments failed, excluded from the sum).
    expect(screen.getByText("11")).toBeInTheDocument();
    expect(within(recordsSection).getByText("7")).toBeInTheDocument();
    expect(within(recordsSection).getByText("4")).toBeInTheDocument();
  });

  it("a rejected count query (e.g. 403) renders n/a for that entity instead of crashing the dashboard", async () => {
    listMock.mockImplementation(defaultListImpl);
    render(<DashboardScreen entities={ENTITIES} />);

    expect(await screen.findByText("Records per entity")).toBeInTheDocument();
    const naValues = await screen.findAllByText("n/a");
    expect(naValues.length).toBeGreaterThan(0);
    // The rest of the dashboard still rendered.
    expect(screen.getByText("comments")).toBeInTheDocument();
  });

  it("renders a status breakdown for the entity with a select field", async () => {
    listMock.mockImplementation(defaultListImpl);
    render(<DashboardScreen entities={ENTITIES} />);

    expect(await screen.findByText("Status breakdown")).toBeInTheDocument();
    expect(screen.getByText("draft")).toBeInTheDocument();
    expect(screen.getByText("published")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("renders recent records for the entity with an auto timestamp field", async () => {
    listMock.mockImplementation(defaultListImpl);
    render(<DashboardScreen entities={ENTITIES} />);

    expect(await screen.findByText("Recent records")).toBeInTheDocument();
    expect(screen.getByText("Hello world")).toBeInTheDocument();
    expect(screen.getByText("Second post")).toBeInTheDocument();
  });

  it("omits the status, trend, and recent-records sections when no entity has a select or auto-timestamp field", async () => {
    // Only plain fields, so all three optional sections should vanish while
    // the per-entity counts still render.
    const plainOnly: Record<string, EntitySchemaSummary> = {
      tags: { fields: { name: { type: "text", required: true } }, permissions: {}, permissionRules: {} },
      links: { fields: { url: { type: "text", required: true } }, permissions: {}, permissionRules: {} },
    };
    listMock.mockResolvedValue({ data: [], meta: { total: 2, limit: 1, offset: 0 } });
    render(<DashboardScreen entities={plainOnly} />);

    // The always-present counts section renders...
    expect(await screen.findByText("Records per entity")).toBeInTheDocument();
    expect(screen.getByText("tags")).toBeInTheDocument();
    expect(screen.getByText("links")).toBeInTheDocument();

    // ...but every optional section is absent.
    expect(screen.queryByText("Status breakdown")).not.toBeInTheDocument();
    expect(screen.queryByText("Recent records")).not.toBeInTheDocument();
    expect(screen.queryByText(/created in the last/i)).not.toBeInTheDocument();
  });

  it("renders a graceful empty state for a schema with zero entities", () => {
    render(<DashboardScreen entities={{}} />);

    expect(screen.getByText(/no entities in this schema yet/i)).toBeInTheDocument();
  });
});
