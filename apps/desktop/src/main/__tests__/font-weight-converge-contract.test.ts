/**
 * PR-FONT-WEIGHT-CONVERGE-0 (issue #520 PR1):
 * lock the font-weight vocabulary so individual PRs can't silently drift
 * back to ad-hoc font-weight values.
 *
 * Three invariants:
 *
 * 1. CSS `font-weight` must reference a whitelisted `--font-weight-*` token
 *    or be a literal (`inherit` / `initial` / `unset` / `revert`). Bare numbers
 *    (400/500/550/600/620/650/680/700) and keyword weights (`normal` / `bold`
 *    / `lighter` / `bolder`) drift visually and bypass the four-tier scale;
 *    `normal`/`bold` are banned too because they are aliases for 400/700 that
 *    hide which tier is in use.
 *
 * 2. `--font-weight-{normal,medium,semibold,bold}` tokens are defined in
 *    `maka-tokens.css` with pinned values (400 / 500 / 600 / 700).
 *
 * 3. Tailwind `--font-weight-*` aliases in `styles.css` `@theme inline` map to
 *    `var(--font-weight-*)` so TSX `font-*` utilities stay single-sourced —
 *    same inline-bridge pattern as `--text-*` / `--leading-*`.
 *
 * Variable-weight Geist + system-ui means 550/620/650/680 are mid-axis picks;
 * they snap to the nearest tier (550/620/650 → semibold 600, 680 → bold 700).
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, TOKENS_FILE, readAllRendererCss, stripCssComments, findFontShorthandOffenders } from './css-test-helpers.js';

const STYLES_FILE = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'styles.css');

// --- token whitelist --------------------------------------------------------

const FONT_WEIGHT_TOKEN_WHITELIST = new Set([
  '--font-weight-normal',
  '--font-weight-medium',
  '--font-weight-semibold',
  '--font-weight-bold',
]);

const LITERAL_OK = /^(?:inherit|initial|unset|revert)$/;

function extractFontWeightValue(decl: string): string {
  return decl.replace(/^font-weight:\s*/i, '').replace(/;$/, '').trim();
}

// --- CSS scanning -----------------------------------------------------------

function findCssOffenders(css: string, label: string): string[] {
  const stripped = stripCssComments(css);
  const offenders: string[] = [];

  const decls = [...stripped.matchAll(/font-weight:\s*[^;}\n]+/gi)];
  for (const m of decls) {
    const raw = m[0].trim();
    const value = extractFontWeightValue(raw);

    // Allowed: var(--font-weight-*)
    if (/^var\(\s*--font-weight-[\w-]+\s*\)$/.test(value)) {
      const tok = value.match(/^var\(\s*(--font-weight-[\w-]+)\s*\)$/)?.[1];
      if (tok && FONT_WEIGHT_TOKEN_WHITELIST.has(tok)) continue;
      offenders.push(`${label}: ${raw} (unknown token)`);
      continue;
    }

    // Allowed: literals
    if (LITERAL_OK.test(value)) continue;

    // Everything else is a violation (bare numbers, normal/bold/lighter/bolder, px, etc.)
    offenders.push(`${label}: ${raw}`);
  }

  // Catch non-literal `font:` shorthand — shared helper bans any `font:` that
  // isn't inherit/initial/unset/revert, covering weight/size/line-height bypass.
  offenders.push(...findFontShorthandOffenders(stripped, label));

  return offenders;
}

// === tests ==================================================================

