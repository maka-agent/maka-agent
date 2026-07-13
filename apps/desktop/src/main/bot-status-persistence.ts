import { humanizeBotStatusReason } from '@maka/core';
import type { BotStatus } from '@maka/runtime';

type PersistedBotStatus = Pick<BotStatus, 'readiness' | 'reason'>;

export function deriveBotStatusPersistenceUpdate(
  previous: PersistedBotStatus | undefined,
  current: PersistedBotStatus,
): { lastError: string | undefined } | undefined {
  if (
    previous?.readiness === current.readiness
    && previous.reason === current.reason
  ) {
    return undefined;
  }

  if (current.readiness === 'degraded') {
    const lastError = humanizeBotStatusReason(current.reason);
    return lastError ? { lastError } : undefined;
  }

  if (current.readiness === 'operational' && previous?.readiness === 'degraded') {
    return { lastError: undefined };
  }

  return undefined;
}
