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

  async function refreshSessionTasks(
    sessionId: string | undefined,
    options: { shouldShowError?: () => boolean } = {},
  ): Promise<void> {
    if (!sessionId) {
      setSessionTasks([]);
      return;
    }
    try {
      const tasks = await window.maka.tasks.list(sessionId);
      // A slow response for a session the user already left must not
      // clobber the newer session's list.
      if (getActiveSessionId() === sessionId) setSessionTasks(tasks);
    } catch (error) {
      if (options.shouldShowError?.() ?? false) {
        toastApi.error('刷新任务清单失败', generalizedErrorMessageChinese(error, '读取会话任务失败，请稍后重试。'));
      }
    }
  }

  async function cancelSessionTask(sessionId: string, taskId: string): Promise<void> {
    try {
      await window.maka.tasks.cancel(sessionId, taskId);
      // The cancel IPC also emits a task-updated event, but refresh directly
      // so the row flips without depending on the broadcast round-trip.
      await refreshSessionTasks(sessionId);
    } catch (error) {
      toastApi.error('取消任务失败', generalizedErrorMessageChinese(error, '取消任务失败，请稍后重试。'));
    }
  }

  return { refreshSessionTasks, cancelSessionTask };
}
