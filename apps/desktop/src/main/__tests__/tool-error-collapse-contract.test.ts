/**
 * PR-TOOL-ERROR-COLLAPSE-0 (issue #741): an errored tool must show one concise
 * summary (ToolErrorBanner) by default and keep the raw diagnostic payload
 * behind a collapsed disclosure, so a verbose validation/runtime failure
 * cannot grow a turn to ~2631px and dominate the conversation until expanded.
 *
 * The banner already truncates errorText to 240px and offers a copy action;
 * the fix adds an inner Collapsible (closed by default, keyboard-reachable
 * trigger) that owns the raw result, and removes the raw result from the
 * shared panel so the truncated banner summary is not duplicated inline.
 *
 * These tests render the public ToolActivity surface (boxed card path) with
 * a single errored item whose error text is long enough that its tail sits
 * past the banner's 240px truncation. The tail marker must NOT appear in the
 * default (collapsed) markup — it only renders inside the CollapsiblePanel,
 * which Base UI leaves unmounted while closed.
 */

import { strict as assert } from 'node:assert';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it } from 'node:test';
import type { ToolActivityItem } from '@maka/ui';
import { ToolActivity } from '@maka/ui';

const TAIL_MARKER = 'TAIL_MARKER_SCHEMA_DETAILS';

// A long, natural-language error whose tail sits past the banner's 240px
// truncation. Repeating varied prose (not a single-char run) so redactSecrets
// does not collapse it to <redacted> and shorten it under the truncation.
const LONG_ERROR = 'Validation failed: ' + Array.from({length: 15}, (_, i) => `field ${i} invalid; `).join('') + TAIL_MARKER;

function erroredItem(errorText: string): ToolActivityItem {
  return {
    toolUseId: 'tu_err_1',
    toolName: 'read',
    status: 'errored',
    args: { path: '/some/file.ts' },
    result: { kind: 'text', text: errorText },
  };
}

function renderErrored(errorText: string): string {
  return renderToStaticMarkup(createElement(ToolActivity, { items: [erroredItem(errorText)] }));
}

describe('PR-TOOL-ERROR-COLLAPSE-0 contract (issue #741)', () => {
  it('renders the concise failure banner by default for an errored tool', () => {
    const markup = renderErrored(LONG_ERROR);
    assert.match(markup, /工具调用失败/, 'errored tool must show the ToolErrorBanner summary');
    assert.match(markup, /Validation failed:/, 'banner must show the start of the error text');
  });

  it('collapses the raw diagnostic payload by default (tail marker not rendered alongside the banner)', () => {
    const markup = renderErrored(LONG_ERROR);
    assert.doesNotMatch(
      markup,
      new RegExp(TAIL_MARKER),
      'raw payload tail must be collapsed by default — the banner already shows the first 240px, the rest must not render until expanded',
    );
  });

  it('exposes a keyboard-reachable trigger to expand the raw diagnostics', () => {
    const markup = renderErrored(LONG_ERROR);
    assert.match(markup, /显示原始诊断/, 'errored tool must label the raw-details disclosure trigger');
  });

  it('does not collapse the banner summary itself — the first 240px stays visible', () => {
    // A short error (under the 240px banner truncation) still renders its text
    // in the banner; only the raw payload (which would duplicate it) collapses.
    const markup = renderErrored('short failure reason');
    assert.match(markup, /short failure reason/, 'a short error must still appear in the banner');
    assert.match(markup, /显示原始诊断/, '...and still offers the raw-details disclosure');
  });
});