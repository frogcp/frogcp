// @vitest-environment jsdom
import { FrogClientError } from "frogcp/client";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { FieldSchemaSummary } from "frogcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataBrowser } from "../../spa/screens/DataBrowser";

const listMock = vi.fn();
const createMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();

vi.mock("../../spa/api", () => ({
  client: {
    entity: () => ({
      list: (...args: unknown[]) => listMock(...args),
      get: vi.fn(),
      create: (...args: unknown[]) => createMock(...args),
      update: (...args: unknown[]) => updateMock(...args),
      delete: (...args: unknown[]) => deleteMock(...args),
    }),
  },
}));

// Covers one field of every kind the browser treats specially: required, auto
// (system-managed), and hidden, which must never surface in the UI.
const FIELDS: Record<string, FieldSchemaSummary> = {
  title: { type: "text", required: true },
  done: { type: "boolean", required: false },
  status: { type: "select", required: false, options: ["todo", "doing", "done"] },
  createdAt: { type: "timestamp", required: false, auto: true },
  secret: { type: "text", required: false, hidden: true },
};

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "r1",
    title: "First note",
    done: false,
    status: "todo",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  listMock.mockReset();
  createMock.mockReset();
  updateMock.mockReset();
  deleteMock.mockReset();
});

describe("DataBrowser", () => {
  it("renders table columns from the schema's non-hidden fields (+ id), excluding hidden ones", async () => {
    listMock.mockResolvedValueOnce({ data: [row()], meta: { total: 1, limit: 25, offset: 0 } });
    render(<DataBrowser entityName="notes" fields={FIELDS} />);

    const table = await screen.findByRole("table");
    const headerText = within(table)
      .getAllByRole("columnheader")
      .map((h) => h.textContent ?? "");

    for (const expected of ["id", "title", "done", "status", "createdAt"]) {
      expect(headerText.some((t) => t.includes(expected))).toBe(true);
    }
    expect(headerText.some((t) => t.includes("secret"))).toBe(false);

    // Auto `createdAt` is shown for reads, even though the create form below
    // excludes it.
    expect(await screen.findByText("First note")).toBeInTheDocument();
  });

  it("paginates from meta.total and refetches with the next offset on Next", async () => {
    listMock.mockResolvedValueOnce({ data: [row()], meta: { total: 60, limit: 25, offset: 0 } });
    render(<DataBrowser entityName="notes" fields={FIELDS} />);

    expect(await screen.findByText("Page 1 of 3")).toBeInTheDocument();

    listMock.mockResolvedValueOnce({ data: [row({ id: "r2" })], meta: { total: 60, limit: 25, offset: 25 } });
    fireEvent.click(screen.getByRole("button", { name: /next/i }));

    await waitFor(() => expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 25, offset: 25 })));
    expect(await screen.findByText("Page 2 of 3")).toBeInTheDocument();
  });

  it("applying a filter refetches with an eq filter built from the field's type", async () => {
    listMock.mockResolvedValue({ data: [row()], meta: { total: 1, limit: 25, offset: 0 } });
    render(<DataBrowser entityName="notes" fields={FIELDS} />);
    await screen.findByRole("table");

    fireEvent.change(screen.getByLabelText(/^filter title$/i), { target: { value: "First" } });
    fireEvent.click(screen.getByRole("button", { name: /^apply$/i }));

    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ filter: { title: "First" }, offset: 0 })),
    );
  });

  it("clicking a column header sorts, toggling direction on a second click", async () => {
    listMock.mockResolvedValue({ data: [row()], meta: { total: 1, limit: 25, offset: 0 } });
    render(<DataBrowser entityName="notes" fields={FIELDS} />);
    await screen.findByRole("table");

    fireEvent.click(screen.getByRole("columnheader", { name: /^title/ }));
    await waitFor(() => expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ sort: ["title"] })));

    fireEvent.click(screen.getByRole("columnheader", { name: /^title/ }));
    await waitFor(() => expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ sort: ["-title"] })));
  });

  it("creating a record posts only eligible fields (no id/auto/hidden) and refreshes the list", async () => {
    listMock.mockResolvedValue({ data: [], meta: { total: 0, limit: 25, offset: 0 } });
    createMock.mockResolvedValueOnce(row());
    render(<DataBrowser entityName="notes" fields={FIELDS} />);
    await screen.findByRole("table");

    fireEvent.click(screen.getByRole("button", { name: /^new$/i }));
    fireEvent.change(screen.getByLabelText(/^title/i), { target: { value: "My new note" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(createMock).toHaveBeenCalled());
    const payload = createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.title).toBe("My new note");
    expect(payload).not.toHaveProperty("id");
    expect(payload).not.toHaveProperty("createdAt");
    expect(payload).not.toHaveProperty("secret");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it("the create form excludes the auto and hidden fields as inputs entirely", async () => {
    listMock.mockResolvedValue({ data: [], meta: { total: 0, limit: 25, offset: 0 } });
    render(<DataBrowser entityName="notes" fields={FIELDS} />);
    await screen.findByRole("table");

    fireEvent.click(screen.getByRole("button", { name: /^new$/i }));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).queryByLabelText(/createdAt/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/secret/i)).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^title/i)).toBeInTheDocument();
  });

  it("shows a client-side validation error for a missing required field, without calling create", async () => {
    listMock.mockResolvedValue({ data: [], meta: { total: 0, limit: 25, offset: 0 } });
    render(<DataBrowser entityName="notes" fields={FIELDS} />);
    await screen.findByRole("table");

    fireEvent.click(screen.getByRole("button", { name: /^new$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/required/i);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("surfaces a 422 FrogClientError from a rejected create inline", async () => {
    listMock.mockResolvedValue({ data: [], meta: { total: 0, limit: 25, offset: 0 } });
    createMock.mockRejectedValueOnce(new FrogClientError(422, "validation", '"title" must be unique'));
    render(<DataBrowser entityName="notes" fields={FIELDS} />);
    await screen.findByRole("table");

    fireEvent.click(screen.getByRole("button", { name: /^new$/i }));
    fireEvent.change(screen.getByLabelText(/^title/i), { target: { value: "dup" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent('"title" must be unique');
  });

  it("surfaces a 403 FrogClientError from a rejected create as a permission message", async () => {
    listMock.mockResolvedValue({ data: [], meta: { total: 0, limit: 25, offset: 0 } });
    createMock.mockRejectedValueOnce(new FrogClientError(403, "forbidden", "Not allowed to create \"notes\""));
    render(<DataBrowser entityName="notes" fields={FIELDS} />);
    await screen.findByRole("table");

    fireEvent.click(screen.getByRole("button", { name: /^new$/i }));
    fireEvent.change(screen.getByLabelText(/^title/i), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/permission/i);
  });

  it("clicking a row opens the edit form pre-filled, and a readonly field renders disabled", async () => {
    const fieldsWithReadonlyTitle: Record<string, FieldSchemaSummary> = {
      ...FIELDS,
      title: { type: "text", required: true, readonly: true },
    };
    listMock.mockResolvedValueOnce({ data: [row()], meta: { total: 1, limit: 25, offset: 0 } });
    render(<DataBrowser entityName="notes" fields={fieldsWithReadonlyTitle} />);

    fireEvent.click(await screen.findByText("First note"));

    const titleInput = await screen.findByLabelText(/^title/i);
    expect(titleInput).toHaveValue("First note");
    expect(titleInput).toBeDisabled();
  });

  it("editing and saving calls client.update with the row's id and the changed fields", async () => {
    listMock.mockResolvedValueOnce({ data: [row()], meta: { total: 1, limit: 25, offset: 0 } });
    updateMock.mockResolvedValueOnce(row({ title: "Updated title" }));
    render(<DataBrowser entityName="notes" fields={FIELDS} />);

    fireEvent.click(await screen.findByText("First note"));
    fireEvent.change(await screen.findByLabelText(/^title/i), { target: { value: "Updated title" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledWith("r1", expect.objectContaining({ title: "Updated title" })));
  });

  it("deletes a row after confirm and refreshes the list", async () => {
    listMock.mockResolvedValueOnce({ data: [row()], meta: { total: 1, limit: 25, offset: 0 } });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    deleteMock.mockResolvedValueOnce(undefined);
    listMock.mockResolvedValueOnce({ data: [], meta: { total: 0, limit: 25, offset: 0 } });

    render(<DataBrowser entityName="notes" fields={FIELDS} />);
    await screen.findByText("First note");

    fireEvent.click(screen.getByRole("button", { name: /delete/i }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("r1"));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it("does not delete when the confirm dialog is dismissed", async () => {
    listMock.mockResolvedValueOnce({ data: [row()], meta: { total: 1, limit: 25, offset: 0 } });
    vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<DataBrowser entityName="notes" fields={FIELDS} />);
    await screen.findByText("First note");

    fireEvent.click(screen.getByRole("button", { name: /delete/i }));

    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("toggling sort resets pagination back to page 1", async () => {
    // Re-sorting from page 2 must refetch from offset 0, not land on the old
    // page of the new ordering.
    listMock.mockResolvedValue({ data: [row()], meta: { total: 60, limit: 25, offset: 0 } });
    render(<DataBrowser entityName="notes" fields={FIELDS} />);
    await screen.findByRole("table");

    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 25 })));

    fireEvent.click(screen.getByRole("columnheader", { name: /^title/ }));
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ sort: ["title"], offset: 0 })),
    );
  });

  it("surfaces a 403 FrogClientError from a rejected delete", async () => {
    listMock.mockResolvedValueOnce({ data: [row()], meta: { total: 1, limit: 25, offset: 0 } });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    deleteMock.mockRejectedValueOnce(new FrogClientError(403, "forbidden", 'Not allowed to delete "notes"'));

    render(<DataBrowser entityName="notes" fields={FIELDS} />);
    await screen.findByText("First note");

    fireEvent.click(screen.getByRole("button", { name: /delete/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent('Not allowed to delete "notes"');
  });
});
