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
    // Terminal-race contract: a user click racing the model's own terminal
    // transition reports the truth (already_terminal + fresh snapshot) rather
    // than a misleading store error — on the pre-check and inside the
    // pre-check/update race window alike; anything else rethrows.
    assert.match(src, /outcome: 'already_terminal'/, 'cancel must report already_terminal instead of erroring');
    assert.match(src, /outcome: 'cancelled'/, 'a performed cancel must report the cancelled outcome');
    assert.match(
      src,
      /catch \(error\)[\s\S]*?already_terminal[\s\S]*?throw error/,
      'the pre-check/update race window must re-read and only rethrow real errors',
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

    // The renderer-side routing of task-updated (refresh the active session's
    // ledger only; skip the session-list re-pull; leave event-stream health
    // untouched) is asserted at behavior level by the BootstrapSubscriptionProbe
    // harness in app-shell-effect-stability-contract.test.ts, not by source
    // regexes here.
  });

  it('clears the panel on session switch and keeps the last snapshot on refresh failure', async () => {
    // R2: the switch effect clears synchronously — within the IPC round-trip a
    // stale panel would offer cancel buttons wired to the previous session's
    // task ids.
    const appShellSrc = await repoFile('apps/desktop/src/renderer/app-shell.tsx');
    assert.match(
      appShellSrc,
      /useEffect\(\(\) => \{\s*setSessionTasks\(\[\]\);\s*void refreshSessionTasksRef\.current\(activeId\);\s*\}, \[activeId\]\);/,
      'switching sessions must synchronously clear the ledger before pulling the new one',
    );

    // R1: with the switch path clearing synchronously, whatever is rendered is
    // this session's own ledger — a transient list failure keeps the last
    // known snapshot instead of blanking the panel.
    const actionsSrc = await repoFile('apps/desktop/src/renderer/app-shell-task-actions.ts');
    assert.doesNotMatch(
      actionsSrc,
      /catch[\s\S]*?setSessionTasks\(\[\]\)/,
      'a failed refresh must not clear the panel (the switch path already prevents cross-session staleness)',
    );

    // R4: responses are ordered by a monotonic sequence so an older snapshot
    // (e.g. a slow list racing a cancel result) can never overwrite a newer one.
    assert.match(actionsSrc, /snapshotSeq/, 'snapshot application must be sequence-ordered');
    assert.match(
      actionsSrc,
      /if \(seq !== snapshotSeq\) return;/,
      'only the newest in-flight snapshot may land',
    );

    // R3 renderer side: the cancel result snapshot is applied directly (no
    // follow-up list), and already_terminal is not surfaced as an error.
    assert.match(
      actionsSrc,
      /const result = await window\.maka\.tasks\.cancel\(sessionId, taskId\);[\s\S]*?applySnapshot\(sessionId, seq, result\.tasks\);/,
      'cancel must render the snapshot the IPC returned instead of re-pulling',
    );
  });

  it('hosts the panel in the right-side collapsible task rail, not the chat column', async () => {
    const railSrc = await repoFile('apps/desktop/src/renderer/task-rail.tsx');

    // (a) collapse state persists under a stable key, defaulting to expanded
    // on a fresh profile (absent key must not read as collapsed).
    assert.match(railSrc, /'maka-task-rail-collapsed-v1'/, 'the rail must persist its collapse state');
    assert.match(
      railSrc,
      /safeLocalStorageGet\(COLLAPSE_KEY\) === '1'/,
      'only an explicit stored flag may collapse the rail — absent key means expanded',
    );
    assert.match(railSrc, /safeLocalStorageSet\(COLLAPSE_KEY, collapsed \? '1' : '0'\)/);

    // (b) an empty ledger takes no space.
    assert.match(
      railSrc,
      /if \(props\.tasks\.length === 0\) return null;/,
      'the rail must return null for an empty ledger',
    );

    // (c) the collapsed strip still communicates the task count, and an
    // in-progress dot only when something is actually running.
    assert.match(railSrc, /maka-task-rail-strip-count/, 'the collapsed strip must show the task count');
    assert.match(
      railSrc,
      /hasInProgress && <span className="maka-task-rail-strip-dot" \/>/,
      'the in-progress dot must be conditional',
    );

    // Mounted in the app shell, as a sibling before ArtifactPane in the same
    // right-side stack — and gone from the chat column entirely.
    const appShellSrc = await repoFile('apps/desktop/src/renderer/app-shell.tsx');
    assert.match(
      appShellSrc,
      /<TaskRail[\s\S]{0,300}<ArtifactPane sessionId=\{activeId\} \/>/,
      'the task rail must sit before ArtifactPane in the right-side stack',
    );
    assert.match(
      appShellSrc,
      /activeId && sessionTasks\.length > 0 &&/,
      'the rail mount must be gated on a known non-empty ledger (lazy-fallback contract)',
    );
    const chatViewSrc = await repoFile('packages/ui/src/chat-view.tsx');
    assert.doesNotMatch(
      chatViewSrc,
      /TaskLedgerPanel/,
      'the chat column must no longer render the task panel',
    );
  });
});
