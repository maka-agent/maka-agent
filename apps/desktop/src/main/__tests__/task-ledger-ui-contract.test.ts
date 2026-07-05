/**
 * Contract for the task-ledger desktop UI slice (PR2, issue #15).
 *
 * Locks the seams between the model-owned ledger and the renderer panel:
 *   (a) the tasks IPC surface is registered, and the cancel handler pins the
 *       status literal to 'cancelled' — the renderer may never pass an
 *       arbitrary status through to the store.
 *   (b) the preload bridge exposes the tasks namespace (list/cancel).
 *   (c) SessionChangedReason includes 'task-updated' — the panel's only
 *       realtime refresh signal.
 *   (d) main.ts wraps the store in the notification decorator so every
 *       mutation (model tools and the cancel IPC alike) broadcasts a
 *       sessions:changed event, and the renderer effect consumes it.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';
import { readMainTsSource } from './main-process-contract-source-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

function repoFile(path: string): Promise<string> {
  return readFile(resolve(REPO_ROOT, path), 'utf8');
}

describe('task ledger UI contract', () => {
  it('registers the tasks IPC surface and pins cancel to the cancelled status', async () => {
    const src = await repoFile('apps/desktop/src/main/task-ledger-ipc-main.ts');

    assert.match(src, /ipcMain\.handle\('tasks:list'/, 'tasks:list handler must be registered');
    assert.match(src, /ipcMain\.handle\('tasks:cancel'/, 'tasks:cancel handler must be registered');
    assert.match(
      src,
      /update\(sessionId,\s*taskId,\s*\{ status: 'cancelled' \}\)/,
      'cancel must pass the pinned status literal to the store',
    );
    // No renderer-supplied status/subject may flow into the cancel patch:
    // the handler signature accepts only (sessionId, taskId).
    assert.doesNotMatch(
      src,
      /ipcMain\.handle\('tasks:cancel',[^)]*(?:status|patch|subject)\s*[:,)]/,
      'tasks:cancel must not accept a status/subject argument from the renderer',
    );

    const mainSrc = await readMainTsSource();
    assert.match(
      mainSrc,
      /registerTaskLedgerIpc\(\{ taskLedger: taskLedgerStore \}\)/,
      'main.ts must register the tasks IPC with the (decorated) task ledger store',
    );
  });

  it('exposes the tasks namespace on the preload bridge', async () => {
    const src = await repoFile('apps/desktop/src/preload/preload.ts');

    assert.match(src, /tasks:\s*\{/, 'preload must expose a tasks namespace');
    assert.match(src, /ipcRenderer\.invoke\('tasks:list', sessionId\)/, 'tasks.list must invoke tasks:list');
    assert.match(
      src,
      /ipcRenderer\.invoke\('tasks:cancel', sessionId, taskId\)/,
      'tasks.cancel must invoke tasks:cancel with sessionId and taskId only',
    );
  });

  it('declares task-updated as a SessionChangedReason', async () => {
    const src = await repoFile('packages/core/src/session.ts');
    const reasonUnion = src.slice(src.indexOf('export type SessionChangedReason'), src.indexOf('export interface SessionChangedEvent'));
    assert.match(reasonUnion, /'task-updated'/, "SessionChangedReason must include 'task-updated'");
  });

  it('notifies onMutation for every committed wired-store mutation, and observer failures stay contained', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createMainTaskLedgerWiring } = await import('../task-ledger-wiring.js');

    const events: string[] = [];
    const wiring = createMainTaskLedgerWiring(await mkdtemp(join(tmpdir(), 'maka-ledger-ui-')), {
      onMutation: (sessionId) => {
        events.push(sessionId);
        throw new Error('renderer window gone');
      },
    });
    const { created: [task] } = await wiring.store.create('sess-ui', [{ subject: '面板联动' }]);
    assert.ok(task, 'a throwing observer must not fail the mutation');
    await wiring.store.update('sess-ui', task.id, { status: 'in_progress' });
    assert.deepEqual(events, ['sess-ui', 'sess-ui'], 'create and update must both notify');

    const mainSrc = await readMainTsSource();
    assert.match(
      mainSrc,
      /onMutation: \(sessionId\) => emitSessionsChanged\('task-updated', sessionId\)/,
      'main.ts must bridge wiring mutations to sessions:changed(task-updated)',
    );

    const effectsSrc = await repoFile('apps/desktop/src/renderer/app-shell-effects.ts');
    assert.match(
      effectsSrc,
      /event\.reason === 'task-updated'/,
      'the renderer session-change handler must refresh on task-updated',
    );
    // task-updated is ledger-only: it must not re-pull the session list and
    // must not reset the per-session event-stream health (it is not paired
    // with a transcript re-pull, so it would mask a dead event stream).
    assert.match(
      effectsSrc,
      /if \(event\.reason !== 'task-updated'\) void options\.refreshSessions\(\);/,
      'task-updated must skip the full session-list refresh',
    );
    assert.match(
      effectsSrc,
      /event\.sessionId && event\.reason !== 'task-updated'/,
      'task-updated must not reset session event-stream health',
    );
  });

  it('clears the panel instead of showing a stale ledger when a refresh fails', async () => {
    const actionsSrc = await repoFile('apps/desktop/src/renderer/app-shell-task-actions.ts');
    // Fail to empty, guarded by the active-session check so a slow rejection
    // for an abandoned session cannot clobber the current one.
    assert.match(
      actionsSrc,
      /catch[\s\S]*?if \(getActiveSessionId\(\) === sessionId\) setSessionTasks\(\[\]\);/,
      'a failed tasks:list must clear the panel for the still-active session',
    );
  });
});
