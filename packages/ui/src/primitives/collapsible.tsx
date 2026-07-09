"use client";

import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";
import { cn } from "../utils.js";
import type React from "react";

// Base UI Collapsible wrappers for the four disclosure sites that used native
// `<details>`/`<summary>` (turn-thinking, reasoning-panel, permission-raw,
// tool-activity — all independent single sections, so Collapsible not
// Accordion). The `data-slot` hooks follow the style-hook convention (item 23)
// so CSS can target `[data-slot="collapsible"]` / `[data-slot="collapsible-trigger"]`
// / `[data-slot="collapsible-panel"]` and read the Base UI native `[data-open]`
// state attribute on the root.
//
// Migration note: native `<details>` rendered the summary + body inline; Base UI
// Collapsible.Trigger is a real `<button>`, so the summary row must be
// click-targetable (it already was — the `<summary>` was the toggle). The
// reasoning panel's "default open, first click sticks" behavior moves from
// reading `e.currentTarget.open` off the toggle event to Collapsible's
// controlled `open` + `onOpenChange` props.

export function Collapsible({
  className,
  ...props
}: CollapsiblePrimitive.Root.Props): React.ReactElement {
  return (
    <CollapsiblePrimitive.Root
      className={cn("flex flex-col", className)}
      data-slot="collapsible"
      {...props}
    />
  );
}

export function CollapsibleTrigger({
  className,
  ...props
}: CollapsiblePrimitive.Trigger.Props): React.ReactElement {
  return (
    <CollapsiblePrimitive.Trigger
      className={cn(
        // Button chrome reset: native <summary> had no background/border/
        // padding/font-family, but <button> does, so reset to a clean slate
        // and let the call site's className own layout + color. cursor stays
        // default (macOS reserves the hand for links; see
        // cursor-convention-contract.test.ts).
        "flex w-full select-none items-center outline-none appearance-none bg-transparent border-0 p-0 [font:inherit] [text-align:inherit]",
        className,
      )}
      data-slot="collapsible-trigger"
      {...props}
    />
  );
}

export function CollapsiblePanel({
  className,
  ...props
}: CollapsiblePrimitive.Panel.Props): React.ReactElement {
  return (
    <CollapsiblePrimitive.Panel
      className={cn("overflow-hidden", className)}
      data-slot="collapsible-panel"
      {...props}
    />
  );
}

export { CollapsiblePrimitive };