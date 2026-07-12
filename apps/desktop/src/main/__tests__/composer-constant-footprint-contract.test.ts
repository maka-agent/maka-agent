/**
 * PR-COMPOSER-CONSTANT-FOOTPRINT-0 (issue #740):
 * lock the Composer's constant vertical footprint so the empty composer can't
 * drift back to the ~200px that ate a quarter of an 820px window.
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
 * Seven invariants pin the vertical budget (each measured against the 820px
 * window: composer outer 200px, inner 128px, textarea 56px, workspace/branch
 * row 36px):
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
 *   6. .maka-composer-workspace-row margin-top stays var(--space-2) (8px) —
 *      the workspace/branch row is a constant, mounted control; it is NOT
 *      tightened (stability: the row's footprint never changes).
 *
 * Combined this drops an empty composer from ~200px to ~164px (≥18%). The
 * contract pins each lever exactly-once (a later rest block, a selector-list
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
 *  selector (split on top-level commas, so `.other, .composer` is scanned for
 *  `.composer`). State pseudo / attribute variants are excluded — only the
 *  plain subject counts as the rest definition. */
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

/** Assert `prop` is declared exactly once across all rest blocks of `selector`
 *  with `expected` value (a later rest block, a selector-list companion, or a
 *  same-block duplicate each fail). */
function assertExactlyOnce(css: string, selector: string, prop: string, expected: string, label: string): void {
  const decls = restBlocks(css, selector).flatMap((b) => declarationsIn(b, prop));
  assert.equal(decls.length, 1, `${label}: ${prop} must be declared exactly once (a later rest block, a selector-list companion, OR a same-block duplicate would all win the cascade); got ${decls.length}: ${JSON.stringify(decls)}`);
  assert.equal(decls[0], expected, `${label}: ${prop} must be ${expected}; got ${decls[0]}`);
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

  it('.maka-composer-workspace-row margin stays var(--space-2) auto 0 — NOT tightened (stability)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    assertExactlyOnce(css, '.maka-composer-workspace-row', 'margin', 'var(--space-2) auto 0', '.maka-composer-workspace-row margin (constant, not tightened)');
  });

  it('assertExactlyOnce flags a same-block duplicate AND a selector-list companion (negative cases)', () => {
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
  });
});