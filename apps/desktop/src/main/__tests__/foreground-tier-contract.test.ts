/**
 * PR-FOREGROUND-TIER-CONVERGE-0 (issue #430 PR4, 2026-07-03):
 * lock the text-color vocabulary so individual PRs can't silently drift
 * back to the old multi-step ladder. Text call sites must use the 3
 * semantic aliases:
 *
 *   var(--foreground)            — primary text (100% ink)
 *   var(--foreground-secondary)  — secondary text (80% ink)
 *   var(--muted-foreground)      — muted text (50% ink)
 *
 * --foreground-40..95 are deleted and must not be re-introduced.
 * Surface wash stops (-2/-3/-5/-8/-10) exist for backgrounds, borders,
 * and other non-text surfaces; they must NOT be used as text color.
 *
 * Invariants:
 *
 * 1. CSS text-color props (color/fill/stroke/caret-color/...) must not
 *    reference --foreground-2..95. Only --foreground, --foreground-
 *    secondary, --muted-foreground are allowed as text color.
 *
 * 2. TS/TSX files must not reference --foreground-40..95 at all (any
 *    syntax form). Tailwind utility classes text-foreground-2..95 are
 *    also banned as text color.
 *
 * 3. @theme must not export --color-foreground-40..95 as Tailwind
 *    color utilities.
 */

import { strict as assert } from 'node:assert';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, TOKENS_FILE, readAllRendererCss, stripCssComments } from './css-test-helpers.js';

// --- banned foreground numbers ----------------------------------------------

/** All foreground mix-stop numbers that must never be used as text color. */
const BANNED_TEXT_NUMS = ['40', '50', '60', '70', '80', '90', '95'];

/** Surface-wash numbers — allowed in bg/border context, banned in text context. */
const SURFACE_WASH_NUMS = ['2', '3', '5', '8', '10'];

/** All banned numbers for TSX (text + surface, since TSX can't distinguish context). */
const ALL_BANNED_NUMS = [...BANNED_TEXT_NUMS, ...SURFACE_WASH_NUMS];

// Properties that set TEXT color (not background/border/shadow).
const TEXT_PROP_RE = /^(color|fill|stroke|caret-color|text-decoration-color|column-rule-color)$/i;

// CSS `var(--foreground-N)` reference (N = digits).
const VAR_FOREGROUND_N_RE = /var\(\s*(--foreground-\d+)\s*\)/g;

// --- CSS scanning -----------------------------------------------------------

/**
 * Extract color property declarations and check they don't reference
 * any banned foreground stop as text color. Text props must only use
 * the 3 semantic aliases (--foreground, --foreground-secondary,
 * --muted-foreground). Surface wash stops are banned in text context
 * but allowed in bg/border context.
 */
function findCssTextOffenders(css: string, label: string): string[] {
  const stripped = stripCssComments(css);
  const offenders: string[] = [];
  const bannedNumsSet = new Set(BANNED_TEXT_NUMS.concat(SURFACE_WASH_NUMS));

  const declRe = /([\w-]+)\s*:\s*([^;}\n]+?)\s*(?:[;}|\n]|$)/gi;
  for (const m of stripped.matchAll(declRe)) {
    const prop = m[1]!;
    const rawVal = m[2]!.trim();
    if (!TEXT_PROP_RE.test(prop)) continue;

    for (const vm of rawVal.matchAll(VAR_FOREGROUND_N_RE)) {
      const tok = vm[1]!;
      const num = tok.replace('--foreground-', '');
      if (bannedNumsSet.has(num)) {
        offenders.push(`${label}: ${prop}: ${rawVal} [banned ${tok}]`);
      }
    }
  }

  return offenders;
}

// --- TSX scanning -----------------------------------------------------------

