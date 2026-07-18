// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LoginScreen } from "../../spa/screens/LoginScreen";

const loginMock = vi.fn();

vi.mock("../../spa/api", () => ({
  client: {
    auth: {
      login: (input: unknown) => loginMock(input),
    },
  },
}));

describe("LoginScreen", () => {
  it("renders email and password inputs and a submit button", () => {
    render(<LoginScreen onLogin={() => {}} />);
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("submitting the form calls client.auth.login with the entered credentials", async () => {
    loginMock.mockResolvedValueOnce({
      user: { id: "u1", email: "admin@example.com", role: "admin", createdAt: "2026-01-01T00:00:00.000Z" },
    });
    const onLogin = vi.fn();
    render(<LoginScreen onLogin={onLogin} />);

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "admin@example.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(loginMock).toHaveBeenCalledWith({ email: "admin@example.com", password: "hunter2" }));
    await waitFor(() => expect(onLogin).toHaveBeenCalledWith(expect.objectContaining({ email: "admin@example.com" })));
  });

  it("shows the thrown error message when login rejects", async () => {
    loginMock.mockRejectedValueOnce(new Error("Invalid credentials"));
    render(<LoginScreen onLogin={() => {}} />);

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid credentials");
  });
});
