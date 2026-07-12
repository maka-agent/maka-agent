/**
 * PR-SIDEBAR-INDICATOR-SIZE-CONVERGE-0 (issue #743, follow-up to #738):
 * session-row indicator sizes converge onto tokens. After the fresh-eye
 * codex review the status icon keeps its dense-meta 12px (per
 * docs/design-system.md §1.9 — dense-meta icons are call-site 12–14px, NOT
 * --icon-size 16px) via a local SVG override, instead of the earlier "converge
 * to 16px" which violated the design contract and silently grew the icon
 * 14→16px. The contract pins each indicator's width/height exactly-once per
 * property (a height-only override is caught, not just a width block) and
 * drops the over-broad `.maka-list-row-*` prefix scanner (it governed
 * non-indicators like -main/-text/-menu-trigger and false-positived on
 * `calc(…)`).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readAllRendererCss, stripCssComments } from './css-test-helpers.js';

function styleRules(css: string): Array<[string, string]> {
  const stripped = stripCssComments(css);
  return [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => {
    const prelude = m[1].replace(/^[\s\S]*;/, '').trim();
    return [prelude, m[2]] as [string, string];
  });
}

function decl(body: string, prop: string): string | undefined {
  const re = new RegExp(`(?:^|[\\n;])\\s*${prop}\\s*:\\s*([^;}]*)`, 'i');
  const m = body.match(re);
  return m ? m[1].trim().replace(/\s+/g, ' ') : undefined;
}

/** All rest-state blocks whose subject is exactly `subjectSelector` (no state
 *  pseudo, no attribute, no @media prelude). Returns ALL matches so a later
 *  same-selector override (the cascade winner) is caught, not just the first. */
function restBlocks(css: string, subjectSelector: string): string[] {
  const escaped = subjectSelector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}\\s*$`);
  const blocks: string[] = [];
  for (const [prelude, body] of styleRules(css)) {
    if (prelude && !prelude.startsWith('@') && re.test(prelude) && !/[:[]/.test(prelude)) {
      blocks.push(body);
    }
  }
  return blocks;
}

/** Rest blocks that actually set `prop` — e.g. the @media animation-only block
 *  for streaming-dot sets no width, so it is excluded. Counting these lets a
 *  height-only override (a second block setting just height) be caught. */
function restBlocksSetting(css: string, subjectSelector: string, prop: string): string[] {
  return restBlocks(css, subjectSelector).filter((b) => decl(b, prop) !== undefined);
}

/** Assert `prop` is set in exactly one rest block of `selector`, with `expected`
 *  value. Catches both first-match and height-only-override false-greens. */
function assertExactlyOnce(css: string, selector: string, prop: string, expected: string, label: string): void {
  const blocks = restBlocksSetting(css, selector, prop);
  assert.equal(blocks.length, 1, `${label}: ${prop} must be set in exactly one rest block (a later same-selector override would win the cascade); got ${blocks.length}`);
  assert.equal(decl(blocks[0]!, prop), expected, `${label}: ${prop} must be ${expected}`);
}

describe('PR-SIDEBAR-INDICATOR-SIZE-CONVERGE-0 contract (issue #743)', () => {
  it('.maka-list-row-streaming-dot width and height are each var(--space-2), set exactly once', async () => {
    const css = stripCssComments(await readAllRendererCss());
    assertExactlyOnce(css, '.maka-list-row-streaming-dot', 'width', 'var(--space-2)', 'streaming-dot');
    assertExactlyOnce(css, '.maka-list-row-streaming-dot', 'height', 'var(--space-2)', 'streaming-dot');
  });

  it('.maka-list-row-unread width and height are each var(--space-2), set exactly once', async () => {
    const css = stripCssComments(await readAllRendererCss());
    assertExactlyOnce(css, '.maka-list-row-unread', 'width', 'var(--space-2)', 'unread');
    assertExactlyOnce(css, '.maka-list-row-unread', 'height', 'var(--space-2)', 'unread');
  });

  it('.maka-list-row-text min-height is var(--space-6) (content spacing, not a control token)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    assertExactlyOnce(css, '.maka-list-row-text', 'min-height', 'var(--space-6)', 'list-row-text');
  });

  it('.maka-list-row-status-icon wrapper declares no width/height; the SVG is var(--space-3) (12px dense meta)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    // wrapper: no width/height (the SVG owns the footprint)
    const wrapper = restBlocks(css, '.maka-list-row-status-icon');
    for (const b of wrapper) {
      assert.equal(decl(b, 'width'), undefined, 'status-icon wrapper must not set width');
      assert.equal(decl(b, 'height'), undefined, 'status-icon wrapper must not set height');
    }
    // svg: 12px dense-meta override (var(--space-3)), not --icon-size 16px
    assertExactlyOnce(css, '.maka-list-row-status-icon svg', 'width', 'var(--space-3)', 'status-icon svg');
    assertExactlyOnce(css, '.maka-list-row-status-icon svg', 'height', 'var(--space-3)', 'status-icon svg');
  });

  it('assertExactlyOnce flags a height-only same-selector override (negative case)', () => {
    const fakeCss =
      '.maka-list-row-unread { width: var(--space-2); height: var(--space-2); }\n' +
      '.maka-list-row-unread { height: var(--space-3); }';
    const blocks = restBlocksSetting(fakeCss, '.maka-list-row-unread', 'height');
    assert.equal(blocks.length, 2, 'a height-only override must be caught (two height blocks), not silently pass via first-match');
  });
});