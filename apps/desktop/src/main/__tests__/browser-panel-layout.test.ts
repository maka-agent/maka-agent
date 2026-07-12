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
        if (node.type !== 'decl') continue;
        const d = node as postcss.Declaration;
        if (d.prop.toLowerCase() === 'min-height') {
          decls.push({ value: d.value.trim(), important: Boolean(d.important) });
        } else if (d.prop.includes('\\')) {
          // A CSS-escaped property name (e.g. `m\69n-height`) decodes to
          // `min-height` in the browser while PostCSS preserves the escape;
          // count it as a competing declaration so the length===1 guard
          // fails closed (#824 Codex review).
          decls.push({ value: '<escaped-prop>', important: Boolean(d.important) });
        }
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
    // a case-variant duplicate (MIN-HEIGHT) -> CSS property names are case-insensitive in the browser (PostCSS preserves source case) -> two entries (the guard fails)
    assert.equal(narrowBrowserMinHeights(block('.maka-browser-panel{min-height:220px;MIN-HEIGHT:0}')).length, 2);
    // a CSS-escaped property name (m\69n-height decodes to min-height in the browser; PostCSS preserves the escape) -> counted as competing -> two entries (the guard fails)
    assert.equal(narrowBrowserMinHeights(block('.maka-browser-panel{min-height:220px;m\\69n-height:0}')).length, 2);
    // a !important -> recorded with the flag (the integration important===false guard fails)
    assert.equal(narrowBrowserMinHeights(block('.maka-browser-panel{min-height:220px !important}'))[0].important, true);
    // removal -> zero entries (the guard fails)
    assert.equal(narrowBrowserMinHeights(block('.maka-browser-panel{width:100%}')).length, 0);
  });
});

/** The exact two selectors of the #824 both-present rule, whitespace-
 *  normalized + sorted so formatting drift doesn't break the contract. The
 *  shape is locked by STRING EQUALITY against these (not by regex), so any
 *  change to the `:has()` scope — removing the non-collapsed guard, wrapping
 *  a `:has()` in `:not()`, adding a selector-list inside `:has()`, reordering
 *  the `:has()` args, dropping a `:has()`, targeting a different panel —
 *  breaks the equality and the contract fails closed. No regex-substring
 *  bypass surface. */
const BOTH_PRESENT_SELECTORS = [
  '.maka-detail-with-artifacts:has(.maka-browser-panel):has(.maka-artifact-pane:not([data-collapsed="true"])) .maka-artifact-pane',
  '.maka-detail-with-artifacts:has(.maka-browser-panel):has(.maka-artifact-pane:not([data-collapsed="true"])) .maka-browser-panel',
].map((s) => s.replace(/\s+/g, ' ').trim()).sort();

interface BothPresentCandidate {
  /** Selectors of the rule, whitespace-normalized + sorted. */
  selectors: string[];
  /** Every `min-height` value on the rule (property name matched
   *  case-insensitively — CSS property names are case-insensitive in the
   *  browser while PostCSS preserves source case), in source order. */
  minHeights: string[];
  /** True if any declaration on the rule uses a CSS-escaped property name
   *  (e.g. `m\69n-height`), which the browser decodes to `min-height` while
   *  PostCSS preserves the escape — could override without being collected.
   *  The test fails closed if any panel-targeting rule sets this. */
  escapedProp: boolean;
}

/** Count rules inside a `@media (max-width: 990px)` block (at-rule name +
 *  media params matched ASCII-case-insensitively — CSS at-rules + media
 *  keywords are case-insensitive, so `@MEDIA (MAX-WIDTH: 990px)` is the same
 *  query) that use `:has()` (ASCII-case-insensitively, so `:HAS(` counts) OR
 *  a CSS-escaped selector (e.g. `:h\61s(` decodes to `:has(` — fail closed on
 *  any backslash in a selector rather than decoding escapes) AND declare a
 *  `min-height` (case-insensitive prop) OR a CSS-escaped property name.
 *  Independent of the panel-ending filter so a same-specificity competitor in
 *  a different target form (`:is(.maka-browser-panel)`) is still counted. The
 *  both-present rule is the only such rule in the real CSS, so the contract
 *  asserts this count === 1. Pure over a CSS string. */
function countHasScopedMinHeightRules(css: string): number {
  const root = postcss.parse(stripCssComments(css), { from: CHAT_DETAIL_CSS });
  let count = 0;
  root.walkAtRules((atRule) => {
    if (atRule.name.toLowerCase() !== 'media') return;
    if (!/^\(\s*max-width\s*:\s*990px\s*\)$/i.test(atRule.params)) return;
    atRule.walkRules((rule) => {
      const scoped = rule.selectors.some((s) => s.toLowerCase().includes(':has(') || s.includes('\\'));
      if (!scoped) return;
      if (rule.nodes.some((n): n is postcss.Declaration => n.type === 'decl' && (n.prop.toLowerCase() === 'min-height' || n.prop.includes('\\')))) count++;
    });
  });
  return count;
}

