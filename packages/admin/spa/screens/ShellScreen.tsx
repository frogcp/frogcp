import { buildClientError, FrogClientError, type AuthUser } from "frogcp/client";
import type { EntitySchemaSummary } from "frogcp";
import { LayoutDashboard, LogOut, Moon, RefreshCw, ShieldAlert, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { FrogMark } from "@/components/ui/icons";
import { Separator } from "@/components/ui/separator";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { client } from "../api";
import { DashboardScreen } from "./DashboardScreen";
import { DataBrowser } from "./DataBrowser";
import { MediaLibraryScreen } from "./MediaLibraryScreen";
import { PermissionMatrixScreen } from "./PermissionMatrixScreen";
import { SchemaViewerScreen } from "./SchemaViewerScreen";
import { UsersScreen } from "./UsersScreen";

export interface ShellScreenProps {
  user: AuthUser;
  onLogout: () => void;
}

/** The part of `GET /api/system/schema`'s envelope this screen reads: the full
 * per-entity summary, not just entity names, since `DataBrowser` and the
 * system screens all need every field's metadata. `mode` tells the schema and
 * permission screens whether editing is possible at all.
 *
 * Fetched with raw `fetch` rather than `frogcp/client`'s `schema.get()`: this
 * call runs before tests stub the `client` module, so staying on `fetch`
 * avoids a second mocking surface for the same request. */
interface SchemaResponse {
  data: { entities: Record<string, EntitySchemaSummary> };
  mode?: "code" | "managed";
}

/** The currently-selected main-pane view: the dashboard home (the default), a
 * system screen, or a data browser for one entity. There is deliberately no
 * empty-state variant, because the dashboard fills that role. */
type Selection = { kind: "dashboard" } | { kind: "entity"; name: string } | { kind: "system"; view: SystemView };
type SystemView = "users" | "media" | "schema" | "permissions";

/** These entities exist only when `frogcp/auth` and `frogcp/media` are
 * installed, so their sidebar items are gated on the entity actually appearing
 * in the fetched schema. */
const USERS_ENTITY = "users";
const MEDIA_ENTITY = "media_files";

/** How the boot-time schema fetch failed: a 403 (the session is valid but not
 * an admin, or has decayed into a state the backend answers with 403 rather
 * than 401), or anything else, treated as retryable. `null` means no error.
 *
 * These are kept distinct from an empty schema because collapsing them into
 * the "no entities" state would tell an admin this backend genuinely has zero
 * entities, on the one surface meant to explain what went wrong. */
type SchemaLoadError = { kind: "forbidden" } | { kind: "failed"; message: string } | null;

/** One sidebar nav button, shared by every nav section so the active and hover
 * states stay visually identical. */
function NavButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full rounded-md px-3 py-1.5 text-left text-sm transition-colors",
        active
          ? "bg-[var(--bg-tint)] font-semibold text-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function NavSectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-3 pt-4 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{children}</div>;
}

/**
 * The authenticated shell: a sidebar over the dashboard, the entity list, and
 * the system screens, plus a main pane rendering whichever is selected.
 *
 * Entities and their field metadata come from a single `/api/system/schema`
 * fetch after login, so the UI is never hardcoded to a specific entity set. A
 * failed fetch replaces the whole shell with an error screen rather than
 * rendering as though the schema were merely empty.
 */
