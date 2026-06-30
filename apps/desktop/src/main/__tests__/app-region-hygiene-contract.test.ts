/**
 * Static-analysis contract test for app-region hygiene
 * (PR-SIDEBAR-IA-0 Phase 3 P0 fixup v5, WAWQAQ msg `5b85fdb1`,
 * xuan `eea556cd`, kenji `0b94f7e9`).
 *
 * Background:
 *   WAWQAQ reported that the macOS window cannot be dragged/resized
 *   from the edges in real-window use of `af681c1`. xuan + kenji
 *   gated the merge on locking down `-webkit-app-region` placement
 *   so a future patch can't accidentally claim the window edge as a
 *   drag region (which would defeat the OS resize hit area on
 *   `titleBarStyle: 'hiddenInset'` windows).
 *
 *   Specifically:
 *   - `-webkit-app-region: drag` must NEVER appear on a full-window
 *     container (.appFrame, .app, .maka-modal-backdrop,
 *     .settingsModalBackdrop). Those covers the whole viewport;
 *     declaring them draggable would steal every click from the
 *     native OS resize handler.
 *   - drag regions are allowed on narrow header / tab / nav strips
 *     where the user expects to drag the window.
 *
 * This file is a grep-style gate. The runtime exercise (4 edges + 4
 * corners actually resize + Search modal open path doesn't block
 * resize) MUST happen in a real Electron window — kenji `0b94f7e9`
 * + xuan `eea556cd` are explicit that screenshots and jsdom can't
 * replace that. The gate here is the SOURCE bound for what is /
 * isn't allowed to declare `drag`.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { readRendererContractCss } from './contract-css-helpers.js';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

const TOKENS_PATH = join(process.cwd(), 'src', 'renderer', 'maka-tokens.css');

/**
 * Selectors that, if they ever carry `-webkit-app-region: drag`,
 * would cover the full window and defeat the OS resize handler.
 * The test asserts none of them appear in a rule body containing
 * the drag declaration.
 */
const FORBIDDEN_DRAG_HOSTS = [
  '.appFrame',
  '.app',
  '.maka-modal-backdrop',
  '.settingsModalBackdrop',
  '.maka-search-modal-backdrop',
  '.permissionBackdrop',
  '.maka-shell-2col',
  // Generic html/body — if someone ever adds a global rule we
  // want it flagged immediately.
  'html',
  'body',
];