/** Rules inside `@media (max-width: 990px)` that target a descendant
 *  `.maka-browser-panel` / `.maka-artifact-pane`. Identification is loose
 *  (panel-targeting); the test locks the exact both-present selectors + value
 *  + single-declaration + no-escaped-prop by string equality + counts; the
 *  single-:has-scoped-min-height-rule guard is the independent
 *  `countHasScopedMinHeightRules` (not pre-filtered by the panel-ending regex,
 *  so it catches `:is()` target + `:HAS()` case-variant competitors). This
 *  does NOT model the CSS cascade, so a higher-specificity override (e.g. an
 *  #id rule) or an `all:initial` reset could still win — verifying the
 *  cascade-effective computed value is the job of the #819 computed-style
 *  fixture (the reliable layer per the #824 Codex review). Pure over a CSS
 *  string so the collection logic is unit-testable. */
function bothPresentCandidates(css: string): BothPresentCandidate[] {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const root = postcss.parse(stripCssComments(css), { from: CHAT_DETAIL_CSS });
  const out: BothPresentCandidate[] = [];
  root.walkAtRules('media', (atRule) => {
    if (!/^\(\s*max-width\s*:\s*990px\s*\)$/.test(atRule.params)) return;
    atRule.walkRules((rule) => {
      if (!rule.selectors.some((s) => /\.maka-(browser-panel|artifact-pane)\s*$/.test(s))) return;
      const minHeights = rule.nodes
        .filter((n): n is postcss.Declaration => n.type === 'decl' && n.prop.toLowerCase() === 'min-height')
        .map((d) => d.value.trim());
      const escapedProp = rule.nodes.some((n): n is postcss.Declaration => n.type === 'decl' && n.prop.includes('\\'));
      out.push({ selectors: rule.selectors.map(norm).sort(), minHeights, escapedProp });
    });
  });
  return out;
}

