import type { Dispatch, SetStateAction } from 'react';
import type { Task } from '@maka/core';
import { generalizedErrorMessageChinese } from '@maka/core';

type ToastApi = {
  error(title: string, description?: string): void;
};

export interface AppShellTaskActions {
  refreshSessionTasks(sessionId: string | undefined, options?: { shouldShowError?: () => boolean }): Promise<void>;
  cancelSessionTask(sessionId: string, taskId: string): Promise<void>;
}

/**
 * Session task ledger actions (plan-actions paradigm). The ledger is the
 * model's; the renderer only pulls snapshots and cancels tasks. Refreshes are
 * triggered by the mount, by session switches, and by sessions:changed events
 * with reason 'task-updated'.
 */
export function createAppShellTaskActions(deps: {
  getActiveSessionId: () => string | undefined;
  setSessionTasks: Dispatch<SetStateAction<Task[]>>;
  toastApi: ToastApi;
}): AppShellTaskActions {
  const { getActiveSessionId, setSessionTasks, toastApi } = deps;
  // Monotonic snapshot sequence: every operation that will produce a ledger
  // snapshot takes a number up front, and only the newest number may land.
  // This orders concurrent responses (cancel result vs broadcast-triggered
  // refresh) so an older snapshot can never overwrite a newer one.
  let snapshotSeq = 0;

  function applySnapshot(sessionId: string, seq: number, tasks: Task[]): void {
    // Both guards are required: seq orders same-session responses; the
    // active-session check drops responses for a session the user already left
    // (the switch path cleared the panel synchronously).
    if (seq !== snapshotSeq) return;
    if (getActiveSessionId() !== sessionId) return;
    setSessionTasks(tasks);
  }

  async function refreshSessionTasks(
    sessionId: string | undefined,
    options: { shouldShowError?: () => boolean } = {},
  ): Promise<void> {
    if (!sessionId) {
      snapshotSeq += 1;
      setSessionTasks([]);
      return;
    }
    const seq = ++snapshotSeq;
    try {
      const tasks = await window.maka.tasks.list(sessionId);
      applySnapshot(sessionId, seq, tasks);
    } catch (error) {
      // Keep the last known snapshot: the session-switch path clears the
      // panel synchronously, so whatever is rendered is this session's own
      // ledger — a transient list failure must not blank the panel (the next
      // task-updated event re-pulls the real list).
      if (options.shouldShowError?.() ?? false) {
        toastApi.error('刷新任务清单失败', generalizedErrorMessageChinese(error, '读取会话任务失败，请稍后重试。'));
      }
    }
  }

  async function cancelSessionTask(sessionId: string, taskId: string): Promise<void> {
    const seq = ++snapshotSeq;
    try {
      const result = await window.maka.tasks.cancel(sessionId, taskId);
      // The IPC returns the post-operation snapshot, so no follow-up list is
      // needed. 'already_terminal' (the model finished or cancelled the task
      // first) is not an error: the snapshot already shows the truth.
      applySnapshot(sessionId, seq, result.tasks);
    } catch (error) {
      toastApi.error('取消任务失败', generalizedErrorMessageChinese(error, '取消任务失败，请稍后重试。'));
    }
  }

  return { refreshSessionTasks, cancelSessionTask };
}
