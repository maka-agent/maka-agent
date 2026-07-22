// packages/ui/src/primitives/stat-tile.tsx
//
// The shared implementation for "big number + label (+ detail)" stat tiles. Before
// this, four near-identical recipes lived in page CSS (permission summary,
// health summary — literal twins — plus the filled MetricCard and the
// daily-review totals cell).
//
// Recipe decisions (union of the twins):
//   - value is tabular-nums ALWAYS (tabular-nums-converge contract);
//   - emphasis="outline" = card-like tile (hairline + radius-surface +
//     1.5em value); emphasis="filled" = compact quiet tile (foreground-5
//     wash + radius-control + ui-size value) for dense metric strips;
//   - tone paints the value ink AND (outline only) tints the border —
//     the health model, which scans better than value-only;
//   - a ZERO count is not an exception: numeric zero drops the tone to
//     neutral and sets data-empty (dim) — the permission rationale
//     (0 已拒绝 in red read as a false alarm) now applies everywhere.
//
// Styled with Tailwind utilities so the primitive is portable; wrapper
// classes from call sites (grid placement, page pins) pass through.

import type { ReactNode } from 'react';
import { cn } from '../utils.js';

export type StatTileTone = 'neutral' | 'info' | 'success' | 'warning' | 'destructive';

const TONE_VALUE_CLASS: Record<StatTileTone, string> = {
  neutral: '',
  info: 'text-[color:var(--info-text)]',
  success: 'text-[color:var(--success-text)]',
  warning: 'text-[color:var(--warning-text)]',
  destructive: 'text-[color:var(--destructive-text)]',
};

const TONE_BORDER_CLASS: Record<StatTileTone, string> = {
  neutral: '',
  info: 'border-[oklch(from_var(--info)_l_c_h_/_0.24)]',
  success: 'border-[oklch(from_var(--success)_l_c_h_/_0.24)]',
  warning: 'border-[oklch(from_var(--warning)_l_c_h_/_0.28)]',
  destructive: 'border-[oklch(from_var(--destructive)_l_c_h_/_0.30)]',
};

export interface StatTileProps {
  label: ReactNode;
  value: ReactNode;
  /** Optional third quiet line under the label (MetricCard's detail). */
  detail?: ReactNode;
  tone?: StatTileTone;
  /** outline = card tile (permission/health); filled = compact metric strip. */
  emphasis?: 'outline' | 'filled';
  /** Numeric zero drops tone to neutral + dims (data-empty). Default on. */
  zeroNeutral?: boolean;
  as?: 'div' | 'li';
  className?: string;
}

export function StatTile({
  label,
  value,
  detail,
  tone = 'neutral',
  emphasis = 'outline',
  zeroNeutral = true,
  as: Tag = 'div',
  className,
}: StatTileProps) {
  const isEmptyCount = zeroNeutral && typeof value === 'number' && value === 0;
  const effectiveTone: StatTileTone = isEmptyCount ? 'neutral' : tone;
  return (
    <Tag
      className={cn(
        'flex min-w-0 flex-col items-start gap-1',
        emphasis === 'outline'
          ? 'rounded-[var(--radius-surface)] border border-[var(--card-border-color,var(--border))] bg-[var(--card-bg,var(--background))] p-3 shadow-[var(--card-shadow,none)]'
          : 'rounded-[var(--radius-control)] bg-[var(--foreground-5)] p-3',
        emphasis === 'outline' ? TONE_BORDER_CLASS[effectiveTone] : '',
        isEmptyCount ? 'opacity-[var(--opacity-disabled)]' : '',
        className,
      )}
      data-slot="stat-tile"
      data-tone={effectiveTone}
      data-empty={isEmptyCount ? 'true' : undefined}
    >
      <span
        className={cn(
          'block max-w-full min-w-0 whitespace-normal font-semibold leading-tight text-foreground [font-variant-numeric:tabular-nums] [overflow-wrap:anywhere]',
          emphasis === 'outline' ? 'text-[length:var(--font-size-stat)]' : 'text-[length:var(--font-size-ui)]',
          TONE_VALUE_CLASS[effectiveTone],
        )}
        data-slot="stat-tile-value"
      >
        {value}
      </span>
      <span
        className="text-[length:var(--font-size-caption)] tracking-wide text-[color:var(--foreground-secondary)]"
        data-slot="stat-tile-label"
      >
        {label}
      </span>
      {detail != null && (
        <span
          className="text-[length:var(--font-size-caption)] text-[color:var(--muted-foreground)]"
          data-slot="stat-tile-detail"
        >
          {detail}
        </span>
      )}
    </Tag>
  );
}
