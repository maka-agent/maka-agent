import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

describe('desktop sandbox diagnostics assembly contract', () => {
  test('builds diagnostics from the same session context and capability probe as tools', async () => {
    const source = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/main/main.ts'), 'utf8');
    const assembly = source.match(
      /async function buildSessionToolAssembly\([\s\S]*?\n\}\nconst buildDesktopChildTools/,
    )?.[0];
    assert.ok(assembly, 'desktop session tool assembly must remain explicit');
    assert.match(assembly, /buildPermissionAwareBuiltinTools\(\{/);
    assert.match(assembly, /probeActiveSandboxCapabilities\(\{[\s\S]*context: permissionAware\.sandboxContext/);
    assert.match(assembly, /buildSandboxDiagnosticsSnapshot\(\{[\s\S]*context: permissionAware\.sandboxContext,[\s\S]*capabilities: sandboxCapabilities/);
    assert.match(assembly, /sandboxDiagnosticsSnapshot/);
  });

  test('rebuilds child diagnostics from the active child header instead of inheriting a parent snapshot', async () => {
    const source = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/main/main.ts'), 'utf8');
    assert.match(source, /const sessionToolAssembly = await buildSessionToolAssembly\(ctx\.header, ctx\.tools\);/);
    assert.match(source, /sandboxDiagnosticsSnapshot: sessionToolAssembly\.sandboxDiagnosticsSnapshot/);
    assert.doesNotMatch(source, /parentSandboxDiagnosticsSnapshot/);
  });
});
