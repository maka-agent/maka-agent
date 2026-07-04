/**
 * PR-LEADING-CONVERGE-0 (issue #520 PR1):
 * lock the line-height vocabulary so individual PRs can't silently drift
 * back to ad-hoc line-height values.
 *
 * Three invariants:
 *
 * 1. CSS `line-height` must reference a whitelisted `--leading-*` token,
 *    use `em` (relative scaling off the element font-size), or be a literal
 *    (`inherit` / `initial` / `unset` / `revert` / `0`). Bare unitless numbers
 *    (1.4, 1.45) and px/rem drift visually and bypass the four-tier scale.
 *    `normal` is banned too — it is a UA default that varies by font and
 *    bypasses the scale; use `var(--leading-normal)` instead.
 *
 * 2. `--leading-{none,tight,snug,normal}` tokens are defined in
 *    `maka-tokens.css` with pinned values (1 / 1.25 / 1.375 / 1.5). A rename
 *    or value change gets flagged at the test layer before any styles site
 *    drifts.
 *
 * 3. Tailwind `--leading-*` aliases in `styles.css` `@theme inline` map to
 *    `var(--leading-*)` so TSX `leading-*` utilities stay single-sourced
 *    with hand-written CSS — same inline-bridge pattern as `--text-*`.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, TOKENS_FILE, readAllRendererCss, stripCssComments, findFontShorthandOffenders, assertTokenPinnedOnce } from './css-test-helpers.js';

const STYLES_FILE = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'styles.css');

// --- token whitelist --------------------------------------------------------

const LEADING_TOKEN_WHITELIST = new Set([
  '--leading-none',
  '--leading-tight',
  '--leading-snug',
  '--leading-normal',
]);

const LITERAL_OK = /^(?:inherit|initial|unset|revert|0)$/;

function extractLineHeightValue(decl: string): string {
  return decl.replace(/^line-height:\s*/i, '').replace(/;$/, '').trim();
}

// --- CSS scanning -----------------------------------------------------------

function findCssOffenders(css: string, label: string): string[] {
  const stripped = stripCssComments(css);
  const offenders: string[] = [];

  // Find every line-height declaration
  const decls = [...stripped.matchAll(/line-height:\s*[^;}\n]+/gi)];
  for (const m of decls) {
    const raw = m[0].trim();
    const value = extractLineHeightValue(raw);

    // Allowed: var(--leading-*)
    if (/^var\(\s*--leading-[\w-]+\s*\)$/.test(value)) {
      const tok = value.match(/^var\(\s*(--leading-[\w-]+)\s*\)$/)?.[1];
      if (tok && LEADING_TOKEN_WHITELIST.has(tok)) continue;
      offenders.push(`${label}: ${raw} (unknown token)`);
      continue;
    }

    // Allowed: em values (relative scaling off element font-size)
    if (/^\d+(?:\.\d+)?em$/.test(value)) continue;

    // Allowed: literals
    if (LITERAL_OK.test(value)) continue;

    // Everything else is a violation (bare numbers, px, rem, normal, etc.)
    offenders.push(`${label}: ${raw}`);
  }

  // Catch non-literal `font:` shorthand — shared helper bans any `font:` that
  // isn't inherit/initial/unset/revert, covering line-height/weight/size bypass.
  offenders.push(...findFontShorthandOffenders(stripped, label));

  return offenders;
}

// === tests ==================================================================

