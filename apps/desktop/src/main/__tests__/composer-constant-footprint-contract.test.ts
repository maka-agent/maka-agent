/**
 * PR-COMPOSER-CONSTANT-FOOTPRINT-0 (issue #740):
 * lock the Composer's constant vertical footprint so the empty composer can't
 * drift back to the ~200px that ate a quarter of an 820px window — AND lock that
 * no state selector ever introduces an idle/active geometry switch.
 *
 * The cut is static — no `[data-compact]` state machine, no idle/active mode.
 * The Composer is the highest-frequency surface and sits at the bottom of the
 * chat column; an idle↔active height switch would push the chat viewport
 * boundary and jump the conversation. Stability takes priority over peak space
 * savings, so the footprint is tightened once via static CSS and stays put. The
 * textarea already auto-resizes as content arrives (capped at
 * COMPOSER_MAX_HEIGHT in @maka/ui), so content-driven "expand" is the textarea's
 * own growth — no enter/leave transition, no reduced-motion special-casing.
 *
 * Six invariants pin the vertical budget (each measured against the 820px
 * window: composer outer 200px, inner 128px, textarea 56px):
 *
 *   1. --h-composer-min (textarea min-height) is 44px (single-line natural),
 *      not 56px.
 *   2. .composer vertical padding is var(--space-2) (8px) top + bottom, not
 *      12/16px.
 *   3. .maka-composer-inner padding-block is var(--space-2)/var(--space-1-5)
 *      (8/6px) with a var(--space-1-5) (6px) gap, not 10/8px + 10px.
 *   4. .composerActions margin-top is var(--space-1) (4px), not 8px.
 *   5. .maka-composer-textarea min-height is var(--h-composer-min) — the
 *      textarea follows the token, not a bare value that could drift.
 *   6. No state selector on .composer/.maka-composer (:hover, :focus-within,
 *      [data-compact], [data-streaming], [data-drag-active], …) declares any
 *      vertical-geometry property (padding* / gap* / margin* / min-height /
 *      min-block-size, including longhands). This is the core #740 lock: an
 *      idle/active mode switch is impossible if no state selector can change
 *      the footprint. (State selectors may still change border/box-shadow/
 *      background/color — those don't affect height.)
 *
 * Combined invariants 1–5 drop an empty composer from ~200px to ~164px (≥18%).
 * The contract pins each lever exactly-once (a later rest block, a selector-list
 * companion, OR a same-block duplicate would all win the cascade) so a
 * regression to the old footprint is caught before it ships.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  TOKENS_FILE,
  readAllRendererCss,
  stripCssComments,
  assertCustomPropPinnedOnce,
} from './css-test-helpers.js';

function styleRules(css: string): Array<[string, string]> {
  const stripped = stripCssComments(css);
  return [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => {
    const prelude = m[1].replace(/^[\s\S]*;/, '').trim();
    return [prelude, m[2]] as [string, string];
  });
}

/** ALL declarations of `prop` within one block (global match), so a
 *  `padding: a; padding: b` same-block override surfaces as two, not one. */
function declarationsIn(body: string, prop: string): string[] {
  const re = new RegExp(`(?:^|[\\n;])\\s*${prop}\\s*:\\s*([^;}]*)`, 'ig');
  return [...body.matchAll(re)].map((m) => m[1].trim().replace(/\s+/g, ' '));
}

/** Rest blocks whose selector list CONTAINS `subjectSelector` as a whole
 *  selector (split on top-level commas). State pseudo / attribute variants are
 *  excluded — only the plain subject counts as the rest definition. */
