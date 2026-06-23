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

  it('opens branched sessions only while the source session is still active', async () => {
    const main = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/main.tsx'), 'utf8');
    const handlerBlock = main.match(/async function handleTurnFooterAction[\s\S]*?const chatSessionStatusBadge/)?.[0] ?? '';
    const branchBlock = handlerBlock.match(/else if \(actionId === 'branch'\) \{[\s\S]*?await refreshSessions\(\);[\s\S]*?\n      \}/)?.[0] ?? '';
    const catchBlock = handlerBlock.match(/catch \(error\) \{([\s\S]*?)\n    \} finally/)?.[1] ?? '';

    assert.match(handlerBlock, /const sessionId = activeIdRef\.current;/);
    assert.match(
      handlerBlock,
      /await window\.maka\.sessions\.retryTurn\(sessionId, \{ sourceTurnId: turnId \}\);[\s\S]*?if \(activeIdRef\.current === sessionId\) toastApi\.info\('已发起重试'/,
      'retry feedback must stay owned by the source session',
    );
    assert.match(
      handlerBlock,
      /await window\.maka\.sessions\.regenerateTurn\(sessionId, \{ sourceTurnId: turnId \}\);[\s\S]*?if \(activeIdRef\.current === sessionId\) toastApi\.info\('已发起重新生成'/,
      'regenerate feedback must stay owned by the source session',
    );
    assert.match(branchBlock, /const newSession = await window\.maka\.sessions\.branchFromTurn/);
    assert.match(branchBlock, /upsertSessionSummary\(newSession\);/);
    assert.match(
      branchBlock,
      /if \(activeIdRef\.current === sessionId\) \{[\s\S]*openSessionInChat\(newSession\.id\);[\s\S]*setMessages\(\[\]\);[\s\S]*await refreshMessages\(newSession\.id\);[\s\S]*toastApi\.success\('已创建分支', `新会话 \$\{newSession\.name\}`\);[\s\S]*\}/,
      'branch completion must not navigate or toast after the user leaves the source session',
    );
    assert.match(branchBlock, /await refreshSessions\(\);/);
    assert.doesNotMatch(
      branchBlock,
      /openSessionInChat\(newSession\.id\);[\s\S]*await refreshSessions\(\);[\s\S]*toastApi\.success/,
      'branch success feedback must be owned by the active source-session guard',
    );
    assert.match(
      handlerBlock,
      /catch \(error\) \{[\s\S]*if \(activeIdRef\.current === sessionId\) toastApi\.error\('操作失败', generalizedErrorMessageChinese\(error, '对话操作失败，请稍后重试。'\)\);[\s\S]*\} finally \{[\s\S]*clearPendingTurnAction\(key\);[\s\S]*\}/,
      'turn footer failures must not toast after the user leaves the source session',
    );
    assert.doesNotMatch(
      handlerBlock,
      /else if \(actionId === 'branch'\) \{[\s\S]*clearPendingTurnAction\(key\);[\s\S]*\}[\s\S]*catch \(error\)/,
      'pending turn actions must not be cleared only by the branch success path',
    );
    assert.doesNotMatch(
      catchBlock,
      /clearPendingTurnAction\(key\);/,
      'pending turn actions must not be cleared only by the error path',
    );
    assert.doesNotMatch(
      handlerBlock,
      /toastApi\.error\('操作失败', cleanErrorMessage\(error\)\)/,
      'turn footer action failures must not echo raw cleaned Error.message in visible toast feedback',
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
