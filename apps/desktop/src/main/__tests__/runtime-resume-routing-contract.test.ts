import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererShellSource } from './renderer-shell-source-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

describe('runtime resume desktop routing contract', () => {
  it('renderer exposes an exact /resume command and reports parked diagnostics', async () => {
    const shell = await readRendererShellSource('app-shell.tsx');
    const send = shell.match(/async function sendWithAttachments\(text: string\): Promise<boolean \| void> \{[\s\S]*?\n  \}/)?.[0] ?? '';

    assert.match(send, /if \(text\.trim\(\) === '\/resume'\) \{/);
    assert.match(send, /window\.maka\.sessions\.resumeLatest\(activeId\)/);
    assert.match(send, /result\.disposition === 'park'/);
    assert.match(send, /result\.rejectionReasons\.join/);
  });

  it('main plans from authoritative state and streams only an approved latest continuation', async () => {
    const main = await readFile(
      resolve(REPO_ROOT, 'apps/desktop/src/main/sessions-ipc-main.ts'),
      'utf8',
    );
    const handler = main.match(/ipcMain\.handle\('sessions:resumeLatest'[\s\S]*?\n  \}\);/)?.[0] ?? '';

    assert.match(handler, /runtime\.planLatestAuthoritativeSafeBoundaryContinuation\(sessionId\)/);
    assert.match(handler, /if \(!plan\.continuation\)/);
    assert.match(handler, /runtime\.resumeSafeBoundaryContinuation\(plan\.continuation\)/);
    assert.match(handler, /streamEvents\(sessionId, iterator, \{/);
    assert.match(handler, /turnId: plan\.continuation\.turnId/);
  });

  it('preload exposes resumeLatest without accepting renderer safety facts', async () => {
    const preload = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/preload/preload.ts'), 'utf8');
    const resume = preload.match(/resumeLatest\(sessionId: string\)[\s\S]*?\n    \}/)?.[0] ?? '';

    assert.match(resume, /ipcRenderer\.invoke\('sessions:resumeLatest', sessionId\)/);
    assert.doesNotMatch(resume, /workspace|tool|background|checkpoint/i);
  });

  it('startup recovery auto-continues only behind the safe-boundary feature flag', async () => {
    const main = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/main/main.ts'), 'utf8');
    const recovery = main.match(/async function recoverInterruptedSessionsOnStartup\(\): Promise<void> \{[\s\S]*?\n\}/)?.[0] ?? '';

    assert.match(recovery, /MAKA_RUNTIME_SAFE_BOUNDARY_RESUME !== '1'/);
    assert.match(recovery, /runtime\.planLatestAuthoritativeSafeBoundaryContinuation\(session\.id\)/);
    assert.match(recovery, /runtime\.resumeSafeBoundaryContinuation\(plan\.continuation\)/);
    assert.match(recovery, /streamEvents\(session\.id, iterator, \{/);
    assert.match(recovery, /turnId: plan\.continuation\.turnId/);
  });
});