describe('PR-LEADING-CONVERGE-0 contract', () => {
  it('CSS uses only whitelisted --leading-* tokens, em, or literals (no bare numbers/px/normal)', async () => {
    const css = await readAllRendererCss();
    const offenders = findCssOffenders(css, 'renderer CSS');
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('maka-tokens.css uses only whitelisted --leading-* tokens, em, or literals', async () => {
    const tokens = stripCssComments(await readFile(TOKENS_FILE, 'utf8'));
    // Strip the token declaration lines themselves (they legitimately spell numbers)
    const stripped = tokens
      .replace(/^\s*--leading-none:\s*1\s*;.*$/gm, '')
      .replace(/^\s*--leading-tight:\s*1\.25\s*;.*$/gm, '')
      .replace(/^\s*--leading-snug:\s*1\.375\s*;.*$/gm, '')
      .replace(/^\s*--leading-normal:\s*1\.5\s*;.*$/gm, '');
    const offenders = findCssOffenders(stripped, 'maka-tokens.css');
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('--leading-{none,tight,snug,normal} tokens are declared exactly once with pinned values', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    assertTokenPinnedOnce(tokens, '--leading-none', '1');
    assertTokenPinnedOnce(tokens, '--leading-tight', '1.25');
    assertTokenPinnedOnce(tokens, '--leading-snug', '1.375');
    assertTokenPinnedOnce(tokens, '--leading-normal', '1.5');
  });

  it('Tailwind --leading-* aliases map to var(--leading-*) in @theme inline', async () => {
    const styles = await readFile(STYLES_FILE, 'utf8');
    assert.match(styles, /--leading-none:\s*var\(--leading-none\)/, '--leading-none must alias var(--leading-none)');
    assert.match(styles, /--leading-tight:\s*var\(--leading-tight\)/, '--leading-tight must alias var(--leading-tight)');
    assert.match(styles, /--leading-snug:\s*var\(--leading-snug\)/, '--leading-snug must alias var(--leading-snug)');
    assert.match(styles, /--leading-normal:\s*var\(--leading-normal\)/, '--leading-normal must alias var(--leading-normal)');
  });
});

describe('leading whitelist negative cases', () => {
  it('rejects typos and private tokens in var()', () => {
    assert.ok(findCssOffenders('line-height: var(--leading-mata)', 'test').length > 0, 'typo must fail');
    assert.ok(findCssOffenders('line-height: var(--leading-private)', 'test').length > 0, 'private token must fail');
  });

  it('accepts valid tokens, em, and literals', () => {
    assert.deepEqual(findCssOffenders('line-height: var(--leading-none)', 'test'), []);
    assert.deepEqual(findCssOffenders('line-height: var(--leading-tight)', 'test'), []);
    assert.deepEqual(findCssOffenders('line-height: var(--leading-snug)', 'test'), []);
    assert.deepEqual(findCssOffenders('line-height: var(--leading-normal)', 'test'), []);
    assert.deepEqual(findCssOffenders('line-height: 1.2em', 'test'), []);
    assert.deepEqual(findCssOffenders('line-height: inherit', 'test'), []);
    assert.deepEqual(findCssOffenders('line-height: 0', 'test'), []);
  });

  it('rejects bare numbers, px, rem, and normal', () => {
    assert.ok(findCssOffenders('line-height: 1.4', 'test').length > 0, 'bare number must fail');
    assert.ok(findCssOffenders('line-height: 1.45', 'test').length > 0, 'bare number must fail');
    assert.ok(findCssOffenders('line-height: 20px', 'test').length > 0, 'px must fail');
    assert.ok(findCssOffenders('line-height: 1.5rem', 'test').length > 0, 'rem must fail');
    assert.ok(findCssOffenders('line-height: normal', 'test').length > 0, 'normal must fail (use --leading-normal)');
  });

  it('rejects non-literal font: shorthand (bare line-height, var() size, weight bypass)', () => {
    assert.ok(findCssOffenders('font: 12px/1.4 var(--font-sans)', 'test').length > 0, 'shorthand numeric line-height must fail');
    assert.ok(findCssOffenders('font: var(--font-size-ui)/1.4 var(--font-sans)', 'test').length > 0, 'shorthand with var() size must fail (line-height bypass)');
    assert.ok(findCssOffenders('font: 600 var(--font-size-ui) var(--font-sans)', 'test').length > 0, 'shorthand with bare weight must fail');
  });

  it('accepts font: inherit and font: initial', () => {
    assert.deepEqual(findCssOffenders('font: inherit', 'test'), []);
    assert.deepEqual(findCssOffenders('font: initial', 'test'), []);
  });

});