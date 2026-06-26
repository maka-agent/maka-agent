import type { SessionSummary, StoredMessage } from '@maka/core';

export type SessionReadBoundaries = Record<string, number>;

export interface SessionListRefresher {
  refresh(): Promise<SessionSummary[]>;
}

export interface SessionListRefresherOptions {
  listSessions: () => Promise<SessionSummary[]>;
  readBoundaries: () => Readonly<SessionReadBoundaries>;
  currentSessions: () => SessionSummary[];
  commitSessions: (sessions: SessionSummary[]) => void;
  onError: (error: unknown) => void;
}

export function rememberSessionReadBoundary(
  boundaries: SessionReadBoundaries,
  sessionId: string,
  messages: readonly StoredMessage[],
): void {
  const boundary = latestMessageTs(messages);
  if (boundary === undefined) return;
  boundaries[sessionId] = Math.max(boundaries[sessionId] ?? 0, boundary);
}

export function applySessionReadOverrides(
  sessions: SessionSummary[],
  boundaries: Readonly<SessionReadBoundaries>,
): SessionSummary[] {
  let changed = false;
  const next = sessions.map((session) => {
    const boundary = boundaries[session.id];
    if (boundary === undefined || !session.hasUnread) return session;
    if ((session.lastMessageAt ?? 0) > boundary) return session;
    changed = true;
    return { ...session, hasUnread: false };
  });
  return changed ? next : sessions;
}

export function applyLocalSessionRead(
  boundaries: SessionReadBoundaries,
  sessions: SessionSummary[],
  sessionId: string,
  readMessages: readonly StoredMessage[],
): SessionSummary[] {
  rememberSessionReadBoundary(boundaries, sessionId, readMessages);
  return applySessionReadOverrides(sessions, boundaries);
}

export function createSessionListRefresher(options: SessionListRefresherOptions): SessionListRefresher {
  let latestRequestId = 0;
  return {
    async refresh(): Promise<SessionSummary[]> {
      const requestId = ++latestRequestId;
      try {
        const listed = await options.listSessions();
        if (requestId !== latestRequestId) return options.currentSessions();
        const next = applySessionReadOverrides(listed, options.readBoundaries());
        options.commitSessions(next);
        return next;
      } catch (error) {
        if (requestId === latestRequestId) options.onError(error);
        return options.currentSessions();
      }
    },
  };
}

function latestMessageTs(messages: readonly StoredMessage[]): number | undefined {
  let latest: number | undefined;
  for (const message of messages) {
    if (!Number.isFinite(message.ts)) continue;
    latest = latest === undefined ? message.ts : Math.max(latest, message.ts);
  }
  return latest;
}
