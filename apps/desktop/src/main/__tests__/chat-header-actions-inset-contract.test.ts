import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { CONTRACT_REPO_ROOT, readRendererContractCss } from './contract-css-helpers.js';

const CHAT_HEADER_TOOLBAR_CLEARANCE_PX = 12;

// --space-* token → px equivalent (mirrors maka-tokens.css, kept in sync
// by the spacing-converge-contract token-value pinning test).
const SPACE_TOKEN_PX: Record<string, number> = {
  '--space-0-5': 2,
  '--space-1': 4,
  '--space-1-5': 6,
  '--space-2': 8,
  '--space-2-5': 10,
  '--space-3': 12,
  '--space-4': 16,
  '--space-5': 20,
  '--space-6': 24,
  '--space-8': 32,
  '--space-10': 40,
  '--space-12': 48,
  '--space-16': 64,
};

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`).exec(css);
  assert.ok(match, `${selector} rule should exist`);
  return match[1] ?? '';
}

function pxDeclaration(body: string, property: string): number {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Accept bare Npx (legacy) or var(--space-N) token (#430 PR3).
  const bareMatch = new RegExp(`${escaped}:\\s*(\\d+)px\\s*;`).exec(body);
  if (bareMatch) return Number(bareMatch[1]);
  const tokenMatch = new RegExp(`${escaped}:\\s*var\\((--space-[\\w-]+)\\)\\s*;`).exec(body);
  assert.ok(tokenMatch, `${property} should be a px or var(--space-*) declaration`);
  const tok = tokenMatch[1]!;
  assert.ok(tok in SPACE_TOKEN_PX, `${tok} should be in the SPACE_TOKEN_PX map`);
  return SPACE_TOKEN_PX[tok]!;
}

function workspaceTopActionsInsetAddend(css: string): number {
  const match = /--maka-workspace-top-actions-inset:\s*calc\(\s*var\(--maka-workspace-top-actions-right\)\s*\+\s*(\d+)px\s*\)\s*;/.exec(css);
  assert.ok(match, '--maka-workspace-top-actions-inset should add a px toolbar footprint');
  return Number(match[1]);
}

async function workspaceTopActionButtonCount(): Promise<number> {
  const source = await readFile(join(CONTRACT_REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'app-shell-chrome-actions.tsx'), 'utf8');
  const start = source.indexOf('export function AppShellWorkspaceTopActions');
  assert.notEqual(start, -1, 'AppShellWorkspaceTopActions should exist');
  const block = source.slice(start);
  return [...block.matchAll(/render=\{<UiButton variant="quiet" size="icon-sm"(?: disabled=\{[^}]+\})? \/>\}/g)].length;
}

describe('chat header actions inset contract', () => {
  // Companion to session-health-notice-layout-contract (#1032 removed the
  // header status cluster). The in-header mode pill (.maka-chat-header-mode-pill)
  // still flows underneath the absolutely-positioned .maka-workspace-top-actions
  // toolbar in the top-right corner. The header must reserve horizontal space
  // for that toolbar.
  it('derives the toolbar inset token from the shared right baseline', async () => {
    const css = await readRendererContractCss();
    assert.match(
      css,
      /--maka-workspace-top-actions-inset:\s*calc\(\s*var\(--maka-workspace-top-actions-right\)/,
      'the inset token should extend the shared toolbar right baseline, not hardcode an unrelated value',
    );
  });

  it('uses Electron titlebar horizontal safe-area env vars for native Windows overlay avoidance', async () => {
    const css = await readRendererContractCss();
    assert.doesNotMatch(
      css,
      /\[data-platform=["']win32["']\]/,
      'Windows titlebar avoidance should not depend on a renderer platform attribute',
    );
    assert.doesNotMatch(
      css,
      /\b138px\b/,
      'Windows titlebar avoidance should not hard-code the native control width',
    );
    assert.match(css, /--maka-titlebar-area-x:\s*env\(titlebar-area-x,\s*0px\)\s*;/);
    assert.match(css, /--maka-titlebar-area-width:\s*env\(titlebar-area-width,\s*100vw\)\s*;/);
    assert.match(
      css,
      /--maka-titlebar-overlay-right-width:\s*max\(\s*0px,\s*calc\(100vw - var\(--maka-titlebar-area-x\) - var\(--maka-titlebar-area-width\)\s*\)\s*\)\s*;/,
      'right-side native control width should be derived from the titlebar safe-area x/width pair',
    );
  });

  it('sizes the inset from the toolbar buttons, gaps, and clearance', async () => {
    const css = await readRendererContractCss();
    const buttonCount = await workspaceTopActionButtonCount();
    const toolbarBody = ruleBody(css, '.maka-workspace-top-actions');
    const buttonSize = 28;
    const gap = pxDeclaration(toolbarBody, 'gap');
    const insetAddend = workspaceTopActionsInsetAddend(css);

    assert.equal(buttonCount, 5, 'current top-actions toolbar renders five icon buttons');
    assert.equal(buttonSize, 28, 'top-actions use the governed compact Button tier');
    assert.equal(gap, 6, 'top-actions icon buttons use a 6px gap');
    assert.equal(
      insetAddend,
      (buttonCount * buttonSize) + ((buttonCount - 1) * gap) + CHAT_HEADER_TOOLBAR_CLEARANCE_PX,
      'the chat-header inset addend must match the rendered toolbar footprint plus 12px clearance',
    );
  });

  it('reserves the toolbar inset by ending the chat-header drag box before the actions', async () => {
    const css = await readRendererContractCss();
    const body = ruleBody(css, '.maka-chat-header');
    assert.match(
      body,
      /margin-right:\s*var\(--maka-workspace-top-actions-inset\)/,
      '.maka-chat-header must reserve --maka-workspace-top-actions-inset in its box geometry so the drag region does not cover .maka-workspace-top-actions',
    );
    assert.match(
      body,
      /padding:\s*0\s+var\(--space-2-5\)\s*;/,
      'after margin-right reserves the toolbar footprint, the header can keep compact symmetric padding for its own content',
    );
  });
});