function restBlocks(css: string, subjectSelector: string): string[] {
  const blocks: string[] = [];
  for (const [prelude, body] of styleRules(css)) {
    if (!prelude || prelude.startsWith('@')) continue;
    const selectors = prelude.split(',').map((s) => s.trim());
    if (selectors.some((sel) => sel === subjectSelector && !/[:[]/.test(sel))) {
      blocks.push(body);
    }
  }
  return blocks;
}

function assertExactlyOnce(css: string, selector: string, prop: string, expected: string, label: string): void {
  const decls = restBlocks(css, selector).flatMap((b) => declarationsIn(b, prop));
  assert.equal(decls.length, 1, `${label}: ${prop} must be declared exactly once (a later rest block, a selector-list companion, OR a same-block duplicate would all win the cascade); got ${decls.length}: ${JSON.stringify(decls)}`);
  assert.equal(decls[0], expected, `${label}: ${prop} must be ${expected}; got ${decls[0]}`);
}

/** State-selector blocks: any selector in the list that references
 *  `.composer` or `.maka-composer` AND carries a state pseudo / attribute
 *  (`:hover`, `[data-compact]`, …). These are the only places an idle/active
 *  geometry switch could sneak in. */
function stateComposerBlocks(css: string): string[] {
  const blocks: string[] = [];
  for (const [prelude, body] of styleRules(css)) {
    if (!prelude || prelude.startsWith('@')) continue;
    const selectors = prelude.split(',').map((s) => s.trim());
    if (selectors.some((sel) => /(^|\s)(?:\.maka-composer-inner|\.composer|\.maka-composer)(?![\w-])/.test(sel) && /[:[]/.test(sel))) {
      blocks.push(body);
    }
  }
  return blocks;
}

/** Any vertical-geometry property declaration: padding* (shorthand + all
 *  longhands), gap* (shorthand + row/column), margin* (shorthand + longhands),
 *  min-height, min-block-size. Catches `padding-block` / `row-gap` etc. that a
 *  shorthand-only scan would miss. */
const GEO_PROP_RE = /(?:^|[;\n])\s*(?:padding(?:-block|-inline|-top|-right|-bottom|-left)?|gap|row-gap|column-gap|margin(?:-block|-inline|-top|-right|-bottom|-left)?|min-height|min-block-size)\s*:/gi;

function geoDeclarationsIn(body: string): string[] {
  return [...body.matchAll(GEO_PROP_RE)].map((m) => m[0].trim().replace(/\s+/g, ' '));
}

describe('PR-COMPOSER-CONSTANT-FOOTPRINT-0 contract (issue #740)', () => {
  it('--h-composer-min is pinned to 44px (single-line natural, not 56px)', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    assertCustomPropPinnedOnce(tokens, '--h-composer-min', '44px', 'maka-tokens.css');
  });

  it('.composer rest padding is var(--space-2) var(--space-6) var(--space-2) (8/24/8)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    assertExactlyOnce(css, '.composer', 'padding', 'var(--space-2) var(--space-6) var(--space-2)', '.composer padding');
  });

  it('.maka-composer-inner rest padding + gap are the constant footprint', async () => {
    const css = stripCssComments(await readAllRendererCss());
    assertExactlyOnce(css, '.composer .maka-composer-inner', 'padding', 'var(--space-2) var(--space-3) var(--space-1-5)', '.maka-composer-inner padding');
    assertExactlyOnce(css, '.composer .maka-composer-inner', 'gap', 'var(--space-1-5)', '.maka-composer-inner gap');
  });

  it('.composerActions rest margin-top is var(--space-1) (4px)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    assertExactlyOnce(css, '.composerActions', 'margin-top', 'var(--space-1)', '.composerActions margin-top');
  });

  it('.maka-composer-textarea min-height follows --h-composer-min (not a bare value)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    assertExactlyOnce(css, '.composer .maka-composer-textarea', 'min-height', 'var(--h-composer-min)', '.maka-composer-textarea min-height');
  });

  it('no state selector on .composer/.maka-composer changes vertical geometry (no idle/active mode switch)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    const geoDecls = stateComposerBlocks(css).flatMap((b) => geoDeclarationsIn(b));
    assert.equal(geoDecls.length, 0, `state selectors on .composer/.maka-composer must not change vertical geometry (no idle/active mode switch per #740); found: ${JSON.stringify(geoDecls)}`);
  });

  it('assertExactlyOnce flags a same-block duplicate AND a selector-list companion; state-geometry guard flags a [data-compact] padding override (negative cases)', () => {
    const sameBlock = '.composer { padding: var(--space-2) var(--space-6) var(--space-2); padding: var(--space-3) var(--space-6) var(--space-4); }';
    assert.throws(
      () => assertExactlyOnce(sameBlock, '.composer', 'padding', 'var(--space-2) var(--space-6) var(--space-2)', '.composer padding'),
      /got 2/,
      'a same-block padding duplicate must be caught',
    );
    const selectorList = '.other, .composer { padding: var(--space-3) var(--space-6) var(--space-4); }';
    assert.throws(
      () => assertExactlyOnce(selectorList, '.composer', 'padding', 'var(--space-2) var(--space-6) var(--space-2)', '.composer padding'),
      /var\(--space-3\)/,
      'a selector-list companion setting padding must be caught (the override won the cascade)',
    );
    const stateCompact = '.composer[data-compact="true"] { padding-block: var(--space-1); }';
    const stateCompactBody = styleRules(stateCompact)[0]?.[1] ?? '';
    assert.equal(
      geoDeclarationsIn(stateCompactBody).length,
      1,
      'a .composer[data-compact] padding-block override must be flagged by the state-geometry guard (longhand, not just shorthand)',
    );
  });
});