describe('app-region hygiene contract (PR-SIDEBAR-IA-0 Phase 3 P0 fixup v5)', () => {
  it('BrowserWindow declares `resizable: true` explicitly (defensive against future silent disable)', async () => {
    // xuan `eea556cd` + kenji `0b94f7e9`: even though the default
    // is true, pin it in source so a future patch that toggles it
    // off becomes visible in diff review.
    const src = await readMainProcessCombinedSource();
    assert.match(
      src,
      /new BrowserWindow\([\s\S]*?resizable:\s*true/,
      'main.ts must declare `resizable: true` on the main BrowserWindow constructor (WAWQAQ 5b85fdb1)',
    );
  });

  for (const host of FORBIDDEN_DRAG_HOSTS) {
    it(`'${host}' selector does NOT carry -webkit-app-region: drag (would steal OS resize hit area)`, async () => {
      const stylesSources = [
        ['renderer CSS', await readRendererContractCss()],
        [TOKENS_PATH, await readFile(TOKENS_PATH, 'utf8')],
      ] as const;
      for (const [sourceLabel, src] of stylesSources) {
        const offender = findRuleWithBoth(src, host, '-webkit-app-region: drag');
        assert.equal(
          offender,
          null,
          `selector '${host}' must NOT declare \`-webkit-app-region: drag\` in ${sourceLabel} — full-window containers steal the OS resize hit area (WAWQAQ ${'`5b85fdb1`'}, xuan ${'`eea556cd`'}). Found rule:\n${offender}`,
        );
      }
    });
  }

  it('every -webkit-app-region: drag rule lives inside a narrow header/tab/nav selector', async () => {
    // Positive form: the drag declarations we DO have must each
    // sit on a class whose name indicates it's a deliberately
    // narrow drag strip (header / tab-bar / nav-window /
    // drag-strip). Anything else flags as "drag declared on an
    // unexpected scope" so reviewers see it before merge.
    const allowedNamePatterns = [
      /-header($|[\s,{])/,
      /-tab-bar($|[\s,{])/,
      /-drag-strip($|[\s,{])/,
      /-nav-window($|[\s,{])/,
      /-toolbar($|[\s,{])/,
    ];
    const stylesSources = [
      ['renderer CSS', await readRendererContractCss()],
      [TOKENS_PATH, await readFile(TOKENS_PATH, 'utf8')],
    ] as const;
    for (const [sourceLabel, src] of stylesSources) {
      const dragRules = findRulesWithDeclaration(src, '-webkit-app-region: drag');
      for (const rule of dragRules) {
        const selector = rule.selector;
        const ok = allowedNamePatterns.some((pattern) => pattern.test(selector));
        assert.ok(
          ok,
          `\`-webkit-app-region: drag\` on selector '${selector}' (in ${sourceLabel}) is outside the allowlisted narrow strips. Allowed naming: *-header / *-tab-bar / *-drag-strip / *-nav-window / *-toolbar. Add the class to the allowlist only after confirming it sits in a narrow strip, NOT a full-window container.`,
        );
      }
    }
  });
});

/**
 * Walk every top-level CSS rule and return the rule that BOTH
 * (a) has a selector containing `hostSelector` as a token, AND
 * (b) declares `declaration` in its body.
 * Returns `null` if no such rule exists.
 */
function findRuleWithBoth(css: string, hostSelector: string, declaration: string): string | null {
  for (const rule of iterateRules(css)) {
    if (!rule.body.includes(declaration)) continue;
    if (selectorMatches(rule.selector, hostSelector)) {
      return `${rule.selector} { ${rule.body.trim()} }`;
    }
  }
  return null;
}

function findRulesWithDeclaration(
  css: string,
  declaration: string,
): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  for (const rule of iterateRules(css)) {
    if (rule.body.includes(declaration)) {
      out.push(rule);
    }
  }
  return out;
}

/**
 * Yield each top-level `selector { body }` rule. Naive — only
 * handles flat rules; nested at-rules (`@media`, `@layer`) keep the
 * inner rules as sub-yields by recursing. Good enough for our
 * scanned files (only `@media (prefers-reduced-motion)` and
 * `@starting-style` blocks).
 */
function* iterateRules(css: string): Generator<{ selector: string; body: string }> {
  let i = 0;
  while (i < css.length) {
    // Skip whitespace and comments.
    while (i < css.length && /\s/.test(css[i]!)) i++;
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2);
      if (end === -1) return;
      i = end + 2;
      continue;
    }
    // Find selector — text up to first `{`.
    const braceIdx = css.indexOf('{', i);
    if (braceIdx === -1) return;
    const selector = css.slice(i, braceIdx).trim();
    // Find matching `}` (track nesting).
    let depth = 1;
    let j = braceIdx + 1;
    while (j < css.length && depth > 0) {
      const ch = css[j];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      j++;
    }
    if (depth !== 0) return;
    const body = css.slice(braceIdx + 1, j - 1);
    // If the selector starts with `@`, recurse into the body (it's
    // an at-rule wrapping inner rules). Otherwise yield as-is.
    if (selector.startsWith('@')) {
      yield* iterateRules(body);
    } else {
      yield { selector, body };
    }
    i = j;
  }
}

/**
 * Return true if the selector string contains `target` as a
 * standalone token (not a substring inside a longer class name).
 * `target` itself is a class selector starting with `.` or a tag
 * name; we tolerate trailing `:hover`, `::before`, descendants, etc.
 */
function selectorMatches(selectorList: string, target: string): boolean {
  // Split on `,` to consider each selector in the list.
  for (const raw of selectorList.split(',')) {
    const selector = raw.trim();
    // Tokenize on whitespace + combinators (` >+~`).
    const tokens = selector.split(/[\s>+~]+/).filter((tok) => tok.length > 0);
    for (const tok of tokens) {
      // Strip pseudo-classes / pseudo-elements / attribute selectors
      // so `.foo:hover` matches `.foo`.
      const base = tok.replace(/[:[].*$/, '');
      if (base === target) return true;
    }
  }
  return false;
}
