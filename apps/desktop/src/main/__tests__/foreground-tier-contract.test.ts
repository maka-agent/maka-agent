/**
 * PR-FOREGROUND-TIER-CONVERGE-0 (issue #430 PR4, 2026-07-03):
 * lock the text-color vocabulary so individual PRs can't silently drift
 * back to the 5-step text ladder (40/50/60/70/80) or the deleted 90/95
 * stops. Text call sites must use the 3 semantic aliases:
 *
 *   var(--foreground)            — primary text (100% ink)
 *   var(--foreground-secondary)  — secondary text (80% ink)
 *   var(--muted-foreground)      — muted text (50% ink)
 *
 * The underlying mix stops (--foreground-40..80) stay in maka-tokens.css
 * so the aliases can target them, and surface washes (-2/-3/-5/-8/-10)
 * are NOT text so they remain call-site addressable. -90/-95 had zero
 * call sites and were deleted.
 *
 * Three invariants:
 *
 * 1. CSS `color:` / `fill:` / `stroke:` properties must not reference
 *    --foreground-40/50/60/70/80 directly — they must use the semantic
 *    aliases. Background/border/etc. properties are out of scope (those
 *    use the surface-wash scale, not the text ladder).
 *
 * 2. TSX inline styles and Tailwind arbitrary values must not reference
 *    the raw mix stops for text color. Tailwind utility aliases
 *    (text-muted-foreground, text-foreground-secondary) are OK.
 *
 * 3. The aliases are defined in maka-tokens.css with pinned targets:
 *    --muted-foreground → --foreground-50, --foreground-secondary →
 *    --foreground-80. --foreground-90/95 must not be defined.
 */

import { strict as assert } from 'node:assert';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, TOKENS_FILE, readAllRendererCss, stripCssComments } from './css-test-helpers.js';

// --- banned raw text stops --------------------------------------------------

const BANNED_TEXT_STOPS = ['--foreground-40', '--foreground-50', '--foreground-60', '--foreground-70', '--foreground-80'];
const DELETED_STOPS = ['--foreground-90', '--foreground-95'];

// Properties that set TEXT color (not background/border/shadow).
// Border-color is excluded — borders use the surface-wash scale or
// alpha overlays, not the text ladder; a separate contract can govern
// border tokens if needed.
const TEXT_PROP_RE = /^(color|fill|stroke|caret-color|text-decoration-color|column-rule-color)$/i;

// CSS `var(--foreground-N)` reference (N = 2 digits).
const VAR_FOREGROUND_N_RE = /var\(\s*(--foreground-\d+)\s*\)/g;

// --- CSS scanning -----------------------------------------------------------

/**
 * Extract color property declarations and check they don't reference
 * the banned raw text stops. Background, border, box-shadow etc. are
 * out of scope — those use the surface-wash scale.
 */
function findCssTextOffenders(css: string, label: string): string[] {
  const stripped = stripCssComments(css);
  const offenders: string[] = [];

  const declRe = /([\w-]+)\s*:\s*([^;}\n]+?)\s*(?:[;}|\n]|$)/gi;
  for (const m of stripped.matchAll(declRe)) {
    const prop = m[1]!;
    const rawVal = m[2]!.trim();
    if (!TEXT_PROP_RE.test(prop)) continue;

    // Scan for var(--foreground-N) references.
    for (const vm of rawVal.matchAll(VAR_FOREGROUND_N_RE)) {
      const tok = vm[1]!;
      if (BANNED_TEXT_STOPS.includes(tok)) {
        offenders.push(`${label}: ${prop}: ${rawVal} [banned ${tok}]`);
      }
    }
  }

  return offenders;
}

// --- TSX scanning -----------------------------------------------------------

/**
 * Scan TS/TSX source for any reference to banned raw foreground mix stops.
 * Instead of matching Tailwind syntax shapes (which evolve and have many
 * forms — arbitrary values, shorthand, variant prefixes, quoted strings,
 * template literals, inline styles), we simply ban the raw token names
 * from appearing in TS/TSX at all. The semantic aliases
 * (--muted-foreground, --foreground-secondary) are the only sanctioned
 * text-color tokens; the raw stops should never be referenced directly.
 *
 * RAW_STOP_RE catches every form that contains the CSS variable name:
 *   className="text-[var(--foreground-60)]"     ✓
 *   cn("text-[var(--foreground-60)]")            ✓
 *   `text-[var(--foreground-60)]`               ✓
 *   style={{ color: "var(--foreground-60)" }}    ✓
 *   text-(--foreground-60)                      ✓ (Tailwind shorthand)
 *   text-[color:var(--foreground-60)]           ✓
 *
 * UTILITY_CLASS_RE catches the Tailwind utility-class form that omits
 * the `--` prefix (these don't contain a CSS var() reference):
 *   text-foreground-60                          ✓
 *   bg-foreground-50                            ✓
 */
const RAW_STOP_RE = /--foreground-(40|50|60|70|80|90|95)\b/g;
const UTILITY_CLASS_RE = /(?:text|bg|border|fill|stroke|ring|from|to|via)-foreground-(40|50|60|70|80|90|95)\b/g;

async function collectTsxOffenders(dirs: string[]): Promise<string[]> {
  const offenders: string[] = [];
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
      for (const m of src.matchAll(RAW_STOP_RE)) {
        offenders.push(`${label}: --foreground-${m[1]}`);
      }
      for (const m of src.matchAll(UTILITY_CLASS_RE)) {
        offenders.push(`${label}: ${m[0]}`);
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
  for (const m of src.matchAll(RAW_STOP_RE)) {
    offenders.push(`--foreground-${m[1]}`);
  }
  for (const m of src.matchAll(UTILITY_CLASS_RE)) {
    offenders.push(m[0]);
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

  it('raw text mix stops --foreground-40/50/60/70/80/90/95 are not defined', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    const allBanned = [...BANNED_TEXT_STOPS, ...DELETED_STOPS];
    for (const stop of allBanned) {
      const re = new RegExp(`^\\s*${stop}:`, 'm');
      assert.doesNotMatch(tokens, re, `${stop} must not be defined`);
    }
  });

  it('@theme inline exports the semantic aliases', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    assert.match(tokens, /--color-foreground-secondary:\s*var\(--foreground-secondary\)/, '@theme must export --color-foreground-secondary');
    assert.match(tokens, /--color-muted-foreground:\s*var\(--muted-foreground\)/, '@theme must export --color-muted-foreground');
  });

  it('@theme inline does not export raw text stops --foreground-40/50/60/70/80', async () => {
    const tokens = stripCssComments(await readFile(TOKENS_FILE, 'utf8'));
    for (const num of ['40', '50', '60', '70', '80']) {
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
});