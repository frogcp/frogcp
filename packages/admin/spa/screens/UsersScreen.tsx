import { FrogClientError } from "frogcp/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CopyField } from "@/components/ui/CopyField";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { client } from "../api";

/** The public-safe shape `frogcp/auth`'s routes return for a `users` row.
 * `passwordHash` is declared `.hidden()` on the entity and never reaches the
 * wire, so nothing here has to strip it. */
interface UserRow {
  id: string;
  email: string;
  name?: string | null;
  role: string;
  createdAt: string;
}

/**
 * Lists every user and lets an admin change a user's `role` per row. `role` is
 * declared `.readonly()`, but the engine's readonly-strip guard applies only
 * to non-admin callers, so an admin session's update genuinely writes it.
 *
 * A rejected update is shown inline next to its row rather than as a
 * page-level banner, so one bad edit never blocks editing anyone else.
 */
export function UsersScreen() {
  const [rows, setRows] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.entity("users").list({ limit: 100 });
      setRows(result.data as UserRow[]);
    } catch (err) {
      setError(err instanceof FrogClientError ? err.message : "Failed to load users.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Every role seen across the loaded rows, plus the two the engine always
  // recognizes, so the dropdown offers a sane target even on a brand-new
  // install with a single user.
  const knownRoles = useMemo(() => {
    const roles = new Set<string>(["admin", "member"]);
    for (const row of rows) roles.add(row.role);
    return Array.from(roles).sort();
  }, [rows]);

  async function handleRoleChange(row: UserRow, role: string) {
    setRowErrors((prev) => {
      if (!(row.id in prev)) return prev;
      const next = { ...prev };
      delete next[row.id];
      return next;
    });
    try {
      const updated = await client.entity("users").update(row.id, { role });
      setRows((prev) => prev.map((r) => (r.id === row.id ? (updated as UserRow) : r)));
    } catch (err) {
      const message = err instanceof FrogClientError ? err.message : "Failed to update role.";
      setRowErrors((prev) => ({ ...prev, [row.id]: message }));
    }
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-foreground">Users</h1>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>id</TableHead>
              <TableHead>email</TableHead>
              <TableHead>name</TableHead>
              <TableHead>role</TableHead>
              <TableHead>createdAt</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  No users.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <CopyField value={row.id} />
                  </TableCell>
                  <TableCell className="text-foreground">{row.email}</TableCell>
                  <TableCell className="text-muted-foreground">{row.name ?? ""}</TableCell>
                  <TableCell>
                    <Select
                      aria-label={`Role for ${row.email}`}
                      className="min-w-[8rem]"
                      value={row.role}
                      onChange={(event) => handleRoleChange(row, event.target.value)}
                    >
                      {knownRoles.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </Select>
                    {rowErrors[row.id] && (
                      <p role="alert" className="mt-1 text-xs text-destructive">
                        {rowErrors[row.id]}
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground whitespace-nowrap">
                    {new Date(row.createdAt).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
