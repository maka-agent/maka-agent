/**
 * PR-COMPOSER-CONSTANT-FOOTPRINT-0 (issue #740):
 * lock the Composer's constant vertical footprint so the empty composer can't
 * drift back to the ~200px that ate a quarter of an 820px window — AND lock that
 * no state selector, no second DOM-class source, and no token override can
 * re-introduce an idle/active geometry switch.
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
 * The <form> carries TWO class aliases — `.maka-composer` AND `.composer` — so
 * a "single source" claim must cover both: .composer owns the padding, and
 * .maka-composer must NOT re-add it. The textarea's min-height must come from
 * CSS (var(--h-composer-min)), not a Tailwind min-h-* utility that could win if
 * the CSS rule is removed.
 *
 * Six invariants pin the vertical budget (each measured against the 820px
 * window: composer outer 200px, inner 128px, textarea 56px):
 *
 *   1. --h-composer-min (textarea min-height) is 44px, not 56px.
 *   2. .composer vertical padding is var(--space-2) (8px) top + bottom; .maka-
 *      composer declares NO padding (single source for the form's two classes).
 *   3. .maka-composer-inner padding-block is var(--space-2)/var(--space-1-5)
 *      (8/6px) with a var(--space-1-5) (6px) gap, not 10/8px + 10px.
 *   4. .composerActions margin-top is var(--space-1) (4px), not 8px.
 *   5. .maka-composer-textarea min-height is var(--h-composer-min) (CSS), and
 *      its className carries no Tailwind min-h-* utility (TSX).
 *   6. No state selector on .composer / .maka-composer / .maka-composer-inner
 *      (state = :hover/:focus-within/[data-…], but NOT ::before/::after which
 *      are the streaming sweep pseudo-elements) declares any vertical-geometry
 *      property — padding* (shorthand + all physical/logical longhands), gap*,
 *      margin* (shorthand + longhands), height/block-size/max-* and min-*, or a
 *      local --h-composer-min override. This is the core #740 lock: an
 *      idle/active mode switch is impossible if no state selector can change
 *      the footprint. (State selectors may still change border/box-shadow/
 *      background/color/position/overflow — those don't affect the form height.)
 *
 * Combined invariants 1–5 drop an empty composer from ~200px to ~164px (≥18%).
 * Each lever is pinned exactly-once (a later rest block, a selector-list
 * companion, OR a same-block duplicate would all win the cascade) so a
 * regression is caught before it ships.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  REPO_ROOT,
  TOKENS_FILE,
  readAllRendererCss,
  stripCssComments,
  assertCustomPropPinnedOnce,
} from './css-test-helpers.js';

const COMPOSER_TSX = join(REPO_ROOT, 'packages/ui/src/composer.tsx');

function styleRules(css: string): Array<[string, string]> {
  const stripped = stripCssComments(css);
  return [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => {
    const prelude = m[1].replace(/^[\s\S]*;/, '').trim();
    return [prelude, m[2]] as [string, string];
  });
}

function declarationsIn(body: string, prop: string): string[] {
  const re = new RegExp(`(?:^|[\\n;])\\s*${prop}\\s*:\\s*([^;}]*)`, 'ig');
  return [...body.matchAll(re)].map((m) => m[1].trim().replace(/\s+/g, ' '));
}

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

/** State-selector blocks: any selector referencing .composer / .maka-composer /
 *  .maka-composer-inner WITH a state pseudo/attribute, but NOT ::before/::after
 *  (those are the streaming sweep pseudo-elements — their height/position is the
 *  sweep line, not the composer footprint). */
