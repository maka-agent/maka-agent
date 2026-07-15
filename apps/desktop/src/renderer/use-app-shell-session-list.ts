import { useRef, useState } from 'react';
import type { SessionSummary, StoredMessage } from '@maka/core';
import { generalizedErrorMessageChinese } from '@maka/core';
import { normalizeSessionSummaryForDisplay } from './session-status-presentation';
import {
  applyLocalSessionRead,
  applySessionReadOverrides,
  createSessionListRefresher,
  type SessionListRefresher,
  type SessionReadBoundaries,
} from './session-read-state';

type ToastApi = {
  error(title: string, description?: string): void;
};

export function useAppShellSessionList(toastApi: ToastApi) {
  const [sessions, setSessionsState] = useState<SessionSummary[]>([]);
  const sessionsRef = useRef<SessionSummary[]>([]);
  const sessionReadBoundariesRef = useRef<SessionReadBoundaries>({});
  const refresherRef = useRef<SessionListRefresher | null>(null);

  function commitSessions(next: SessionSummary[]): void {
    sessionsRef.current = next;
    setSessionsState(next);
  }

  function setSessions(updater: (current: SessionSummary[]) => SessionSummary[]): void {
    setSessionsState((current) => {
      const next = updater(current);
      sessionsRef.current = next;
      return next;
    });
  }

  if (!refresherRef.current) {
    refresherRef.current = createSessionListRefresher({
      listSessions: () => window.maka.sessions.list(),
      readBoundaries: () => sessionReadBoundariesRef.current,
      currentSessions: () => sessionsRef.current,
      commitSessions: (next) => commitSessions(next.map(normalizeSessionSummaryForDisplay)),
      onError: (error) => {
        toastApi.error('刷新会话列表失败', generalizedErrorMessageChinese(error, '刷新会话列表失败，请稍后重试。'));
      },
    });
  }

  async function refreshSessions(): Promise<SessionSummary[]> {
    return refresherRef.current!.refresh();
  }

  function seedSessions(snapshotSessions: readonly SessionSummary[]): SessionSummary[] {
    const next = applySessionReadOverrides([...snapshotSessions], sessionReadBoundariesRef.current)
      .map(normalizeSessionSummaryForDisplay);
    commitSessions(next);
    return next;
  }

  function upsertSessionSummary(session: SessionSummary): void {
    setSessions((current) => [
      normalizeSessionSummaryForDisplay(session),
      ...current.filter((entry) => entry.id !== session.id),
    ]);
  }

  // Sending locally precedes the persisted running status. Open the UI gate
  // optimistically, then let session refresh reconcile it. The restore only
  // applies while this exact optimistic status still owns the entry, so a
  // newer backend update always wins.
  function markSessionRunningOptimistic(sessionId: string): (() => void) | undefined {
    const prior = sessionsRef.current.find((entry) => entry.id === sessionId);
    if (!prior || prior.status === 'running') return undefined;
    const priorStatus = prior.status;
    setSessions((current) => current.map((entry) => (
      entry.id === sessionId && entry.status !== 'running'
        ? { ...entry, status: 'running' as const }
        : entry
    )));
    return () => {
      setSessions((current) => current.map((entry) => (
        entry.id === sessionId && entry.status === 'running'
          ? { ...entry, status: priorStatus }
          : entry
      )));
    };
  }

  function markSessionReadLocally(sessionId: string, readMessages: readonly StoredMessage[]): void {
    setSessions((current) => applyLocalSessionRead(
      sessionReadBoundariesRef.current,
      current,
      sessionId,
      readMessages,
    ));
  }

  return {
    sessions,
    sessionsRef,
    setSessions,
    refreshSessions,
    seedSessions,
    upsertSessionSummary,
    markSessionRunningOptimistic,
    markSessionReadLocally,
  };
}
