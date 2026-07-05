"use client";

import { forwardRef } from "react";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../utils.js";

/**
 * Table — shadcn-style table family for the settings stats surface, so the
 * table container carries `data-slot="table"` instead of a hand-rolled
 * `.settingsStatsTable` class. The table itself owns the surface chrome
 * (border + radius + caption font-size); the row/cell members own the
 * tabular-nums + hairline row separators + caption-tone color that the old
 * `.settingsStatsTable th, .settingsStatsTable td` rules supplied.
 *
 * `scope` is left to the caller: the usage-stats table has both column
 * headers (`scope="col"` in `<thead>`) and a row header (`scope="row"` on
 * the first `<th>` of each body row), so baking in a default would lie.
 */
export type TableProps = ComponentPropsWithoutRef<"table">;

export const Table = forwardRef<HTMLTableElement, TableProps>(function Table(
  { className, ...props },
  ref,
) {
  return (
    <table
      ref={ref}
      data-slot="table"
      className={cn(
        "w-full border-collapse overflow-hidden rounded-[var(--radius-surface)] border border-border text-[length:var(--font-size-caption)]",
        className,
      )}
      {...props}
    />
  );
});

export const TableHeader = forwardRef<
  HTMLTableSectionElement,
  ComponentPropsWithoutRef<"thead">
>(function TableHeader({ className, ...props }, ref) {
  return <thead ref={ref} data-slot="table-header" className={cn(className)} {...props} />;
});

export const TableBody = forwardRef<
  HTMLTableSectionElement,
  ComponentPropsWithoutRef<"tbody">
>(function TableBody({ className, ...props }, ref) {
  return <tbody ref={ref} data-slot="table-body" className={cn(className)} {...props} />;
});

export const TableRow = forwardRef<
  HTMLTableRowElement,
  ComponentPropsWithoutRef<"tr">
>(function TableRow({ className, ...props }, ref) {
  return (
    <tr
      ref={ref}
      data-slot="table-row"
      className={cn("border-b border-border", className)}
      {...props}
    />
  );
});

export const TableHead = forwardRef<
  HTMLTableCellElement,
  ComponentPropsWithoutRef<"th">
>(function TableHead({ className, ...props }, ref) {
  return (
    <th
      ref={ref}
      data-slot="table-head"
      className={cn(
        "border-b border-border px-[var(--space-2)] py-[var(--space-1)] text-left align-middle font-semibold text-foreground-secondary [font-variant-numeric:tabular-nums]",
        className,
      )}
      {...props}
    />
  );
});

export const TableCell = forwardRef<
  HTMLTableCellElement,
  ComponentPropsWithoutRef<"td">
>(function TableCell({ className, ...props }, ref) {
  return (
    <td
      ref={ref}
      data-slot="table-cell"
      className={cn(
        "border-b border-border px-[var(--space-2)] py-[var(--space-1)] text-left align-middle text-foreground-secondary [font-variant-numeric:tabular-nums]",
        className,
      )}
      {...props}
    />
  );
});