export function ShellScreen({ user, onLogout }: ShellScreenProps) {
  const [entities, setEntities] = useState<Record<string, EntitySchemaSummary>>({});
  const [mode, setMode] = useState<"code" | "managed">("code");
  const [schemaError, setSchemaError] = useState<SchemaLoadError>(null);
  const [selection, setSelection] = useState<Selection>({ kind: "dashboard" });
  const [retryToken, setRetryToken] = useState(0);
  const [theme, toggleTheme] = useTheme();

  useEffect(() => {
    let cancelled = false;
    setSchemaError(null);
    fetch("/api/system/schema", { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) throw await buildClientError(res);
        return res.json() as Promise<SchemaResponse>;
      })
      .then((body) => {
        if (cancelled) return;
        setEntities(body.data.entities);
        setMode(body.mode ?? "code");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setEntities({});
        if (err instanceof FrogClientError && err.status === 403) {
          setSchemaError({ kind: "forbidden" });
        } else {
          const message = err instanceof Error ? err.message : "Failed to load schema.";
          setSchemaError({ kind: "failed", message });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [retryToken]);

  async function handleLogout() {
    await client.auth.logout();
    onLogout();
  }

  function handleRetry() {
    setRetryToken((t) => t + 1);
  }

  const entityNames = Object.keys(entities);
  const hasUsers = USERS_ENTITY in entities;
  const hasMedia = MEDIA_ENTITY in entities;

  function isEntitySelected(name: string): boolean {
    return selection.kind === "entity" && selection.name === name;
  }
  function isSystemSelected(view: SystemView): boolean {
    return selection.kind === "system" && selection.view === view;
  }

  function systemNavItem(view: SystemView, label: string) {
    return (
      <li key={view}>
        <NavButton active={isSystemSelected(view)} onClick={() => setSelection({ kind: "system", view })}>
          {label}
        </NavButton>
      </li>
    );
  }

  if (schemaError?.kind === "forbidden") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground" role="alert">
        <ShieldAlert className="size-8 text-destructive" />
        <p>Admin role required. Sign in with an admin account.</p>
        <Button type="button" variant="outline" onClick={handleLogout}>
          Log out
        </Button>
      </div>
    );
  }

  if (schemaError?.kind === "failed") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground" role="alert">
        <ShieldAlert className="size-8 text-destructive" />
        <p>Failed to load schema.</p>
        <Button type="button" variant="outline" onClick={handleRetry}>
          <RefreshCw /> Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full bg-background text-foreground">
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-card" aria-label="Admin navigation">
        <div className="flex items-center gap-2 px-4 py-4">
          <FrogMark size={26} />
          <span className="font-sans text-base font-bold tracking-tight text-foreground">frogCP</span>
        </div>
        <Separator />
        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          <NavSectionLabel>Overview</NavSectionLabel>
          <ul className="flex flex-col gap-0.5">
            <li>
              <NavButton active={selection.kind === "dashboard"} onClick={() => setSelection({ kind: "dashboard" })}>
                <span className="flex items-center gap-2">
                  <LayoutDashboard className="size-4" /> Dashboard
                </span>
              </NavButton>
            </li>
          </ul>

          <NavSectionLabel>Entities</NavSectionLabel>
          <ul className="flex flex-col gap-0.5">
            {entityNames.map((name) => (
              <li key={name}>
                <NavButton active={isEntitySelected(name)} onClick={() => setSelection({ kind: "entity", name })}>
                  {name}
                </NavButton>
              </li>
            ))}
          </ul>

          <NavSectionLabel>System</NavSectionLabel>
          <ul className="flex flex-col gap-0.5">
            {hasUsers && systemNavItem("users", "Users")}
            {hasMedia && systemNavItem("media", "Media")}
            {systemNavItem("schema", "Schema")}
            {systemNavItem("permissions", "Permissions")}
          </ul>
        </nav>
        <Separator />
        <div className="flex flex-col gap-2 px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={user.email}>
              {user.email}
            </span>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              title="Toggle theme"
              onClick={toggleTheme}
              className="text-muted-foreground"
            >
              {theme === "dark" ? <Sun /> : <Moon />}
            </Button>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={handleLogout} className="justify-start gap-2">
            <LogOut className="size-3.5" /> Log out
          </Button>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto p-8">{renderMain(selection, entities, mode, setEntities)}</main>
    </div>
  );
}

function renderMain(
  selection: Selection,
  entities: Record<string, EntitySchemaSummary>,
  mode: "code" | "managed",
  onSchemaUpdated: (entities: Record<string, EntitySchemaSummary>) => void,
) {
  if (selection.kind === "dashboard") {
    return <DashboardScreen entities={entities} />;
  }
  if (selection.kind === "entity") {
    const schema = entities[selection.name];
    if (!schema) return <DashboardScreen entities={entities} />;
    return <DataBrowser key={selection.name} entityName={selection.name} fields={schema.fields} />;
  }
  switch (selection.view) {
    case "users":
      return <UsersScreen />;
    case "media":
      return <MediaLibraryScreen />;
    case "schema":
      return <SchemaViewerScreen entities={entities} mode={mode} onSchemaUpdated={onSchemaUpdated} />;
    case "permissions":
      return <PermissionMatrixScreen entities={entities} mode={mode} onSchemaUpdated={onSchemaUpdated} />;
  }
}
