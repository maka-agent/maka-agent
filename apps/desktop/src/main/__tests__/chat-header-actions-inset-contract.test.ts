import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { CONTRACT_REPO_ROOT, readRendererContractCss } from './contract-css-helpers.js';

const CHAT_HEADER_TOOLBAR_CLEARANCE_PX = 12;

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`).exec(css);
  assert.ok(match, `${selector} rule should exist`);
  return match[1] ?? '';
}

function pxDeclaration(body: string, property: string): number {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}:\\s*(\\d+)px\\s*;`).exec(body);
  assert.ok(match, `${property} should be a px declaration`);
  return Number(match[1]);
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
  return [...block.matchAll(/className="maka-workspace-icon-action"/g)].length;
}

describe('chat header actions inset contract', () => {
  // Companion to chat-status-cluster-layout-contract: PR-CHAT-HEADER-STATUS-CLUSTER-0
  // only relocated the status badge cluster. The in-header mode pill
  // (.maka-chat-header-mode-pill) and model switcher still flowed underneath the
  // absolutely-positioned .maka-workspace-top-actions toolbar in the top-right
  // corner. The header must reserve horizontal space for that toolbar.
  it('derives the toolbar inset token from the shared right baseline', async () => {
    const css = await readRendererContractCss();
    assert.match(
      css,
      /--maka-workspace-top-actions-inset:\s*calc\(\s*var\(--maka-workspace-top-actions-right\)/,
      'the inset token should extend the shared toolbar right baseline, not hardcode an unrelated value',
    );
  });

  it('sizes the inset from the toolbar buttons, gaps, and clearance', async () => {
    const css = await readRendererContractCss();
    const buttonCount = await workspaceTopActionButtonCount();
    const toolbarBody = ruleBody(css, '.maka-workspace-top-actions');
    const iconBody = ruleBody(css, '.maka-workspace-icon-action');

    const buttonWidth = pxDeclaration(iconBody, 'width');
    const buttonHeight = pxDeclaration(iconBody, 'height');
    const gap = pxDeclaration(toolbarBody, 'gap');
    const insetAddend = workspaceTopActionsInsetAddend(css);

    assert.equal(buttonCount, 4, 'current top-actions toolbar renders four icon buttons');
    assert.equal(buttonWidth, 24, 'top-actions icon buttons are 24px wide');
    assert.equal(buttonHeight, buttonWidth, 'top-actions icon buttons should stay square');
    assert.equal(gap, 6, 'top-actions icon buttons use a 6px gap');
    assert.equal(
      insetAddend,
      (buttonCount * buttonWidth) + ((buttonCount - 1) * gap) + CHAT_HEADER_TOOLBAR_CLEARANCE_PX,
      'the chat-header inset addend must match the rendered toolbar footprint plus 12px clearance',
    );
  });

  it('reserves the toolbar inset as chat-header right padding', async () => {
    const css = await readRendererContractCss();
    const body = ruleBody(css, '.maka-chat-header');
    assert.match(
      body,
      /padding:[^;]*var\(--maka-workspace-top-actions-inset\)/,
      '.maka-chat-header must reserve --maka-workspace-top-actions-inset as right padding so right-aligned content does not render under .maka-workspace-top-actions',
    );
    assert.doesNotMatch(
      body,
      /padding:\s*0\s+10px\s*;/,
      'the header should no longer use the pre-fix symmetric 10px padding that let pills overlap the toolbar',
    );
  });
});
