import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const RENDERER_ROOT = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer');

describe('AppShell session-list ownership boundary', () => {
  it('keeps session collection state and IPC behind one controller hook', async () => {
    const [shell, owner] = await Promise.all([
      readFile(resolve(RENDERER_ROOT, 'app-shell.tsx'), 'utf8'),
      readFile(resolve(RENDERER_ROOT, 'use-app-shell-session-list.ts'), 'utf8'),
    ]);

    assert.match(shell, /useAppShellSessionList\(/);
    assert.doesNotMatch(shell, /useState<SessionSummary\[\]>/);
    assert.doesNotMatch(shell, /createSessionListRefresher\(/);
    assert.doesNotMatch(shell, /window\.maka\.sessions\.list\(/);

    assert.match(owner, /createSessionListRefresher\(/);
    assert.match(owner, /window\.maka\.sessions\.list\(/);
    assert.match(owner, /seedSessions/);
    assert.match(owner, /markSessionRunningOptimistic/);
    assert.match(owner, /markSessionReadLocally/);
  });
});
