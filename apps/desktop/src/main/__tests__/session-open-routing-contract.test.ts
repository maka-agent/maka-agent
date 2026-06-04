import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

describe('session open routing contract', () => {
  it('centralizes cross-module session opens through the chat surface', async () => {
    const main = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/main.tsx'), 'utf8');
    const helper = main.match(/function openSessionInChat\(sessionId: string, turnId\?: string\): void \{[\s\S]*?\n  \}/)?.[0] ?? '';

    assert.match(helper, /setNavSelection\(\{ section: 'sessions', filter: 'chats' \}\);/);
    assert.match(helper, /setActiveId\(sessionId\);/);
    assert.match(helper, /setSearchScrollTarget\(\{ sessionId, turnId, nonce: Date\.now\(\) \}\);/);
    assert.match(helper, /setSearchScrollTarget\(null\);/);
  });

  it('does not pass raw setActiveId to module session links', async () => {
    const main = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/main.tsx'), 'utf8');

    assert.doesNotMatch(
      main,
      /<ChatView[\s\S]*?onSelectSession=\{setActiveId\}/,
      'Daily Review session buttons live inside ChatView module mode and must route back to the chat surface',
    );
    assert.match(
      main,
      /<ChatView[\s\S]*?onSelectSession=\{openSessionInChat\}/,
      'Daily Review session buttons must use the shell-level session open helper',
    );
  });

  it('binds branched sessions before refreshing the sidebar list', async () => {
    const main = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/main.tsx'), 'utf8');
    const branchBlock = main.match(/else if \(actionId === 'branch'\) \{[\s\S]*?toastApi\.success/)?.[0] ?? '';

    assert.match(branchBlock, /const newSession = await window\.maka\.sessions\.branchFromTurn/);
    assert.match(branchBlock, /openSessionInChat\(newSession\.id\);/);
    assert.match(branchBlock, /upsertSessionSummary\(newSession\);/);
    assert.match(branchBlock, /setMessages\(\[\]\);/);
    assert.match(branchBlock, /await refreshMessages\(newSession\.id\);/);
    assert.match(branchBlock, /await refreshSessions\(\);/);
    assert.doesNotMatch(
      branchBlock,
      /await refreshSessions\(\);[\s\S]*setActiveId\(newSession\.id\)/,
      'branch navigation must not wait for sidebar refresh before binding the newly created session',
    );
  });

  it('new-chat navigation does not wipe other sessions live renderer state', async () => {
    const main = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/main.tsx'), 'utf8');
    const createSession = main.match(/async function createSession\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';

    assert.match(createSession, /setActiveId\(undefined\);/);
    assert.match(createSession, /setNavSelection\(\{ section: 'sessions', filter: 'chats' \}\);/);
    assert.match(createSession, /setSearchScrollTarget\(null\);/);
    assert.match(createSession, /setMessages\(\[\]\);/);
    assert.doesNotMatch(
      createSession,
      /setStreamingBySession\(\{\}\)|setLiveToolsBySession\(\{\}\)|setPermissionBySession\(\{\}\)/,
      'new chat should clear only the current empty chat surface, not wipe live state for other running sessions',
    );
  });
});
