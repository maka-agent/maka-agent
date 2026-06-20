import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const repoRoot = join(process.cwd(), '..', '..');

describe('renderer utility surfaces use shared UI primitives', () => {
  it('keeps browser chrome on Button/Input instead of raw form controls', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/browser-panel.tsx'), 'utf8');

    assert.match(source, /import \{[^}]*\bButton\b[^}]*\bInput\b[^}]*\} from '@maka\/ui';/);
    assert.doesNotMatch(source, /<button\b/, 'BrowserPanel nav controls must use shared Button');
    assert.doesNotMatch(source, /<input\b/, 'BrowserPanel address bar must use shared Input');
  });

  it('keeps unsupported artifact preview CTA on Button without legacy classes', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/artifact-preview-registry-shell.tsx'), 'utf8');

    assert.match(source, /import \{ Button, Spinner \} from '@maka\/ui';/);
    assert.doesNotMatch(source, /<button\b/, 'unsupported artifact preview CTA must use shared Button');
    assert.doesNotMatch(source, /className="maka-button/, 'artifact preview CTA must not keep legacy maka-button styling');
    assert.match(source, /<Button[\s\S]*variant="secondary"[\s\S]*className="maka-artifact-preview-unsupported-cta"/);
  });

  it('keeps artifact preview loading indicators on shared primitive Spinner', async () => {
    const legacySource = await readFile(join(process.cwd(), 'src/renderer/artifact-preview.tsx'), 'utf8');
    const registrySource = await readFile(join(process.cwd(), 'src/renderer/artifact-preview-registry-shell.tsx'), 'utf8');
    const styles = await readFile(join(process.cwd(), 'src/renderer/styles.css'), 'utf8');

    for (const [label, source] of [
      ['legacy preview', legacySource],
      ['registry preview', registrySource],
    ] as const) {
      assert.match(source, /import \{[^}]*\bSpinner\b[^}]*\} from '@maka\/ui';/, `${label} must import shared primitive Spinner`);
      assert.match(
        source,
        /<Spinner className="maka-artifact-preview-spinner" aria-hidden="true" role="presentation" \/>/,
        `${label} loading indicator must render shared primitive Spinner as a decorative glyph inside the Chinese status row`,
      );
      assert.doesNotMatch(
        source,
        /<span className="maka-artifact-preview-spinner"/,
        `${label} must not restore the hand-rolled spinner span`,
      );
    }
    assert.doesNotMatch(styles, /@keyframes maka-artifact-spinner/, 'artifact loading must not keep a custom spinner animation');
    assert.doesNotMatch(styles, /border-top-color:\s*var\(--accent\)/, 'artifact loading spinner styling must not hand-draw a border spinner');
  });

  it('keeps artifact pane controls on shared Button primitives', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/artifact-pane.tsx'), 'utf8');

    assert.match(source, /import \{[^}]*\bButton\b[^}]*\bToolbar\b[^}]*\bToolbarGroup\b[^}]*\bToolbarSeparator\b[^}]*\buseToast\b[^}]*\} from '@maka\/ui';/);
    assert.doesNotMatch(source, /<button\b/, 'ArtifactPane controls must use shared Button');
    assert.doesNotMatch(source, /role="toolbar"/, 'ArtifactPane toolbar semantics must come from shared primitive Toolbar');
    assert.match(source, /<Toolbar className="maka-artifact-toolbar" aria-label="生成文件操作">/);
    assert.match(source, /<ToolbarSeparator className="maka-artifact-toolbar-separator" orientation="vertical" \/>/);
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

    assert.match(source, /import \{[^}]*\bButton\b[^}]*\bInputGroup\b[^}]*\bInputGroupAddon\b[^}]*\bInputGroupInput\b[^}]*\bKbd\b[^}]*\bKbdGroup\b[^}]*\buseModalA11y\b[^}]*\} from '@maka\/ui';/);
    assert.doesNotMatch(source, /<input\b/, 'Command palette search must use shared Input');
    assert.doesNotMatch(source, /<button\b/, 'Command palette rows must use shared Button');
    assert.doesNotMatch(source, /<kbd\b/, 'Command palette shortcut glyphs must use shared primitive Kbd');
    assert.match(source, /<InputGroup className="maka-palette-input-wrap" aria-label="命令面板搜索">/);
    assert.match(source, /<InputGroupInput[\s\S]*className="maka-palette-input"/);
    assert.match(source, /<InputGroupAddon align="inline-end" className="maka-palette-input-hint-addon">/);
    assert.match(source, /<Button[\s\S]*role="option"[\s\S]*className="maka-palette-item"/);
    assert.match(source, /<KbdGroup className="maka-shortcut-group">[\s\S]*<Kbd className="maka-shortcut-kbd">↑<\/Kbd>[\s\S]*<Kbd className="maka-shortcut-kbd">↓<\/Kbd>/);
  });

  it('keeps keyboard help close action on shared Button', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/keyboard-help.tsx'), 'utf8');

    assert.match(source, /import \{ Button, Kbd, useModalA11y \} from '@maka\/ui';/);
    assert.doesNotMatch(source, /<button\b/, 'KeyboardHelpModal close action must use shared Button');
    assert.doesNotMatch(source, /<kbd\b/, 'KeyboardHelpModal shortcut glyphs must use shared primitive Kbd');
    assert.match(source, /<Button[\s\S]*className="settingsCloseButton"[\s\S]*aria-label="关闭快捷键面板"/);
    assert.match(source, /<Kbd className="maka-shortcut-kbd">\{key\}<\/Kbd>/);
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
