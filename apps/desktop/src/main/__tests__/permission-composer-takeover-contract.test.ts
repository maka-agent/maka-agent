import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const rendererRoot = join(process.cwd(), 'src', 'renderer');

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.[\]/+*]/g, (character) => `\\${character}`);
  return css.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'))?.[1] ?? '';
}

describe('permission composer takeover', () => {
  it('keeps Composer mounted while the permission surface owns its slot', async () => {
    const appShell = await readFile(join(rendererRoot, 'app-shell.tsx'), 'utf8');
    const overlays = await readFile(join(rendererRoot, 'app-shell-overlays.tsx'), 'utf8');
    const composerBlock = appShell.match(/<Composer\s+ref=\{composerRef\}[\s\S]*?\/>/)?.[0] ?? '';

    assert.match(
      appShell,
      /className="maka-composer-interaction-slot"[\s\S]*?<PermissionPrompt/,
      'the permission prompt must render in the stable composer interaction slot',
    );
    assert.match(
      composerBlock,
      /hidden=\{[^}]*Boolean\(activePermission\)[^}]*\}/,
      'Composer must stay mounted and hide itself while permission owns the slot so its draft survives',
    );
    assert.doesNotMatch(
      composerBlock,
      /disabled=\{Boolean\(activePermission\)\}/,
      'permission takeover replaces the composer instead of leaving a disabled composer behind it',
    );
    assert.doesNotMatch(
      overlays,
      /Permission(Dialog|Prompt)/,
      'permission is an in-flow composer interaction, not a global overlay',
    );
  });

  it('renders a non-modal permission region with an always-visible Stop action', async () => {
    const appShell = await readFile(join(rendererRoot, 'app-shell.tsx'), 'utf8');
    const permissionSource = await readFile(
      join(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'permission-dialog.tsx'),
      'utf8',
    );
    const prompt = permissionSource.match(
      /export function PermissionPrompt[\s\S]*?function renderBrowserSummary/,
    )?.[0] ?? '';

    assert.doesNotMatch(prompt, /AlertDialog(Root|Content)/, 'the takeover must not enter the modal top layer');
    assert.match(prompt, /<section[\s\S]*?role="region"[\s\S]*?className="maka-permission-prompt composer"/);
    assert.match(prompt, /onStop\(\): void \| Promise<void>/);
    assert.match(prompt, /disabled=\{props\.stopPending\}/);
    assert.match(prompt, /props\.stopPending \? '停止中…' : '停止'/);
    assert.match(prompt, /const denyButtonRef = useRef<HTMLButtonElement>\(null\)/);
    assert.match(prompt, /denyButtonRef\.current\?\.focus\(\)/, 'focus must move from the hidden composer to the safe decision');
    assert.match(prompt, /ref=\{denyButtonRef\}[\s\S]*?submit\('deny'\)/);
    assert.match(
      appShell,
      /<PermissionPrompt[\s\S]*?onStop=\{stop\}[\s\S]*?stopPending=\{activeId \? stopPendingBySession\[activeId\] === true : false\}/,
      'the takeover must use the same stop owner and pending state as Composer',
    );
    assert.match(
      appShell,
      /const hasModalOpen = helpOpen \|\| paletteOpen \|\| searchModalOpen;/,
      'a permission prompt must not hide the live browser or make the workspace modal',
    );
  });

  it('uses the chat measure, compact composer geometry, and capped detail scrolling', async () => {
    const css = await readFile(join(rendererRoot, 'styles', 'permission-dialog.css'), 'utf8');
    const surface = ruleBody(css, '.maka-permission-prompt-inner');
    const detailPanel = ruleBody(css, '.maka-permission-raw [data-slot="collapsible-panel"]');
    const dangerNote = ruleBody(css, '.maka-permission-danger-note');
    const rawCode = ruleBody(css, '.maka-permission-raw .maka-code');

    assert.match(surface, /width:\s*min\(var\(--maka-chat-measure\), 100%\)/);
    assert.match(surface, /border:\s*var\(--border-width-hairline\) solid var\(--border\)/);
    assert.match(surface, /border-radius:\s*var\(--radius-surface\)/);
    assert.match(surface, /display:\s*grid/);
    assert.match(detailPanel, /max-height:\s*min\(60vh, 520px\)/);
    assert.match(detailPanel, /overflow:\s*auto/);
    assert.match(rawCode, /max-height:\s*min\(36vh, 280px\)/);
    assert.match(rawCode, /overflow:\s*auto/);
    assert.match(dangerNote, /border:\s*0/);
    assert.match(dangerNote, /background:\s*transparent/);
    assert.match(dangerNote, /padding:\s*0/);
    assert.doesNotMatch(css, /\.permissionDialog\b/, 'the old modal geometry must be removed');
  });

  it('keeps long previews and diffs inside the capped disclosure', async () => {
    const permissionSource = await readFile(
      join(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'permission-dialog.tsx'),
      'utf8',
    );
    const prompt = permissionSource.match(
      /export function PermissionPrompt[\s\S]*?function renderBrowserSummary/,
    )?.[0] ?? '';
    const summary = permissionSource.match(
      /function renderPermissionSummary[\s\S]*?function renderPermissionDetails/,
    )?.[0] ?? '';
    const details = permissionSource.match(
      /function renderPermissionDetails[\s\S]*?function permissionTextPreview/,
    )?.[0] ?? '';

    assert.match(
      prompt,
      /<Collapsible className="maka-permission-raw">[\s\S]*?<CollapsiblePanel>[\s\S]*?\{details[\s\S]*?formatRedactedJson[\s\S]*?<footer className="permissionActions">[\s\S]*?<CollapsibleTrigger>完整参数<\/CollapsibleTrigger>/,
      'expanded details grow above the footer while the trigger shares the compact control row',
    );
    assert.doesNotMatch(summary, /maka-permission-diff/, 'diffs do not belong in the compact summary');
    assert.match(details, /maka-permission-diff/, 'diffs remain inspectable in expanded details');
    assert.doesNotMatch(summary, /maka-permission-preview/, 'long content previews do not belong in the compact summary');
    assert.match(details, /maka-permission-preview/, 'long content previews remain inspectable in expanded details');
  });
});