/**
 * Two-layer scan strategy:
 *
 * 1. RAW_STOP_RE: --foreground-40..95 are deleted; ban them from TS/TSX
 *    entirely (any syntax form, any context).
 *
 * 2. TEXT_CONTEXT_RE: surface wash stops (2/3/5/8/10) are allowed in
 *    surface context (bg-/background/border-/ring-/from-/to-/via-) but
 *    banned in text-like context. We match any occurrence of
 *    --foreground-N preceded by a text-like utility prefix, regardless
 *    of the surrounding Tailwind syntax (arbitrary value, shorthand,
 *    inline style, var with fallback, etc.).
 *
 *    Text-like prefixes: text-, fill-, stroke-, caret-, decoration-,
 *    color: (inline style), [color: (arbitrary property), and the
 *    Tailwind v4 shorthand type-hint form text-(color:...).
 *
 *    This approach does NOT depend on var() being properly closed,
 *    so `var(--foreground-5, currentColor)` is caught.
 *
 *    Surface-context prefixes (bg-, border-, ring-, from-, to-, via-,
 *    background:, [background:, [border:) are NOT matched — surface
 *    wash stops remain addressable there.
 */
const RAW_STOP_RE = /--foreground-(40|50|60|70|80|90|95)\b/g;

/**
 * TEXT_CONTEXT_RE: matches surface wash stops (2/3/5/8/10) when preceded
 * by a text-like context. Matches the full sequence from prefix to token,
 * capturing N. Does NOT depend on var() being properly closed.
 *
 * Text-like prefixes matched:
 *   text-foreground-N          (utility class)
 *   text-[color:var(--fg-N)]   (arbitrary value)
 *   text-[var(--fg-N)]         (arbitrary value, no color:)
 *   text-(--fg-N)              (shorthand)
 *   text-(color:--fg-N)       (type-hint shorthand)
 *   fill/stroke/caret/decoration-foreground-N
 *   fill/stroke-[...var(--fg-N)]
 *   fill/stroke-(--fg-N)
 *   [color:var(--fg-N)]        (arbitrary property)
 *   color: var(--fg-N)         (inline style)
 *   color: var(--fg-N, ...)    (inline style w/ fallback)
 *
 * Surface prefixes NOT matched (allowed):
 *   bg-foreground-N, bg-[var(--fg-N)], border-foreground-N,
 *   background: var(--fg-N), [background:var(--fg-N)]
 *
 * The regex has three alternatives:
 * A) Utility class form: (text|fill|stroke|caret|decoration)-foreground-N
 * B) Arbitrary value / shorthand form with bracket or paren:
 *    (text|fill|stroke|caret|decoration)-[\( or \[](?:color:)?var?...--foreground-N
 *    Also covers bare [color:var(--fg-N)] (no utility prefix).
 * C) Inline style: color/fill/stroke: "...var(--fg-N"
 */
const TEXT_CONTEXT_RE = new RegExp(
  // A) utility class: text-foreground-5, fill-foreground-5, etc.
  '(?:text|fill|stroke|caret|decoration)-foreground-(\\d+)'
  // B) arbitrary value or shorthand with text-like utility prefix:
  //    text-[color:var(--fg-N)], text-[var(--fg-N)], text-(--fg-N),
  //    text-(color:--fg-N), fill-[...], stroke-(...)
  + '|(?:text|fill|stroke|caret|decoration)-[(\\[](?:color:)?(?:var\\()?(?:\\s*)?--foreground-(\\d+)'
  // C) arbitrary property (no utility prefix): [color:var(--fg-N)]
  //    Must start with [color: to distinguish from bg-[var(--fg-N)].
  + '|\\[color:(?:var\\()?(?:\\s*)?--foreground-(\\d+)'
  // D) inline style string: color: "var(--foreground-N...", color: var(--fg-N...
  + '|(?:color|fill|stroke)\\s*:\\s*["\']?var\\(\\s*--foreground-(\\d+)'
  , 'g');

