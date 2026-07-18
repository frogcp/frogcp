import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A plain native `<select>`, styled to match `Input`. The admin's option lists
 * (schema-driven filter values, field types, rule kinds) are simple enough
 * that a native control beats pulling in Radix's `Select` primitive for a
 * handful of dropdowns. Kept here rather than inlined per call site so every
 * `<select>` shares one themed look.
 */
function Select({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        className,
      )}
      {...props}
    />
  );
}

export { Select };