describe('both-present shared-height CSS contract (#824)', () => {
  it('is exactly one rule with the exact both-present selectors and min-height: min(22dvh, 220px)', async () => {
    const css = await readFile(CHAT_DETAIL_CSS, 'utf8');
    const candidates = bothPresentCandidates(css);
    const matching = candidates.filter(
      (c) => c.selectors.length === BOTH_PRESENT_SELECTORS.length && c.selectors.every((s, i) => s === BOTH_PRESENT_SELECTORS[i]),
    );
    assert.equal(matching.length, 1, 'expected exactly one rule in the 990px block with the exact both-present selectors (a second rule with the same selectors would make the cascade-effective min-height ambiguous)');
    assert.equal(matching[0]!.minHeights.length, 1, 'expected exactly one min-height declaration on the both-present rule (a duplicate, including a case variant like MIN-HEIGHT, would win the cascade)');
    assert.equal(matching[0]!.minHeights[0], 'min(22dvh, 220px)', 'expected min-height: min(22dvh, 220px) — shrink below 220px at short heights, never grow above 220px at tall heights (>=1000px tall unchanged)');
    // #824 Codex review: fail closed on CSS-escaped property names — an
    // escaped prop (e.g. `m\69n-height`) decodes to `min-height` in the
    // browser while PostCSS preserves the escape, so it could override
    // without being collected. No panel-targeting rule may use one.
    assert.ok(candidates.every((c) => !c.escapedProp), 'no panel-targeting rule in the 990px block may use a CSS-escaped property name (could override min-height without being collected)');
    // #824 Codex review: exactly one :has()-scoped rule with a min-height in
    // the 990px block — counted independently of the panel-ending filter so a
    // same-specificity competitor in a different target form (`:is(.maka-
    // browser-panel)`) or a `:HAS()` case variant is still caught. A second
    // such rule with a competing min-height would win the cascade (same
    // specificity, later source order) while its different selector string
    // keeps it out of `matching`. Higher-specificity overrides (e.g. #id) and
    // `all:initial` resets are beyond a text contract and belong to the #819
    // computed-style fixture (the reliable cascade verification).
    assert.equal(countHasScopedMinHeightRules(css), 1, 'expected exactly one :has()-scoped rule with a min-height in the 990px block (a same-specificity competitor could override the cascade-effective value)');
  });

  it('collects candidates so the guard catches a second rule, a duplicate / case-variant declaration, a changed selector shape, a wrong value, or removal', () => {
    const block = (rule: string) => `@media (max-width: 990px){${rule}}`;
    const cond = ':has(.maka-browser-panel):has(.maka-artifact-pane:not([data-collapsed="true"]))';
    const selectors = (c: string) => `.maka-detail-with-artifacts${c} .maka-browser-panel,.maka-detail-with-artifacts${c} .maka-artifact-pane`;
    const rule = (body: string) => `${selectors(cond)}{${body}}`;
    const matching = (css: string) =>
      bothPresentCandidates(css).filter(
        (c) => c.selectors.length === BOTH_PRESENT_SELECTORS.length && c.selectors.every((s, i) => s === BOTH_PRESENT_SELECTORS[i]),
      );

    // clean -> one matching candidate, one min-height, exact value
    const ok = matching(block(rule('min-height:min(22dvh, 220px)')));
    assert.equal(ok.length, 1);
    assert.equal(ok[0]!.minHeights.length, 1);
    assert.equal(ok[0]!.minHeights[0], 'min(22dvh, 220px)');

    // a second rule with the same selectors -> two matching candidates
    // (the integration length===1 guard fails; the cascade-effective value is ambiguous)
    assert.equal(matching(block(rule('min-height:min(22dvh, 220px)') + rule('min-height:0'))).length, 2);

    // a within-rule duplicate (last declaration wins the cascade) -> one candidate, 2 min-heights
    const dup = matching(block(rule('min-height:min(22dvh, 220px);min-height:0')));
    assert.equal(dup.length, 1);
    assert.equal(dup[0]!.minHeights.length, 2);

    // a case-variant duplicate (MIN-HEIGHT) -> browser treats as the same property -> 2 min-heights
    const caseDup = matching(block(rule('min-height:min(22dvh, 220px);MIN-HEIGHT:0')));
    assert.equal(caseDup.length, 1);
    assert.equal(caseDup[0]!.minHeights.length, 2);
    // a CSS-escaped property name (m\69n-height -> min-height in the browser) -> escapedProp flag set (the integration no-escapedProp guard fails)
    assert.equal(bothPresentCandidates(block(rule('min-height:min(22dvh, 220px);m\\69n-height:0'))).some((c) => c.escapedProp), true);
    // a reordered-:has() competitor (same specificity, later source order wins) -> two :has-scoped min-height rules (the integration count===1 guard fails)
    const reorderedCond = ':has(.maka-artifact-pane:not([data-collapsed="true"])):has(.maka-browser-panel)';
    assert.equal(countHasScopedMinHeightRules(block(rule('min-height:min(22dvh, 220px)') + `${selectors(reorderedCond)}{min-height:0}`)), 2);
    // a :is() target form competitor (same specificity, not a panel-ending literal) -> counted by the independent counter (count===2)
    const isTarget = `.maka-detail-with-artifacts${cond} :is(.maka-browser-panel),.maka-detail-with-artifacts${cond} :is(.maka-artifact-pane)`;
    assert.equal(countHasScopedMinHeightRules(block(rule('min-height:min(22dvh, 220px)') + `${isTarget}{min-height:0}`)), 2);
    // a :HAS() case-variant competitor (CSS pseudo-classes are case-insensitive) -> counted (count===2)
    const upperHas = ':HAS(.maka-browser-panel):HAS(.maka-artifact-pane:not([data-collapsed="true"]))';
    assert.equal(countHasScopedMinHeightRules(block(rule('min-height:min(22dvh, 220px)') + `${selectors(upperHas)}{min-height:0}`)), 2);
    // a :h\61s() escaped-:has competitor (decodes to :has in the browser; source has no literal `:has(`) -> fail closed on the backslash -> counted (count===2)
    const escapedHas = ':h\\61s(.maka-browser-panel):h\\61s(.maka-artifact-pane:not([data-collapsed="true"]))';
    assert.equal(countHasScopedMinHeightRules(block(rule('min-height:min(22dvh, 220px)') + `${selectors(escapedHas)}{min-height:0}`)), 2);
    // a @MEDIA (MAX-WIDTH: 990px) case-variant media competitor (same query; at-rule name + media keywords are case-insensitive) -> counted (count===2)
    assert.equal(countHasScopedMinHeightRules(`@MEDIA (MAX-WIDTH: 990px){${rule('min-height:min(22dvh, 220px)')}${selectors(cond)}{min-height:0}}`), 2);

    // changed selector shapes (negated guard / collapsed-condition / mixed
    // :has() selector-list / missing :not guard) -> selectors != expected -> 0 matching
    const negated = ':has(.maka-browser-panel):not(:has(.maka-artifact-pane:not([data-collapsed="true"])))';
    assert.equal(matching(block(`${selectors(negated)}{min-height:min(22dvh, 220px)}`)).length, 0);
    const collapsedCond = ':has(.maka-browser-panel):has(.maka-artifact-pane[data-collapsed="true"])';
    assert.equal(matching(block(`${selectors(collapsedCond)}{min-height:min(22dvh, 220px)}`)).length, 0);
    const mixedCond = ':has(.maka-browser-panel):has(.maka-artifact-pane:not([data-collapsed="true"]), .maka-artifact-pane[data-collapsed="true"])';
    assert.equal(matching(block(`${selectors(mixedCond)}{min-height:min(22dvh, 220px)}`)).length, 0);
    const noGuard = ':has(.maka-browser-panel):has(.maka-artifact-pane)';
    assert.equal(matching(block(`${selectors(noGuard)}{min-height:min(22dvh, 220px)}`)).length, 0);

    // a wrong value -> matched selectors but the exact-value integration guard fails
    const bare = matching(block(rule('min-height:22dvh')));
    assert.equal(bare.length, 1);
    assert.notEqual(bare[0]!.minHeights[0], 'min(22dvh, 220px)');

    // removal -> 0 matching
    assert.equal(matching(block('')).length, 0);
  });
});
