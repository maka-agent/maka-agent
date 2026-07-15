import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const RENDERER_ROOT = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer');

describe('AppShell session workspace ownership boundary', () => {
  it('keeps active session, messages, session collection, and transient UI behind one workspace owner', async () => {
    const [shell, workspace, listOwner, effects] = await Promise.all([
      readFile(resolve(RENDERER_ROOT, 'app-shell.tsx'), 'utf8'),
      readFile(resolve(RENDERER_ROOT, 'use-app-shell-session-workspace.ts'), 'utf8'),
      readFile(resolve(RENDERER_ROOT, 'use-app-shell-session-list.ts'), 'utf8'),
      readFile(resolve(RENDERER_ROOT, 'app-shell-effects.ts'), 'utf8'),
    ]);

    assert.match(shell, /useAppShellSessionWorkspace\(/);
    assert.doesNotMatch(shell, /useState<SessionSummary\[\]>/);
    assert.doesNotMatch(shell, /useState<string \| undefined>\(\)/);
    assert.doesNotMatch(shell, /useState<StoredMessage\[\]>/);
    assert.doesNotMatch(shell, /useAppShellSessionList|useAppShellSessionUiState/);
    assert.doesNotMatch(shell, /createSessionListRefresher\(/);
    assert.doesNotMatch(shell, /window\.maka\.sessions\.list\(/);

    assert.match(workspace, /useAppShellSessionList\(toastApi\)/);
    assert.match(workspace, /useAppShellSessionUiState\(\)/);
    assert.match(workspace, /function setActiveId/);
    assert.match(workspace, /activeIdRef\.current = next/);
    assert.doesNotMatch(effects, /activeIdRef\.current\s*=(?!=)/);
    assert.match(workspace, /function startNewSession/);
    assert.match(workspace, /function clearOwnedSessionState/);
    assert.match(workspace, /const \[messages, setMessages\] = useState<StoredMessage\[\]>/);
    assert.match(listOwner, /createSessionListRefresher\(/);
    assert.match(listOwner, /window\.maka\.sessions\.list\(/);
    assert.match(listOwner, /seedSessions/);
    assert.match(listOwner, /markSessionRunningOptimistic/);
    assert.match(listOwner, /markSessionReadLocally/);
  });
});