async function collectTsxOffenders(dirs: string[]): Promise<string[]> {
  const offenders: string[] = [];
  const surfaceSet = new Set(SURFACE_WASH_NUMS);
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!/\.(tsx|ts)$/.test(entry.name)) continue;
      if (entry.name.includes('.test.')) continue;
      const src = await readFile(full, 'utf8');
      const label = full.replace(REPO_ROOT + '/', '');

      // Deleted stops: banned in any context.
      for (const m of src.matchAll(RAW_STOP_RE)) {
        offenders.push(`${label}: --foreground-${m[1]}`);
      }
      // Surface wash in text-like context, OR any text-foreground-N
      // utility class (all N banned as text, not just surface wash).
      for (const m of src.matchAll(TEXT_CONTEXT_RE)) {
        const num = m[1] || m[2] || m[3] || m[4];
        if (!num) continue;
        // Alternative A (utility class): ban all N — deleted stops
        // (40..95) and surface wash (2/3/5/8/10) alike.
        if (m[1]) {
          offenders.push(`${label}: text-foreground-${num}`);
        }
        // Alternatives B/C/D: only surface wash banned in text context.
        else if (surfaceSet.has(num)) {
          offenders.push(`${label}: text-context --foreground-${num}`);
        }
      }
    }
  }
  for (const dir of dirs) {
    await walk(resolve(REPO_ROOT, dir));
  }
  return offenders;
}

// === tests ==================================================================

/** Scan a TSX source snippet for banned foreground references. */
function scanTsxSnippet(src: string): string[] {
  const offenders: string[] = [];
  const surfaceSet = new Set(SURFACE_WASH_NUMS);
  for (const m of src.matchAll(RAW_STOP_RE)) {
    offenders.push(`--foreground-${m[1]}`);
  }
  for (const m of src.matchAll(TEXT_CONTEXT_RE)) {
    const num = m[1] || m[2] || m[3] || m[4];
    if (!num) continue;
    if (m[1]) {
      offenders.push(`text-foreground-${num}`);
    } else if (surfaceSet.has(num)) {
      offenders.push(`text-context --foreground-${num}`);
    }
  }
  return offenders;
}

