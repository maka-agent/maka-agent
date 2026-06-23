import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

// Chrome icon-size contract (PR-ICON-SCALE).
//
// The hand-rolled desktop chrome (left-nav glyphs + the `buttonVariants` button
// icon) shares ONE size, expressed as the `--icon-size` token, so nav and
// buttons can't drift apart again (the original defect: nav at 18px while
// buttons sat at size-4/1rem). Deliberately small dense-meta icons (12-14px)
// and large hero/emphasis icons (20px+) stay set at their call sites — they are
// intentional, not drift, so this contract does NOT flatten them, and it
// explicitly forbids reintroducing a blanket `svg.lucide { width }` rule that
// would silently resize every icon in the app.

const rendererDir = join(process.cwd(), 'src', 'renderer');
const repoRoot = resolve(process.cwd(), '..', '..');

function ruleBody(css: string, selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1];
}

describe('icon system contract (single chrome size token)', () => {
  it('defines --icon-size as the chrome glyph token', async () => {
    const tokens = await readFile(join(rendererDir, 'maka-tokens.css'), 'utf8');
    assert.match(tokens, /--icon-size:\s*16px/, 'chrome icon size token = 16px');
  });

  it('routes nav glyphs through the token, not hardcoded px', async () => {
    const styles = await readFile(join(rendererDir, 'styles.css'), 'utf8');
    // PR-DELETE-ORPHAN-CSS: `.maka-nav-primary-icon` was an orphan
    // class (no TSX consumer); deleted alongside the dead CSS sweep.
    // The icon-token check now covers `.maka-nav-icon` and the
    // `.maka-nav-row` column track, which is what actually renders.
    const navIcon = ruleBody(styles, '.maka-nav-icon');
    const navRow = ruleBody(styles, '.maka-nav-row');
    assert.ok(navIcon && navRow, 'nav rules must exist');
    assert.match(navIcon, /width:\s*var\(--icon-size\)/);
    assert.match(navIcon, /height:\s*var\(--icon-size\)/);
    assert.doesNotMatch(navIcon, /\b(width|height):\s*\d+px/, '.maka-nav-icon must not re-hardcode px');
    assert.match(navRow, /grid-template-columns:\s*var\(--icon-size\)/, 'nav-row glyph column tracks the token');
  });

  it('routes the shared button icon through the same token', async () => {
    const ui = await readFile(join(repoRoot, 'packages', 'ui', 'src', 'ui.tsx'), 'utf8');
    assert.match(
      ui,
      /\[&_svg\]:size-\[var\(--icon-size,1rem\)\]/,
      'buttonVariants svg size must consume --icon-size (1rem fallback keeps @maka/ui standalone)',
    );
  });

  it('forbids a blanket svg.lucide size rule (no app-wide resize hammer)', async () => {
    const styles = await readFile(join(rendererDir, 'styles.css'), 'utf8');
    const blanket = ruleBody(styles, 'svg.lucide');
    assert.ok(
      !blanket || !/\b(width|height)\s*:/.test(blanket),
      'a global `svg.lucide { width/height }` rule would silently resize every '
        + 'icon, including intentional 11-14px dense glyphs — it must not exist',
    );
  });

  it('registers the iconography contract in design-system.md', async () => {
    const doc = await readFile(join(repoRoot, 'docs', 'design-system.md'), 'utf8');
    assert.match(doc, /###\s*1\.9\s*图标/, 'design-system.md must carry §1.9 图标');
    assert.match(doc, /--icon-size\b/, 'doc must register the icon-size token');
  });
});
