import type { SessionStatus } from './session.js';

export const SESSION_EVENT_STREAM_STATUSES = ['connected', 'stale', 'recovered', 'closed'] as const;

export type SessionEventStreamStatus = (typeof SESSION_EVENT_STREAM_STATUSES)[number];

export const SESSION_EVENT_STREAM_STALE_AFTER_MS = 15_000;
export const SESSION_EVENT_STREAM_REFRESH_COOLDOWN_MS = 10_000;

export interface SessionEventStreamSnapshot {
  sessionId: string;
  status: SessionEventStreamStatus;
  subscribedAt: number;
  checkedAt: number;
  lastEventAt?: number;
  lastChangedAt?: number;
  staleSince?: number;
  refreshRequestedAt?: number;
}

export function isSessionEventStreamStatus(value: unknown): value is SessionEventStreamStatus {
  return (
    typeof value === 'string' &&
    (SESSION_EVENT_STREAM_STATUSES as readonly string[]).includes(value)
  );
}

export function sessionExpectsEventStream(
  status: SessionStatus | undefined,
  hasLiveActivity = false,
): boolean {
  return status === 'running' || hasLiveActivity;
}

export function newestSessionStreamObservation(input: {
  subscribedAt: number;
  lastEventAt?: number;
  lastChangedAt?: number;
}): number {
  return Math.max(input.subscribedAt, input.lastEventAt ?? 0, input.lastChangedAt ?? 0);
}

export function deriveSessionEventStreamStatus(input: {
  now: number;
  subscribedAt: number;
  lastEventAt?: number;
  lastChangedAt?: number;
  previousStatus?: SessionEventStreamStatus;
  expected: boolean;
  staleAfterMs?: number;
}): SessionEventStreamStatus {
  if (!input.expected) return 'closed';
  const staleAfterMs = input.staleAfterMs ?? SESSION_EVENT_STREAM_STALE_AFTER_MS;
  const observedAt = newestSessionStreamObservation(input);
  if (input.now - observedAt >= staleAfterMs) return 'stale';
  return input.previousStatus === 'stale' ? 'recovered' : 'connected';
}

export function shouldRefreshStaleSessionEventStream(input: {
  status: SessionEventStreamStatus;
  now: number;
  refreshRequestedAt?: number;
  cooldownMs?: number;
}): boolean {
  if (input.status !== 'stale') return false;
  const cooldownMs = input.cooldownMs ?? SESSION_EVENT_STREAM_REFRESH_COOLDOWN_MS;
  return (
    input.refreshRequestedAt === undefined || input.now - input.refreshRequestedAt >= cooldownMs
  );
}
