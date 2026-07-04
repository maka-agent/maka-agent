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
