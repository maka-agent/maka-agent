#!/usr/bin/env node
/**
 * Workspace a11y audit (PR-IR-03 per `docs/ui-quality-plan.md` §5).
 *
 * Walks all .tsx source under apps/ and packages/ (excluding __tests__/,
 * dist/, node_modules/) and flags common a11y regressions that block §3.2
 * keyboard / §1 a11y gates from the UI quality plan:
 *
 *  1. **Icon-only buttons** — `<button>` whose only children are
 *     self-closing JSX elements (e.g. `<Icon />`) and which lack
 *     `aria-label` or `aria-labelledby`. These are unannounceable to
 *     screen readers.
 *
 *  2. **Positive tabIndex** — `tabIndex={N}` with N > 0. Positive
 *     tabIndex breaks the natural DOM tab order; UI gate § 3.2 bans it.
 *
 * Like `check-console.mjs`, this script lives outside ESLint to keep
 * tooling surface minimal. Run via `pretest` hook in @maka/desktop.
 *
 * Future rules should be added to the RULES array without changing the
 * caller contract (e.g. icon-only links, dialog labels, input labels).
 *
 * To add a legitimate exception, add a `// a11y-allow: <reason>` comment
 * on the same line as the offending element. The allow-list is in-source,
 * not in this file, so reviewers see the justification next to the code.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ROOTS = ['apps', 'packages'];
const EXTS = new Set(['.tsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__']);

async function walk(root) {
  const out = [];
  async function visit(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        const dot = entry.name.lastIndexOf('.');
        const ext = dot >= 0 ? entry.name.slice(dot) : '';
        if (EXTS.has(ext)) out.push(full);
      }
    }
  }
  await visit(root);
  return out;
}

// Each rule is { name, scan(line, prevLines, nextLines) -> message | null }.
// Lines are checked one at a time with a small lookahead/lookbehind for
// multi-line opening tags. `// a11y-allow: <reason>` on the same line
// silences the rule for that line.

const RULES = [
  {
    name: 'icon-only-button',
    /**
     * Catches `<button … >` whose immediate children are only self-closing
     * JSX elements (typically icons). Skips:
     *  - buttons with children that include text
     *  - buttons with aria-label / aria-labelledby
     *  - lines containing `// a11y-allow:`
     */
    scan(text) {
      const offenders = [];
      // Strip line comments first — they may contain text that looks like JSX.
      const stripped = text.replace(/\/\/.*$/gm, '');
      // Match `<button …>` opening tag (single-line for now; multi-line
      // tags get less coverage but we accept that for the gate).
      const BUTTON_OPEN_RE = /<button\b([^>]*)>/gi;
      let match;
      while ((match = BUTTON_OPEN_RE.exec(stripped))) {
        const attrs = match[1] ?? '';
        const start = match.index + match[0].length;
        const close = stripped.indexOf('</button>', start);
        if (close < 0) continue;
        const body = stripped.slice(start, close);
        // a11y-allow comment in the same opening tag → skip
        const fullDecl = stripped.slice(Math.max(0, match.index - 200), close);
        if (/\/\/\s*a11y-allow:/.test(fullDecl)) continue;
        // Has aria-label or aria-labelledby → OK
        if (/\baria-label(?:ledby)?\s*=/.test(attrs)) continue;
        // Has visible text content? Two checks (either passes):
        //   (a) Plain text after stripping nested JSX tags
        //   (b) Any string literal inside `{...}` expressions (e.g.
        //       `{busy ? '保存中…' : '保存'}`) — common pattern for
        //       conditional text labels.
        const textOnly = body.replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '').trim();
        if (textOnly.length > 0 && /[a-zA-Z一-鿿]/.test(textOnly)) continue;
        if (/['"`][^'"`]*[a-zA-Z一-鿿][^'"`]*['"`]/.test(body)) continue;
        // Has a {label} expression child like {label} {someText}? Accept —
        // we can't statically check that the expression resolves to text,
        // but it's common-enough that ruling it out has too many false positives.
        if (/\{[^{}]*(label|name|text|title|alt|description)/i.test(body)) continue;
        const lineIndex = text.slice(0, match.index).split('\n').length;
        offenders.push({ line: lineIndex, snippet: match[0].trim() });
      }
      return offenders;
    },
  },
  {
    name: 'positive-tabindex',
    scan(text) {
      const offenders = [];
      const POSITIVE_TABINDEX = /\btabIndex\s*=\s*\{?(\d+)\}?/g;
      let match;
      while ((match = POSITIVE_TABINDEX.exec(text))) {
        const value = Number(match[1]);
        if (!Number.isFinite(value) || value <= 0) continue;
        // a11y-allow comment on same line → skip
        const lineStart = text.lastIndexOf('\n', match.index) + 1;
        const lineEnd = text.indexOf('\n', match.index);
        const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
        if (/\/\/\s*a11y-allow:/.test(line)) continue;
        const lineIndex = text.slice(0, match.index).split('\n').length;
        offenders.push({ line: lineIndex, snippet: match[0].trim() });
      }
      return offenders;
    },
  },
  {
    name: 'dialog-missing-label',
    /**
     * Catches elements with `role="dialog"` that lack a label
     * (`aria-label` or `aria-labelledby`). Without a label, screen
     * readers announce "dialog" with no context.
     */
    scan(text) {
      const offenders = [];
      const DIALOG_RE = /<(\w+)\b([^>]*\brole\s*=\s*["']dialog["'][^>]*)>/g;
      let match;
      while ((match = DIALOG_RE.exec(text))) {
        const attrs = match[2] ?? '';
        // a11y-allow comment within the same element opening
        const before = text.slice(Math.max(0, match.index - 200), match.index + match[0].length);
        if (/\/\/\s*a11y-allow:/.test(before)) continue;
        if (/\baria-label(?:ledby)?\s*=/.test(attrs)) continue;
        const lineIndex = text.slice(0, match.index).split('\n').length;
        offenders.push({ line: lineIndex, snippet: match[0].trim().slice(0, 120) });
      }
      return offenders;
    },
  },
  {
    name: 'icon-only-link',
    /**
     * Same shape as icon-only-button but for `<a href>` links — an
     * anchor with only icon children needs an aria-label so AT can
     * announce it.
     */
    scan(text) {
      const offenders = [];
      const stripped = text.replace(/\/\/.*$/gm, '');
      const ANCHOR_OPEN_RE = /<a\s+([^>]*\bhref\s*=[^>]*)>/g;
      let match;
      while ((match = ANCHOR_OPEN_RE.exec(stripped))) {
        const attrs = match[1] ?? '';
        const start = match.index + match[0].length;
        const close = stripped.indexOf('</a>', start);
        if (close < 0) continue;
        const body = stripped.slice(start, close);
        const fullDecl = stripped.slice(Math.max(0, match.index - 200), close);
        if (/\/\/\s*a11y-allow:/.test(fullDecl)) continue;
        if (/\baria-label(?:ledby)?\s*=/.test(attrs)) continue;
        const textOnly = body.replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '').trim();
        if (textOnly.length > 0 && /[a-zA-Z一-鿿]/.test(textOnly)) continue;
        if (/['"`][^'"`]*[a-zA-Z一-鿿][^'"`]*['"`]/.test(body)) continue;
        if (/\{[^{}]*(label|name|text|title|alt|description|url|href|children|content|message)/i.test(body)) continue;
        const lineIndex = text.slice(0, match.index).split('\n').length;
        offenders.push({ line: lineIndex, snippet: match[0].trim() });
      }
      return offenders;
    },
  },
];

async function main() {
  const offenders = [];
  for (const root of ROOTS) {
    const files = await walk(join(REPO_ROOT, root));
    for (const file of files) {
      const rel = relative(REPO_ROOT, file).split('\\').join('/');
      const src = await readFile(file, 'utf8');
      for (const rule of RULES) {
        const hits = rule.scan(src);
        for (const hit of hits) {
          offenders.push({ path: rel, rule: rule.name, line: hit.line, snippet: hit.snippet });
        }
      }
    }
  }
  if (offenders.length === 0) {
    console.log(`[check-a11y] OK — ${RULES.map((r) => r.name).join(', ')} all clean.`);
    return;
  }
  console.error(`[check-a11y] FAILED — ${offenders.length} a11y violations:`);
  for (const o of offenders) {
    console.error(`  [${o.rule}] ${o.path}:${o.line}`);
    console.error(`    ${o.snippet}`);
  }
  console.error('');
  console.error('Fix options:');
  console.error('  - icon-only-button   → add `aria-label="<chinese label>"`');
  console.error('  - icon-only-link     → add `aria-label="<chinese label>"`');
  console.error('  - positive-tabindex  → use natural DOM order; `tabIndex={0}` or `tabIndex={-1}` only');
  console.error('  - dialog-missing-label → add `aria-label` or `aria-labelledby` to the dialog element');
  console.error('');
  console.error('Genuine exceptions: add `// a11y-allow: <reason>` on the same line.');
  process.exit(1);
}

main().catch((err) => {
  console.error('[check-a11y] unexpected error:', err);
  process.exit(2);
});
