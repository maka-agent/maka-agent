/**
 * PR-SIDEBAR-INDICATOR-SIZE-CONVERGE-0 (issue #743, follow-up to #738):
 * session-row indicator sizes converge onto tokens. After the fresh-eye
 * codex review:
 *   - streaming-dot/unread 8px → var(--space-2)
 *   - status icon keeps its 14px wrapper layout slot (a documented dense-meta
 *     exception per docs/design-system.md §1.9) AND scopes a local 12px SVG
 *     override so buttonVariants' [&_svg]:size-[var(--icon-size,1rem)] (16px
 *     chrome tier, a cascade leak from borrowing UiButton) does not grow the
 *     <Icon size={12}> dense-meta glyph. The wrapper footprint stays 14px so
 *     the title does not shift.
 *   - .maka-list-row-text min-height was dropped — the row's 32px control
 *     min-height + grid center owns the height, so the 24px was redundant.
 *
 * The contract pins each indicator's width/height/min-height exactly-once
 * across rest blocks AND within each block (a `height: a; height: b` in one
 * block is caught, not just a second block).
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

/** ALL declarations of `prop` within one block (global match), so a
 *  `height: var(--space-2); height: var(--space-3)` same-block override is
 *  surfaced as two declarations, not collapsed to the first. */
function declarationsIn(body: string, prop: string): string[] {
  const re = new RegExp(`(?:^|[\\n;])\\s*${prop}\\s*:\\s*([^;}]*)`, 'ig');
  return [...body.matchAll(re)].map((m) => m[1].trim().replace(/\s+/g, ' '));
}

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

/** Assert `prop` is declared exactly once across all rest blocks of `selector`,
 *  with `expected` value. Catches both a second rest block and a same-block
 *  duplicate (`height: a; height: b`) — either yields two declarations. */
function assertExactlyOnce(css: string, selector: string, prop: string, expected: string, label: string): void {
  const blocks = restBlocks(css, selector);
  const decls = blocks.flatMap((b) => declarationsIn(b, prop));
  assert.equal(decls.length, 1, `${label}: ${prop} must be declared exactly once (a later rest block OR a same-block duplicate would both win the cascade); got ${decls.length}: ${JSON.stringify(decls)}`);
  assert.equal(decls[0], expected, `${label}: ${prop} must be ${expected}`);
}

describe('PR-SIDEBAR-INDICATOR-SIZE-CONVERGE-0 contract (issue #743)', () => {
  it('.maka-list-row-streaming-dot width and height are each var(--space-2), declared exactly once', async () => {
    const css = stripCssComments(await readAllRendererCss());
    assertExactlyOnce(css, '.maka-list-row-streaming-dot', 'width', 'var(--space-2)', 'streaming-dot');
    assertExactlyOnce(css, '.maka-list-row-streaming-dot', 'height', 'var(--space-2)', 'streaming-dot');
  });

  it('.maka-list-row-unread width and height are each var(--space-2), declared exactly once', async () => {
    const css = stripCssComments(await readAllRendererCss());
    assertExactlyOnce(css, '.maka-list-row-unread', 'width', 'var(--space-2)', 'unread');
    assertExactlyOnce(css, '.maka-list-row-unread', 'height', 'var(--space-2)', 'unread');
  });

  it('.maka-list-row-text declares no min-height (the row 32px control min-height + grid center own the height)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    const decls = restBlocks(css, '.maka-list-row-text').flatMap((b) => declarationsIn(b, 'min-height'));
    assert.equal(decls.length, 0, `.maka-list-row-text must not set min-height (redundant with .maka-list-row's 32px); got ${JSON.stringify(decls)}`);
  });

  it('.maka-list-row-status-icon wrapper is 14px (dense-meta slot) and the SVG is var(--space-3) (12px)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    assertExactlyOnce(css, '.maka-list-row-status-icon', 'width', '14px', 'status-icon wrapper');
    assertExactlyOnce(css, '.maka-list-row-status-icon', 'height', '14px', 'status-icon wrapper');
    assertExactlyOnce(css, '.maka-list-row-status-icon svg', 'width', 'var(--space-3)', 'status-icon svg');
    assertExactlyOnce(css, '.maka-list-row-status-icon svg', 'height', 'var(--space-3)', 'status-icon svg');
  });

  it('assertExactlyOnce flags a same-block duplicate override (negative case)', () => {
    const fakeCss = '.maka-list-row-unread { width: var(--space-2); height: var(--space-2); height: var(--space-3); }';
    const decls = restBlocks(fakeCss, '.maka-list-row-unread').flatMap((b) => declarationsIn(b, 'height'));
    assert.equal(decls.length, 2, 'a same-block height duplicate must be caught (two declarations), not silently pass via first-match');
  });
});