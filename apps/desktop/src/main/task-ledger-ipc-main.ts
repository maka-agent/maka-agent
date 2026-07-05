import { ipcMain } from 'electron';
import type { TaskLedgerStore } from '@maka/core';

interface TaskLedgerIpcDeps {
  taskLedger: TaskLedgerStore;
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
  ipcMain.handle('tasks:cancel', (_event, sessionId: string, taskId: string) =>
    deps.taskLedger.update(sessionId, taskId, { status: 'cancelled' }),
  );
}