describe('PR-FOREGROUND-TIER-CONVERGE-0 contract', () => {
  it('CSS text-color props use semantic aliases, not raw --foreground-40..80', async () => {
    const css = await readAllRendererCss();
    const offenders = findCssTextOffenders(css, 'renderer CSS');
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('maka-tokens.css text-color props use semantic aliases', async () => {
    const tokens = stripCssComments(await readFile(TOKENS_FILE, 'utf8'));
    // Strip alias definition lines and @theme mirror lines — they
    // legitimately reference --foreground (no number suffix).
    const stripped = tokens
      .replace(/^\s*--muted-foreground:\s*color-mix.*$/gm, '')
      .replace(/^\s*--foreground-secondary:\s*color-mix.*$/gm, '')
      .replace(/^\s*--color-foreground-secondary:.*$/gm, '')
      .replace(/^\s*--color-muted-foreground:.*$/gm, '');
    const offenders = findCssTextOffenders(stripped, 'maka-tokens.css');
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('TSX text-color uses semantic aliases, not raw --foreground-40..80', async () => {
    const offenders = await collectTsxOffenders([
      'packages/ui/src',
      'packages/ui/stories',
      'apps/desktop/src/renderer',
    ]);
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('--muted-foreground is defined as 50% foreground mix', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    assert.match(tokens, /--muted-foreground:\s*color-mix\(in oklch,\s*var\(--foreground\)\s*50%,\s*var\(--background\)\)/, '--muted-foreground must be 50% foreground mix');
  });

  it('--foreground-secondary is defined as 80% foreground mix', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    assert.match(tokens, /--foreground-secondary:\s*color-mix\(in oklch,\s*var\(--foreground\)\s*80%,\s*var\(--background\)\)/, '--foreground-secondary must be 80% foreground mix');
  });

  it('raw text mix stops --foreground-40..95 are not defined', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    for (const num of BANNED_TEXT_NUMS) {
      const re = new RegExp(`^\\s*--foreground-${num}:`, 'm');
      assert.doesNotMatch(tokens, re, `--foreground-${num} must not be defined`);
    }
  });

  it('@theme inline exports the semantic aliases', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    assert.match(tokens, /--color-foreground-secondary:\s*var\(--foreground-secondary\)/, '@theme must export --color-foreground-secondary');
    assert.match(tokens, /--color-muted-foreground:\s*var\(--muted-foreground\)/, '@theme must export --color-muted-foreground');
  });

  it('@theme inline does not export raw text stops --foreground-40..95', async () => {
    const tokens = stripCssComments(await readFile(TOKENS_FILE, 'utf8'));
    for (const num of BANNED_TEXT_NUMS) {
      const re = new RegExp(`--color-foreground-${num}\\s*:`);
      assert.doesNotMatch(tokens, re, `@theme must not export --color-foreground-${num}`);
    }
  });
});

describe('foreground-tier negative cases', () => {
  it('rejects raw --foreground-60 in color props', () => {
    assert.ok(findCssTextOffenders('color: var(--foreground-60)', 'test').length > 0, 'raw --foreground-60 in color must fail');
  });

  it('accepts --muted-foreground in color props', () => {
    assert.deepEqual(findCssTextOffenders('color: var(--muted-foreground)', 'test'), []);
  });

  it('accepts --foreground-secondary in color props', () => {
    assert.deepEqual(findCssTextOffenders('color: var(--foreground-secondary)', 'test'), []);
  });

  it('does not scan background/border props for text-stop violations', () => {
    assert.deepEqual(findCssTextOffenders('background: var(--foreground-5)', 'test'), []);
    assert.deepEqual(findCssTextOffenders('border-color: var(--foreground-10)', 'test'), []);
  });

  it('accepts --foreground (100% ink) in color props', () => {
    assert.deepEqual(findCssTextOffenders('color: var(--foreground)', 'test'), []);
  });

  it('rejects text-[color:var(--foreground-60)] in TSX', () => {
    assert.ok(scanTsxSnippet("text-[color:var(--foreground-60)]").length > 0);
  });

  it('rejects text-[var(--foreground-60)] in TSX', () => {
    assert.ok(scanTsxSnippet("text-[var(--foreground-60)]").length > 0);
  });

  it('rejects disabled:text-[var(--foreground-40)] in TSX', () => {
    assert.ok(scanTsxSnippet("disabled:text-[var(--foreground-40)]").length > 0);
  });

  it('rejects text-foreground-60 Tailwind utility in TSX', () => {
    assert.ok(scanTsxSnippet("text-foreground-60").length > 0);
  });

  it('rejects className="text-[var(--foreground-60)]" (quoted string)', () => {
    assert.ok(scanTsxSnippet('className="text-[var(--foreground-60)]"').length > 0);
  });

  it('rejects cn("text-[var(--foreground-60)]") (cn call)', () => {
    assert.ok(scanTsxSnippet('cn("text-[var(--foreground-60)]")').length > 0);
  });

  it('rejects `text-[var(--foreground-60)]` (template literal)', () => {
    assert.ok(scanTsxSnippet('`text-[var(--foreground-60)]`').length > 0);
  });

  it('rejects style={{ color: "var(--foreground-60)" }} (inline style)', () => {
    assert.ok(scanTsxSnippet('style={{ color: "var(--foreground-60)" }}').length > 0);
  });

  it('rejects text-(--foreground-60) Tailwind shorthand', () => {
    assert.ok(scanTsxSnippet("text-(--foreground-60)").length > 0);
  });

  it('rejects hover:text-(--foreground-60) variant + shorthand', () => {
    assert.ok(scanTsxSnippet("hover:text-(--foreground-60)").length > 0);
  });

  it('rejects fill-(--foreground-50) fill shorthand', () => {
    assert.ok(scanTsxSnippet("fill-(--foreground-50)").length > 0);
  });

  it('accepts text-[color:var(--foreground-secondary)] in TSX', () => {
    assert.deepEqual(scanTsxSnippet("text-[color:var(--foreground-secondary)]"), []);
  });

  it('accepts text-[color:var(--muted-foreground)] in TSX', () => {
    assert.deepEqual(scanTsxSnippet("text-[color:var(--muted-foreground)]"), []);
  });

  // P2: CSS 90/95 must be banned in text props too
  it('rejects color: var(--foreground-90) in CSS', () => {
    assert.ok(findCssTextOffenders('color: var(--foreground-90)', 'test').length > 0);
  });

  it('rejects fill: var(--foreground-95) in CSS', () => {
    assert.ok(findCssTextOffenders('fill: var(--foreground-95)', 'test').length > 0);
  });

  // P2: surface wash stops banned in text context
  it('rejects text-foreground-5 (surface wash as text) in TSX', () => {
    assert.ok(scanTsxSnippet("text-foreground-5").length > 0);
  });

  it('rejects text-[color:var(--foreground-5)] in TSX', () => {
    assert.ok(scanTsxSnippet("text-[color:var(--foreground-5)]").length > 0);
  });

  it('rejects text-(--foreground-5) in TSX', () => {
    assert.ok(scanTsxSnippet("text-(--foreground-5)").length > 0);
  });

  it('rejects color: var(--foreground-5) in CSS text prop', () => {
    assert.ok(findCssTextOffenders('color: var(--foreground-5)', 'test').length > 0);
  });

  // P2: surface wash stops allowed in non-text context
  it('accepts bg-foreground-5 in TSX (bg context)', () => {
    assert.deepEqual(scanTsxSnippet("bg-foreground-5"), []);
  });

  it('accepts bg-[var(--foreground-5)] in TSX (bg context)', () => {
    assert.deepEqual(scanTsxSnippet("bg-[var(--foreground-5)]"), []);
  });

  it('accepts background: var(--foreground-5) in CSS (bg context)', () => {
    assert.deepEqual(findCssTextOffenders('background: var(--foreground-5)', 'test'), []);
  });

  it('accepts border-color: var(--foreground-10) in CSS (border context)', () => {
    assert.deepEqual(findCssTextOffenders('border-color: var(--foreground-10)', 'test'), []);
  });

  // P2: arbitrary property, type-hint shorthand, fill/stroke/caret/decoration utility
  it('rejects [color:var(--foreground-5)] (arbitrary property) in TSX', () => {
    assert.ok(scanTsxSnippet("[color:var(--foreground-5)]").length > 0);
  });

  it('rejects hover:[color:var(--foreground-5)] in TSX', () => {
    assert.ok(scanTsxSnippet("hover:[color:var(--foreground-5)]").length > 0);
  });

  it('rejects text-(color:--foreground-5) (type-hint shorthand) in TSX', () => {
    assert.ok(scanTsxSnippet("text-(color:--foreground-5)").length > 0);
  });

  it('rejects fill-foreground-5 in TSX', () => {
    assert.ok(scanTsxSnippet("fill-foreground-5").length > 0);
  });

  it('rejects stroke-foreground-5 in TSX', () => {
    assert.ok(scanTsxSnippet("stroke-foreground-5").length > 0);
  });

  it('rejects caret-foreground-5 in TSX', () => {
    assert.ok(scanTsxSnippet("caret-foreground-5").length > 0);
  });

  it('rejects decoration-foreground-5 in TSX', () => {
    assert.ok(scanTsxSnippet("decoration-foreground-5").length > 0);
  });

  // P2: var() with fallback — must not depend on closing paren
  it('rejects color: var(--foreground-5, currentColor) (var with fallback) in TSX', () => {
    assert.ok(scanTsxSnippet("color: var(--foreground-5, currentColor)").length > 0);
  });

  it('rejects text-[color:var(--foreground-5,currentColor)] in TSX', () => {
    assert.ok(scanTsxSnippet("text-[color:var(--foreground-5,currentColor)]").length > 0);
  });

  // P2: surface context still allowed
  it('accepts [background:var(--foreground-5)] in TSX (bg arbitrary property)', () => {
    assert.deepEqual(scanTsxSnippet("[background:var(--foreground-5)]"), []);
  });

  it('accepts border-foreground-10 in TSX (border context)', () => {
    assert.deepEqual(scanTsxSnippet("border-foreground-10"), []);
  });

  // P2: @theme 90/95 export banned
  it('@theme must not export --color-foreground-90/95', async () => {
    const tokens = stripCssComments(await readFile(TOKENS_FILE, 'utf8'));
    for (const num of ['90', '95']) {
      const re = new RegExp(`--color-foreground-${num}\\s*:`);
      assert.doesNotMatch(tokens, re, `@theme must not export --color-foreground-${num}`);
    }
  });
});