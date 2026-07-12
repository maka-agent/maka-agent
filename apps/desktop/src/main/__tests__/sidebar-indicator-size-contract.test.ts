/**
 * PR-SIDEBAR-INDICATOR-SIZE-CONVERGE-0 (issue #743, follow-up to #738):
 * session-row indicator sizes converge onto tokens. After the codex review
 * the status-icon 14px wrapper was removed (it never clipped the SVG —
 * buttonVariants owns the in-button glyph size via var(--icon-size), so the
 * icon converges to 16px like every other in-button glyph), and the contract
 * now scans ALL .maka-list-row-* selectors for bare-px width/height/min-height
 * so a new off-ruler indicator cannot sneak back. .maka-list-row-text uses
 * var(--space-6) (content spacing), not --h-control-sm (reserved for controls
 * by control-height-converge-contract).
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

/** Extract a declared property value from a selector block's body. Matches
 *  at start-of-block or after a `;` or newline so single- and multi-line
 *  declarations both work. Whitespace is collapsed. */
function decl(body: string, prop: string): string | undefined {
  const re = new RegExp(`(?:^|[\\n;])\\s*${prop}\\s*:\\s*([^;}]*)`, 'i');
  const m = body.match(re);
  return m ? m[1].trim().replace(/\s+/g, ' ') : undefined;
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

const NEUTRAL_SIZE = /^(?:0(?:px|%)?|100%|auto|inherit|initial|unset|revert|none)$/;

/** Bare-px width/height/min-height on any .maka-list-row-* selector — the
 *  indicator path must use tokens (var(...)) or neutral literals. A new
 *  off-ruler indicator anywhere in .maka-list-row-* is flagged here, not
 *  just the four originally-listed selectors. */
function barePxSizeOffenders(css: string): string[] {
  const offenders: string[] = [];
  for (const [prelude, body] of styleRules(css)) {
    if (!prelude.includes('.maka-list-row-')) continue;
    for (const prop of ['width', 'height', 'min-height']) {
      const v = decl(body, prop);
      if (v === undefined) continue;
      if (/^var\(/.test(v) || NEUTRAL_SIZE.test(v)) continue;
      offenders.push(`${prelude.replace(/\s+/g, ' ')} ${prop}: ${v}`);
    }
  }
  return offenders;
}

/** Among the rest blocks for a selector, the ones that actually set `prop`
 *  (e.g. the @media animation-only block for streaming-dot sets no width, so
 *  it is excluded — only the geometry block counts). */
function restBlocksSetting(css: string, subjectSelector: string, prop: string): string[] {
  return restBlocks(css, subjectSelector).filter((b) => decl(b, prop) !== undefined);
}

describe('PR-SIDEBAR-INDICATOR-SIZE-CONVERGE-0 contract (issue #743)', () => {
  it('.maka-list-row-streaming-dot uses var(--space-2) for width/height', async () => {
    const css = stripCssComments(await readAllRendererCss());
    const w = restBlocksSetting(css, '.maka-list-row-streaming-dot', 'width');
    assert.equal(w.length, 1, '.maka-list-row-streaming-dot width must be set in exactly one rest block (the @media animation block sets none)');
    assert.equal(decl(w[0]!, 'width'), 'var(--space-2)');
    assert.equal(decl(w[0]!, 'height'), 'var(--space-2)');
  });

  it('.maka-list-row-unread uses var(--space-2) for width/height', async () => {
    const css = stripCssComments(await readAllRendererCss());
    const w = restBlocksSetting(css, '.maka-list-row-unread', 'width');
    assert.equal(w.length, 1, '.maka-list-row-unread width must be set in exactly one rest block');
    assert.equal(decl(w[0]!, 'width'), 'var(--space-2)');
    assert.equal(decl(w[0]!, 'height'), 'var(--space-2)');
  });

  it('.maka-list-row-text min-height uses var(--space-6) (content spacing, not a control token)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    const m = restBlocksSetting(css, '.maka-list-row-text', 'min-height');
    assert.equal(m.length, 1, '.maka-list-row-text min-height must be set in exactly one rest block');
    assert.equal(decl(m[0]!, 'min-height'), 'var(--space-6)');
  });

  it('.maka-list-row-status-icon declares no width/height (the SVG size is owned by buttonVariants)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    const blocks = restBlocks(css, '.maka-list-row-status-icon');
    for (const b of blocks) {
      assert.equal(decl(b, 'width'), undefined, 'no .maka-list-row-status-icon rest block may set width (buttonVariants sizes the SVG via var(--icon-size))');
      assert.equal(decl(b, 'height'), undefined, 'no .maka-list-row-status-icon rest block may set height');
    }
  });

  it('no bare-px width/height/min-height remains on any .maka-list-row-* selector', async () => {
    const css = stripCssComments(await readAllRendererCss());
    const offenders = barePxSizeOffenders(css);
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('barePxSizeOffenders flags a new off-ruler indicator (negative case)', () => {
    const fakeCss = '.maka-list-row-other-indicator { width: 14px; height: 14px; }';
    const offenders = barePxSizeOffenders(fakeCss);
    assert.equal(offenders.length, 2, 'a new bare-px .maka-list-row-* indicator must be flagged, not just the four originally-listed selectors');
  });
});