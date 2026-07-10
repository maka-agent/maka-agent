import type { SessionSummary } from '@maka/core';
import type { LiveTurnProjection } from '@maka/ui';

export function settledSessionTransientIds(options: {
  activeId?: string;
  sessions: readonly SessionSummary[];
  liveTurnBySession: Readonly<Record<string, LiveTurnProjection>>;
}): string[] {
  return options.sessions.flatMap((session) => {
    if (session.status === 'running' || session.status === 'waiting_for_user') return [];
    const projection = options.liveTurnBySession[session.id];
    if (session.id === options.activeId && projection?.terminal) return [];
    return [session.id];
  });
}
