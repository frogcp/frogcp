"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface CopyFieldProps {
  /** The mono-styled value shown and copied, e.g. a row id. */
  value: string;
  className?: string;
}

/**
 * Just the copy affordance, with no masking or link-out: this renders the `id`
 * column in `DataBrowser`'s table, and row ids aren't secrets and never link
 * anywhere.
 */
export function CopyField({ value, className }: CopyFieldProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard access can be denied (permissions, non-secure context).
      // There's no fallback UI; the button just won't have copied anything.
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <div className={cn("flex items-center gap-1 rounded-sm border border-input bg-muted/40 py-0.5 pr-0.5 pl-2 dark:bg-input/30", className)}>
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--accent-ink)]">{value}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        title="Copy id"
        onClick={handleCopy}
        className={cn("text-muted-foreground hover:text-primary", copied && "text-primary")}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}
