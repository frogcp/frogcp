// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../spa/App";

// `App.test.tsx` proves login -> shell and `ShellScreen.test.tsx` proves
// entity-select -> `DataBrowser`, but both in isolation. This file is the one
// test that runs the transitions back-to-back from the same unauthenticated
// `App` root the real SPA boots as.
const meMock = vi.fn();
const loginMock = vi.fn();
const listMock = vi.fn();

vi.mock("../../spa/api", () => ({
  client: {
    auth: {
      me: () => meMock(),
      login: (...args: unknown[]) => loginMock(...args),
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

beforeEach(() => {
  window.history.pushState({}, "", "/admin/");
});

afterEach(() => {
  vi.restoreAllMocks();
  meMock.mockReset();
  loginMock.mockReset();
  listMock.mockReset();
});

describe("App: composed flow (login -> shell -> entity select -> data browser)", () => {
  it("logging in from the login screen reveals the shell, and selecting an entity lists its rows", async () => {
    meMock.mockRejectedValueOnce(new Error("401"));

    const user = { id: "u1", email: "admin@example.com", role: "admin", createdAt: "2026-01-01T00:00:00.000Z" };
    loginMock.mockResolvedValueOnce({ user });

    // ShellScreen's boot-time schema fetch bypasses `frogcp/client`, so it has
    // to be stubbed on the global `fetch` rather than the api mock above.
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
    listMock.mockResolvedValue({
      data: [{ id: "r1", title: "First note" }],
      meta: { total: 1, limit: 25, offset: 0 },
    });

    render(<App />);

    const emailInput = await screen.findByLabelText(/email/i);
    const passwordInput = screen.getByLabelText(/password/i);
    fireEvent.change(emailInput, { target: { value: "admin@example.com" } });
    fireEvent.change(passwordInput, { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByText("admin@example.com")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "notes" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /dashboard/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "notes" }));

    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(await screen.findByText("First note")).toBeInTheDocument();
    expect(listMock).toHaveBeenCalled();
  });
});
