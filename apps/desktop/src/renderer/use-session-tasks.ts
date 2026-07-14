import { useCallback, useEffect, useRef, useState } from 'react';
import { generalizedErrorMessageChinese, type Task } from '@maka/core';

interface SessionTaskSnapshot {
  sessionId?: string;
  tasks: Task[];
  loading: boolean;
  error?: string;
}

const EMPTY_SNAPSHOT: SessionTaskSnapshot = {
  tasks: [],
  loading: false,
};

export function useSessionTasks(sessionId: string | undefined): SessionTaskSnapshot & { retry: () => void } {
  const revisionRef = useRef(0);
  const [snapshot, setSnapshot] = useState<SessionTaskSnapshot>(EMPTY_SNAPSHOT);

  const load = useCallback((targetSessionId: string, preserveTasks: boolean) => {
    const revision = ++revisionRef.current;
    setSnapshot((current) => ({
      sessionId: targetSessionId,
      tasks: preserveTasks && current.sessionId === targetSessionId ? current.tasks : [],
      loading: true,
    }));
    void window.maka.tasks.list(targetSessionId).then(
      (tasks) => {
        if (revision !== revisionRef.current) return;
        setSnapshot({ sessionId: targetSessionId, tasks, loading: false });
      },
      (error: unknown) => {
        if (revision !== revisionRef.current) return;
        setSnapshot((current) => ({
          sessionId: targetSessionId,
          tasks: current.sessionId === targetSessionId ? current.tasks : [],
          loading: false,
          error: generalizedErrorMessageChinese(error, '任务载入失败，请重试。'),
        }));
      },
    );
  }, []);

  useEffect(() => {
    revisionRef.current += 1;
    if (!sessionId) {
      setSnapshot(EMPTY_SNAPSHOT);
      return;
    }
    const unsubscribe = window.maka.tasks.subscribeChanges((event) => {
      if (event.sessionId === sessionId) load(sessionId, true);
    });
    load(sessionId, false);
    return () => {
      revisionRef.current += 1;
      unsubscribe();
    };
  }, [load, sessionId]);

  const retry = useCallback(() => {
    if (sessionId) load(sessionId, true);
  }, [load, sessionId]);

  if (snapshot.sessionId !== sessionId) {
    return { ...EMPTY_SNAPSHOT, loading: Boolean(sessionId), retry };
  }
  return { ...snapshot, retry };
}
