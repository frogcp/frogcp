import { FrogClientError } from "frogcp/client";
import { type ChangeEvent, useCallback, useEffect, useState } from "react";
import { Button, buttonVariants, Card, CardContent, Label } from "@/components/ui";
import { client } from "../api";

/** `frogcp/media`'s `media_files` entity fields plus the implicit `id`. The
 * entity's `owner` field is omitted because delete is already owner-scoped
 * server-side and nothing in this screen displays it. */
interface MediaRow {
  id: string;
  key: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

/**
 * Lists `media_files` with a thumbnail for `image/*` rows and a file icon for
 * everything else, plus upload and confirmed per-item delete.
 *
 * Delete is owner-scoped server-side: an admin bypasses that check, while any
 * other non-owner sees a 404 rather than a 403, because the permission engine
 * deliberately offers no existence oracle.
 */
export function MediaLibraryScreen() {
  const [rows, setRows] = useState<MediaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.entity("media_files").list({ limit: 100 });
      setRows(result.data as MediaRow[]);
    } catch (err) {
      setError(err instanceof FrogClientError ? err.message : "Failed to load media.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset the input immediately so selecting the SAME file again still
    // fires a change event next time.
    event.target.value = "";
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      await client.media.upload(file);
      await load();
    } catch (err) {
      setError(err instanceof FrogClientError ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(row: MediaRow) {
    if (!window.confirm(`Delete "${row.filename}"? This cannot be undone.`)) return;
    try {
      await client.entity("media_files").delete(row.id);
      await load();
    } catch (err) {
      setError(err instanceof FrogClientError ? err.message : "Failed to delete file.");
    }
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-foreground">Media library</h1>
        <div>
          <Label
            htmlFor="media-upload-input"
            className={buttonVariants({ variant: "default", className: uploading ? "cursor-default opacity-50" : "cursor-pointer" })}
          >
            {uploading ? "Uploading…" : "Upload file"}
          </Label>
          <input id="media-upload-input" type="file" className="sr-only" onChange={handleUpload} disabled={uploading} />
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="flex h-40 items-center justify-center rounded-2xl border border-dashed border-border text-sm text-muted-foreground">
          No media files.
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {rows.map((row) => (
            <li key={row.id}>
              <Card className="gap-0 overflow-hidden p-0">
                <div className="flex aspect-square items-center justify-center bg-muted">
                  {row.contentType?.startsWith("image/") ? (
                    <img src={client.media.url(row.key)} alt={row.filename} className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-4xl" aria-hidden="true">
                      📄
                    </span>
                  )}
                </div>
                <CardContent className="flex flex-col gap-2 p-3">
                  <span className="truncate text-sm text-foreground" title={row.filename}>
                    {row.filename}
                  </span>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs text-muted-foreground tabular-nums">{formatSize(row.size)}</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => handleDelete(row)}
                    >
                      Delete
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Human-readable byte size for a media row's `size` field. */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
