import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererShellSource } from './renderer-shell-source-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

describe('runtime resume desktop routing contract', () => {
  it('renderer routes interrupted-banner resume and reports parked diagnostics', async () => {
    const shell = await readRendererShellSource('app-shell.tsx');
    const send = shell.match(/async function sendWithAttachments\(text: string\): Promise<boolean \| void> \{[\s\S]*?\n  \}/)?.[0] ?? '';

    assert.doesNotMatch(send, /text\.trim\(\) === '\/resume'/);
    assert.match(shell, /async function resumeInterruptedSession\(\)/);
    assert.match(shell, /window\.maka\.sessions\.resumeLatest\(sessionId\)/);
    assert.match(shell, /resumeParkToastCopy\(result\.rejectionReasons\)/);
    assert.doesNotMatch(shell, /result\.rejectionReasons\.join/);
    assert.match(shell, /safeResumeAction=/);

    const turn = await readFile(resolve(REPO_ROOT, 'packages/ui/src/chat-turn.tsx'), 'utf8');
    assert.match(turn, /safeResumeAction/);
    assert.match(turn, /maka-turn-failed-resume/);
    assert.match(turn, /安全恢复/);
  });

  it('main plans from authoritative state and streams only an approved latest continuation', async () => {
    const main = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/main/main.ts'), 'utf8');
    const handler = main.match(/ipcMain\.handle\('sessions:resumeLatest'[\s\S]*?\n  \}\);/)?.[0] ?? '';

    assert.match(handler, /runtime\.planLatestAuthoritativeSafeBoundaryContinuation\(sessionId\)/);
    assert.match(handler, /if \(!plan\.continuation\)/);
    assert.match(handler, /runtime\.resumeSafeBoundaryContinuation\(plan\.continuation\)/);
    assert.match(handler, /streamEvents\(sessionId, iterator, plan\.continuation\.turnId\)/);
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
    assert.match(recovery, /streamEvents\(session\.id, iterator, plan\.continuation\.turnId\)/);
  });
});
