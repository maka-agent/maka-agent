export const PERMISSION_REQUEST_HEALTH_STATUSES = ['fresh', 'stale', 'expired'] as const;

export type PermissionRequestHealthStatus = (typeof PERMISSION_REQUEST_HEALTH_STATUSES)[number];

export const PERMISSION_REQUEST_STALE_AFTER_MS = 2 * 60_000;
export const PERMISSION_REQUEST_EXPIRED_AFTER_MS = 10 * 60_000;

export interface PermissionRequestHealth {
  status: PermissionRequestHealthStatus;
  ageMs: number;
}

export function isPermissionRequestHealthStatus(
  value: unknown,
): value is PermissionRequestHealthStatus {
  return (
    typeof value === 'string' &&
    (PERMISSION_REQUEST_HEALTH_STATUSES as readonly string[]).includes(value)
  );
}

export function derivePermissionRequestHealth(input: {
  requestedAt: number;
  now: number;
  staleAfterMs?: number;
  expiredAfterMs?: number;
}): PermissionRequestHealth {
  const staleAfterMs = input.staleAfterMs ?? PERMISSION_REQUEST_STALE_AFTER_MS;
  const expiredAfterMs = input.expiredAfterMs ?? PERMISSION_REQUEST_EXPIRED_AFTER_MS;
  const ageMs = Math.max(0, input.now - input.requestedAt);
  if (ageMs >= expiredAfterMs) return { status: 'expired', ageMs };
  if (ageMs >= staleAfterMs) return { status: 'stale', ageMs };
  return { status: 'fresh', ageMs };
}

export function formatPermissionRequestWait(ageMs: number): string {
  const clamped = Math.max(0, ageMs);
  if (clamped < 60_000) return '< 1 分钟';
  const minutes = Math.floor(clamped / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder > 0 ? `${hours} 小时 ${remainder} 分钟` : `${hours} 小时`;
}
