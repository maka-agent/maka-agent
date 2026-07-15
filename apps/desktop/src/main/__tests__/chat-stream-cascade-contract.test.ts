import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, TOKENS_FILE, readAllRendererCss, stripCssComments } from './css-test-helpers.js';

/**
 * Governance contract for the #332 PR3 tool live-output stream substrate after
 * its #712 retirement. The stream shell (`streamVariants`), the pulsing "live"
 * dot (`LiveIndicator`), and the canonical `@keyframes maka-pulse` that breathed
 * it are all removed — the tool body now renders through the flat `ToolTrow`,
 * which expresses running state via a `TextShimmer` text sweep (not a pulsing
 * dot), so the retired dot + its keyframe have no successor in the production
 * path. The separate `maka-tool-pulse` keyframe (the `ToolActivity` card's ring
 * dot) is a different concern and stays.
 *
 * What stays guarded here: the computed-style fixture stays aligned with the
 * quiet production panel + its disclosure defaults, the retired bespoke
 * `.maka-tool-output-stream-*` selectors + `maka-tool-output-stream-pulse`
 * keyframe stay absent, and the removed PR3 substrate (`streamVariants` /
 * `LiveIndicator` / `@keyframes maka-pulse`) stays removed.
 */
describe('chat tool-output stream migration contract (#332 PR3)', () => {
  it('keeps the computed-style fixture aligned with the quiet tool-output panel', async () => {
    const harness = await readFile(
      resolve(REPO_ROOT, 'scripts', 'check-chat-marker-computed-style.mjs'),
      'utf8',
    );

    // Stream variants are no longer the production tool body; the quiet panel is.
    assert.match(harness, /TOOL_OUTPUT_PANEL_CLASS/);
    assert.match(harness, /TOOL_OUTPUT_BODY_CLASS/);
    assert.match(harness, /data-slot="tool-output"/);
    assert.doesNotMatch(harness, /toolOutputPanel[\s\S]*maka-tool-output-stream|sv\s*\(/);
  });

  it('keeps the computed-style fixture aligned with production disclosure defaults', async () => {
    const harness = await readFile(
      resolve(REPO_ROOT, 'scripts', 'check-chat-marker-computed-style.mjs'),
      'utf8',
    );

    assert.match(
      harness,
      /const openByDefault = \(s\) => s === 'waiting_permission';/,
    );
  });

  it('retires the bespoke stream shell selectors + the per-feature pulse keyframe', async () => {
    const css = stripCssComments(await readAllRendererCss());
    for (const selector of [
      '.maka-tool-output-stream',
      '.maka-tool-output-stream-header',
      '.maka-tool-output-stream-label',
      '.maka-tool-output-stream-dot',
      '.maka-tool-output-stream-counts',
      '.maka-tool-output-stream-body',
      '.maka-tool-output-stream-chunk',
      '.maka-tool-output-stream-redacted-tag',
      '.maka-tool-output-stream-truncated-tag',
      // the dot's per-feature breath is retired.
      '@keyframes maka-tool-output-stream-pulse',
    ]) {
      assert.ok(
        !css.includes(selector),
        `retired stream selector "${selector}" still present in renderer CSS`,
      );
    }
  });

  it('keeps the retired PR3 stream substrate fully removed', async () => {
    // #712 retired the tool live-output stream; this PR finishes removing the
    // substrate. The `streamVariants` shell table, the `LiveIndicator` dot
    // primitive, and the `@keyframes maka-pulse` that breathed it must all stay
    // gone — comments may still mention the history, so the chat.tsx check
    // strips comments before asserting the identifiers are absent from code.
    const rawSrc = await readFile(
      resolve(REPO_ROOT, 'packages', 'ui', 'src', 'primitives', 'chat.tsx'),
      'utf8',
    );
    const chatSrc = rawSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(
      !/\bstreamVariants\b/.test(chatSrc),
      '`streamVariants` must stay removed from chat.tsx code',
    );
    assert.ok(
      !/\bLiveIndicator\b/.test(chatSrc),
      '`LiveIndicator` must stay removed from chat.tsx code',
    );
    const tokens = stripCssComments(await readFile(TOKENS_FILE, 'utf8'));
    // Precise declaration match so a future `@keyframes maka-pulse-ring` (or
    // similar) is not falsely rejected by a bare substring check.
    assert.ok(
      !/@keyframes\s+maka-pulse\s*\{/.test(tokens),
      '`@keyframes maka-pulse` must stay removed from maka-tokens.css (its only consumer, LiveIndicator, is gone)',
    );
  });
});
