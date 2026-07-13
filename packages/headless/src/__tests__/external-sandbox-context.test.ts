import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  EXTERNAL_HEADLESS_EXECUTION_FACTS,
  externalPermissionProfileForIsolation,
} from '../external-sandbox-context.js';
import { buildIsolatedHeadlessTools } from '../tools.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

describe('external headless sandbox context', () => {
  test('maps explicit external isolation to PermissionProfile.External', () => {
    assert.equal(externalPermissionProfileForIsolation(undefined), undefined);
    assert.deepEqual(externalPermissionProfileForIsolation({
      kind: 'external',
      label: 'test container',
    }), {
      type: 'external',
      name: 'external',
      network: { kind: 'enabled' },
    });
  });

  test('marks all isolated shell and file tools as externally sandboxed', () => {
    const tools = buildIsolatedHeadlessTools({
      exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    });

    for (const name of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.deepEqual(tool?.executionFacts, EXTERNAL_HEADLESS_EXECUTION_FACTS);
      assert.equal(tool?.sandboxRequirement, 'external');
    }
  });

  test('builds an external diagnostics snapshot from the isolated workspace', async () => {
    const source = await readFile(resolve(REPO_ROOT, 'packages/headless/src/harbor-cell.ts'), 'utf8');
    assert.match(source, /const externalCwd = context\.realBackendIsolation\?\.workspaceDir \?\? context\.workspaceDir/);
    assert.match(source, /buildSandboxDiagnosticsSnapshot\(\{[\s\S]*cwd: externalCwd,[\s\S]*workspaceRoots: \[externalCwd\],[\s\S]*profile: externalProfile/);
    assert.match(source, /sandboxDiagnosticsSnapshot,/);
    assert.doesNotMatch(source, /probeActiveSandboxCapabilities\(\{/);
  });
});
