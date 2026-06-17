import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildLoadTool, LOAD_TOOL_NAME, type DeferredToolCatalog } from '../load-tool.js';
import type { MakaToolContext } from '../tool-runtime.js';

const catalog: DeferredToolCatalog = [
  {
    namespace: 'browser',
    summary: 'Drive the in-app browser (navigate, click, type, read pages).',
    toolNames: ['browser_navigate', 'browser_click', 'browser_type'],
  },
  {
    namespace: 'rive',
    summary: 'Build and edit Rive animation workflows.',
    toolNames: ['RiveWorkflow'],
  },
];

function ctx(): MakaToolContext {
  return {
    sessionId: 's',
    turnId: 't',
    cwd: '/',
    toolCallId: 'c',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}

describe('load_tool', () => {
  test('is named load_tool, stays direct, and lists every namespace card in its description', () => {
    const t = buildLoadTool(catalog);
    assert.equal(t.name, LOAD_TOOL_NAME);
    assert.notEqual(t.exposure, 'deferred'); // the catalog tool itself is never deferred
    assert.match(t.description, /browser/);
    assert.match(t.description, /rive/);
    assert.match(t.description, /Drive the in-app browser/);
    assert.match(t.description, /Build and edit Rive/);
  });

  test('loading a namespace returns exactly its tool names (thin result, no schema)', async () => {
    const t = buildLoadTool(catalog);
    const result = await t.impl({ namespace: 'browser' }, ctx());
    assert.deepEqual(result, { loaded: ['browser_navigate', 'browser_click', 'browser_type'] });
    const keys = Object.keys(result as object);
    assert.ok(!keys.includes('schema'), 'must not return a JSON schema');
    assert.ok(!keys.includes('parameters'), 'must not return parameters');
    assert.ok(!keys.includes('inputSchema'), 'must not return an input schema');
  });

  test('an unknown namespace is rejected with the available groups listed', async () => {
    const t = buildLoadTool(catalog);
    await assert.rejects(
      async () => t.impl({ namespace: 'nope' } as never, ctx()),
      /Unknown tool group.*browser.*rive/s,
    );
  });

  test('loading does not itself require a permission prompt', () => {
    const t = buildLoadTool(catalog);
    assert.equal(t.permissionRequired, false);
  });
});
