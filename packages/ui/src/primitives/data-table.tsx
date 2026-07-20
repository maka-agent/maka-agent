// packages/ui/src/primitives/data-table.tsx
//
// The ONE hairline data-table recipe. Extracted from usage-settings'
// inline `UsageStatsTable` (#1252) once it grew a second and third
// prospective consumer (health signals, permission capabilities) — a
// real HTML `<table>` with:
//   - a muted + weight-medium scoped header row (`<th scope="col">`);
//   - the first data cell of every row promoted to a scoped row header
//     (`<th scope="row">`, weight-medium ink) so screen readers announce
//     the row by its name column;
//   - hairline row separators (`border-b`) and a hairline-boxed surface;
//   - right-aligned tabular-nums numeric columns so figures never jitter;
//   - exactly one `grow` column that absorbs the row's slack while every
//     other column sizes to its content on one line (no floating gaps,
//     no per-character header wrapping).
//
// Empty handling is deliberately NOT here: a table primitive renders a
// table. Call sites branch to the shared `EmptyState` before rendering it
// (that decision — icon + copy vs. a bare header row — is a page concern
// and already converged in `EmptyState`).
//
// Styled with Tailwind utilities so the primitive is portable; a call
// site's pin class passes through via `className` for CSS placement / test
// + CDP selectors.

import type { ReactNode } from 'react';
import { cn } from '../utils.js';

export interface DataTableColumn {
  header: ReactNode;
  /** Numeric columns right-align and force tabular-nums. */
  numeric?: boolean;
  /** The single column that absorbs slack so the others size to content. */
  grow?: boolean;
}

export interface DataTableProps {
  /** Table-specific accessible name (each surface names its own table). */
  ariaLabel: string;
  columns: DataTableColumn[];
  /** Row-major cells; cell 0 of each row becomes the scoped row header. */
  rows: Array<Array<ReactNode>>;
  /** Pin class for page-level CSS placement / stable selectors. */
  className?: string;
}

const CELL_BASE =
  'border-b border-border px-[var(--space-2)] py-[var(--space-1-5)] align-middle';

// Only the grow column wraps; every other column stays on one line and sizes
// to its content (no per-character header wrapping, no floating giant gaps).
function shape(column: DataTableColumn): string {
  return [
    column.numeric ? 'text-right [font-variant-numeric:tabular-nums]' : 'text-left',
    column.grow ? 'w-full' : 'whitespace-nowrap',
  ].join(' ');
}

export function DataTable({ ariaLabel, columns, rows, className }: DataTableProps) {
  const cellClass = (column: DataTableColumn) =>
    `${CELL_BASE} text-foreground-secondary ${shape(column)}`;
  const headClass = (column: DataTableColumn) =>
    `${CELL_BASE} font-medium text-muted-foreground ${shape(column)}`;
  return (
    <table
      aria-label={ariaLabel}
      data-slot="data-table"
      className={cn(
        'w-full border-collapse overflow-hidden rounded-[var(--radius-surface)] border border-border text-[length:var(--font-size-caption)]',
        className,
      )}
    >
      <thead>
        <tr>
          {columns.map((column, columnIndex) => (
            <th key={columnIndex} scope="col" className={headClass(column)}>
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.map((cell, cellIndex) =>
              cellIndex === 0 ? (
                <th
                  key={cellIndex}
                  scope="row"
                  className={`${cellClass(columns[cellIndex])} font-medium text-foreground`}
                >
                  {cell}
                </th>
              ) : (
                <td key={cellIndex} className={cellClass(columns[cellIndex])}>
                  {cell}
                </td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
