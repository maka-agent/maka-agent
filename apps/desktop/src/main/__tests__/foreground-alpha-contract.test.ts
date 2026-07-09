/**
 * FOREGROUND-ALPHA-TOKEN-0 (issue #546 PR5): the file-attachment card's
 * semi-transparent foreground washes (card bg, icon-tile bg, inset ring, and
 * the remove-button hover) are governed by named alpha-tint tokens, not
 * scattered arbitrary Tailwind alpha utilities.
 *
 * Two invariants:
 *
 * 1. `--foreground-alpha-{6,10,12}` are declared in `maka-tokens.css` as
 *    color-mix alpha of `--foreground` over `transparent` (NOT the solid
 *    `--foreground-N` tints, which mix with `--background` and would change
 *    rendering — the ring would thicken, the wash would stop tracking the
 *    backdrop). The alpha form preserves the existing semi-transparent
 *    look exactly while naming the three values the card uses (0.06 / 0.10 /
 *    0.12).
 *
 * 2. `attachment-file-card.tsx` references these tokens (via
 *    `bg-[var(--foreground-alpha-N)]` / `ring-[var(--foreground-alpha-N)]`)
 *    and contains no bare `foreground/[0.0X]` / `foreground/NN` arbitrary
 *    alpha utility. Scanning the literal className text (the
 *    `readRendererTsxFiles` seam) is enough here because the card's classes
 *    are all literal strings, not runtime-composed.
 *
 * Scope note: this contract governs the attachment card's alphas only. The
 * existing `opacity-converge-contract` governs the `opacity:` property (and
 * explicitly excludes TSX Tailwind utilities), so the alpha *color* washes
 * were a blind spot — this contract fills it for the one component that
 * carried arbitrary foreground alphas.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  REPO_ROOT,
  TOKENS_FILE,
  parseCssCustomProps,
  readRendererTsxFiles,
  stripCssComments,
} from './css-test-helpers.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const CARD_FILE = resolve(REPO_ROOT, 'packages', 'ui', 'src', 'attachment-file-card.tsx');

const ALPHA_TOKENS = [
  { name: '--foreground-alpha-6', alpha: '0.06' },
  { name: '--foreground-alpha-10', alpha: '0.10' },
  { name: '--foreground-alpha-12', alpha: '0.12' },
] as const;

describe('FOREGROUND-ALPHA-TOKEN-0 contract (#546 PR5)', () => {
  it('maka-tokens.css declares each --foreground-alpha-N once, as oklch alpha of --foreground (NOT the solid --foreground-N tint)', async () => {
    const css = stripCssComments(await readFile(TOKENS_FILE, 'utf8'));
    const props = parseCssCustomProps(css);
    for (const { name, alpha } of ALPHA_TOKENS) {
      const values = props.get(name) ?? [];
      assert.equal(
        values.length,
        1,
        `maka-tokens.css: ${name} must be declared exactly once; got ${values.length}: ${JSON.stringify(values)}`,
      );
      assert.match(
        values[0],
        new RegExp(`^oklch\\(from var\\(--foreground\\) l c h / ${alpha.replace('.', '\\.')}\\)$`),
        `maka-tokens.css: ${name} must be oklch(from var(--foreground) l c h / ${alpha}) (alpha over the backdrop, NOT the solid --foreground-N tint that mixes with --background); got ${values[0]}`,
      );
    }
  });

  it('attachment-file-card.tsx uses the alpha tokens and has no bare foreground/ alpha utility', async () => {
    const src = await readFile(CARD_FILE, 'utf8');
    // 1) references all three tokens
    for (const { name } of ALPHA_TOKENS) {
      assert.match(
        src,
        new RegExp(`var\\(${name.replace(/[()]/g, '\\$&')}\\)`),
        `attachment-file-card.tsx must reference ${name} (bg-/ring-[${name}])`,
      );
    }
    // 2) no bare foreground alpha — any `foreground/` (slash opacity modifier)
    //    is an ungoverned arbitrary alpha; after convergence none remain.
    const offenders = [...src.matchAll(/foreground\/\S+/g)].map((m) => m[0]);
    assert.deepEqual(
      offenders,
      [],
      `attachment-file-card.tsx must use --foreground-alpha-* tokens, not bare foreground/ alphas: ${offenders.join(', ')}`,
    );
  });
});