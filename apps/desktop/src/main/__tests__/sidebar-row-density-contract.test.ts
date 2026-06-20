/**
 * CSS contract test for the sidebar session row density refactor
 * (PR-SIDEBAR-IA-0 Phase 3, WAWQAQ msgs `14ed98b5` + `761141c5`,
 * xuan tightening `2d4526b5`).
 *
 * Phase 3 ships:
 *   - Default row 30px tall (single line: name + time / unread).
 *   - Flat list (no card border/radius/shadow on the row itself).
 *   - Snippet (`lastMessagePreview`) NOT rendered in the default
 *     row DOM and NOT exposed via native `title=` tooltip.
 *   - Active row keeps the 30px height and uses a neutral flat fill,
 *     not a left rail or inflated card.
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
const UI_COMPONENTS_PATH = join(process.cwd(), '../../packages/ui/src/components.tsx');

describe('sidebar session row density CSS contract (PR-SIDEBAR-IA-0 Phase 3)', () => {
  it('module nav rows stay inset and slim instead of full-width chunky pills', async () => {
    // task #98: WAWQAQ caught the restored module nav rows reading
    // as oversized full-width pills on the 210px gray plate. The
    // row itself should be visually inset and slim; the sidebar
    // remains the hit/scan region, but active fill must not paint
    // the full rail width.
    const css = await readFile(STYLES_PATH, 'utf8');
    const modules = extractRuleBody(css, '.maka-sidebar-modules');
    const panel = extractRuleBody(css, '.maka-session-panel');
    const row = extractRuleBody(css, '.maka-nav-row');
    const active = extractRuleBody(css, '.maka-nav-row[data-active="true"]');
    const count = extractRuleBody(css, '.maka-nav-count');

    assert.ok(panel, '.maka-session-panel rule must exist');
    assert.ok(modules, '.maka-sidebar-modules rule must exist');
    assert.ok(row, '.maka-nav-row rule must exist');
    assert.ok(active, '.maka-nav-row[data-active="true"] rule must exist');
    assert.ok(count, '.maka-nav-count rule must exist');
    assert.match(
      panel,
      /grid-template-rows:\s*auto\s+auto\s+minmax\(0,\s*1fr\)\s+auto/,
      'module nav must be its own auto row; only the session list may consume flexible height',
    );
    assert.match(modules, /align-self:\s*start/);
    assert.match(modules, /align-content:\s*start/);
    assert.match(modules, /padding:\s*4px 6px/);
    assert.match(row, /width:\s*calc\(100% - 12px\)/);
    assert.match(row, /margin-inline:\s*6px/);
    assert.match(row, /padding:\s*3px 6px/);
    assert.match(row, /border-radius:\s*6px/);
    assert.match(row, /line-height:\s*1\.25/);
    assert.match(active, /background:\s*oklch\(from var\(--foreground\) l c h \/ 0\.07\)/);
    assert.match(count, /height:\s*16px/);
    assert.doesNotMatch(
      row,
      /width:\s*100%/,
      'module nav row must not return to full-width active/hover pills',
    );
    assert.doesNotMatch(
      active,
      /\/ 0\.10\)/,
      'module nav active fill must not return to the heavy 0.10 overlay',
    );
  });

  it('.maka-list-row is 30px tall (single-line slim row, not a 56px card)', async () => {
    const css = await readFile(STYLES_PATH, 'utf8');
    const ruleBody = extractRuleBody(css, '.maka-list-row');
    assert.ok(ruleBody, '.maka-list-row rule must exist');
    assert.match(
      ruleBody,
      /min-height:\s*30px/,
      '.maka-list-row must declare min-height: 30px so 60 sessions fit in the sidebar without scrolling away the footer',
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
    // The selected row must NOT change height — that would create
    // a layout shift as the user clicks between rows and is the
    // original "fat row" problem in disguise.
    const css = await readFile(STYLES_PATH, 'utf8');
    const ruleBody = extractRuleBody(css, '.maka-list-row[data-active="true"]');
    assert.ok(ruleBody, '.maka-list-row[data-active="true"] rule must exist');
    assert.doesNotMatch(
      ruleBody,
      /min-height:/,
      '.maka-list-row[data-active="true"] must NOT declare min-height (selected state stays 32px)',
    );
  });

  it('.maka-list-row[data-active="true"] stays flat without an accent left rail', async () => {
    // WAWQAQ called out that the left rail still carried too much
    // old Maka/Slack-style chrome. The active row now follows the
    // reference-style flat list: neutral fill, no ::before
    // rail, and no accent stripe.
    const css = await readFile(STYLES_PATH, 'utf8');
    const ruleBody = extractRuleBody(css, '.maka-list-row[data-active="true"]::before');
    assert.equal(ruleBody, undefined, 'active row must not render an accent ::before rail');
    assert.match(
      extractRuleBody(css, '.maka-list-row[data-active="true"]') ?? '',
      /background:\s*var\(--foreground-4\)/,
      'active row should use neutral flat fill instead of accent tint',
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

  it('unread dot follows PawWork status priority: asking/busy/error outrank unread', async () => {
    // PawWork sidebar status slot is ordered asking → busy → error → unread → time.
    // Maka renders asking/busy/error as the name-side SessionStatusIcon, so the
    // right-side unread dot must not also appear for those states.
    const ui = await readFile(UI_COMPONENTS_PATH, 'utf8');
    assert.match(ui, /function shouldShowSessionUnreadDot/, 'SessionRow must route unread visibility through a named helper');
    assert.match(ui, /if \(active\) return false;/, 'the currently open session must not still announce unread status');
    assert.match(ui, /SIDEBAR_UNREAD_SUPPRESSED_STATUSES/, 'helper must use a closed suppressed-status list');
    assert.match(ui, /'running'/, 'running/busy sessions must suppress unread dot');
    assert.match(ui, /'waiting_for_user'/, 'asking sessions must suppress unread dot');
    assert.match(ui, /'blocked'/, 'blocked/error sessions must suppress unread dot');
    assert.match(
      ui,
      /shouldShowSessionUnreadDot\(session,\s*Boolean\(streaming\),\s*active\)/,
      'SessionRow render path must use shouldShowSessionUnreadDot instead of raw hasUnread && !streaming',
    );
    assert.doesNotMatch(
      ui,
      /session\.hasUnread\s*&&\s*!streaming\s*\?/,
      'raw unread-vs-streaming ternary would ignore waiting/running/blocked priority',
    );
  });

  it('active session row exposes current-session semantics, not only visual accent styling', async () => {
    const ui = await readFile(UI_COMPONENTS_PATH, 'utf8');
    const sessionRow = ui.slice(ui.indexOf('function SessionRow'), ui.indexOf('interface PermissionModeMeta'));

    assert.match(
      sessionRow,
      /data-active=\{active\}/,
      'SessionRow must keep its visual active-state hook',
    );
    assert.match(
      sessionRow,
      /aria-current=\{active \? 'true' : undefined\}/,
      'the current conversation row must expose aria-current so assistive tech can announce the selected conversation',
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

  it('hidden row actions stay out of the accessibility tree and tab order', async () => {
    const ui = await readFile(UI_COMPONENTS_PATH, 'utf8');
    const sessionRow = ui.slice(ui.indexOf('function SessionRow'), ui.indexOf('interface PermissionModeMeta'));

    assert.match(
      sessionRow,
      /const \[actionsVisible,\s*setActionsVisible\] = useState\(false\);/,
      'SessionRow must track whether hover/focus actions are actually visible',
    );
    assert.match(
      sessionRow,
      /const actionTabIndex = actionsVisible \? 0 : -1;/,
      'hidden row action buttons must not remain in the tab order',
    );
    assert.match(
      sessionRow,
      /onMouseEnter=\{\(\) => setActionsVisible\(true\)\}/,
      'mouse hover must expose row actions',
    );
    assert.match(
      sessionRow,
      /onFocus=\{\(\) => setActionsVisible\(true\)\}/,
      'keyboard focus on the row must expose row actions before the next Tab stop',
    );
    assert.match(
      sessionRow,
      /aria-hidden=\{actionsVisible \? undefined : 'true'\}/,
      'hidden row action clusters must be removed from the accessibility tree',
    );
    assert.match(
      sessionRow,
      /className="maka-list-row-action"[\s\S]*?tabIndex=\{actionTabIndex\}/,
      'row action buttons must share the visibility-controlled tabIndex',
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