describe('PR-FONT-WEIGHT-CONVERGE-0 contract', () => {
  it('CSS uses only whitelisted --font-weight-* tokens or literals (no bare numbers/normal/bold)', async () => {
    const css = await readAllRendererCss();
    const offenders = findCssOffenders(css, 'renderer CSS');
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('maka-tokens.css uses only whitelisted --font-weight-* tokens or literals', async () => {
    const tokens = stripCssComments(await readFile(TOKENS_FILE, 'utf8'));
    const stripped = tokens
      .replace(/^\s*--font-weight-normal:\s*400\s*;.*$/gm, '')
      .replace(/^\s*--font-weight-medium:\s*500\s*;.*$/gm, '')
      .replace(/^\s*--font-weight-semibold:\s*600\s*;.*$/gm, '')
      .replace(/^\s*--font-weight-bold:\s*700\s*;.*$/gm, '');
    const offenders = findCssOffenders(stripped, 'maka-tokens.css');
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('--font-weight-{normal,medium,semibold,bold} tokens are defined with pinned values', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    assert.match(tokens, /--font-weight-normal:\s*400\s*;/, '--font-weight-normal must be 400');
    assert.match(tokens, /--font-weight-medium:\s*500\s*;/, '--font-weight-medium must be 500');
    assert.match(tokens, /--font-weight-semibold:\s*600\s*;/, '--font-weight-semibold must be 600');
    assert.match(tokens, /--font-weight-bold:\s*700\s*;/, '--font-weight-bold must be 700');
  });

  it('Tailwind --font-weight-* aliases map to var(--font-weight-*) in @theme inline', async () => {
    const styles = await readFile(STYLES_FILE, 'utf8');
    assert.match(styles, /--font-weight-normal:\s*var\(--font-weight-normal\)/, '--font-weight-normal must alias var(--font-weight-normal)');
    assert.match(styles, /--font-weight-medium:\s*var\(--font-weight-medium\)/, '--font-weight-medium must alias var(--font-weight-medium)');
    assert.match(styles, /--font-weight-semibold:\s*var\(--font-weight-semibold\)/, '--font-weight-semibold must alias var(--font-weight-semibold)');
    assert.match(styles, /--font-weight-bold:\s*var\(--font-weight-bold\)/, '--font-weight-bold must alias var(--font-weight-bold)');
  });
});

describe('font-weight whitelist negative cases', () => {
  it('rejects typos and private tokens in var()', () => {
    assert.ok(findCssOffenders('font-weight: var(--font-weight-mata)', 'test').length > 0, 'typo must fail');
    assert.ok(findCssOffenders('font-weight: var(--font-weight-private)', 'test').length > 0, 'private token must fail');
  });

  it('accepts valid tokens and literals', () => {
    assert.deepEqual(findCssOffenders('font-weight: var(--font-weight-normal)', 'test'), []);
    assert.deepEqual(findCssOffenders('font-weight: var(--font-weight-medium)', 'test'), []);
    assert.deepEqual(findCssOffenders('font-weight: var(--font-weight-semibold)', 'test'), []);
    assert.deepEqual(findCssOffenders('font-weight: var(--font-weight-bold)', 'test'), []);
    assert.deepEqual(findCssOffenders('font-weight: inherit', 'test'), []);
    assert.deepEqual(findCssOffenders('font-weight: initial', 'test'), []);
  });

  it('rejects bare numbers and keyword weights', () => {
    assert.ok(findCssOffenders('font-weight: 400', 'test').length > 0, 'bare 400 must fail');
    assert.ok(findCssOffenders('font-weight: 600', 'test').length > 0, 'bare 600 must fail');
    assert.ok(findCssOffenders('font-weight: 550', 'test').length > 0, 'mid-axis 550 must fail');
    assert.ok(findCssOffenders('font-weight: normal', 'test').length > 0, 'normal must fail (use --font-weight-normal)');
    assert.ok(findCssOffenders('font-weight: bold', 'test').length > 0, 'bold must fail (use --font-weight-bold)');
    assert.ok(findCssOffenders('font-weight: lighter', 'test').length > 0, 'lighter must fail');
  });

  it('rejects non-literal font: shorthand (bare weight, var() size, line-height bypass)', () => {
    assert.ok(findCssOffenders('font: 600 12px sans-serif', 'test').length > 0, 'shorthand numeric weight must fail');
    assert.ok(findCssOffenders('font: bold 12px sans-serif', 'test').length > 0, 'shorthand bold must fail');
    assert.ok(findCssOffenders('font: 600 var(--font-size-ui) var(--font-sans)', 'test').length > 0, 'shorthand with var() size must fail (weight bypass)');
    assert.ok(findCssOffenders('font: var(--font-size-ui)/1.4 var(--font-sans)', 'test').length > 0, 'shorthand with bare line-height must fail');
  });

  it('accepts font: inherit and font: initial', () => {
    assert.deepEqual(findCssOffenders('font: inherit', 'test'), []);
    assert.deepEqual(findCssOffenders('font: initial', 'test'), []);
  });

  it('pin regex rejects drifted token values (no prefix matching)', () => {
    assert.ok(!/--font-weight-normal:\s*400\s*;/.test('--font-weight-normal: 4000;'), '4000 must not satisfy 400');
    assert.ok(!/--font-weight-semibold:\s*600\s*;/.test('--font-weight-semibold: 650;'), '650 must not satisfy 600');
    assert.ok(!/--font-weight-bold:\s*700\s*;/.test('--font-weight-bold: 70;'), '70 must not satisfy 700');
  });
});