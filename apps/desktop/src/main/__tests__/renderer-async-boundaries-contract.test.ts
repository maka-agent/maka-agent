import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const CHAT_MODEL_SWITCHER_PATH = resolve(REPO_ROOT, 'packages', 'ui', 'src', 'chat-model-switcher.tsx');
const SESSION_LIST_PANEL_PATH = resolve(REPO_ROOT, 'packages', 'ui', 'src', 'session-list-panel.tsx');

describe('renderer async action boundary contract', () => {
  it('keeps chat model switching on a rejection-safe local async boundary', async () => {
    const source = await readFile(CHAT_MODEL_SWITCHER_PATH, 'utf8');

    assert.match(source, /runAsyncActionBoundary/, 'ChatModelSwitcher must use the shared async boundary helper');
    assert.doesNotMatch(
      source,
      /\.then\(\(\) => props\.onChange\?\.\(next\)\)\s*\.finally\(/,
      'model switching must not chain the action promise directly into finally without a rejection boundary',
    );
  });

  it('keeps session row actions on a rejection-safe local async boundary', async () => {
    const source = await readFile(SESSION_LIST_PANEL_PATH, 'utf8');

    assert.match(source, /runAsyncActionBoundary/, 'SessionRow actions must use the shared async boundary helper');
    assert.doesNotMatch(
      source,
      /Promise\.resolve\(\)\.then\(action\)\.finally\(/,
      'session row actions must not chain action promises directly into finally without a rejection boundary',
    );
  });
});