function stateComposerBlocks(css: string): string[] {
  const blocks: string[] = [];
  for (const [prelude, body] of styleRules(css)) {
    if (!prelude || prelude.startsWith('@')) continue;
    const selectors = prelude.split(',').map((s) => s.trim());
    if (selectors.some((sel) => /(^|\s)(?:\.maka-composer-inner|\.composer|\.maka-composer)(?![\w-])/.test(sel) && /[:[]/.test(sel) && !/::(?:before|after)/.test(sel))) {
      blocks.push(body);
    }
  }
  return blocks;
}

/** Any vertical-geometry property + a local --h-composer-min override.
 *  padding/gap/margin cover shorthand + all physical/logical longhands
 *  (padding-block-start/end, margin-block-start/end, …); height/block-size/
 *  max-* and min-* cover explicit box height; --h-composer-min covers a state rule
 *  locally overriding the token that drives textarea min-height. */
const GEO_PROP_RE = /(?:^|[;\n])\s*(?:padding(?:-block(?:-start|-end)?|-inline(?:-start|-end)?|-top|-right|-bottom|-left)?|gap|row-gap|column-gap|margin(?:-block(?:-start|-end)?|-inline(?:-start|-end)?|-top|-right|-bottom|-left)?|height|block-size|max-height|max-block-size|min-height|min-block-size|--h-composer-min)\s*:/gi;

function geoDeclarationsIn(body: string): string[] {
  return [...body.matchAll(GEO_PROP_RE)].map((m) => m[0].trim().replace(/\s+/g, ' '));
}

describe('PR-COMPOSER-CONSTANT-FOOTPRINT-0 contract (issue #740)', () => {
  it('--h-composer-min is pinned to 44px (single-line natural, not 56px)', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    assertCustomPropPinnedOnce(tokens, '--h-composer-min', '44px', 'maka-tokens.css');
  });

  it('.composer rest padding is var(--space-2) var(--space-6) var(--space-2) AND .maka-composer declares no padding (form carries both classes — single source)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    assertExactlyOnce(css, '.composer', 'padding', 'var(--space-2) var(--space-6) var(--space-2)', '.composer padding');
    const makaComposerPadding = restBlocks(css, '.maka-composer').flatMap((b) => declarationsIn(b, 'padding'));
    assert.equal(makaComposerPadding.length, 0, `.maka-composer must not declare padding (the <form> carries .maka-composer + .composer; .composer is the single padding source); got ${JSON.stringify(makaComposerPadding)}`);
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

  it('.maka-composer-textarea min-height is var(--h-composer-min) (CSS) AND its className carries no Tailwind min-h-* (TSX single source)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    assertExactlyOnce(css, '.composer .maka-composer-textarea', 'min-height', 'var(--h-composer-min)', '.maka-composer-textarea min-height');
    const source = await readFile(COMPOSER_TSX, 'utf8');
    const textareaLine = source.split('\n').find((l) => l.includes('maka-composer-textarea'));
    assert.ok(textareaLine, 'maka-composer-textarea className line not found in composer.tsx');
    assert.doesNotMatch(textareaLine!, /min-h-[a-z0-9]+/i, '.maka-composer-textarea className must not carry a Tailwind min-h-* utility (CSS min-height: var(--h-composer-min) is the single source)');
  });

  it('no state selector on .composer/.maka-composer/.maka-composer-inner changes vertical geometry or overrides --h-composer-min (no idle/active mode switch)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    const geoDecls = stateComposerBlocks(css).flatMap((b) => geoDeclarationsIn(b));
    assert.equal(geoDecls.length, 0, `state selectors on .composer/.maka-composer/.maka-composer-inner must not change vertical geometry or override --h-composer-min (no idle/active mode switch per #740); found: ${JSON.stringify(geoDecls)}`);
  });

  it('negative cases: same-block duplicate, selector-list companion, state [data-compact] height + token override + ::before sweep exclusion, .maka-composer padding return, textarea min-h-* return', () => {
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
      'a selector-list companion setting padding must be caught',
    );
    const stateHeight = '.composer[data-compact="true"] { height: 120px; }';
    assert.equal(stateComposerBlocks(stateHeight).flatMap((b) => geoDeclarationsIn(b)).length, 1, 'a .composer[data-compact] height override must be flagged end-to-end');
    const stateTokenOverride = '.composer[data-compact="true"] { --h-composer-min: 32px; }';
    assert.equal(stateComposerBlocks(stateTokenOverride).flatMap((b) => geoDeclarationsIn(b)).length, 1, 'a .composer[data-compact] --h-composer-min override must be flagged (it drives textarea min-height)');
    const sweep = '.maka-composer-inner[data-streaming="true"]::before { height: 1px; top: 0; }';
    assert.equal(stateComposerBlocks(sweep).flatMap((b) => geoDeclarationsIn(b)).length, 0, '::before/::after state pseudo-elements must NOT be flagged (streaming sweep, not footprint)');
    const makaReturn = '.maka-composer { padding: var(--space-4) var(--space-6); }';
    assert.equal(restBlocks(makaReturn, '.maka-composer').flatMap((b) => declarationsIn(b, 'padding')).length, 1, 'a .maka-composer padding return must be caught (form carries both classes)');
    const tsxReturn = '          className="maka-composer-textarea min-h-11 resize-none"';
    assert.match(tsxReturn, /min-h-[a-z0-9]+/i, 'a returned textarea min-h-* utility must be caught');
  });
});