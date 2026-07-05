"use client";

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { cn } from "../utils.js";
import type React from "react";

// Base UI Tooltip wrappers for the icon-only-action buttons that used the
// native `title=` attribute (an unstyled, delayed browser tooltip). Base UI
// Tooltip gives a themed, positioned, hover+focus tooltip matching the app.
// The `data-slot` hooks follow the style-hook convention (item 23).
//
// Usage:
//   <Tooltip>
//     <TooltipTrigger render={<Button />}>…</TooltipTrigger>
//     <TooltipContent>{label}</TooltipContent>
//   </Tooltip>
//
// Base UI v1 uses the `render` prop (not Radix `asChild`): the Trigger merges
// its own props + children into the rendered element.
//
// TooltipContent collapses Portal + Positioner + Popup (the same shape
// DialogContent uses for the dialog) so the call site is one component. The
// Popup carries the themed tooltip look (popover bg/corner/shadow); the
// Positioner owns placement + the z-layer.

export function Tooltip({
  ...props
}: TooltipPrimitive.Root.Props): React.ReactElement {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

export function TooltipTrigger({
  className,
  ...props
}: TooltipPrimitive.Trigger.Props): React.ReactElement {
  return (
    <TooltipPrimitive.Trigger
      className={className}
      data-slot="tooltip-trigger"
      {...props}
    />
  );
}

export function TooltipContent({
  className,
  ...props
}: Omit<TooltipPrimitive.Popup.Props, "render"> & React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner sideOffset={6}>
        <TooltipPrimitive.Popup
          className={cn(
            "z-[var(--z-overlay)] max-w-[min(90vw,320px)] rounded-md bg-popover px-2 py-1 text-xs text-popover-foreground shadow-maka-panel",
            className,
          )}
          data-slot="tooltip-content"
          {...props}
        />
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { TooltipPrimitive };