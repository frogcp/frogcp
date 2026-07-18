// @vitest-environment jsdom
import { FrogClientError } from "frogcp/client";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { EntitySchemaSummary } from "frogcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionMatrixScreen } from "../../spa/screens/PermissionMatrixScreen";

// Exercises owner/role/or rule summaries plus an omitted action (`delete` has
// no declared rule, so it default-denies to "admin only"). `permissionRules`
// is the structured source of truth and mirrors `permissions` exactly.
const ENTITIES: Record<string, EntitySchemaSummary> = {
  notes: {
    fields: { title: { type: "text", required: true } },
    permissions: {
      read: "owner(ownerId) OR role(admin)",
      list: "role(admin)",
      create: "authenticated",
      update: "owner(ownerId)",
      // delete omitted on purpose
    },
    permissionRules: {
      read: { kind: "or", rules: [{ kind: "owner", field: "ownerId" }, { kind: "role", role: "admin" }] },
      list: { kind: "role", role: "admin" },
      create: { kind: "authenticated" },
      update: { kind: "owner", field: "ownerId" },
      // delete omitted on purpose
    },
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

/** ACTIONS order is ["read", "list", "create", "update", "delete"], offset by
 * one because cells[0] is the entity-name cell. */
function actionCell(entityName: string, actionIndex: number): HTMLElement {
  const row = screen.getByText(entityName).closest("tr") as HTMLElement;
  const cells = within(row).getAllByRole("cell");
  return cells[actionIndex + 1] as HTMLElement;
}

describe("PermissionMatrixScreen", () => {
  it("renders the rule summary strings from the schema and 'admin only' for an omitted action (code mode)", () => {
    render(<PermissionMatrixScreen entities={ENTITIES} mode="code" onSchemaUpdated={noop} />);

    const table = screen.getByRole("table");
    const row = within(table).getByText("notes").closest("tr");
    expect(row).not.toBeNull();
    const cells = within(row as HTMLElement).getAllByRole("cell");
    expect(cells[1]).toHaveTextContent("owner(ownerId) OR role(admin)");
    expect(cells[2]).toHaveTextContent("role(admin)");
    expect(cells[3]).toHaveTextContent("authenticated");
    expect(cells[4]).toHaveTextContent("owner(ownerId)");
    expect(cells[5]).toHaveTextContent("admin only");
  });

  it("notes that permission editing needs managed mode", () => {
    render(<PermissionMatrixScreen entities={ENTITIES} mode="code" onSchemaUpdated={noop} />);
    expect(screen.getByText(/managed mode/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save schema/i })).not.toBeInTheDocument();
  });

  it("managed mode: renders an editable rule builder per cell (a select + add control)", () => {
    render(<PermissionMatrixScreen entities={ENTITIES} mode="managed" onSchemaUpdated={noop} />);
    expect(screen.getByRole("button", { name: /save schema/i })).toBeInTheDocument();
    // `delete` is omitted from the fixture, so it starts as a fresh cell.
    const deleteCell = actionCell("notes", 4);
    expect(within(deleteCell).getByText(/admin only/i)).toBeInTheDocument();
    expect(within(deleteCell).getByLabelText(/new condition kind for notes delete/i)).toBeInTheDocument();
  });

  it("managed mode: an existing OR'd rule is editable, so removing one condition leaves the other and save reflects it", async () => {
    updateMock.mockResolvedValueOnce({ data: { entities: ENTITIES }, mode: "managed" });
    render(<PermissionMatrixScreen entities={ENTITIES} mode="managed" onSchemaUpdated={noop} />);

    const readCell = actionCell("notes", 0);
    expect(within(readCell).getByText("owner(ownerId)")).toBeInTheDocument();
    expect(within(readCell).getByText("role(admin)")).toBeInTheDocument();

    fireEvent.click(within(readCell).getByRole("button", { name: /remove condition role\(admin\)/i }));
    expect(within(readCell).queryByText("role(admin)")).not.toBeInTheDocument();
    expect(within(readCell).getByText("owner(ownerId)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /save schema/i }));

    await screen.findByRole("button", { name: /save schema/i });
    const [config] = updateMock.mock.calls[0] as [{ entities: Record<string, { permissions: Record<string, unknown> }> }];
    expect(config.entities.notes?.permissions.read).toEqual({ kind: "owner", field: "ownerId" });
  });

  it("managed mode: adding a condition (owner) to a previously admin-only cell builds the right RuleExpr and save calls update", async () => {
    updateMock.mockResolvedValueOnce({ data: { entities: ENTITIES }, mode: "managed" });
    render(<PermissionMatrixScreen entities={ENTITIES} mode="managed" onSchemaUpdated={noop} />);

    const deleteCell = actionCell("notes", 4);
    fireEvent.change(within(deleteCell).getByLabelText(/new condition kind for notes delete/i), { target: { value: "owner" } });
    fireEvent.change(within(deleteCell).getByLabelText(/new condition value for notes delete/i), { target: { value: "ownerId" } });
    fireEvent.click(within(deleteCell).getByRole("button", { name: /\+ or/i }));

    expect(within(deleteCell).getByText("owner(ownerId)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /save schema/i }));

    await screen.findByRole("button", { name: /save schema/i });
    expect(updateMock).toHaveBeenCalledTimes(1);
    const [config] = updateMock.mock.calls[0] as [{ entities: Record<string, { permissions: Record<string, unknown> } > }];
    expect(config.entities.notes?.permissions.delete).toEqual({ kind: "owner", field: "ownerId" });
    expect(config.entities.notes?.permissions.create).toEqual({ kind: "authenticated" });
  });

  it("managed mode: an AND rule the builder can't represent renders read-only 'opaque' and is re-sent VERBATIM on save (never dropped or regenerated)", async () => {
    const andExpr = { kind: "and" as const, rules: [{ kind: "role" as const, role: "admin" }, { kind: "authenticated" as const }] };
    const withAnd: Record<string, EntitySchemaSummary> = {
      notes: {
        fields: { title: { type: "text", required: true } },
        permissions: { read: "role(admin) AND authenticated", create: "public" },
        permissionRules: { read: andExpr, create: { kind: "public" } },
      },
    };
    updateMock.mockResolvedValueOnce({ data: { entities: withAnd }, mode: "managed" });
    render(<PermissionMatrixScreen entities={withAnd} mode="managed" onSchemaUpdated={noop} />);

    const readCell = actionCell("notes", 0);
    expect(within(readCell).getByText(/too complex to edit here/i)).toBeInTheDocument();
    expect(within(readCell).queryByLabelText(/new condition kind/i)).not.toBeInTheDocument();

    // Saving without touching anything must re-send the AND expr verbatim.
    fireEvent.click(screen.getByRole("button", { name: /save schema/i }));

    await screen.findByRole("button", { name: /save schema/i });
    const [config] = updateMock.mock.calls[0] as [{ entities: Record<string, { permissions: Record<string, unknown> }> }];
    expect(config.entities.notes?.permissions.read).toEqual(andExpr);
    expect(config.entities.notes?.permissions.create).toEqual({ kind: "public" });
  });

  it("a 422 from client.schema.update surfaces as a form-level error", async () => {
    updateMock.mockRejectedValueOnce(new FrogClientError(422, "validation", "role name is required"));
    render(<PermissionMatrixScreen entities={ENTITIES} mode="managed" onSchemaUpdated={noop} />);

    fireEvent.click(screen.getByRole("button", { name: /save schema/i }));

    expect(await screen.findByText(/role name is required/i)).toBeInTheDocument();
  });

  describe("plugin-owned entities (e.g. frogcp/auth's 'users')", () => {
    const WITH_PLUGIN: Record<string, EntitySchemaSummary> = {
      ...ENTITIES,
      users: {
        fields: { email: { type: "text", required: true } },
        permissions: { read: "authenticated" },
        permissionRules: { read: { kind: "authenticated" } },
        pluginOwned: true,
      },
    };

    it("renders read-only with a 'plugin' badge even in managed mode, with no rule-builder controls", () => {
      render(<PermissionMatrixScreen entities={WITH_PLUGIN} mode="managed" onSchemaUpdated={noop} />);

      const usersRow = screen.getByText("users").closest("tr") as HTMLElement;
      expect(within(usersRow).getByText("plugin")).toBeInTheDocument();
      expect(within(usersRow).getByText("authenticated")).toBeInTheDocument();
      expect(within(usersRow).queryByLabelText(/new condition kind for users/i)).not.toBeInTheDocument();

      const notesRow = screen.getByText("notes").closest("tr") as HTMLElement;
      expect(within(notesRow).getByLabelText(/new condition kind for notes read/i)).toBeInTheDocument();
    });

    it("save omits the plugin-owned entity from the posted config entirely", async () => {
      updateMock.mockResolvedValueOnce({ data: { entities: WITH_PLUGIN }, mode: "managed" });
      render(<PermissionMatrixScreen entities={WITH_PLUGIN} mode="managed" onSchemaUpdated={noop} />);

      fireEvent.click(screen.getByRole("button", { name: /save schema/i }));

      await screen.findByRole("button", { name: /save schema/i });
      const [config] = updateMock.mock.calls[0] as [{ entities: Record<string, unknown> }];
      expect(Object.keys(config.entities).sort()).toEqual(["notes"]);
      expect(config.entities.users).toBeUndefined();
    });
  });
});
