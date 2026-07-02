import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, TOKENS_FILE, readAllRendererCss, stripCssComments } from './css-test-helpers.js';

async function readUiSource(): Promise<string> {
  return readFile(resolve(REPO_ROOT, 'packages/ui/src/ui.tsx'), 'utf8');
}

async function readSourceTree(dir: string): Promise<Array<{ path: string; source: string }>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') {
        return [];
      }
      return readSourceTree(path);
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) {
      return [];
    }
    return [{ path, source: await readFile(path, 'utf8') }];
  }));
  return files.flat();
}

function readCssToken(source: string, selector: ':root' | '.dark', token: string): string {
  const block = source.match(new RegExp(`${selector.replace('.', '\\.')}(?:\\s*,\\s*[^{]+)?\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
  return block.match(new RegExp(`--${token}:\\s*([^;]+);`))?.[1].trim() ?? '';
}

function parseOklch(value: string): [number, number, number] {
  const match = value.match(/^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  assert.ok(match, `${value} must be a literal oklch() color`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function oklchToSrgb([l, c, h]: [number, number, number]): [number, number, number] {
  const hue = h * Math.PI / 180;
  const a = c * Math.cos(hue);
  const b = c * Math.sin(hue);
  const lPrime = l + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = l - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = l - 0.0894841775 * a - 1.2914855480 * b;
  const lCube = lPrime ** 3;
  const mCube = mPrime ** 3;
  const sCube = sPrime ** 3;
  const linear = [
    4.0767416621 * lCube - 3.3077115913 * mCube + 0.2309699292 * sCube,
    -1.2684380046 * lCube + 2.6097574011 * mCube - 0.3413193965 * sCube,
    -0.0041960863 * lCube - 0.7034186147 * mCube + 1.7076147010 * sCube,
  ];
  return linear.map((channel) => {
    const srgb = channel <= 0.0031308 ? 12.92 * channel : 1.055 * (channel ** (1 / 2.4)) - 0.055;
    return Math.min(1, Math.max(0, srgb));
  }) as [number, number, number];
}

function relativeLuminance(rgb: [number, number, number]): number {
  return rgb
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const high = Math.max(relativeLuminance(a), relativeLuminance(b));
  const low = Math.min(relativeLuminance(a), relativeLuminance(b));
  return (high + 0.05) / (low + 0.05);
}

describe('issue #406 design-system governance contract', () => {
  it('does not ship decorative enter/exit motion by default', async () => {
    const rendererCss = stripCssComments(await readAllRendererCss());
    const tokens = stripCssComments(await readFile(TOKENS_FILE, 'utf8'));
    const uiSources = await readSourceTree(resolve(REPO_ROOT, 'packages/ui/src'));
    const functionalMotion = new Set([
      'animate-spin',
      'maka-composer-permission-pulse',
      'maka-composer-stream-bounce',
      'maka-cursor',
      'maka-list-row-streaming-pulse',
      'maka-pulse',
      'maka-reasoning-panel-pulse',
      'maka-shimmer',
      'maka-status-spin',
      'maka-tool-pulse',
    ]);
    const motionRe = /@keyframes\s+([-\w]+)|(?:^|[{\s])animation:\s*([^;]+);|\[animation:([^\]]+)\]|(?<![\w-])(animate-[\w-]+)/g;
    const violations: string[] = [];

    assert.equal((rendererCss.match(/@starting-style/g) ?? []).length, 0);
    assert.equal((tokens.match(/@starting-style/g) ?? []).length, 0);
    for (const { path, source } of uiSources) {
      const stripped = stripCssComments(source).replace(/\/\/.*$/gm, '');
      assert.equal((stripped.match(/data-(?:starting|ending)-style/g) ?? []).length, 0, path);
      assert.equal((stripped.match(/maka-tool-card-enter/g) ?? []).length, 0, path);
    }

    for (const [name, source] of [
      ['renderer CSS', rendererCss],
      ...uiSources.map(({ path, source }) => [path, stripCssComments(source).replace(/\/\/.*$/gm, '')] as const),
    ] as const) {
      for (const match of source.matchAll(motionRe)) {
        const raw = match[0].trim();
        if (raw.includes('animation: none') || raw.includes('[animation:none]')) continue;
        const captured = match.slice(1).find(Boolean) ?? raw;
        // Extract the first identifier (the animation-name) from the captured
        // string. CSS form: "maka-pulse 1.4s ease-in-out infinite".
        // Tailwind arbitrary: "maka-pulse_1.4s_ease-in-out_infinite".
        const animName = captured.replace(/[_\s].*$/, '').replace(/^@keyframes\s+/, '');
        if (functionalMotion.has(animName)) continue;
        violations.push(`${name}: ${raw}`);
      }
    }
    assert.deepEqual(violations, []);
  });

  it('splits action and control semantics without foreground-as-primary', async () => {
    const styles = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/styles.css'), 'utf8');
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    const emphasisTokens = ['link', 'focus-ring', 'status-running', 'nav-active', 'toast-accent'];
    for (const selector of [':root', '.dark'] as const) {
      const action = readCssToken(tokens, selector, 'action');
      const actionForeground = readCssToken(tokens, selector, 'action-foreground');
      const control = readCssToken(tokens, selector, 'control');
      const controlForeground = readCssToken(tokens, selector, 'control-foreground');

      assert.notEqual(action, 'var(--accent)', `${selector} action must be independently tunable`);
      assert.notEqual(control, 'var(--accent)', `${selector} control must be independently tunable`);
      assert.match(actionForeground, /^oklch\(0\.985 0\.003 250\)$/);
      assert.match(controlForeground, /^oklch\(0\.985 0\.003 250\)$/);
      assert.ok(
        contrastRatio(oklchToSrgb(parseOklch(action)), oklchToSrgb(parseOklch(actionForeground))) >= 4.5,
        `${selector} action/action-foreground contrast must clear 4.5:1`,
      );
      assert.ok(
        contrastRatio(oklchToSrgb(parseOklch(control)), oklchToSrgb(parseOklch(controlForeground))) >= 4.5,
        `${selector} control/control-foreground contrast must clear 4.5:1`,
      );
      for (const token of emphasisTokens) {
        assert.equal(readCssToken(tokens, selector, token), 'var(--accent)', `${selector} ${token} must start as a thin accent alias`);
      }
    }
    assert.match(styles, /--color-primary:\s*var\(--action\);/);
    assert.match(styles, /--color-primary-foreground:\s*var\(--action-foreground\);/);
    assert.match(styles, /--color-control:\s*var\(--control\);/);
    assert.match(styles, /--color-control-foreground:\s*var\(--control-foreground\);/);
    assert.doesNotMatch(styles, /--color-primary:\s*var\(--accent\);/);
    assert.doesNotMatch(styles, /--color-primary:\s*var\(--foreground\);/);
    for (const token of emphasisTokens) {
      assert.match(tokens, new RegExp(`--color-${token}:\\s*var\\(--${token}\\);`));
    }

    const ui = await readUiSource();
    assert.match(ui, /default:\s*'bg-primary text-primary-foreground/);
    assert.match(ui, /data-\[checked\]:bg-control/);
    assert.match(ui, /<BaseProgress\.Indicator className="[^"]*bg-control/);

    const menu = await readFile(resolve(REPO_ROOT, 'packages/ui/src/primitives/menu.tsx'), 'utf8');
    const tabs = await readFile(resolve(REPO_ROOT, 'packages/ui/src/primitives/tabs.tsx'), 'utf8');
    assert.match(menu, /data-checked:bg-control/);
    assert.match(tabs, /bg-control data-\[orientation=horizontal\]:h-0\.5/);
    assert.doesNotMatch(menu, /data-checked:bg-primary/);
    assert.doesNotMatch(tabs, /bg-primary data-\[orientation=horizontal\]:h-0\.5/);

    const docs = await readFile(resolve(REPO_ROOT, 'docs/design-system.md'), 'utf8');
    assert.match(docs, /不 flip 到 `--foreground`/);
    assert.match(docs, /选中控件继续.*2\.46:1/);
  });

  it('uses radius tokens for preview card surfaces', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    for (const token of ['--radius-control: 6px', '--radius-surface: 8px', '--radius-modal: 12px', '--radius-pill: 999px']) {
      assert.ok(tokens.includes(token), `${token} must be defined in maka-tokens.css`);
    }

    const styles = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/styles.css'), 'utf8');
    assert.match(styles, /--radius-sm:\s*var\(--radius-control\);/);
    assert.match(styles, /--radius-md:\s*var\(--radius-surface\);/);
    assert.match(styles, /--radius-lg:\s*var\(--radius-surface\);/);
    assert.match(styles, /--radius-xl:\s*var\(--radius-modal\);/);

    const chat = await readFile(resolve(REPO_ROOT, 'packages/ui/src/primitives/chat.tsx'), 'utf8');
    const previewBlock = chat.slice(
      chat.indexOf('const previewVariants'),
      chat.indexOf('export { previewVariants }'),
    );
    assert.match(previewBlock, /diff:\s*"[^"]*rounded-\[var\(--radius-surface\)\]/);
    assert.match(previewBlock, /terminal:\s*"[^"]*rounded-\[var\(--radius-surface\)\]/);
    assert.match(previewBlock, /"load-tool":\s*"[^"]*rounded-\[var\(--radius-control\)\]/);
    assert.doesNotMatch(previewBlock, /diff:\s*"[^"]*rounded-\[(?:8|6)px\]/);
    assert.doesNotMatch(previewBlock, /terminal:\s*"[^"]*rounded-\[(?:8|6)px\]/);
    assert.doesNotMatch(previewBlock, /"load-tool":\s*"[^"]*rounded-\[(?:8|6)px\]/);
  });

  it('keeps core visual surfaces on shadow rings instead of hard borders', async () => {
    const ui = await readUiSource();
    const styles = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/styles.css'), 'utf8');
    const dialogClass = ui.match(/className=\{cn\(\s*'([^']*shadow-maka-panel[^']*)'/)?.[1] ?? '';
    const selectClass = ui.match(/SelectPopup[\s\S]*?className=\{cn\('([^']*shadow-maka-panel[^']*)'/)?.[1] ?? '';
    const panelShadow = styles.match(/--shadow-maka-panel:\s*([^;]+);/)?.[1] ?? '';

    assert.match(panelShadow, /0\s+0\s+0\s+1px\s+var\(--border\)/);
    for (const [name, className] of [['DialogPopup', dialogClass], ['SelectPopup', selectClass]] as const) {
      assert.ok(className.includes('shadow-maka-panel'), `${name} must keep the shadow-ring recipe`);
      assert.ok(!/\bborder\b|\bborder-border\b/.test(className), `${name} must not use a hard visual border`);
    }

    const chat = await readFile(resolve(REPO_ROOT, 'packages/ui/src/primitives/chat.tsx'), 'utf8');
    assert.ok(chat.includes('[box-shadow:var(--shadow-minimal-flat)]'));
    assert.ok(!chat.includes('[animation:maka-tool-card-enter_350ms_var(--ease-out-strong)_both]'));
  });
});
