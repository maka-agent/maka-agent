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
 * Tailwind arbitrary value referencing a raw foreground mix stop.
 * Matches any utility (text, color, fill, stroke, bg, border, etc.)
 * with optional variant prefix (disabled:, hover:, etc.) and optional
 * `color:` inner prefix:
 *   text-[color:var(--foreground-60)]     ✓ caught
 *   text-[var(--foreground-60)]            ✓ caught
 *   disabled:text-[var(--foreground-40)]  ✓ caught
 *   bg-[var(--foreground-50)]             ✓ caught
 *
 * Note: the utility name is followed by `-[` (e.g. `text-[`), not `[`
 * directly — the `-` is the Tailwind arbitrary value separator.
 */
const TSX_ARBITRARY_RE = /(?:^|\s|:)(?:text|color|fill|stroke|bg|border|ring|from|to|via)-\[(?:color:)?var\(\s*(--foreground-\d+)\s*\)\]/g;

/**
 * Tailwind utility-class form: text-foreground-40, bg-foreground-50, etc.
 * These should not exist once @theme stops exporting the raw stops,
 * but the regex catches them defensively if someone re-adds the export.
 */
const TSX_UTILITY_RE = /(?:^|\s|:)(?:text|bg|border|fill|stroke|ring|from|to|via)-foreground-(\d+)\b/g;

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

      // Tailwind arbitrary value: text-[color:var(--foreground-N)],
      // text-[var(--foreground-N)], disabled:text-[var(--foreground-N)], etc.
      for (const m of src.matchAll(TSX_ARBITRARY_RE)) {
        const tok = m[1]!;
        if (BANNED_TEXT_STOPS.includes(tok)) {
          offenders.push(`${label}: ${m[0].trim()} [banned ${tok}]`);
        }
      }

      // Tailwind utility class: text-foreground-40, bg-foreground-50, etc.
      for (const m of src.matchAll(TSX_UTILITY_RE)) {
        const num = m[1]!;
        const tok = `--foreground-${num}`;
        if (BANNED_TEXT_STOPS.includes(tok)) {
          offenders.push(`${label}: ${m[0].trim()} [banned ${tok}]`);
        }
      }

      // Inline style: { color: 'var(--foreground-N)' }
      const styleRe = /(color|fill|stroke)\s*:\s*['"]var\(\s*(--foreground-\d+)\s*\)['"]/g;
      for (const m of src.matchAll(styleRe)) {
        const tok = m[2]!;
        if (BANNED_TEXT_STOPS.includes(tok)) {
          offenders.push(`${label}: inline style ${m[1]}: var(${tok})`);
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
  for (const m of src.matchAll(TSX_ARBITRARY_RE)) {
    const tok = m[1]!;
    if (BANNED_TEXT_STOPS.includes(tok)) {
      offenders.push(`${m[0].trim()} [banned ${tok}]`);
    }
  }
  for (const m of src.matchAll(TSX_UTILITY_RE)) {
    const num = m[1]!;
    const tok = `--foreground-${num}`;
    if (BANNED_TEXT_STOPS.includes(tok)) {
      offenders.push(`${m[0].trim()} [banned ${tok}]`);
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
    // Strip the alias definition lines and @theme mirror lines — they
    // legitimately reference the raw stops.
    const stripped = tokens
      .replace(/^\s*--muted-foreground:\s*var\(--foreground-50\)\s*;?\s*$/gm, '')
      .replace(/^\s*--foreground-secondary:\s*var\(--foreground-80\)\s*;?\s*$/gm, '')
      .replace(/^\s*--color-foreground-\d+:\s*var\(--foreground-\d+\)\s*;?\s*$/gm, '')
      .replace(/^\s*--color-foreground-secondary:\s*var\(--foreground-secondary\)\s*;?\s*$/gm, '')
      .replace(/^\s*--color-muted-foreground:\s*var\(--muted-foreground\)\s*;?\s*$/gm, '');
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

  it('--muted-foreground is defined and targets --foreground-50', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    assert.match(tokens, /--muted-foreground:\s*var\(--foreground-50\)/, '--muted-foreground must target --foreground-50');
  });

  it('--foreground-secondary is defined and targets --foreground-80', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    assert.match(tokens, /--foreground-secondary:\s*var\(--foreground-80\)/, '--foreground-secondary must target --foreground-80');
  });

  it('--foreground-90 and --foreground-95 are not defined', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    for (const stop of DELETED_STOPS) {
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
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    for (const stop of BANNED_TEXT_STOPS) {
      const re = new RegExp(`--color-${stop}:`);
      assert.doesNotMatch(tokens, re, `@theme must not export ${stop} as a Tailwind color utility`);
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
    const offenders = scanTsxSnippet("text-[color:var(--foreground-60)]");
    assert.ok(offenders.length > 0, 'text-[color:var(--foreground-60)] must fail');
  });

  it('rejects text-[var(--foreground-60)] in TSX', () => {
    const offenders = scanTsxSnippet("text-[var(--foreground-60)]");
    assert.ok(offenders.length > 0, 'text-[var(--foreground-60)] must fail');
  });

  it('rejects disabled:text-[var(--foreground-40)] in TSX', () => {
    const offenders = scanTsxSnippet("disabled:text-[var(--foreground-40)]");
    assert.ok(offenders.length > 0, 'disabled:text-[var(--foreground-40)] must fail');
  });

  it('rejects text-foreground-60 Tailwind utility in TSX', () => {
    const offenders = scanTsxSnippet("text-foreground-60");
    assert.ok(offenders.length > 0, 'text-foreground-60 must fail');
  });

  it('accepts text-[color:var(--foreground-secondary)] in TSX', () => {
    const offenders = scanTsxSnippet("text-[color:var(--foreground-secondary)]");
    assert.deepEqual(offenders, []);
  });

  it('accepts text-[color:var(--muted-foreground)] in TSX', () => {
    const offenders = scanTsxSnippet("text-[color:var(--muted-foreground)]");
    assert.deepEqual(offenders, []);
  });
});