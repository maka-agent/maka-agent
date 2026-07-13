/**
 * #546 composer governance: lock the Base UI Menu item *highlight* recipe so
 * the shadcn stock `data-highlighted:bg-accent` can't leak back in.
 *
 * Why this exists: shadcn's Menu primitive paints the highlighted (hovered /
 * keyboard-active) item with `bg-accent`. That is correct in stock shadcn,
 * where `--accent` is a *neutral* hover gray. Maka reuses the primitive but
 * defines `--accent` as the **product blue** (`oklch(0.70 0.135 250)`,
 * maka-tokens.css), reserved for emphasis (links / focus-ring / nav-active /
 * send button). So the unmodified recipe painted every menu hover blue —
 * clashing with the rest of the app, which highlights list rows with the
 * neutral `--state-selected-bg` token (see `.maka-search-modal-result`,
 * `.maka-palette-item` in sidebar.css / palette.css).
 *
 * This contract pins the converged recipe: menu highlight must use
 * `--state-selected-bg` (neutral), never `--accent`, and must not recolor the
 * text (the neutral tint needs no contrast swap). It reads the primitive
 * source directly because the recipe is a Tailwind utility on the className,
 * not a rule in the renderer CSS the other contracts scan.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { compile } from 'tailwindcss';
import { REPO_ROOT } from './css-test-helpers.js';

const MENU_PRIMITIVE = join(REPO_ROOT, 'packages', 'ui', 'src', 'primitives', 'menu.tsx');
const STYLES_ENTRY = join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'styles.css');

async function readMenuSource(): Promise<string> {
  return readFile(MENU_PRIMITIVE, 'utf8');
}

describe('menu highlight recipe contract (#546 menu-hover governance)', () => {
  it('highlights with the neutral --state-selected-bg, not the blue --accent', async () => {
    const src = await readMenuSource();

    // The blue leak — shadcn stock recipe mapped onto Maka's product-blue
    // accent token. Must not appear on any menu item state.
    assert.ok(
      !src.includes('data-highlighted:bg-accent'),
      'menu item highlight must not use bg-accent (Maka --accent is the product blue, not a neutral). Use bg-[var(--state-selected-bg)].',
    );
    assert.ok(
      !src.includes('data-popup-open:bg-accent'),
      'submenu-open state must not use bg-accent either — same neutral-highlight rule.',
    );

    // No text recolor on highlight. The neutral --state-selected-bg tint
    // (6.5% foreground) keeps foreground text readable, so the shadcn
    // accent-foreground contrast swap is both unnecessary and inconsistent
    // with palette/search rows.
    assert.ok(
      !src.includes('data-highlighted:text-accent-foreground'),
      'menu highlight must not recolor text to accent-foreground (neutral tint needs no swap).',
    );
  });

  it('MenuItem positively pins data-highlighted:bg-[var(--state-selected-bg)]', async () => {
    const src = await readMenuSource();
    // Positive lock on the canonical item so the recipe can't silently revert
    // to a bare token or a different utility. Arbitrary-value utility maps to
    // background-color: var(--state-selected-bg).
    assert.ok(
      src.includes('data-highlighted:bg-[var(--state-selected-bg)]'),
      'MenuItem recipe must pin data-highlighted:bg-[var(--state-selected-bg)] to match palette/search list-highlight.',
    );
  });

  it('uses the readable destructive text token for destructive menu items', async () => {
    const src = await readMenuSource();

    assert.ok(
      src.includes('data-[variant=destructive]:text-destructive-text'),
      'destructive menu items sit on a neutral popup and must use --destructive-text',
    );
    assert.ok(
      !src.includes('data-[variant=destructive]:text-destructive-foreground'),
      '--destructive-foreground is reserved for text placed on a solid destructive background',
    );
  });

  it('generates the destructive menu text utility from the canonical token bridge', async () => {
    const styles = await readFile(STYLES_ENTRY, 'utf8');
    const theme = styles.match(/@theme inline \{[\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(theme, 'styles.css must expose the canonical Tailwind theme bridge');
    const compiler = await compile(`${theme}\n@tailwind utilities;`);
    const css = compiler.build(['data-[variant=destructive]:text-destructive-text']);

    assert.match(
      css,
      /\.data-\\\[variant\\=destructive\\\]\\:text-destructive-text\s*\{[\s\S]*?color:\s*var\(--destructive-text\);/,
    );
  });
});
