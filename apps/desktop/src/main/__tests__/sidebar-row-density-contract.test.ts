/**
 * CSS contract test for the sidebar session row density refactor
 * (PR-SIDEBAR-IA-0 Phase 3, WAWQAQ msgs `14ed98b5` + `761141c5`,
 * xuan tightening `2d4526b5`).
 *
 * Phase 3 ships:
 *   - Default row 32px tall (single line: name + time / unread).
 *   - Flat list (no card border/radius/shadow on the row itself).
 *   - Snippet (`lastMessagePreview`) NOT rendered in the default
 *     row DOM and NOT exposed via native `title=` tooltip.
 *   - Active row keeps the 32px height — selected state is a 3px
 *     left rail + light accent bg, NOT an inflated card.
 *   - Row actions reveal on `:hover` AND `:focus-within` so keyboard
 *     users can reach them.
 *
 * This file is a cheap grep-style regression gate: if a later phase
 * inflates `.maka-list-row` back to a 56px card, re-introduces
 * `.maka-list-row-preview`, or removes the `:focus-within` reveal,
 * the static-analysis gate flips red. Visual baseline is captured
 * via `sidebar-long-sessions` and `turn-narrative` smoke scenarios.
 *
 * Mirrors `sidebar-scroll-contract.test.ts` (Phase 1) — same
 * `extractRuleBody` shape, same describe-block pattern.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';

const STYLES_PATH = join(process.cwd(), 'src', 'renderer', 'styles.css');

describe('sidebar session row density CSS contract (PR-SIDEBAR-IA-0 Phase 3)', () => {
  it('.maka-list-row is 32px tall (single-line slim row, not a 56px card)', async () => {
    const css = await readFile(STYLES_PATH, 'utf8');
    const ruleBody = extractRuleBody(css, '.maka-list-row');
    assert.ok(ruleBody, '.maka-list-row rule must exist');
    assert.match(
      ruleBody,
      /min-height:\s*32px/,
      '.maka-list-row must declare min-height: 32px so 60 sessions fit in the sidebar without scrolling away the footer',
    );
  });

  it('.maka-list-row has no card chrome (border / radius / shadow stripped)', async () => {
    // Phase 3 reads as a flat list (Slack/Linear); the previous
    // card chrome made every row look like an isolated card, which
    // was the visual weight WAWQAQ called out as "肥很臃肿".
    const css = await readFile(STYLES_PATH, 'utf8');
    const ruleBody = extractRuleBody(css, '.maka-list-row');
    assert.ok(ruleBody);
    assert.match(ruleBody, /border:\s*0/, '.maka-list-row must declare border: 0 (no card outline)');
    assert.doesNotMatch(
      ruleBody,
      /box-shadow:\s*var\(--shadow/,
      '.maka-list-row must NOT carry a card-style shadow token',
    );
  });

  it('.maka-list-row-preview rule does NOT exist (snippet dropped from default DOM)', async () => {
    // Per xuan `2d4526b5`: snippet is intentionally not exposed in
    // the default row, not even as a native title= tooltip. A
    // future hover/focus detail PR will reintroduce it deliberately;
    // this gate ensures it doesn't sneak back as a styled element
    // without that conversation.
    const css = await readFile(STYLES_PATH, 'utf8');
    const ruleBody = extractRuleBody(css, '.maka-list-row-preview');
    assert.equal(
      ruleBody,
      undefined,
      '.maka-list-row-preview must NOT exist in the renderer CSS — Phase 3 dropped snippet preview from the default DOM',
    );
  });

  it('.maka-list-row[data-active="true"] keeps min-height untouched (active row does NOT inflate)', async () => {
    // The selected row's only visual differentiation is a 3px
    // left rail (::before) + light accent bg. It must NOT change
    // the row height — that would create a layout shift as the
    // user clicks between rows and is the original "fat row"
    // problem in disguise.
    const css = await readFile(STYLES_PATH, 'utf8');
    const ruleBody = extractRuleBody(css, '.maka-list-row[data-active="true"]');
    assert.ok(ruleBody, '.maka-list-row[data-active="true"] rule must exist');
    assert.doesNotMatch(
      ruleBody,
      /min-height:/,
      '.maka-list-row[data-active="true"] must NOT declare min-height (selected state stays 32px)',
    );
  });

  it('.maka-list-row[data-active="true"]::before declares a left rail (subtle selected affordance)', async () => {
    // The 3px left accent bar is the entire selected-state
    // indicator (paired with a light accent bg). Removing it
    // would leave the active row indistinguishable from hover.
    const css = await readFile(STYLES_PATH, 'utf8');
    const ruleBody = extractRuleBody(css, '.maka-list-row[data-active="true"]::before');
    assert.ok(ruleBody, '.maka-list-row[data-active="true"]::before rule must exist');
    assert.match(ruleBody, /width:\s*3px/, 'active row ::before must declare width: 3px');
    assert.match(
      ruleBody,
      /background:\s*var\(--accent\)/,
      'active row ::before must declare background: var(--accent)',
    );
  });

  it('meta + unread dot HIDE on :hover AND :focus-within so they do not show through the actions overlay', async () => {
    // PR-SIDEBAR-IA-0 Phase 3 P0 fixup v4 (WAWQAQ msg `5dd1c348`):
    // when the absolute-positioned `.maka-list-row-actions` overlay
    // becomes visible (hover / focus-within), the time meta and
    // unread dot underneath would visually leak through the
    // gradient mask — especially on accent-tinted selected rows
    // where the gradient (`--foreground-3`) is the wrong color.
    // The fix hides them via `visibility: hidden` so they don't
    // overlap. Layout is preserved (the grid auto column still
    // reserves the slot) so actions slide in without shifting
    // anything.
    const css = await readFile(STYLES_PATH, 'utf8');
    assert.match(
      css,
      /\.maka-list-row:hover\s+\.maka-list-row-meta[\s\S]{0,200}visibility:\s*hidden/,
      'CSS must hide `.maka-list-row-meta` on `:hover` (no overlap with action overlay per WAWQAQ 5dd1c348)',
    );
    assert.match(
      css,
      /\.maka-list-row:focus-within\s+\.maka-list-row-meta[\s\S]{0,200}visibility:\s*hidden/,
      'CSS must hide `.maka-list-row-meta` on `:focus-within` (no overlap on the clicked/active row)',
    );
    assert.match(
      css,
      /\.maka-list-row:hover\s+\.maka-list-row-unread[\s\S]{0,200}visibility:\s*hidden/,
      'CSS must also hide `.maka-list-row-unread` on `:hover` (unread dot occupies the same auto column as meta)',
    );
    assert.match(
      css,
      /\.maka-list-row:focus-within\s+\.maka-list-row-unread[\s\S]{0,200}visibility:\s*hidden/,
      'CSS must hide `.maka-list-row-unread` on `:focus-within` (per xuan `bcf4304d` — full 4-selector lock)',
    );
  });

  it('row actions reveal on :hover AND :focus-within (keyboard a11y)', async () => {
    // Per xuan `2d4526b5`: actions must be reachable via keyboard.
    // The reveal rule must include both `:hover` and `:focus-within`
    // — `:focus-within` ensures Tab navigation onto any action
    // button reveals the cluster, matching the mouse hover state.
    const css = await readFile(STYLES_PATH, 'utf8');
    // We can't use extractRuleBody for compound selectors (it
    // anchors to a single line); just confirm both selectors are
    // present in the CSS source text adjacent to `.maka-list-row-actions`.
    assert.match(
      css,
      /\.maka-list-row:hover\s+\.maka-list-row-actions/,
      'CSS must declare `.maka-list-row:hover .maka-list-row-actions` reveal rule',
    );
    assert.match(
      css,
      /\.maka-list-row:focus-within\s+\.maka-list-row-actions/,
      'CSS must declare `.maka-list-row:focus-within .maka-list-row-actions` reveal rule (keyboard a11y per xuan 2d4526b5)',
    );
  });

  it('.maka-list-row-actions overlays via absolute positioning so title gets full row width by default', async () => {
    // Per xuan `2d4526b5` "actions 用 absolute/预留区域" + kenji
    // `e949119d` "如果 280px 左栏里标题只剩很短一截，那就需要把
    // actions 预留宽度压到只够 hover/focus 的实际图标组，或改 absolute
    // overlay": in a narrow sidebar a 126px reserved column would
    // truncate long titles too early. Phase 3 uses absolute
    // overlay — title gets the row's full content width by
    // default; on hover/focus the actions paint over the right
    // portion with a gradient mask.
    //
    // Layout shift invariant still holds because actions don't
    // participate in the row's flex layout in either visibility
    // state.
    const css = await readFile(STYLES_PATH, 'utf8');
    const ruleBody = extractRuleBody(css, '.maka-list-row-actions');
    assert.ok(ruleBody, '.maka-list-row-actions rule must exist');
    assert.match(
      ruleBody,
      /position:\s*absolute/,
      '.maka-list-row-actions must be position: absolute (overlay variant per kenji e949119d)',
    );
    assert.match(
      ruleBody,
      /opacity:\s*0/,
      '.maka-list-row-actions must start at opacity: 0 (invisible until hover/focus)',
    );
    assert.match(
      ruleBody,
      /pointer-events:\s*none/,
      '.maka-list-row-actions must start with pointer-events: none so the row click target underneath is reachable',
    );
  });
});

/**
 * Extract the body (text between `{` and matching `}`) of a CSS rule
 * by selector. Naive (does not handle nested braces — none of the
 * targeted rules contain them), but enough for top-level flat rules.
 * Returns `undefined` if the selector is not found.
 *
 * Copy of the helper in `sidebar-scroll-contract.test.ts` — kept
 * duplicated rather than extracted to a shared module because the
 * tests are deliberately self-contained gate scripts. If a third
 * contract test gets added, the helper can be promoted to a
 * `__tests__/_css-contract-helpers.ts` module.
 */
