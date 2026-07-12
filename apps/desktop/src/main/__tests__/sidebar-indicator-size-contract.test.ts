/**
 * PR-SIDEBAR-INDICATOR-SIZE-CONVERGE-0 (issue #743, follow-up to #738):
 * the session-row indicator path used bare 8/14/24px literals that bypassed
 * the spacing and control-height vocabularies. Converge them onto tokens so
 * the row can't drift off-ruler:
 *
 *   .maka-list-row-streaming-dot  width/height 8px → var(--space-2)
 *   .maka-list-row-unread         width/height 8px → var(--space-2)
 *   .maka-list-row-text           min-height 24px → var(--h-control-sm)
 *   .maka-list-row-status-icon    width/height 14px → documented dense exception (kept)
 *
 * The 14px status icon stays a documented exception: --icon-size is 16px
 * (chrome glyphs), and 16px would degrade the session row's density. The
 * contract asserts that one selector keeps 14px so a NEW bare 14px elsewhere
 * in the indicator path would still need its own exception.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  readAllRendererCss,
  stripCssComments,
} from './css-test-helpers.js';

function styleRules(css: string): Array<[string, string]> {
  const stripped = stripCssComments(css);
  return [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => {
    const prelude = m[1].replace(/^[\s\S]*;/, '').trim();
    return [prelude, m[2]] as [string, string];
  });
}

function decl(body: string, prop: string): string | undefined {
  const re = new RegExp(`(?:^|\\n)\\s*${prop}\\s*:\\s*([^;}]*)`, 'i');
  const m = body.match(re);
  return m ? m[1].trim().replace(/\s+/g, ' ') : undefined;
}

function restBlock(css: string, subjectSelector: string): string | undefined {
  const escaped = subjectSelector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}\\s*$`);
  for (const [prelude, body] of styleRules(css)) {
    if (prelude && !prelude.startsWith('@') && re.test(prelude) && !/[:[]/.test(prelude)) {
      return body;
    }
  }
  return undefined;
}

describe('PR-SIDEBAR-INDICATOR-SIZE-CONVERGE-0 contract (issue #743)', () => {
  it('.maka-list-row-streaming-dot uses var(--space-2) for width/height (not bare 8px)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    const body = restBlock(css, '.maka-list-row-streaming-dot');
    assert.ok(body, '.maka-list-row-streaming-dot rest block not found');
    assert.equal(decl(body, 'width'), 'var(--space-2)', 'streaming-dot width must be var(--space-2)');
    assert.equal(decl(body, 'height'), 'var(--space-2)', 'streaming-dot height must be var(--space-2)');
  });

  it('.maka-list-row-unread uses var(--space-2) for width/height (not bare 8px)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    const body = restBlock(css, '.maka-list-row-unread');
    assert.ok(body, '.maka-list-row-unread rest block not found');
    assert.equal(decl(body, 'width'), 'var(--space-2)', 'unread width must be var(--space-2)');
    assert.equal(decl(body, 'height'), 'var(--space-2)', 'unread height must be var(--space-2)');
  });

  it('.maka-list-row-text min-height uses var(--h-control-sm) (not bare 24px)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    const body = restBlock(css, '.maka-list-row-text');
    assert.ok(body, '.maka-list-row-text rest block not found');
    assert.equal(decl(body, 'min-height'), 'var(--h-control-sm)', 'list-row-text min-height must be var(--h-control-sm)');
  });

  it('.maka-list-row-status-icon stays a documented dense exception (14px, not --icon-size=16px)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    const body = restBlock(css, '.maka-list-row-status-icon');
    assert.ok(body, '.maka-list-row-status-icon rest block not found');
    // 14px is the documented dense exception: --icon-size is 16px (chrome glyphs)
    // and 16px would degrade the session row's density. Pinned here so a NEW
    // bare 14px elsewhere in the indicator path still needs its own exception.
    assert.equal(decl(body, 'width'), '14px', 'status-icon width is the documented 14px dense exception');
    assert.equal(decl(body, 'height'), '14px', 'status-icon height is the documented 14px dense exception');
  });
});