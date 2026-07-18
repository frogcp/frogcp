// @vitest-environment jsdom
import { FrogClientError } from "frogcp/client";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { EntitySchemaSummary } from "frogcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SchemaViewerScreen } from "../../spa/screens/SchemaViewerScreen";

const ENTITIES: Record<string, EntitySchemaSummary> = {
  notes: {
    fields: {
      title: { type: "text", required: true, unique: true },
      status: { type: "select", required: false, options: ["todo", "done"] },
      author: { type: "ref", required: false, target: "users" },
      secret: { type: "text", required: false, hidden: true },
    },
    permissions: {},
    permissionRules: {},
  },
};

const updateMock = vi.fn();

vi.mock("../../spa/api", () => ({
  client: {
    schema: {
      update: (...args: unknown[]) => updateMock(...args),
    },
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  updateMock.mockReset();
});

function noop() {
  // no-op onSchemaUpdated for tests that don't care
}

describe("SchemaViewerScreen", () => {
  it("renders each field's type and flags", () => {
    render(<SchemaViewerScreen entities={ENTITIES} mode="code" onSchemaUpdated={noop} />);
    expect(screen.getByRole("heading", { name: "notes" })).toBeInTheDocument();

    const titleRow = screen.getByText("title").closest("tr") as HTMLElement;
    expect(within(titleRow).getByText("text")).toBeInTheDocument();
    expect(within(titleRow).getByText("required")).toBeInTheDocument();
    expect(within(titleRow).getByText("unique")).toBeInTheDocument();
  });

  it("shows a hidden field with a hidden badge (hidden fields are included)", () => {
    render(<SchemaViewerScreen entities={ENTITIES} mode="code" onSchemaUpdated={noop} />);
    const secretRow = screen.getByText("secret").closest("tr") as HTMLElement;
    expect(within(secretRow).getByText("hidden")).toBeInTheDocument();
  });

  it("shows a ref field's target and a select field's options", () => {
    render(<SchemaViewerScreen entities={ENTITIES} mode="code" onSchemaUpdated={noop} />);

    const authorRow = screen.getByText("author").closest("tr") as HTMLElement;
    expect(within(authorRow).getByText(/target:\s*users/i)).toBeInTheDocument();

    const statusRow = screen.getByText("status").closest("tr") as HTMLElement;
    expect(within(statusRow).getByText(/options:\s*todo,\s*done/i)).toBeInTheDocument();
  });

  it("code mode: stays read-only, with an accurate 'managed mode' note and no editing controls", () => {
    render(<SchemaViewerScreen entities={ENTITIES} mode="code" onSchemaUpdated={noop} />);
    expect(screen.getByText(/editing requires managed mode/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save schema/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/new entity name/i)).not.toBeInTheDocument();
  });

  it("managed mode: renders an 'add entity' form and per-entity 'add field'/'remove field' controls", () => {
    render(<SchemaViewerScreen entities={ENTITIES} mode="managed" onSchemaUpdated={noop} />);
    expect(screen.queryByText(/editing requires managed mode/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/new entity name/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save schema/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/remove field title/i)).toBeInTheDocument();
  });

  it("managed mode: adding an entity then saving calls client.schema.update with a config including the new entity", async () => {
    updateMock.mockResolvedValueOnce({
      data: { entities: { ...ENTITIES, tags: { fields: {}, permissions: {} } } },
      mode: "managed",
    });
    const onSchemaUpdated = vi.fn();

    render(<SchemaViewerScreen entities={ENTITIES} mode="managed" onSchemaUpdated={onSchemaUpdated} />);

    fireEvent.change(screen.getByLabelText(/new entity name/i), { target: { value: "tags" } });
    fireEvent.click(screen.getByRole("button", { name: /^add entity$/i }));

    expect(await screen.findByRole("heading", { name: "tags" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /save schema/i }));

    await screen.findByRole("heading", { name: "tags" });
    expect(updateMock).toHaveBeenCalledTimes(1);
    const [config] = updateMock.mock.calls[0] as [{ entities: Record<string, unknown> }];
    expect(Object.keys(config.entities).sort()).toEqual(["notes", "tags"]);
    expect(onSchemaUpdated).toHaveBeenCalled();
  });

  it("managed mode: adding a field on an entity, then saving, includes it in the update config", async () => {
    updateMock.mockResolvedValueOnce({ data: { entities: ENTITIES }, mode: "managed" });

    render(<SchemaViewerScreen entities={ENTITIES} mode="managed" onSchemaUpdated={noop} />);

    fireEvent.change(screen.getByLabelText(/new field name for notes/i), { target: { value: "priority" } });
    fireEvent.change(screen.getByLabelText(/new field type for notes/i), { target: { value: "number" } });
    fireEvent.click(screen.getByRole("button", { name: /^add field$/i }));

    expect(screen.getByText("priority")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /save schema/i }));

    await screen.findByText("priority");
    expect(updateMock).toHaveBeenCalledTimes(1);
    const [config] = updateMock.mock.calls[0] as [{ entities: Record<string, { fields: Record<string, unknown> }> }];
    expect(config.entities.notes?.fields.priority).toEqual({ type: "number", required: false });
  });

  it("managed mode: removing a field then saving omits it from the update config", async () => {
    updateMock.mockResolvedValueOnce({ data: { entities: ENTITIES }, mode: "managed" });

    render(<SchemaViewerScreen entities={ENTITIES} mode="managed" onSchemaUpdated={noop} />);

    fireEvent.click(screen.getByLabelText(/remove field secret/i));
    fireEvent.click(screen.getByRole("button", { name: /save schema/i }));

    await screen.findByRole("heading", { name: "notes" });
    const [config] = updateMock.mock.calls[0] as [{ entities: Record<string, { fields: Record<string, unknown> }> }];
    expect(config.entities.notes?.fields.secret).toBeUndefined();
  });

  it("managed mode: editing a field on entity B PRESERVES an unrepresentable AND rule on entity A verbatim (source of truth is permissionRules, not the summary string)", async () => {
    // `posts` carries an AND permission the OR-only rule builder can't
    // represent. SchemaViewer must copy `permissionRules` straight through
    // rather than reparse it, and an opaque rule must not block the save.
    const andExpr = { kind: "and" as const, rules: [{ kind: "role" as const, role: "admin" }, { kind: "authenticated" as const }] };
    const withAnd: Record<string, EntitySchemaSummary> = {
      ...ENTITIES,
      posts: {
        fields: { body: { type: "text", required: true } },
        permissions: { read: "role(admin) AND authenticated" },
        permissionRules: { read: andExpr },
      },
    };
    updateMock.mockResolvedValueOnce({ data: { entities: withAnd }, mode: "managed" });

    render(<SchemaViewerScreen entities={withAnd} mode="managed" onSchemaUpdated={noop} />);

    // Two entities means two "Add field" buttons, so scope to the notes card.
    const notesNameInput = screen.getByLabelText(/new field name for notes/i);
    fireEvent.change(notesNameInput, { target: { value: "priority" } });
    const notesInlineForm = notesNameInput.closest('[data-slot="card"]') as HTMLElement;
    fireEvent.click(within(notesInlineForm).getByRole("button", { name: /^add field$/i }));

    fireEvent.click(screen.getByRole("button", { name: /save schema/i }));

    await screen.findByText("priority");
    const [config] = updateMock.mock.calls[0] as [
      { entities: Record<string, { fields: Record<string, unknown>; permissions: Record<string, unknown> }> },
    ];
    expect(config.entities.posts?.permissions.read).toEqual(andExpr);
    expect(config.entities.notes?.fields.priority).toEqual({ type: "text", required: false });
  });

  it("a 422 from client.schema.update surfaces as a form-level error", async () => {
    updateMock.mockRejectedValueOnce(new FrogClientError(422, "validation", "Invalid ref target \"bogus\""));

    render(<SchemaViewerScreen entities={ENTITIES} mode="managed" onSchemaUpdated={noop} />);

    fireEvent.click(screen.getByRole("button", { name: /save schema/i }));

    expect(await screen.findByText(/invalid ref target "bogus"/i)).toBeInTheDocument();
  });

  describe("plugin-owned entities (e.g. frogcp/auth's 'users')", () => {
    const WITH_PLUGIN: Record<string, EntitySchemaSummary> = {
      ...ENTITIES,
      users: {
        fields: { email: { type: "text", required: true } },
        permissions: {},
        permissionRules: {},
        pluginOwned: true,
      },
    };

    it("renders a 'plugin' badge and no add/remove-field controls, in managed mode", () => {
      render(<SchemaViewerScreen entities={WITH_PLUGIN} mode="managed" onSchemaUpdated={noop} />);
      const usersHeading = screen.getByRole("heading", { name: /users/i });
      expect(within(usersHeading).getByText("plugin")).toBeInTheDocument();
      expect(screen.queryByLabelText(/new field name for users/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/remove field email/i)).not.toBeInTheDocument();
      expect(screen.getByLabelText(/new field name for notes/i)).toBeInTheDocument();
    });

    it("save omits the plugin-owned entity from the posted config entirely", async () => {
      updateMock.mockResolvedValueOnce({ data: { entities: WITH_PLUGIN }, mode: "managed" });
      render(<SchemaViewerScreen entities={WITH_PLUGIN} mode="managed" onSchemaUpdated={noop} />);

      fireEvent.click(screen.getByRole("button", { name: /save schema/i }));

      await screen.findByRole("button", { name: /save schema/i });
      expect(updateMock).toHaveBeenCalledTimes(1);
      const [config] = updateMock.mock.calls[0] as [{ entities: Record<string, unknown> }];
      expect(Object.keys(config.entities).sort()).toEqual(["notes"]);
      expect(config.entities.users).toBeUndefined();
    });
  });
});
