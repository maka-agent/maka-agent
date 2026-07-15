/**
 * PR-RADIUS-NESTING-0 (issue #520 PR4 item 12, 2026-07-05):
 * pin the concentric-radius nesting convention so the two calc-nested
 * input sites don't silently regress to a hardcoded tier.
 *
 * Roadmap §1.3 / P-RADIUS: when a rounded surface sits inside another
 * rounded surface with padding between them, the inner radius =
 * outer radius − padding so the two curves share a center and read as
 * one machined shell. Two forms (documented on the radius tokens in
 * maka-tokens.css):
 *
 *   1. If outer − padding lands on a tier, pick that tier directly —
 *      e.g. a settings card (8px surface) inside a 12px modal with 4px
 *      padding: 12 − 4 = 8 = --radius-surface. The radius-converge
 *      contract's SELECTOR_TIER already pins this, so this contract does
 *      not re-check it.
 *
 *   2. If outer − padding does NOT land on a tier, use
 *      `calc(var(--radius-*) - Npx)` — the radius-converge contract's
 *      calc allowlist permits only this shrink form. One site today
 *      uses it: an input inside a 12px modal shell with an 8px inset
 *      (12 − 8 = 4px, not a tier):
 *        .maka-search-modal-input-row  (sidebar.css)
 *      This contract pins it so a later "cleanup" can't drop the calc
 *      and revert to a hardcoded --radius-control (6px) that would read
 *      as too round against the shell corners.
 *
 * The command palette uses the control tier directly: its current header
 * inset is not 8px, so applying this formula there would not be concentric.
 *
 * The settings-modal inner cards (audited) use the surface/control tier
 * inside the modal shell — that is form (1), already governed by the
 * radius-converge SELECTOR_TIER, so no calc is needed there. The seven
 * settings inner surfaces that use --radius-modal are peer sub-modals
 * (login modal, scan modal, select popup), not nested cards, so they
 * legitimately keep the modal tier.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readAllRendererCss, stripCssComments } from './css-test-helpers.js';

/** Extract the body of a CSS rule for an exact selector (first match),
 *  matching the radius-converge SELECTOR_TIER block extraction. */
function ruleBody(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\s/g, '\\s+');
  const normalized = css.replace(/\{/g, '{\n').replace(/\}/g, '\n}');
  const re = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g');
  const m = re.exec(normalized);
  return m ? m[1] : null;
}

describe('PR-RADIUS-NESTING-0 contract', () => {
  it('the modal-inset search input uses calc(var(--radius-modal) - 8px) (12 − 8 = 4px, not a tier)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    const sites: Array<[string, string]> = [
      ['.maka-search-modal-input-row', 'sidebar.css'],
    ];
    for (const [selector, label] of sites) {
      const body = ruleBody(css, selector);
      assert.ok(body, `${selector} rule must exist (${label}) — stale contract entry or renamed selector`);
      assert.match(
        body,
        /border-radius:\s*calc\(var\(--radius-modal\)\s*-\s*8px\)/,
        `${selector} (${label}) must keep the concentric nesting calc(var(--radius-modal) - 8px) — dropping it to a hardcoded tier would make the input read too round against the 12px modal shell`,
      );
    }
  });

  it('the nesting calc uses the shrink form only (the radius-converge calc allowlist enforces this, restated here for the nesting sites)', async () => {
    // No site should ADD to the modal radius (that would break concentricity).
    const css = stripCssComments(await readAllRendererCss());
    const additionSites = [...css.matchAll(/calc\(var\(--radius-[\w-]+\)\s*\+\s*\d+px\)/g)];
    assert.equal(
      additionSites.length,
      0,
      `radius nesting must only SHRINK (calc(var(--radius-*) - Npx)); addition breaks concentricity. Found ${additionSites.length} addition site(s): ${additionSites.map((m) => m[0]).join(', ')}`,
    );
  });
});
