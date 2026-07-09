"use client";

import { forwardRef } from "react";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../utils.js";

/**
 * Card — shared surface container for settings card surfaces (row-list
 * containers, metric tiles, the renderer crash surface). Intentionally thin
 * (maka's ChoiceCard philosophy): it contributes `data-slot="card"` plus the
 * surface radius, and each call site keeps its own layout/visual CSS (grid,
 * padding, border, background) via `className`.
 *
 * Why thin and not shadcn-heavy: settingsRows (row-list), settingsMetricCard
 * (metric tile), and maka-error-card (crash surface) share only the surface
 * radius; their border / background / padding all differ, so a heavy default
 * (`border bg-card shadow`) would have to be overridden at every site. Thin
 * keeps each site byte-identical while unifying on the `data-slot` hook that
 * the style-hook convention (#520 PR5 item 23) and converge contracts key on.
 */
export type CardProps = ComponentPropsWithoutRef<"div">;

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-slot="card"
      className={cn("rounded-[var(--radius-surface)]", className)}
      {...props}
    />
  );
});
