import { ipcMain } from 'electron';
import type { Task, TaskLedgerStore, TaskStatus } from '@maka/core';

interface TaskLedgerIpcDeps {
  taskLedger: TaskLedgerStore;
}

export interface TaskCancelResult {
  /**
   * 'cancelled' — this call performed the cancel. 'already_terminal' — the
   * task had already reached completed/cancelled (typically the model racing
   * the user's click); the returned snapshot is the truth and the renderer
   * must not surface an error for it.
   */
  outcome: 'cancelled' | 'already_terminal';
  /** Post-operation ledger snapshot, so the renderer needs no follow-up list. */
  tasks: Task[];
}

function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}

/**
 * Renderer surface for the session task ledger. Read-mostly by design: the
 * ledger belongs to the model (TaskCreate/TaskUpdate tools); the only user
 * action is cancelling a task. Session-id validation lives in the store
 * (assertSafeSessionId), so both handlers pass ids straight through.
 */
export function registerTaskLedgerIpc(deps: TaskLedgerIpcDeps): void {
  ipcMain.handle('tasks:list', (_event, sessionId: string) => deps.taskLedger.list(sessionId));
  // The status literal is pinned here, not taken from renderer args: the
  // renderer may only cancel, never flip subjects or other statuses.
  ipcMain.handle('tasks:cancel', async (_event, sessionId: string, taskId: string): Promise<TaskCancelResult> => {
    const current = await deps.taskLedger.list(sessionId);
    const target = current.find((task) => task.id === taskId);
    if (!target) throw new Error(`No such task: ${taskId}`);
    // A user click racing the model's own terminal transition is not an
    // error: report the truth so the renderer just shows the fresh snapshot.
    if (isTerminalStatus(target.status)) {
      return { outcome: 'already_terminal', tasks: current };
    }
    try {
      await deps.taskLedger.update(sessionId, taskId, { status: 'cancelled' });
    } catch (error) {
      // The pre-check and the update are not atomic: if the task reached a
      // terminal status inside that window, re-read and report the truth
      // instead of a misleading failure. Anything else is a real error.
      const after = await deps.taskLedger.list(sessionId);
      const now = after.find((task) => task.id === taskId);
      if (now && isTerminalStatus(now.status)) {
        return { outcome: 'already_terminal', tasks: after };
      }
      throw error;
    }
    return { outcome: 'cancelled', tasks: await deps.taskLedger.list(sessionId) };
  });
}
