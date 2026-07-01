import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, TOKENS_FILE, readAllRendererCss, stripCssComments } from './css-test-helpers.js';

async function readUiSource(): Promise<string> {
  return readFile(resolve(REPO_ROOT, 'packages/ui/src/ui.tsx'), 'utf8');
}

describe('issue #406 design-system governance contract', () => {
  it('does not ship decorative enter/exit primitives by default', async () => {
    const rendererCss = stripCssComments(await readAllRendererCss());
    const tokens = stripCssComments(await readFile(TOKENS_FILE, 'utf8'));
    const uiSources = stripCssComments([
      await readUiSource(),
      await readFile(resolve(REPO_ROOT, 'packages/ui/src/primitives/chat.tsx'), 'utf8'),
    ].join('\n')).replace(/\/\/.*$/gm, '');

    assert.equal((rendererCss.match(/@starting-style/g) ?? []).length, 0);
    assert.equal((tokens.match(/@starting-style/g) ?? []).length, 0);
    assert.equal((uiSources.match(/data-(?:starting|ending)-style/g) ?? []).length, 0);
    assert.equal((uiSources.match(/maka-tool-card-enter/g) ?? []).length, 0);
  });

  it('maps primary to foreground while keeping accent for control state', async () => {
    const styles = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/styles.css'), 'utf8');
    assert.match(styles, /--color-primary:\s*var\(--foreground\);/);
    assert.match(styles, /--color-primary-foreground:\s*var\(--background\);/);
    assert.doesNotMatch(styles, /--color-primary:\s*var\(--accent\);/);

    const ui = await readUiSource();
    assert.match(ui, /default:\s*'bg-primary text-primary-foreground/);
    assert.match(ui, /data-\[checked\]:bg-accent/);
    assert.match(ui, /<BaseProgress\.Indicator className="[^"]*bg-accent/);
  });

  it('uses the single radius token vocabulary', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    for (const token of ['--radius-control: 6px', '--radius-surface: 8px', '--radius-modal: 12px', '--radius-pill: 999px']) {
      assert.ok(tokens.includes(token), `${token} must be defined in maka-tokens.css`);
    }

    const styles = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/styles.css'), 'utf8');
    assert.match(styles, /--radius-sm:\s*var\(--radius-control\);/);
    assert.match(styles, /--radius-md:\s*var\(--radius-surface\);/);
    assert.match(styles, /--radius-lg:\s*var\(--radius-surface\);/);
    assert.match(styles, /--radius-xl:\s*var\(--radius-modal\);/);
  });

  it('keeps core visual surfaces on shadow rings instead of hard borders', async () => {
    const ui = await readUiSource();
    const dialogClass = ui.match(/className=\{cn\(\s*'([^']*shadow-maka-panel[^']*)'/)?.[1] ?? '';
    const selectClass = ui.match(/SelectPopup[\s\S]*?className=\{cn\('([^']*shadow-maka-panel[^']*)'/)?.[1] ?? '';

    for (const [name, className] of [['DialogPopup', dialogClass], ['SelectPopup', selectClass]] as const) {
      assert.ok(className.includes('shadow-maka-panel'), `${name} must keep the shadow-ring recipe`);
      assert.ok(!/\bborder\b|\bborder-border\b/.test(className), `${name} must not use a hard visual border`);
    }

    const chat = await readFile(resolve(REPO_ROOT, 'packages/ui/src/primitives/chat.tsx'), 'utf8');
    assert.ok(chat.includes('[box-shadow:var(--shadow-minimal-flat)]'));
    assert.ok(!chat.includes('[animation:maka-tool-card-enter_350ms_var(--ease-out-strong)_both]'));
  });
});
