import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT } from './css-test-helpers.js';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

async function source(relativePath: string): Promise<string> {
  if (relativePath === 'apps/desktop/src/main/main.ts') return readMainProcessCombinedSource();
  return readFile(resolve(REPO_ROOT, relativePath), 'utf8');
}

describe('desktop task ledger contract', () => {
  it('exposes a signal-only IPC read model and reloads the active session with a revision guard', async () => {
    const [main, preload, globalTypes, hook] = await Promise.all([
      source('apps/desktop/src/main/main.ts'),
      source('apps/desktop/src/preload/preload.ts'),
      source('apps/desktop/src/preload/bridge-contract.d.ts'),
      source('apps/desktop/src/renderer/use-session-tasks.ts'),
    ]);
    assert.match(main, /ipcMain\.handle\('tasks:list'/);
    assert.match(main, /return tasks\.map\(sanitizeTaskLedgerTask\)/);
    assert.match(
      main,
      /listActionableTaskKeys:[\s\S]*?filterModelVisibleTaskLedgerTasks\(tasks\)[\s\S]*?task\.status === 'pending'[\s\S]*?task\.status === 'in_progress'/,
    );
    assert.match(main, /taskLedgerStore\.subscribe\(\(event\) => safeSendToRenderer\('tasks:changed', event\)\)/);
    assert.match(preload, /tasks:\s*\{[\s\S]*ipcRenderer\.invoke\('tasks:list', sessionId\)/);
    assert.match(preload, /ipcRenderer\.on\('tasks:changed', listener\)/);
    assert.match(globalTypes, /tasks:\s*\{[\s\S]*list\(sessionId: string\): Promise<Task\[\]>/);
    assert.match(hook, /revisionRef\.current/);
    assert.match(hook, /event\.sessionId === sessionId/);
    assert.match(hook, /window\.maka\.tasks\.list\(targetSessionId\)/);
    assert.match(hook, /generalizedErrorMessageChinese\(error, '任务载入失败，请重试。'\)/);
    assert.match(hook, /const unsubscribe = window\.maka\.tasks\.subscribeChanges[\s\S]*?load\(sessionId, false\)/);
    assert.doesNotMatch(hook, /StoredMessage|tool_result|parse.*message/i);
  });

  it('renders the existing task tree as workbar content instead of a chat band', async () => {
    const [chat, panel, css] = await Promise.all([
      source('packages/ui/src/chat-view.tsx'),
      source('packages/ui/src/task-ledger-panel.tsx'),
      source('apps/desktop/src/renderer/styles/task-ledger.css'),
    ]);
    assert.doesNotMatch(chat, /<TaskLedgerPanel\b/);
    assert.match(panel, /className="maka-task-ledger-panel"/);
    assert.match(panel, /role="tree"/);
    assert.match(panel, /aria-level=\{depth \+ 1\}/);
    assert.match(panel, /recentTerminal[\s\S]*slice\(0, 3\)/);
    assert.match(panel, /blockedReason \?\? task\.failureReason \?\? task\.completionEvidence/);
    assert.match(css, /\.maka-task-ledger-panel\s*\{[\s\S]*height:\s*100%[\s\S]*overflow-y:\s*auto/);
    assert.match(css, /grid-template-columns:/);
    assert.match(css, /@media\s*\(max-width:\s*620px\)/);
    assert.match(css, /overflow-wrap:\s*anywhere/);
    assert.doesNotMatch(panel, /drag|drop|dependency|bulk|schedule/i);
  });
});
