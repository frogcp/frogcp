// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../spa/App";

const meMock = vi.fn();
// The shell defaults to `DashboardScreen`, which lists every entity in the
// schema to compute its counts, so this stub has to resolve even in tests that
// never open a `DataBrowser`. None of them assert on the dashboard's numbers.
const listMock = vi.fn().mockResolvedValue({ data: [], meta: { total: 0, limit: 1, offset: 0 } });

vi.mock("../../spa/api", () => ({
  client: {
    auth: {
      me: () => meMock(),
      login: vi.fn(),
      logout: vi.fn(),
    },
    entity: () => ({
      list: (...args: unknown[]) => listMock(...args),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    }),
  },
}));

// `App`'s `<BrowserRouter basename="/admin">` renders nothing when the URL
// doesn't start with that basename, and jsdom defaults to `http://localhost/`.
// Move under `/admin/` first, matching how the SPA is actually served.
beforeEach(() => {
  window.history.pushState({}, "", "/admin/");
});

afterEach(() => {
  vi.restoreAllMocks();
  meMock.mockReset();
  // `.mockClear()`, not `.mockReset()`: the default resolved value is set once
  // above and every test relies on it still being there.
  listMock.mockClear();
});

describe("App", () => {
  it("shows the login screen when there is no existing session", async () => {
    meMock.mockRejectedValueOnce(new Error("401"));
    render(<App />);
    expect(await screen.findByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("shows the app shell's sidebar nav after an existing session is detected", async () => {
    meMock.mockResolvedValueOnce({
      user: { id: "u1", email: "admin@example.com", role: "admin", createdAt: "2026-01-01T00:00:00.000Z" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            entities: {
              notes: { fields: {}, permissions: {} },
              users: { fields: {}, permissions: {} },
              media_files: { fields: {}, permissions: {} },
            },
          },
        }),
      }),
    );

    render(<App />);

    expect(await screen.findByText("admin@example.com")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Users" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Media" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Schema" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Permissions" })).toBeInTheDocument();
    // "notes" also appears in the dashboard's magnitude bar once its data
    // loads, so target the sidebar nav button specifically.
    expect(await screen.findByRole("button", { name: "notes" })).toBeInTheDocument();
  });

  it("hides the Users and Media nav items when their entities are absent from the schema", async () => {
    meMock.mockResolvedValueOnce({
      user: { id: "u1", email: "admin@example.com", role: "admin", createdAt: "2026-01-01T00:00:00.000Z" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { entities: { notes: { fields: {}, permissions: {} } } } }),
      }),
    );

    render(<App />);

    expect(await screen.findByText("admin@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Schema" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Permissions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Users" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Media" })).not.toBeInTheDocument();
  });
});
