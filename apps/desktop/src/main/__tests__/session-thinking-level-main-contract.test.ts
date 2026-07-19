import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

async function readMainSource(): Promise<string> {
  return readMainProcessCombinedSource();
}

function extractIpcHandler(source: string, channel: string): string {
  const marker = `ipcMain.handle('${channel}'`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${channel} handler must exist`);
  const next = source.indexOf("ipcMain.handle('", start + marker.length);
  return source.slice(start, next === -1 ? undefined : next);
}

describe('session thinking-level main IPC contract', () => {
  it('generates titles with the sticky session model and emits the existing rename event', async () => {
    const main = await readMainSource();

    assert.match(
      main,
      /generateSessionTitle: async \(\{ sessionId, header, sourceText \}\) => \{[\s\S]*getReadyConnection\(header\.llmConnectionSlug, header\.model\)/,
    );
    assert.match(main, /providerOptions: buildProviderOptions\(connection, model\)/);
    assert.doesNotMatch(main, /generateSessionTitle:[\s\S]{0,1200}thinkingLevel/);
    assert.match(main, /onSessionTitleChanged: \(sessionId\) => emitSessionsChanged\('renamed', sessionId\)/);
  });

  it('creates first-message Desktop sessions with the canonical default title', async () => {
    const chatActions = await readFile(
      resolve(REPO_ROOT, 'apps/desktop/src/renderer/app-shell-chat-actions.ts'),
      'utf8',
    );

    assert.match(chatActions, /window\.maka\.sessions\.create\(\{[\s\S]*?name: DEFAULT_SESSION_NAME/);
    assert.doesNotMatch(chatActions, /name: text\.slice\(0, 42\)/);
  });

  it('validates new-chat thinkingLevel against the ready provider/model before persisting it', async () => {
    const main = await readMainSource();
    const createHandler = extractIpcHandler(main, 'sessions:create');

    assert.match(main, /thinkingVariantsForModel/, 'main must use the model metadata, not only enum validation');
    assert.match(main, /function normalizeSupportedSessionThinkingLevel\(/, 'create and update IPC should share one thinking-level validator');
    assert.match(
      main,
      /thinkingVariantsForModel\(providerType, model\)\.includes\(thinkingLevel\)/,
      'the validator must reject levels unsupported by the current provider/model',
    );
    assert.match(
      createHandler,
      /const \{ connection, model \} = await getReadyConnection\(requestedSlug, input\?\.model\);[\s\S]*const thinkingLevel = normalizeSupportedSessionThinkingLevel\(input\?\.thinkingLevel, connection\.providerType, model\);/,
      'sessions:create must validate the requested thinkingLevel after resolving the ready model',
    );
    assert.match(
      createHandler,
      /createSession\(\{[\s\S]*model,[\s\S]*\.\.\.\(thinkingLevel !== undefined \? \{ thinkingLevel \} : \{\}\),/,
      'sessions:create must persist the supported thinkingLevel into the session header so the first turn providerOptions use it',
    );
    assert.match(
      main,
      /buildProviderOptions\(connection, model, ctx\.header\.thinkingLevel\)/,
      'send path must derive providerOptions from the session header thinkingLevel',
    );
  });

  it('validates sessions:setThinkingLevel against the current session provider/model before update', async () => {
    const main = await readMainSource();
    const setHandler = extractIpcHandler(main, 'sessions:setThinkingLevel');

    assert.match(
      setHandler,
      /const connection = await connectionStore\.get\(header\.llmConnectionSlug\);/,
      'setThinkingLevel must read the current session connection before validation',
    );
    assert.match(
      setHandler,
      /const nextThinkingLevel = normalizeSupportedSessionThinkingLevel\(input, connection\.providerType, header\.model\);/,
      'setThinkingLevel must share the create-path validator without requiring credential readiness',
    );
    assert.match(
      setHandler,
      /runtime\.updateSession\(sessionId, nextThinkingLevel === undefined \? \{ thinkingLevel: undefined \} : \{ thinkingLevel: nextThinkingLevel \}\)/,
      'unsupported levels must not be written into the session header',
    );
  });
});