function extractRuleBody(css: string, selector: string): string | undefined {
  const lines = css.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (matchesSelectorLine(line, selector)) {
      let braceIndex = line.indexOf('{');
      let cursor = i;
      while (braceIndex === -1 && cursor + 1 < lines.length) {
        cursor++;
        braceIndex = (lines[cursor] ?? '').indexOf('{');
      }
      if (braceIndex === -1) return undefined;
      const body: string[] = [];
      const startLine = lines[cursor] ?? '';
      const startTail = startLine.slice(braceIndex + 1);
      if (startTail.includes('}')) {
        return startTail.slice(0, startTail.indexOf('}'));
      }
      body.push(startTail);
      let j = cursor + 1;
      while (j < lines.length) {
        const next = lines[j] ?? '';
        const closingIdx = next.indexOf('}');
        if (closingIdx !== -1) {
          body.push(next.slice(0, closingIdx));
          return body.join('\n');
        }
        body.push(next);
        j++;
      }
      return undefined;
    }
    i++;
  }
  return undefined;
}

/**
 * Return true if `line` starts a CSS rule whose selector list contains
 * `selector` as an exact token (not a substring of another class).
 */
function matchesSelectorLine(line: string, selector: string): boolean {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith(selector)) return false;
  const next = trimmed.charAt(selector.length);
  return next === ' ' || next === '\t' || next === ',' || next === '{' || next === '';
}
