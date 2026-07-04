import { cn, PrimitiveBadge, type PrimitiveBadgeProps } from '@maka/ui';

/**
 * Settings-scope status badge: the shared Badge primitive plus the
 * settings design decision that status chips use compact squared
 * target-layout corners, not pills (settings-form-a11y-contract). The
 * primitive stays canonically pill-shaped; this wrapper owns the
 * settings exception so call sites can't drift.
 */
export function SettingsBadge({ className, size = 'sm', ...props }: PrimitiveBadgeProps) {
  return (
    <PrimitiveBadge
      size={size}
      {...props}
      className={cn('rounded-[var(--radius-control)]', className)}
    />
  );
}
