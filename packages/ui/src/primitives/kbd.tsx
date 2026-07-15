import { cn } from "../utils.js";
import type * as React from "react";

export function Kbd({
  className,
  ...props
}: React.ComponentProps<"kbd">): React.ReactElement {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-4 min-w-4 select-none items-center justify-center gap-1 rounded-[var(--radius-control)] bg-foreground/4 px-1 font-semibold font-sans text-foreground-secondary text-[var(--font-size-caption)] leading-none [&_svg:not([class*='size-'])]:size-3",
        className,
      )}
      data-slot="kbd"
      {...props}
    />
  );
}

export function KbdGroup({
  className,
  ...props
}: React.ComponentProps<"span">): React.ReactElement {
  return (
    <span
      className={cn("inline-flex items-center gap-1", className)}
      data-slot="kbd-group"
      {...props}
    />
  );
}
