import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const repoRoot = join(process.cwd(), '..', '..');

describe('renderer utility surfaces use shared UI primitives', () => {
  it('keeps browser chrome on Button/Input instead of raw form controls', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/browser-panel.tsx'), 'utf8');

    assert.match(source, /import \{ Button, Input \} from '@maka\/ui';/);
    assert.doesNotMatch(source, /<button\b/, 'BrowserPanel nav controls must use shared Button');
    assert.doesNotMatch(source, /<input\b/, 'BrowserPanel address bar must use shared Input');
  });

  it('keeps unsupported artifact preview CTA on Button without legacy classes', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/artifact-preview-registry-shell.tsx'), 'utf8');

    assert.match(source, /import \{ Button \} from '@maka\/ui';/);
    assert.doesNotMatch(source, /<button\b/, 'unsupported artifact preview CTA must use shared Button');
    assert.doesNotMatch(source, /className="maka-button/, 'artifact preview CTA must not keep legacy maka-button styling');
    assert.match(source, /<Button[\s\S]*variant="secondary"[\s\S]*className="maka-artifact-preview-unsupported-cta"/);
  });

  it('keeps artifact pane controls on shared Button primitives', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/artifact-pane.tsx'), 'utf8');

    assert.match(source, /import \{ Button, useToast \} from '@maka\/ui';/);
    assert.doesNotMatch(source, /<button\b/, 'ArtifactPane controls must use shared Button');
    for (const className of [
      'maka-artifact-pane-collapse',
      'maka-artifact-error-retry',
      'maka-artifact-row',
      'maka-artifact-toolbar-button',
    ]) {
      assert.match(source, new RegExp(`<Button[\\s\\S]*className="${className}`));
    }
  });

  it('keeps command palette search and rows on shared primitives', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/command-palette.tsx'), 'utf8');

    assert.match(source, /import \{ Button, Input, useModalA11y \} from '@maka\/ui';/);
    assert.doesNotMatch(source, /<input\b/, 'Command palette search must use shared Input');
    assert.doesNotMatch(source, /<button\b/, 'Command palette rows must use shared Button');
    assert.match(source, /<Input[\s\S]*className="maka-palette-input"/);
    assert.match(source, /<Button[\s\S]*role="option"[\s\S]*className="maka-palette-item"/);
  });

  it('keeps keyboard help close action on shared Button', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/keyboard-help.tsx'), 'utf8');

    assert.match(source, /import \{ Button, useModalA11y \} from '@maka\/ui';/);
    assert.doesNotMatch(source, /<button\b/, 'KeyboardHelpModal close action must use shared Button');
    assert.match(source, /<Button[\s\S]*className="settingsCloseButton"[\s\S]*aria-label="关闭快捷键面板"/);
  });

  it('keeps toast actions and confirm dialog buttons on shared Button without legacy classes', async () => {
    const source = await readFile(join(repoRoot, 'packages/ui/src/toast.tsx'), 'utf8');

    assert.match(source, /import \{ Button \} from '.\/ui\.js';/);
    assert.doesNotMatch(source, /<button\b/, 'ToastProvider controls must use shared Button');
    assert.doesNotMatch(source, /className="maka-button/, 'Confirm dialog actions must not keep legacy maka-button styling');
    assert.match(source, /<Button[\s\S]*className="maka-toast-action"/);
    assert.match(source, /<Button[\s\S]*className="maka-toast-close"/);
    assert.match(source, /<Button[\s\S]*variant=\{destructive \? 'destructive' : 'default'\}/);
  });
});
