import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../../');

describe('AgentSwarm host registration contract', () => {
  test('desktop, CLI, and headless use the same parent Agent tool builder', async () => {
    const [desktop, cli, headless] = await Promise.all([
      readFile(resolve(REPO_ROOT, 'apps/desktop/src/main/main.ts'), 'utf8'),
      readFile(resolve(REPO_ROOT, 'packages/cli/src/runtime-bootstrap.ts'), 'utf8'),
      readFile(resolve(REPO_ROOT, 'packages/headless/src/tools.ts'), 'utf8'),
    ]);

    assert.match(
      desktop,
      /buildParentAgentTools\(\{\s*taskLedger: taskLedgerStore,\s*\}\)/,
    );
    assert.match(cli, /const subagentTools = input\.surface === 'tui'\s*\?\s*buildParentAgentTools\(\)/);
    assert.match(headless, /\.\.\.buildParentAgentTools\(\)/);

    for (const source of [desktop, cli, headless]) {
      assert.doesNotMatch(
        source,
        /buildAgentSwarmTool\(/,
        'hosts must consume the shared parent tool surface instead of forking AgentSwarm',
      );
    }
  });

  test('all hosts use the shared deferred Agent group contract', async () => {
    const [desktop, cli, headless] = await Promise.all([
      readFile(resolve(REPO_ROOT, 'apps/desktop/src/main/main.ts'), 'utf8'),
      readFile(resolve(REPO_ROOT, 'packages/cli/src/runtime-bootstrap.ts'), 'utf8'),
      readFile(resolve(REPO_ROOT, 'packages/headless/src/tools.ts'), 'utf8'),
    ]);

    assert.match(desktop, /buildSubagentToolGroup\(\)/);
    assert.match(cli, /groups: \[buildSubagentToolGroup\(\)\]/);
    assert.match(headless, /groups: \[buildSubagentToolGroup\(\)\]/);
  });
});
