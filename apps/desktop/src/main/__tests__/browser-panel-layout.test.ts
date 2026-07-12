/**
 * CSS contract test for BrowserPanel narrow layout (#546 closeout).
 *
 * Narrow source contract: locks ONLY the declaration that prevents the
 * disappearing-browser defect — `min-height` on the narrow `.maka-browser-panel`
 * rule. BrowserPanel's strip reports its rect to main each animation frame;
 * without a panel min-height the strip's `flex: 1 1 auto` resolves to ~0 in the
 * auto grid row and the native WebContentsView is mirrored to nothing, so the
 * embedded browser disappears. `min-height` is genuinely exclusive to the
 * narrow rule (the base `.maka-browser-panel` rule does not declare it), so a
 * source contract can lock its effective value within the block.
 *
 * This does NOT simulate the CSS cascade and does NOT claim to lock width,
 * border-left, max-height, border-top, or appearance. `width` / `border-left`
 * are also declared by the base rule and the narrow values win only by source
 * order, which a text contract cannot verify; `max-height` is a space cap, not
 * the disappearance-prevention floor; `border-top` / `box-shadow` are visual.
 * Those belong to visual smoke review, not a text contract. Locking the full
 * computed layout would need a real browser computed-style check.
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import postcss from 'postcss';
import { REPO_ROOT, stripCssComments } from './css-test-helpers.js';

const CHAT_DETAIL_CSS = resolve(REPO_ROOT, 'apps/desktop/src/renderer/styles/chat-detail.css');

interface MinHeightDecl {
  value: string;
  important: boolean;
}

/** All `min-height` declarations on exact-`.maka-browser-panel` rules inside
 *  `@media (max-width: 990px)` blocks, in source order with their !important
 *  flag. Pure over a CSS string so the collection/guard logic is unit-testable. */
function narrowBrowserMinHeights(css: string): MinHeightDecl[] {
  const root = postcss.parse(stripCssComments(css), { from: CHAT_DETAIL_CSS });
  const decls: MinHeightDecl[] = [];
  root.walkAtRules('media', (atRule) => {
    if (!/^\(\s*max-width\s*:\s*990px\s*\)$/.test(atRule.params)) return;
    atRule.walkRules((rule) => {
      if (!rule.selectors.includes('.maka-browser-panel')) return;
      for (const node of rule.nodes) {
        if (node.type !== 'decl' || node.prop !== 'min-height') continue;
        const d = node as postcss.Declaration;
        decls.push({ value: d.value.trim(), important: Boolean(d.important) });
      }
    });
  });
  return decls;
}

describe('BrowserPanel narrow layout CSS contract', () => {
  it('reserves a usable non-zero strip height at <=990px via a single unchallenged min-height', async () => {
    const decls = narrowBrowserMinHeights(await readFile(CHAT_DETAIL_CSS, 'utf8'));
    assert.equal(decls.length, 1, 'expected exactly one min-height on .maka-browser-panel in the 990px block (a second rule or duplicate property would compete)');
    assert.equal(decls[0].value, '220px', 'expected min-height:220px so the strip (and native view) is non-zero');
    assert.equal(decls[0].important, false, 'expected the narrow min-height not to need !important (a !important override would escape the contract)');
  });

  it('collects min-height across all matching rules so the guard catches a second overriding rule, a duplicate property, !important, or removal', () => {
    const block = (browserRule: string) => `@media (max-width: 990px){.maka-artifact-pane{width:100%}${browserRule}}`;
    // one clean declaration -> a single entry (the integration guard passes)
    assert.equal(narrowBrowserMinHeights(block('.maka-browser-panel{min-height:220px}')).length, 1);
    // a second overriding rule -> two entries (the integration length===1 guard fails)
    assert.equal(narrowBrowserMinHeights(block('.maka-browser-panel{min-height:220px}.maka-browser-panel{min-height:0}')).length, 2);
    // a duplicate property within one rule -> two entries (the guard fails)
    assert.equal(narrowBrowserMinHeights(block('.maka-browser-panel{min-height:220px;min-height:0}')).length, 2);
    // a !important -> recorded with the flag (the integration important===false guard fails)
    assert.equal(narrowBrowserMinHeights(block('.maka-browser-panel{min-height:220px !important}'))[0].important, true);
    // removal -> zero entries (the guard fails)
    assert.equal(narrowBrowserMinHeights(block('.maka-browser-panel{width:100%}')).length, 0);
  });
});