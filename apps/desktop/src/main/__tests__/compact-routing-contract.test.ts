import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererShellSource } from './renderer-shell-source-helpers.js';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

// Characterization tests pinning the /compact routing across the desktop
// boundary, so a future change cannot silently drop the interception and send
// the literal "/compact" text to the model. Follows the repo's source-matching
// contract style (see session-open-routing-contract.test.ts).
describe('/compact routing contract', () => {
  it('renderer intercepts exact /compact and routes to sessions.compact, never send', async () => {
    const shell = await readRendererShellSource('app-shell.tsx');
    const send = shell.match(/async function sendWithAttachments\(text: string\): Promise<boolean \| void> \{[\s\S]*?\n  \}/)?.[0] ?? '';

    // exact /compact (after trim) is the only trigger
    assert.match(send, /if \(text\.trim\(\) === '\/compact'\) \{/);
    // routes to compact only when an active session exists — the no-active-session guard
    assert.match(send, /const sessionId = activeIdRef\.current;/);
    assert.match(send, /if \(!sessionId\) return true;/);
    assert.match(send, /await window\.maka\.sessions\.compact\(sessionId\);/);
    assert.match(
      send,
      /catch \(error\) \{[\s\S]*if \(activeIdRef\.current !== sessionId\) return false;[\s\S]*isSessionWorkspaceUnavailableError\(error\)[\s\S]*showSessionWorkspaceUnavailableToast\(toastApi, uiLocale\)[\s\S]*return false;/,
      'compact failures must be consumed by the shell and preserve workspace recovery copy',
    );
    // returns early so /compact never falls through to the normal send path
    assert.match(send, /return true;/);
    // non-compact text still goes through the normal send path
    assert.match(send, /const ok = await send\(text, pending\);/);
  });

  it('main sessions:compact IPC drives runtime.compactSession via streamEvents', async () => {
    const main = await readMainProcessCombinedSource();
    const handler = main.match(/ipcMain\.handle\('sessions:compact'[\s\S]*?\n  \}\);/)?.[0] ?? '';

    assert.match(handler, /await ensureSessionCanSend\(sessionId\);/);
    assert.match(handler, /runtime\.compactSession\(sessionId, \{ turnId \}\)/);
    assert.match(handler, /streamEvents\(sessionId, runtime\.compactSession/);
  });

  it('preload exposes compact() bound to the sessions:compact IPC', async () => {
    const preload = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/preload/preload.ts'), 'utf8');
    const compact = preload.match(/compact\(sessionId: string\): Promise<void> \{[\s\S]*?\n    \}/)?.[0] ?? '';

    assert.match(compact, /ipcRenderer\.invoke\('sessions:compact', sessionId\)/);
  });
});
