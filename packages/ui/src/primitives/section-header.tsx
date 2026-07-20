// packages/ui/src/primitives/section-header.tsx
//
// Convergence round 5: the ONE "section title (+ count / subtitle) +
// trailing action" header. Before this, three dialects were hand-rolled:
// skills' span-row (label + N 个), daily-review's h4 with a colored
// accent bar, and permission's h4 + small + trailing button.
//
// Styled with Tailwind utilities (portable, like DialogHeader/StatTile);
// call sites keep their wrapper classes for page-pinned CSS placement.

import type { ReactNode } from 'react';
import { cn } from '../utils.js';

export interface SectionHeaderProps {
  title: ReactNode;
  /** `id` on the title element, for a section's `aria-labelledby` link. */
  titleId?: string;
  /** Muted trailing count (e.g. "3 个" / "2 份"). */
  count?: ReactNode;
  /** One quiet line under the title (permission's layer explainer). */
  subtitle?: ReactNode;
  /** Right-aligned action cluster (button / filter pills). */
  action?: ReactNode;
  /** Leading accent bar (daily-review's section marker). */
  accent?: boolean;
  /** Heading level for the title, or a non-heading `span`. `h3` is for a
   *  section that sits directly under a page `h2` (关于 privacy, 数据 config). */
  as?: 'h3' | 'h4' | 'span';
  className?: string;
}

export function SectionHeader({
  title,
  titleId,
  count,
  subtitle,
  action,
  accent = false,
  as: Tag = 'span',
  className,
}: SectionHeaderProps) {
  return (
    <div
      className={cn('flex min-w-0 items-center justify-between gap-3', className)}
      data-slot="section-header"
    >
      <div className="min-w-0">
        <Tag
          id={titleId}
          className={cn(
            'm-0 inline-flex items-center gap-2 text-[length:var(--font-size-ui)] font-semibold text-foreground',
            accent &&
              'before:inline-block before:h-3 before:w-[3px] before:rounded-[var(--radius-pill)] before:bg-[oklch(from_var(--status-running)_l_c_h_/_0.85)] before:content-[""]',
          )}
          data-slot="section-header-title"
        >
          {title}
          {count != null && (
            <small
              className="text-[length:var(--font-size-caption)] font-normal text-[color:var(--muted-foreground)] [font-variant-numeric:tabular-nums]"
              data-slot="section-header-count"
            >
              {count}
            </small>
          )}
        </Tag>
        {subtitle != null && (
          <small
            className="mt-0.5 block text-[length:var(--font-size-caption)] font-normal text-[color:var(--foreground-secondary)]"
            data-slot="section-header-subtitle"
          >
            {subtitle}
          </small>
        )}
      </div>
      {action != null && (
        <div className="flex shrink-0 items-center gap-2" data-slot="section-header-action">
          {action}
        </div>
      )}
    </div>
  );
}
