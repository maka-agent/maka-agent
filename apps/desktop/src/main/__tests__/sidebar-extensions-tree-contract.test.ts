import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const repoRoot = resolve(process.cwd(), '..', '..');

describe('sidebar extensions tree contract', () => {
  it('keeps Skills and MCP out of app navigation and exposes them as settings peers', async () => {
    const source = await readFile(
      resolve(repoRoot, 'packages/ui/src/session-sidebar-nav.tsx'),
      'utf8',
    );

    assert.doesNotMatch(source, /extensionsOpen|extensionsTreeId|maka-sidebar-nav-tree/);
    assert.doesNotMatch(source, /moduleNavLabel\.mcp/);
    assert.doesNotMatch(source, /moduleNavLabel\.skills/);
    assert.doesNotMatch(source, /专家套件|连接器/);

    const settingsSource = await readFile(
      resolve(repoRoot, 'apps/desktop/src/renderer/settings/settings-nav.ts'),
      'utf8',
    );
    assert.match(settingsSource, /id:\s*'skills'/);
    assert.match(settingsSource, /id:\s*'mcp'/);
  });

  it('hides only session grouping on module pages and preserves history', async () => {
    const source = await readFile(
      resolve(repoRoot, 'packages/ui/src/session-list-panel.tsx'),
      'utf8',
    );

    assert.match(source, /showSessionNavigation\s*=\s*props\.selection\.section\s*===\s*'sessions'/);
    assert.match(source, /showSessionNavigation\s*&&\s*onViewModeChange/);
    assert.match(source, /<SessionHistoryList/);
    assert.doesNotMatch(source, /showSessionNavigation\s*\?\s*\(\s*<SessionHistoryList/s);
    assert.match(source, /data-content=\{showSessionNavigation\s*\?\s*'sessions'\s*:\s*'module'\}/);
  });
});
