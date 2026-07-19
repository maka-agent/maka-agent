import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererContractCss } from './contract-css-helpers.js';

const repoRoot = resolve(process.cwd(), '..', '..');

describe('sidebar extensions tree contract', () => {
  it('renders Extensions as a disclosure with only Skills and MCP children', async () => {
    const source = await readFile(
      resolve(repoRoot, 'packages/ui/src/session-sidebar-nav.tsx'),
      'utf8',
    );

    assert.match(source, /aria-expanded=\{extensionsOpen\}/);
    assert.match(source, /aria-controls=\{extensionsTreeId\}/);
    assert.match(source, /className="maka-sidebar-nav-tree"/);
    assert.match(source, /hidden=\{!extensionsOpen\}/);
    assert.match(source, /maka-nav-extension-hover-icon/);
    assert.match(source, /moduleNavLabel\.skills/);
    assert.match(source, /moduleNavLabel\.mcp/);
    assert.doesNotMatch(source, /专家套件|连接器/);
  });

  it('uses a hairline tree guide and an expanded state surface', async () => {
    const css = await readRendererContractCss();

    assert.match(
      css,
      /\.maka-nav-extension-toggle\[data-expanded="true"\]\s*\{[^}]*background:\s*var\(--state-selected-bg\)/s,
    );
    assert.match(
      css,
      /\.maka-sidebar-nav-tree\s*\{[^}]*border-left:\s*var\(--border-width-hairline\)\s+solid\s+var\(--border\)/s,
    );
    assert.match(
      css,
      /\.maka-nav-extension-toggle:not\(\[data-expanded="true"\]\):is\(:hover, :focus-visible\) \.maka-nav-extension-hover-icon/s,
    );
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
