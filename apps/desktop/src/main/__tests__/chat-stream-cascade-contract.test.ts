import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, TOKENS_FILE, readAllRendererCss, stripCssComments } from './css-test-helpers.js';

/**
 * Zero-visual governance contract for issue #332 PR3 — the tool live-output
 * stream (`ToolOutputStream`) moved onto the `@maka/ui` chat substrate: the
 * panel/header/flags/body/chunk shell onto the `streamVariants` literalize
 * table, and the pulsing "live" dot onto the governed `LiveIndicator` primitive.
 *
 * The shell halves of "zero visual change" are locked the same way as PR2: the
 * bespoke `.maka-tool-output-stream-*` selectors are retired and each literal
 * compiles 1:1 to the declaration it replaced. The dot is the exception — an
 * animation can't be a leaf-literal and `getComputedStyle` reads a phase-
 * dependent value, so its breath is pinned by the canonical `@keyframes
 * maka-pulse` (frames asserted below) plus the literals in `chat.tsx`, verified
 * by before/after screenshots rather than the computed-style diff harness.
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
    // Live code must not still import/call streamVariants (comments may mention history).
    assert.doesNotMatch(harness, /streamVariants\s*\(/);
    assert.doesNotMatch(harness, /from\s+.*primitives\/chat.*streamVariants|streamVariants\s*\}/);
    assert.doesNotMatch(harness, /toolOutputPanel[\s\S]*maka-tool-output-stream|sv\s*\(/);
  });

  it('keeps the computed-style fixture aligned with production disclosure defaults', async () => {
    const harness = await readFile(
      resolve(REPO_ROOT, 'scripts', 'check-chat-marker-computed-style.mjs'),
      'utf8',
    );

    assert.match(
      harness,
      /const openByDefault = \(s\) => s === 'waiting_permission' \|\| s === 'errored';/,
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
      // the dot's per-feature breath is retired onto the shared `maka-pulse`.
      '@keyframes maka-tool-output-stream-pulse',
    ]) {
      assert.ok(
        !css.includes(selector),
        `retired stream selector "${selector}" still present in renderer CSS`,
      );
    }
  });

  it('keeps the governed canonical pulse keyframe with the retired dot frames', async () => {
    const tokens = stripCssComments(await readFile(TOKENS_FILE, 'utf8'));
    assert.ok(
      tokens.includes('@keyframes maka-pulse'),
      'canonical `@keyframes maka-pulse` must live in maka-tokens.css (the shared motion home)',
    );
    // The frames mirror the retired `maka-tool-output-stream-pulse` exactly
    // (rest opacity 0.55, scale 1 → 1.1). This is the dot's zero-visual proof —
    // it can't be machine-diffed, so the values are pinned here.
    const pulse = tokens.slice(
      tokens.indexOf('@keyframes maka-pulse'),
      tokens.indexOf('@keyframes maka-pulse') + 220,
    );
    for (const frame of [
      'opacity: 0.55',
      'transform: scale(1)',
      'opacity: 1',
      'transform: scale(1.1)',
    ]) {
      assert.ok(pulse.includes(frame), `maka-pulse must pin the retired dot frame "${frame}"`);
    }
  });

  it('pins the live indicator dot — the one part the computed-style diff cannot cover', async () => {
    // The stream SHELL (container/header/flags/body/chunk) is proven by the
    // computed-style diff harness (0 delta), so this test does NOT
    // re-assert those literals — that would just mirror the implementation. The
    // dot is the exception: an animation can't be a leaf-literal and
    // `getComputedStyle` reads a phase-dependent value, so the diff can't see it.
    // Its breath is pinned by the `@keyframes maka-pulse` frame contract (above)
    // plus the `LiveIndicator` literals here — the only machine proof it has.
    const rawSrc = await readFile(
      resolve(REPO_ROOT, 'packages', 'ui', 'src', 'primitives', 'chat.tsx'),
      'utf8',
    );
    const chatSrc = rawSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const liveBlock = chatSrc.slice(chatSrc.indexOf('function LiveIndicator'));
    for (const literal of [
      'w-[6px] h-[6px] rounded-[50%] bg-[var(--status-running)]',
      '[animation:maka-pulse_1.4s_ease-in-out_infinite]',
      'motion-reduce:[animation:none] motion-reduce:opacity-[0.8]',
    ]) {
      assert.ok(
        liveBlock.includes(literal),
        `LiveIndicator must carry the literal "${literal}" mirroring the retired dot`,
      );
    }
    // The dot must never fall back to Tailwind's built-in `animate-pulse` (a
    // different opacity-only keyframe) or recolor off the accent token.
    for (const banned of ['animate-pulse', 'bg-primary']) {
      assert.ok(
        !liveBlock.includes(banned),
        `LiveIndicator must use the governed maka-pulse/accent, not "${banned}"`,
      );
    }
  });
});
