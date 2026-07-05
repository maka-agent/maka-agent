import { strict as assert } from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
export const RENDERER_STYLES_ENTRY = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'styles.css');
export const RENDERER_STYLES_DIR = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'styles');
export const TOKENS_FILE = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'maka-tokens.css');
export const STYLES_FILE = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'styles.css');

export async function readCssTree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return readCssTree(path);
    }
    return entry.name.endsWith('.css') ? [path] : [];
  }));
  return files.flat().sort();
}

const CSS_IMPORT_RE = /@import\s+"([^"]+\.css)"(?:\s+layer\([^)]+\))?\s*;/g;

export async function expandCssImports(file: string, seen: Set<string>): Promise<string> {
  const source = await readFile(file, 'utf8');
  let expanded = source;

  for (const match of source.matchAll(CSS_IMPORT_RE)) {
    const importPath = match[1];
    if (!importPath.startsWith('.')) continue;

    const resolvedPath = resolve(dirname(file), importPath);
    if (seen.has(resolvedPath)) continue;

    seen.add(resolvedPath);
    expanded += `\n${await expandCssImports(resolvedPath, seen)}`;
  }

  return expanded;
}

export async function readAllRendererCss(): Promise<string> {
  // Fail closed: if import expansion breaks (missing file, bad @import path),
  // surface the error so converge contracts catch it instead of silently
  // degrading to only the styles.css entry and skipping styles/*.
  return expandCssImports(RENDERER_STYLES_ENTRY, new Set([RENDERER_STYLES_ENTRY]));
}

export function stripCssComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Strip `@keyframes <name> { … }` blocks so converge contracts can scan
 * element-state declarations without false-positiving on animation frames
 * (keyframe opacity/transform are animation intent, not element state).
 * One level of `{}` nesting is enough for all current keyframes (0%/50%/100%
 * frames with no nested blocks). */
export function stripKeyframes(css: string): string {
  return css.replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
}

/** Ban non-literal `font:` shorthand in renderer CSS.
 *
 * `font:` shorthand can hide bare font-weight (`font: 600 12px sans-serif`),
 * bare line-height (`font: 12px/1.4 sans-serif`), or token-bypassing sizes
 * (`font: 600 var(--font-size-ui) var(--font-sans)`). Per-property converge
 * contracts only scan longhand declarations, so any `font:` shorthand that
 * isn't a literal (`inherit` / `initial` / `unset` / `revert`) is a bypass
 * vector. Renderer CSS today only uses `font: inherit`, so the whitelist is
 * literals-only — no regex arms race over which shorthand component is bare.
 *
 * The value is extracted and checked against the literal set rather than
 * using a negative lookahead: `\s*` backtracking lets a lookahead succeed at
 * the `:` position and would match `font: inherit` as an offender. */
const FONT_SHORTHAND_RE = /\bfont:\s*[^;}\n]+/gi;
const FONT_LITERAL_OK = /^(?:inherit|initial|unset|revert)$/i;

export function findFontShorthandOffenders(css: string, label: string): string[] {
  const stripped = stripCssComments(css);
  const offenders: string[] = [];
  for (const m of stripped.matchAll(FONT_SHORTHAND_RE)) {
    const decl = m[0].trim();
    const value = decl.replace(/^font:\s*/i, '').trim();
    if (FONT_LITERAL_OK.test(value)) continue;
    offenders.push(`${label}: ${decl} (non-literal font: shorthand — use longhand + tokens)`);
  }
  return offenders;
}

// --- token pin (exact-once) -----------------------------------------------

/** Parse all custom property declarations (`--token: value;`) from CSS.
 * Returns token name → array of declared values, one entry per occurrence
 * (so duplicates are visible). Comments are stripped first; values trimmed. */
export function parseCssCustomProps(css: string): Map<string, string[]> {
  const stripped = stripCssComments(css);
  const map = new Map<string, string[]>();
  for (const m of stripped.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+?)\s*;/g)) {
    const name = m[1];
    const value = m[2].trim();
    const list = map.get(name);
    if (list) list.push(value);
    else map.set(name, [value]);
  }
  return map;
}

/** Assert a custom property is declared exactly once with the expected value.
 *
 * Works for both token definitions in maka-tokens.css (e.g.
 * `--font-weight-normal: 400`) and Tailwind bridge aliases in styles.css
 * `@theme inline` (e.g. `--leading-normal: var(--leading-normal)`). Stronger
 * than `assert.match(css, /--prop:\s*value\s*;/)`: that only proves a correct
 * declaration exists somewhere — a later overriding declaration (e.g.
 * `--font-weight-normal: 400; --font-weight-normal: 450;`, or
 * `--leading-normal: var(--leading-normal); --leading-normal: 1.55;`) still
 * passes because the first match satisfies `assert.match`. This helper fails
 * on duplicate declarations and on a single declaration with a drifted value. */
export function assertCustomPropPinnedOnce(
  css: string,
  prop: string,
  expected: string,
  label = 'maka-tokens.css',
): void {
  const values = parseCssCustomProps(css).get(prop) ?? [];
  assert.equal(values.length, 1, `${label}: ${prop} must be declared exactly once with ${expected}; got ${values.length} declaration(s): ${JSON.stringify(values)}`);
  assert.equal(values[0], expected, `${label}: ${prop} must be ${expected}; got ${values[0]}`);
}

/** Assert every `var(--xxx)` reference reachable from `prop` resolves to a
 *  defined custom property — recursively, with cycle detection.
 *
 *  Catches the bug where a token points at an undefined custom prop — e.g.
 *  `--h-control-md: var(--space-7)` when maka's discrete spacing scale skips
 *  7. The declaration is invalid at computed-value time, so the sized
 *  element collapses to its initial/inherited value (width/height → auto,
 *  min-height → 0) instead of the intended 28px. A pin-only contract that
 *  just checks `--h-control-md` is declared with `var(--space-7)` passes
 *  while the token is broken — this helper walks the reference chain.
 *
 *  Recurses through the whole chain, not just the first hop: a chain like
 *  `--h-control-xs → --space-5 → --missing` (undefined two hops out) is
 *  caught, and a cycle like `--a → --b → --a` is caught via a `visiting`
 *  set. Each node must also be declared exactly once. */
export function assertCustomPropRefsDefined(
  css: string,
  prop: string,
  label = 'maka-tokens.css',
): void {
  const props = parseCssCustomProps(css);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const errors: string[] = [];
  const dfs = (name: string, path: string[]): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      errors.push(`${label}: circular custom-prop reference: ${[...path, name].join(' → ')}`);
      return;
    }
    visiting.add(name);
    const values = props.get(name);
    if (values === undefined) {
      const via = path.length ? ` (via ${path.join(' → ')})` : '';
      errors.push(`${label}: ${prop} references undefined ${name}${via} — the declaration would collapse to its initial/inherited value at computed-value time`);
    } else if (values.length !== 1) {
      errors.push(`${label}: ${name} must be declared exactly once; got ${values.length} declaration(s): ${JSON.stringify(values)}`);
    } else {
      const refs = [...values[0].matchAll(/var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)/g)].map((m) => m[1]);
      for (const ref of refs) dfs(ref, [...path, name]);
    }
    visiting.delete(name);
    visited.add(name);
  };
  dfs(prop, []);
  assert.ok(errors.length === 0, errors.join('\n'));
}
