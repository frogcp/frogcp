// @vitest-environment jsdom
import { FrogClientError } from "frogcp/client";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsersScreen } from "../../spa/screens/UsersScreen";

const listMock = vi.fn();
const updateMock = vi.fn();

vi.mock("../../spa/api", () => ({
  client: {
    entity: () => ({
      list: (...args: unknown[]) => listMock(...args),
      get: vi.fn(),
      create: vi.fn(),
      update: (...args: unknown[]) => updateMock(...args),
      delete: vi.fn(),
    }),
  },
}));

const USERS = [
  { id: "u1", email: "admin@example.com", name: "Admin", role: "admin", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "u2", email: "bob@example.com", name: "Bob", role: "member", createdAt: "2026-01-02T00:00:00.000Z" },
];

afterEach(() => {
  vi.restoreAllMocks();
  listMock.mockReset();
  updateMock.mockReset();
});

describe("UsersScreen", () => {
  it("renders users from the mocked list", async () => {
    listMock.mockResolvedValueOnce({ data: USERS, meta: { total: 2, limit: 100, offset: 0 } });
    render(<UsersScreen />);

    expect(await screen.findByText("admin@example.com")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
    // passwordHash is hidden and never on the wire, so nothing renders it.
    expect(screen.queryByText(/passwordHash/i)).not.toBeInTheDocument();
  });

  it("changing a user's role dropdown calls client.entity('users').update(id, { role })", async () => {
    listMock.mockResolvedValueOnce({ data: USERS, meta: { total: 2, limit: 100, offset: 0 } });
    updateMock.mockResolvedValueOnce({ ...USERS[1], role: "admin" });
    render(<UsersScreen />);

    const select = await screen.findByLabelText(/role for bob@example.com/i);
    fireEvent.change(select, { target: { value: "admin" } });

    await waitFor(() => expect(updateMock).toHaveBeenCalledWith("u2", { role: "admin" }));
  });

  it("surfaces a 422 'server-managed' error inline without blocking the rest of the table", async () => {
    listMock.mockResolvedValueOnce({ data: USERS, meta: { total: 2, limit: 100, offset: 0 } });
    updateMock.mockRejectedValueOnce(new FrogClientError(422, "validation", "role is server-managed"));
    render(<UsersScreen />);

    const select = await screen.findByLabelText(/role for bob@example.com/i);
    fireEvent.change(select, { target: { value: "admin" } });

    expect(await screen.findByRole("alert")).toHaveTextContent(/server-managed/i);
    expect(screen.getByText("admin@example.com")).toBeInTheDocument();
  });
});
