/**
 * PR-FOCUS-RING-RECIPE-0 (issue #520 PR2):
 * lock the focus-ring recipe so outline width/offset and box-shadow ring
 * width can't drift back to hand-written px values.
 *
 * Three invariants:
 *
 * 1. `outline:` width must be `var(--focus-ring-width)` (or `none` / `0` to
 *    disable focus). Color stays free: `--focus-ring` (strong accent) or
 *    `--ring` (subtle foreground) for two focus strengths, plus alpha
 *    variants (`oklch(from var(--focus-ring) l c h / 0.42)`). One geometric
 *    recipe, two color strengths.
 * 2. `outline-offset:` must be `var(--focus-ring-offset)`.
 * 3. `box-shadow: 0 0 0 <px> var(--ring)` (global *:focus-visible ring) must
 *    use `var(--focus-ring-width)` for the ring width.
 *
 * `--focus-ring-width: 2px` + `--focus-ring-offset: 2px` are declared in
 * maka-tokens.css. The link-focus outline (`outline: 1px solid
 * oklch(from var(--link) …)`) is whitelisted as a one-off — it's a link
 * affordance, not the keyboard focus-ring recipe, and uses a different
 * color/width on purpose.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { REPO_ROOT, TOKENS_FILE, readAllRendererCss, stripCssComments, assertCustomPropPinnedOnce } from './css-test-helpers.js';

// --- whitelist -------------------------------------------------------------

/** Link-focus one-off: `outline: 1px solid oklch(from var(--link) …)` —
 *  not the keyboard focus-ring recipe (different color + width on purpose). */
const LINK_FOCUS_RE = /outline:\s*1px\s+solid\s+oklch\(from\s+var\(--link\)/i;

// --- scanning --------------------------------------------------------------

function findFocusRingOffenders(css: string, label: string): string[] {
  const stripped = stripCssComments(css);
  const offenders: string[] = [];

  // outline: <width> solid <color> — width must be var(--focus-ring-width), or none/0
  for (const m of stripped.matchAll(/(?<![-\w])outline:\s*([^;}\n]+)/gi)) {
    const decl = m[0].trim();
    const value = m[1].trim();

    // outline: none / 0 / 0px — literal disable, OK
    if (/^(?:none|0(?:px)?)\b/i.test(value)) continue;
    // link-focus one-off whitelist
    if (LINK_FOCUS_RE.test(decl)) continue;
    // outline: var(--focus-ring-width) solid … — recipe, OK
    if (/^var\(--focus-ring-width\)\s+solid\b/i.test(value)) continue;

    // any other outline with a bare px width — offender
    if (/^\d+px\s+solid\b/i.test(value)) {
      offenders.push(`${label}: ${decl} (bare outline width — use var(--focus-ring-width))`);
    }
  }

  // outline-offset: must be var(--focus-ring-offset)
  for (const m of stripped.matchAll(/(?<![-\w])outline-offset:\s*([^;}\n]+)/gi)) {
    const decl = m[0].trim();
    const value = m[1].trim();
    if (/^var\(--focus-ring-offset\)/i.test(value)) continue;
    offenders.push(`${label}: ${decl} (bare outline-offset — use var(--focus-ring-offset))`);
  }

  // box-shadow ring width: 0 0 0 <px> var(--ring) — width must be var(--focus-ring-width)
  for (const m of stripped.matchAll(/box-shadow:\s*0\s+0\s+0\s+(\d+px)\s+var\(--ring\)/gi)) {
    offenders.push(`${label}: ${m[0].trim()} (bare ring width in box-shadow — use var(--focus-ring-width))`);
  }

  return offenders;
}

// === tests ==================================================================

describe('PR-FOCUS-RING-RECIPE-0 contract', () => {
  it('renderer CSS uses var(--focus-ring-width/--offset) for outline width/offset + box-shadow ring (no bare px)', async () => {
    const css = await readAllRendererCss();
    const offenders = findFocusRingOffenders(css, 'renderer CSS');
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('--focus-ring-width / --focus-ring-offset are declared exactly once with pinned values', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    assertCustomPropPinnedOnce(tokens, '--focus-ring-width', '2px');
    assertCustomPropPinnedOnce(tokens, '--focus-ring-offset', '2px');
  });
});

describe('focus-ring recipe negative cases', () => {
  it('rejects bare outline width px', () => {
    assert.ok(findFocusRingOffenders('outline: 2px solid var(--focus-ring)', 'test').length > 0, 'bare 2px must fail');
    assert.ok(findFocusRingOffenders('outline: 3px solid var(--ring)', 'test').length > 0, 'bare 3px must fail');
  });

  it('accepts var(--focus-ring-width) + any color (focus-ring/ring/alpha)', () => {
    assert.deepEqual(findFocusRingOffenders('outline: var(--focus-ring-width) solid var(--focus-ring)', 'test'), []);
    assert.deepEqual(findFocusRingOffenders('outline: var(--focus-ring-width) solid var(--ring)', 'test'), []);
    assert.deepEqual(findFocusRingOffenders('outline: var(--focus-ring-width) solid oklch(from var(--focus-ring) l c h / 0.42)', 'test'), []);
  });

  it('accepts outline: none / 0 (disable focus) and link-focus one-off', () => {
    assert.deepEqual(findFocusRingOffenders('outline: none', 'test'), []);
    assert.deepEqual(findFocusRingOffenders('outline: 0', 'test'), []);
    assert.deepEqual(findFocusRingOffenders('outline: 1px solid oklch(from var(--link) l c h / 0.34)', 'test'), []);
  });

  it('rejects bare outline-offset px (and negatives)', () => {
    assert.ok(findFocusRingOffenders('outline-offset: 2px', 'test').length > 0, 'bare 2px must fail');
    assert.ok(findFocusRingOffenders('outline-offset: -2px', 'test').length > 0, 'bare -2px must fail');
    assert.ok(findFocusRingOffenders('outline-offset: 6px', 'test').length > 0, 'bare 6px must fail');
  });

  it('accepts var(--focus-ring-offset)', () => {
    assert.deepEqual(findFocusRingOffenders('outline-offset: var(--focus-ring-offset)', 'test'), []);
  });

  it('rejects bare ring width in box-shadow: 0 0 0 <px> var(--ring)', () => {
    assert.ok(findFocusRingOffenders('box-shadow: 0 0 0 2px var(--ring)', 'test').length > 0, 'bare ring width must fail');
  });

  it('accepts box-shadow ring with var(--focus-ring-width)', () => {
    assert.deepEqual(findFocusRingOffenders('box-shadow: 0 0 0 var(--focus-ring-width) var(--ring)', 'test'), []);
  });
});