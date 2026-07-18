// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellScreen } from "../../spa/screens/ShellScreen";

/** Shaped to match what `buildClientError` (from `frogcp/client`) expects:
 * `ok`/`status` plus a `json()` resolving to the frogCP error envelope, so
 * `ShellScreen` parses out a real `FrogClientError` rather than a generic one. */
function errorResponse(status: number, code: string, message: string) {
  return { ok: false, status, statusText: "", json: async () => ({ error: { code, message } }) };
}

const listMock = vi.fn();
const logoutMock = vi.fn();

vi.mock("../../spa/api", () => ({
  client: {
    auth: { logout: () => logoutMock() },
    entity: () => ({
      list: (...args: unknown[]) => listMock(...args),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    }),
  },
}));

const user = { id: "u1", email: "admin@example.com", role: "admin", createdAt: "2026-01-01T00:00:00.000Z" };

afterEach(() => {
  vi.restoreAllMocks();
  listMock.mockReset();
  logoutMock.mockReset();
});

describe("ShellScreen", () => {
  it("selecting an entity from the sidebar mounts a schema-driven DataBrowser for it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            entities: {
              notes: { fields: { title: { type: "text", required: true } }, permissions: {} },
            },
          },
        }),
      }),
    );
    listMock.mockResolvedValue({ data: [], meta: { total: 0, limit: 25, offset: 0 } });

    render(<ShellScreen user={user} onLogout={() => {}} />);

    // The dashboard is the default selection, and its heading renders
    // synchronously, before the schema fetch resolves.
    expect(screen.getByRole("heading", { name: /dashboard/i })).toBeInTheDocument();

    // "notes" appears twice once the dashboard loads (sidebar nav item and
    // magnitude bar), so target the nav button by its accessible role.
    fireEvent.click(await screen.findByRole("button", { name: "notes" }));

    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /title/i })).toBeInTheDocument();
    expect(listMock).toHaveBeenCalled();
  });

  it("a 403 FrogClientError from the schema fetch renders the admin-required message, not the empty 'No entities' shell", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(errorResponse(403, "forbidden", "Admin role required")),
    );

    render(<ShellScreen user={user} onLogout={() => {}} />);

    expect(await screen.findByText(/admin role required/i)).toBeInTheDocument();
    // Falling through to the ordinary shell would read as "this backend has
    // zero entities", which is false: the fetch was forbidden, not empty.
    expect(screen.queryByRole("heading", { name: /dashboard/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /log out/i }));
    expect(logoutMock).toHaveBeenCalled();
  });

  it("a network error from the schema fetch renders a retry affordance, not the empty 'No entities' shell", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("network down")).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { entities: {} } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ShellScreen user={user} onLogout={() => {}} />);

    expect(await screen.findByText(/failed to load schema/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /dashboard/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    // The retry succeeds with a genuinely empty schema, so the dashboard
    // should show its own "no entities" state rather than the error.
    expect(await screen.findByText(/no entities in this schema yet/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
