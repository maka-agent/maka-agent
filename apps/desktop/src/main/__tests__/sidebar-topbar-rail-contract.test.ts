import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONTRACT_REPO_ROOT, readRendererContractCss } from './contract-css-helpers.js';

const SHELL_TOPBAR_CLEARANCE_PX = 8;

async function shellTopbarButtonCount(): Promise<number> {
  const source = await readFile(
    join(CONTRACT_REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'app-shell-chrome-actions.tsx'),
    'utf8',
  );
  const start = source.indexOf('export function AppShellTopbarActions');
  const end = source.indexOf('export function AppShellWorkspaceTopActions');
  assert.notEqual(start, -1, 'AppShellTopbarActions should exist');
  assert.notEqual(end, -1, 'AppShellWorkspaceTopActions should exist');
  const block = source.slice(start, end);
  return [...block.matchAll(/className="maka-shell-topbar-button"/g)].length;
}

describe('sidebar topbar rail geometry contract', () => {
  it('keeps expanded and collapsed shell controls on the shared titlebar geometry', async () => {
    const css = await readRendererContractCss();
    const buttonCount = await shellTopbarButtonCount();

    const tokenRule = extractRuleBody(css, '.maka-shell-2col');
    assert.ok(tokenRule, '.maka-shell-2col must define the shared topbar geometry tokens');
    for (const token of [
      '--maka-sidebar-topbar-button-size',
      '--maka-sidebar-topbar-gap',
      '--maka-sidebar-topbar-offset-y',
      '--maka-sidebar-topbar-offset-x',
      '--maka-sidebar-collapsed-topbar-inset',
    ]) {
      assert.match(tokenRule, new RegExp(`${escapeRegExp(token)}\\s*:`), `${token} must be defined once on the shell`);
    }
    const insetValue = customPropertyValue(tokenRule, '--maka-sidebar-collapsed-topbar-inset');
    assert.match(insetValue, /var\(--maka-sidebar-topbar-offset-x\)/);
    assert.equal(
      countMatches(insetValue, /var\(--maka-sidebar-topbar-button-size\)/g),
      buttonCount,
      'collapsed chat header drag strip must reserve the collapsed titlebar button footprint',
    );
    assert.equal(
      countMatches(insetValue, /var\(--maka-sidebar-topbar-gap\)/g),
      buttonCount - 1,
      'collapsed chat header drag strip must include the gaps between titlebar buttons',
    );
    assert.match(
      insetValue,
      new RegExp(`${SHELL_TOPBAR_CLEARANCE_PX}px`),
      'collapsed chat header drag strip must keep a small clearance after the titlebar buttons',
    );

    const shellRail = extractRuleBody(css, '.maka-shell-topbar-rail');
    assert.ok(shellRail, '.maka-shell-topbar-rail rule must exist');
    assert.match(shellRail, /top:\s*var\(--maka-sidebar-topbar-offset-y\)/);
    assert.match(shellRail, /left:\s*var\(--maka-sidebar-topbar-offset-x\)/);
    assert.match(shellRail, /gap:\s*var\(--maka-sidebar-topbar-gap\)/);
    assert.doesNotMatch(
      shellRail,
      /var\(--maka-session-list-width/,
      'shell controls must not move horizontally when the sidebar width changes',
    );

    const collapsedRail = extractRuleBody(css, '.maka-shell-topbar-rail.is-collapsed');
    assert.doesNotMatch(css, /--maka-sidebar-collapsed-topbar-offset-y/, 'do not reintroduce a below-titlebar collapsed rail offset');
    if (collapsedRail) {
      assert.doesNotMatch(
        collapsedRail,
        /top\s*:/,
        'collapsed shell controls must not get a special vertical offset; keep the rail visually in the titlebar and carve the drag strip instead',
      );
    }

    const shellButtons = extractRuleBody(css, '.maka-shell-topbar-button');
    assert.ok(shellButtons, 'shell rail buttons must share one rule');
    assert.match(shellButtons, /width:\s*var\(--maka-sidebar-topbar-button-size\)/);
    assert.match(shellButtons, /height:\s*var\(--maka-sidebar-topbar-button-size\)/);
  });

  it('keeps expanded top chrome in the titlebar while drag strips avoid the icon hit boxes', async () => {
    const css = await readRendererContractCss();

    assert.doesNotMatch(
      css,
      /--maka-titlebar-interactive-safe-center-y/,
      'do not move top chrome below the titlebar to dodge hit-test bugs; keep it on the titlebar baseline and carve drag regions away instead',
    );
    assert.match(
      css,
      /--maka-workspace-top-actions-top:\s*calc\(var\(--maka-titlebar-control-safe-top\)\s*-\s*17px\)/,
      'workspace top actions should stay aligned to the titlebar control baseline',
    );

    const shellTokens = extractRuleBody(css, '.maka-shell-2col');
    assert.ok(shellTokens, '.maka-shell-2col must define sidebar topbar geometry tokens');
    assert.match(
      shellTokens,
      /--maka-sidebar-topbar-offset-y:\s*calc\(var\(--maka-titlebar-control-safe-top\)\s*-\s*18px\)/,
      'sidebar topbar rail should stay aligned to the titlebar control baseline',
    );

    const sidebarHeader = extractRuleBody(css, '.maka-session-panel-header');
    assert.ok(sidebarHeader, '.maka-session-panel-header rule must exist');
    assert.doesNotMatch(
      sidebarHeader,
      /-webkit-app-region:\s*drag/,
      'the full sidebar header covers the titlebar buttons; only the narrowed drag strip should be draggable',
    );

    const sidebarDragStrip = extractRuleBody(css, '.maka-sidebar-drag-strip');
    assert.ok(sidebarDragStrip, '.maka-sidebar-drag-strip rule must exist');
    assert.match(
      sidebarDragStrip,
      /margin-left:\s*calc\(\s*var\(--maka-sidebar-topbar-offset-x\)\s*\+\s*var\(--maka-sidebar-topbar-button-size\)\s*\+\s*var\(--maka-sidebar-topbar-button-size\)\s*\+\s*var\(--maka-sidebar-topbar-gap\)\s*\+\s*8px\s*\)/,
      'the sidebar drag strip should start to the right of the two titlebar buttons',
    );

    const chatHeader = extractRuleBody(css, '.maka-chat-header');
    assert.ok(chatHeader, '.maka-chat-header rule must exist');
    const collapsedChatHeader = extractRuleBody(
      css,
      '.maka-shell-2col[data-sidebar-state="collapsed"] .maka-chat-header',
    );
    assert.ok(collapsedChatHeader, 'collapsed chat header rule must exist');
    assert.match(
      collapsedChatHeader,
      /margin-left:\s*var\(--maka-sidebar-collapsed-topbar-inset\)/,
      'when the sidebar is collapsed, the chat header drag strip must start after the left titlebar buttons',
    );
    assert.match(
      chatHeader,
      /-webkit-app-region:\s*drag/,
      'the chat header remains a narrow drag strip after reserving the toolbar hit box',
    );
  });
});

function extractRuleBody(css: string, selector: string | string[]): string | undefined {
  const expected = Array.isArray(selector) ? selector : [selector];
  for (const rule of iterateRules(css)) {
    const selectors = rule.selector.split(',').map((part) => part.trim());
    if (selectors.length === expected.length && expected.every((part) => selectors.includes(part))) {
      return rule.body;
    }
  }
  return undefined;
}

function customPropertyValue(body: string, property: string): string {
  const match = new RegExp(`${escapeRegExp(property)}:\\s*([\\s\\S]*?);`).exec(body);
  assert.ok(match, `${property} must be declared`);
  return match[1] ?? '';
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function* iterateRules(css: string): Generator<{ selector: string; body: string }> {
  let i = 0;
  while (i < css.length) {
    while (i < css.length && /\s/.test(css[i]!)) i += 1;
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2);
      if (end === -1) return;
      i = end + 2;
      continue;
    }
    const braceIdx = css.indexOf('{', i);
    if (braceIdx === -1) return;
    const selector = css.slice(i, braceIdx).trim();
    let depth = 1;
    let j = braceIdx + 1;
    while (j < css.length && depth > 0) {
      const ch = css[j];
      if (ch === '{') depth += 1;
      if (ch === '}') depth -= 1;
      j += 1;
    }
    if (selector && !selector.startsWith('@')) {
      yield { selector, body: css.slice(braceIdx + 1, j - 1) };
    }
    i = j;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
