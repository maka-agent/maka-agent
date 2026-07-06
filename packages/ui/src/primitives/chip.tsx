"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cn } from "../utils.js";
import { cva, type VariantProps } from "class-variance-authority";
import type React from "react";

// Chip is the squared, compact status label for dense information rows
// (settings connection status, capability chips, default markers). It is the
// squared counterpart to the pill Badge primitive:
//   - Badge = emphasis marker (pill, radius-pill) — health/permission center
//   - Chip  = status label (squared, radius-control) — settings rows
// Variants mirror StatusTone so settings callers pass the tone straight
// through with no mapping function. Visual values reproduce the retired
// .settingsConnectionBadge oklch alphas (success /12, info /14, warning /18,
// destructive /15) and the .settingsBadge neutral (foreground-5) base.
export const chipVariants = cva(
  "inline-flex items-center whitespace-nowrap rounded-[var(--radius-control)] text-xs outline-none [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
      variant: "neutral",
    },
    variants: {
      size: {
        default:
          "min-h-5 px-[var(--space-2)] py-[var(--space-0-5)] font-semibold",
        sm: "min-h-4.5 px-[var(--space-1-5)] py-0 font-normal",
      },
      variant: {
        neutral: "bg-secondary text-[var(--foreground-secondary)]",
        info: "bg-info/14 text-info-foreground",
        success: "bg-success/12 text-success",
        warning: "bg-warning/18 text-warning-foreground font-bold",
        destructive: "bg-destructive/15 text-destructive font-bold",
      },
    },
  },
);

export interface ChipProps extends useRender.ComponentProps<"span"> {
  variant?: VariantProps<typeof chipVariants>["variant"];
  size?: VariantProps<typeof chipVariants>["size"];
}

export function Chip({
  className,
  variant,
  size,
  render,
  ...props
}: ChipProps): React.ReactElement {
  const defaultProps = {
    className: cn(chipVariants({ className, size, variant })),
    "data-slot": "chip",
  };

  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, props),
    render,
  });
}