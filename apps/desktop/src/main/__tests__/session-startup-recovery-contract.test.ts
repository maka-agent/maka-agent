import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const REPO_ROOT = new URL('../../../../..', import.meta.url).pathname;

describe('session startup recovery contract', () => {
  it('runtime exposes interrupted-session recovery for persisted running turns', async () => {
    const src = await readFile(join(REPO_ROOT, 'packages/runtime/src/session-manager.ts'), 'utf8');

    assert.match(src, /async recoverInterruptedSessions\(\): Promise<string\[\]>/);
    assert.match(src, /session\.status !== 'archived'/);
    assert.match(src, /latest\.status === 'running'/);
    assert.match(src, /if \(recoveries\.length === 0\) continue;/);
    assert.match(src, /errorClass: 'app_restarted'/);
    assert.match(src, /session\.status === 'running' \|\| session\.status === 'waiting_for_user'/);
    assert.match(src, /latest\.status === 'completed' && !bucket\.hasAssistant && failed/);
  });

  it('desktop runs recovery before creating the renderer window', async () => {
    const src = await readFile(join(REPO_ROOT, 'apps/desktop/src/main/main.ts'), 'utf8');
    const startupBlock = src.match(/app\.whenReady\(\)\.then\(async \(\) => \{[\s\S]*?await mainWindowController\.createWindow\(\);/)?.[0] ?? '';

    assert.match(src, /async function recoverInterruptedSessionsOnStartup\(\): Promise<void>/);
    assert.match(startupBlock, /await recoverInterruptedSessionsOnStartup\(\);[\s\S]*await mainWindowController\.createWindow\(\);/);
  });

  it('turn summary only shows in-progress for genuinely running turns', async () => {
    const src = await readFile(join(REPO_ROOT, 'packages/ui/src/chat-view.tsx'), 'utf8');

    assert.match(src, /const inProgress = turn\.status === 'running' && turn\.user !== undefined && turn\.assistant === undefined;/);
  });
});
