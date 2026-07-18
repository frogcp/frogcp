import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type StatusRole = "success" | "warning" | "neutral" | "danger";

/**
 * Takes a `role` directly rather than switching on a closed status union: this
 * admin renders values from an ARBITRARY, schema-driven `select` field or a
 * plain `boolean`, so there's no fixed vocabulary to key off. Boolean cells
 * and `roleForValue` below both derive a role.
 */
export interface StatusPillProps {
  role: StatusRole;
  label: string;
  className?: string;
}

export function StatusPill({ role, label, className }: StatusPillProps) {
  return (
    <Badge variant={role} className={cn("gap-1.5 rounded-full font-mono text-[11px] tracking-[0.04em]", className)}>
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          role === "success" && "bg-[var(--status-success-dot)]",
          role === "warning" && "animate-pulse bg-[var(--status-warning-dot)]",
          role === "danger" && "bg-[var(--status-danger-dot)]",
          role === "neutral" && "bg-[var(--status-neutral-dot)]",
        )}
      />
      {label}
    </Badge>
  );
}

/** Recognized values in priority order; the first matching list wins.
 * Deliberately generic, since `DataBrowser` is schema-driven and can't know
 * what a given `select` field will contain. Anything unrecognized falls back
 * to "neutral". */
const SUCCESS_WORDS = ["active", "live", "done", "published", "complete", "completed", "approved", "success", "ok", "true"];
const WARNING_WORDS = ["pending", "queued", "draft", "building", "provisioning", "uploading", "migrating", "in_progress", "review"];
const DANGER_WORDS = ["failed", "error", "rejected", "cancelled", "canceled", "blocked", "false"];

/** Classifies an arbitrary field value into a `StatusRole` by keyword match.
 * A display heuristic ONLY: it never changes what's stored or sent. */
export function roleForValue(value: string): StatusRole {
  const normalized = value.trim().toLowerCase();
  if (SUCCESS_WORDS.includes(normalized)) return "success";
  if (WARNING_WORDS.includes(normalized)) return "warning";
  if (DANGER_WORDS.includes(normalized)) return "danger";
  return "neutral";
}
