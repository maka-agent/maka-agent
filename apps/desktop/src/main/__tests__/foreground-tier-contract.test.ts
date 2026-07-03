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

// Properties that set TEXT color (not background/border/shadow).
const TEXT_PROP_RE = /^(color|fill|stroke|caret-color|text-decoration-color|column-rule-color)$/i;

// CSS `--foreground-N` token reference (N = digits). Does NOT require
// var() to be closed — catches `var(--foreground-5, currentColor)`.
const FOREGROUND_TOKEN_RE = /--foreground-(\d+)\b/g;

// --- CSS scanning -----------------------------------------------------------

/**
 * Extract color property declarations and check they don't reference
 * any banned foreground stop as text color. Text props must only use
 * the 3 semantic aliases (--foreground, --foreground-secondary,
 * --muted-foreground). Surface wash stops are banned in text context
 * but allowed in bg/border context.
 *
 * Declaration values may span multiple lines (e.g. color-mix() with
 * line breaks). The value regex matches [^;}]+ so newlines are
 * included.
 */
function findCssTextOffenders(css: string, label: string): string[] {
  const stripped = stripCssComments(css);
  const offenders: string[] = [];
  const bannedNumsSet = new Set(BANNED_TEXT_NUMS.concat(SURFACE_WASH_NUMS));

  // Value may span multiple lines — stop at ; or } (or EOF).
  const declRe = /([\w-]+)\s*:\s*([^;}]+?)\s*(?:[;}]|$)/gi;
  for (const m of stripped.matchAll(declRe)) {
    const prop = m[1]!;
    const rawVal = m[2]!.trim();
    if (!TEXT_PROP_RE.test(prop)) continue;

    for (const vm of rawVal.matchAll(FOREGROUND_TOKEN_RE)) {
      const num = vm[1]!;
      if (bannedNumsSet.has(num)) {
        offenders.push(`${label}: ${prop}: ${rawVal} [banned --foreground-${num}]`);
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
 * 2. Token-based context scan: split source into class-like tokens, then
 *    classify each token as text-like or surface-like by its prefix.
 *    Text-like tokens (text/fill/stroke/caret/decoration prefix, or bare
 *    [color:...] arbitrary property) trigger a search for --foreground-N
 *    anywhere inside the token — not just right after the prefix. This
 *    catches complex arbitrary values like
 *    text-[color:color-mix(in_oklch,var(--foreground-5),...)].
 *
 *    Inline-style declarations (color:/fill:/stroke: followed by a value
 *    that may span whitespace) are scanned separately, since the
 *    property name and value can be split across tokens by whitespace.
 *
 *    Surface-context prefixes (bg-, border-, ring-, from-, to-, via-,
 *    [background:, [border-color:) are NOT matched — surface wash stops
 *    remain addressable there.
 */
const RAW_STOP_RE = /--foreground-(40|50|60|70|80|90|95)\b/g;

/** Utility prefixes that set TEXT color. */
const TEXT_PREFIXES = new Set(['text', 'fill', 'stroke', 'caret', 'decoration']);

/**
 * Strip Tailwind variant prefixes (hover:, sm:, disabled:, group-hover:,
 * etc.) from a class token. Handles stacked variants.
 */
function stripVariant(cls: string): string {
  let s = cls;
  while (/^[a-z][a-z-]*:/.test(s)) s = s.replace(/^[a-z][a-z-]*:/, '');
  return s;
}

/** Does this class token have a text-like utility prefix? */
function isTextLikeClass(cls: string): boolean {
  const m = stripVariant(cls).match(/^([a-z]+)/);
  return m !== null && TEXT_PREFIXES.has(m[1]!);
}

/** Bare arbitrary property setting text color: [color:...], [caret-color:...], etc. */
const BARE_TEXT_PROP_RE = /^\[(color|caret-color|text-decoration-color|column-rule-color):/i;

function isBareTextProperty(cls: string): boolean {
  return BARE_TEXT_PROP_RE.test(stripVariant(cls));
}

/** Utility class form: text-foreground-N (no --). Captures N. */
const UTILITY_CLASS_RE = /^(?:text|fill|stroke|caret|decoration)-foreground-(\d+)/;

/** Inline-style declaration: color/fill/stroke: ... var(--foreground-N) ... */
const INLINE_STYLE_RE = /(?:^|[\s;{])(?:color|fill|stroke)\s*:\s*var\(\s*--foreground-(\d+)/gi;

/** Splits source into class-like tokens (non-whitespace, non-quote, non-brace). */
const TOKEN_RE = /[^\s"'`;{}=]+/g;

/** Find --foreground-N (any N) inside a token string. */
const FG_IN_TOKEN_RE = /--foreground-(\d+)\b/g;

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
      offenders.push(...scanTsx(src).map((o) => `${label}: ${o}`));
    }
  }
  for (const dir of dirs) {
    await walk(resolve(REPO_ROOT, dir));
  }
  return offenders;
}

/** Scan TS/TSX source for banned foreground references. Returns offender strings. */
function scanTsx(src: string): string[] {
  const offenders: string[] = [];
  const surfaceSet = new Set(SURFACE_WASH_NUMS);

  // 1. Deleted stops: banned in any context.
  for (const m of src.matchAll(RAW_STOP_RE)) {
    offenders.push(`--foreground-${m[1]}`);
  }

  // 2. Class-like tokens: check if text-like context, then search for
  //    --foreground-N anywhere inside (handles complex arbitrary values).
  for (const m of src.matchAll(TOKEN_RE)) {
    const tok = m[0];
    if (!tok.includes('foreground')) continue;
    if (!isTextLikeClass(tok) && !isBareTextProperty(tok)) continue;

    // Utility class form: text-foreground-N (no -- prefix) — ban all N.
    const um = stripVariant(tok).match(UTILITY_CLASS_RE);
    if (um) {
      offenders.push(`text-foreground-${um[1]}`);
    }

    // CSS var form: --foreground-N anywhere in token — ban surface wash.
    for (const fm of tok.matchAll(FG_IN_TOKEN_RE)) {
      const num = fm[1]!;
      if (surfaceSet.has(num)) {
        offenders.push(`text-context --foreground-${num}`);
      }
    }
  }

  // 3. Inline-style: color/fill/stroke: var(--foreground-N) — value may
  //    span whitespace (e.g. "color: var(--foreground-5)").
  INLINE_STYLE_RE.lastIndex = 0;
  for (const m of src.matchAll(INLINE_STYLE_RE)) {
    const num = m[1]!;
    if (surfaceSet.has(num) || BANNED_TEXT_NUMS.includes(num)) {
      offenders.push(`inline-style --foreground-${num}`);
    }
  }

  return offenders;
}

// === tests ==================================================================

/** Scan a TSX source snippet for banned foreground references. */
function scanTsxSnippet(src: string): string[] {
  return scanTsx(src);
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

  it('renderer CSS has no deleted raw --foreground-40..95 (any context)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    const offenders: string[] = [];
    for (const m of css.matchAll(RAW_STOP_RE)) {
      offenders.push(`renderer CSS: --foreground-${m[1]}`);
    }
    assert.deepEqual(offenders, [], `Deleted raw stops must not appear:\n  ${offenders.join('\n  ')}`);
  });

  it('maka-tokens.css has no deleted raw --foreground-40..95 (any context)', async () => {
    const tokens = stripCssComments(await readFile(TOKENS_FILE, 'utf8'));
    const offenders: string[] = [];
    for (const m of tokens.matchAll(RAW_STOP_RE)) {
      offenders.push(`maka-tokens.css: --foreground-${m[1]}`);
    }
    assert.deepEqual(offenders, [], `Deleted raw stops must not appear:\n  ${offenders.join('\n  ')}`);
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

  // P3: surface arbitrary property must not be误杀
  it('accepts [border-color:var(--foreground-10)] in TSX (border arbitrary property)', () => {
    assert.deepEqual(scanTsxSnippet("[border-color:var(--foreground-10)]"), []);
  });

  it('accepts [background-color:var(--foreground-5)] in TSX (bg arbitrary property)', () => {
    assert.deepEqual(scanTsxSnippet("[background-color:var(--foreground-5)]"), []);
  });

  it('rejects [caret-color:var(--foreground-5)] in TSX (text-like arbitrary property)', () => {
    assert.ok(scanTsxSnippet("[caret-color:var(--foreground-5)]").length > 0);
  });

  it('rejects [text-decoration-color:var(--foreground-5)] in TSX (text-like arbitrary property)', () => {
    assert.ok(scanTsxSnippet("[text-decoration-color:var(--foreground-5)]").length > 0);
  });

  // P2: CSS var() fallback — text context must fail even with fallback
  it('rejects color: var(--foreground-5, currentColor) in CSS (var with fallback)', () => {
    assert.ok(findCssTextOffenders('color: var(--foreground-5, currentColor)', 'test').length > 0);
  });

  it('rejects fill: var(--foreground-95, currentColor) in CSS (var with fallback)', () => {
    assert.ok(findCssTextOffenders('fill: var(--foreground-95, currentColor)', 'test').length > 0);
  });

  it('accepts background: var(--foreground-5, currentColor) in CSS (bg context with fallback)', () => {
    assert.deepEqual(findCssTextOffenders('background: var(--foreground-5, currentColor)', 'test'), []);
  });

  // P2: @theme 90/95 export banned
  it('@theme must not export --color-foreground-90/95', async () => {
    const tokens = stripCssComments(await readFile(TOKENS_FILE, 'utf8'));
    for (const num of ['90', '95']) {
      const re = new RegExp(`--color-foreground-${num}\\s*:`);
      assert.doesNotMatch(tokens, re, `@theme must not export --color-foreground-${num}`);
    }
  });

  // P3-a: surface utility with [color:] type hint must pass
  it('accepts border-[color:var(--foreground-10)] in TSX (border w/ color type hint)', () => {
    assert.deepEqual(scanTsxSnippet("border-[color:var(--foreground-10)]"), []);
  });

  it('accepts bg-[color:var(--foreground-5)] in TSX (bg w/ color type hint)', () => {
    assert.deepEqual(scanTsxSnippet("bg-[color:var(--foreground-5)]"), []);
  });

  it('accepts ring-[color:var(--foreground-5)] in TSX (ring w/ color type hint)', () => {
    assert.deepEqual(scanTsxSnippet("ring-[color:var(--foreground-5)]"), []);
  });

  // P2-b: complex arbitrary value — token must be found anywhere in payload
  it('rejects text-[color:color-mix(in_oklch,var(--foreground-5),var(--background))] in TSX', () => {
    assert.ok(scanTsxSnippet("text-[color:color-mix(in_oklch,var(--foreground-5),var(--background))]").length > 0);
  });

  it('rejects text-[oklch(from_var(--foreground-5)_l_c_h)] in TSX', () => {
    assert.ok(scanTsxSnippet("text-[oklch(from_var(--foreground-5)_l_c_h)]").length > 0);
  });

  // P2-b: CSS multi-line declaration value
  it('rejects multi-line color: color-mix(...,var(--foreground-5),...) in CSS', () => {
    const css = `color:
  color-mix(in oklch,
    var(--foreground-5),
    var(--background));`;
    assert.ok(findCssTextOffenders(css, 'test').length > 0);
  });

  it('rejects multi-line color: color-mix(...,var(--foreground-5) 50%,...) in CSS', () => {
    const css = `color: color-mix(
  in oklch,
  var(--foreground-5) 50%,
  var(--background)
);`;
    assert.ok(findCssTextOffenders(css, 'test').length > 0);
  });

  // P2-a: global raw stop ban in CSS (non-text context)
  it('rejects background: var(--foreground-80) in renderer CSS (global raw ban)', async () => {
    // Simulate by scanning a snippet with stripCssComments
    assert.ok(stripCssComments('background: var(--foreground-80)').match(RAW_STOP_RE));
  });

  it('rejects border-color: var(--foreground-60) in renderer CSS (global raw ban)', async () => {
    assert.ok(stripCssComments('border-color: var(--foreground-60)').match(RAW_STOP_RE));
  });
});