import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, TOKENS_FILE, readAllRendererCss, stripCssComments } from './css-test-helpers.js';

/**
 * Zero-visual governance contract for issue #332 PR3b — the `ToolActivity` card
 * shell (the inline section + count pill, the `<details>` card, its `<summary>`
 * header row + status dot, the body / intent, and the args `<pre>` override)
 * moved onto the `@maka/ui` chat substrate's `toolVariants` literalize table.
 *
 * The SHELL halves of "zero visual change" are proven by the computed-style diff
 * harness (`npm run check:chat-visual`): each retired `.maka-tool*` / `.toolInline`
 * / `.toolItem` / `.toolArgs` declaration compiles 1:1 to its literal utility, so
 * this test does NOT re-assert those literals — that would only mirror the
 * implementation. It locks the three things the diff cannot cover:
 *   1. the ABSENCE of the retired selectors (a diff of computed styles can't show
 *      a selector is gone), scoped so the still-bespoke `.maka-tool-error*`
 *      (PR3c), `.maka-tool-diff*` / `.maka-tool-terminal*` (result previews, out
 *      of scope), and shared `.maka-code` base survive untouched;
 *   2. the running status dot's `@keyframes maka-tool-pulse` ring frames — an
 *      animation can't be a leaf-literal and `getComputedStyle` reads a phase-
 *      dependent value, so the breath is pinned here + by the `chat.tsx` literal;
 *   3. native `<summary>` marker reset — re-keyed off the retired `.maka-tool`
 *      class onto the governed `[data-slot="tool"]` hook.
 */
describe('chat tool-card migration contract (#332 PR3b)', () => {
  it('retires the bespoke tool-card shell selectors (without touching error/preview/maka-code)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    for (const selector of [
      // inline section + args override (styles/tool-output.css)
      '.toolInline',
      '.toolItem',
      '.toolArgs',
      // summary header row + status dot + body / intent / count (maka-tokens.css)
      '.maka-tool-header',
      '.maka-tool-name',
      '.maka-tool-meta',
      '.maka-tool-duration',
      '.maka-tool-status-label',
      '.maka-tool-status-dot',
      '.maka-tool-body',
      '.maka-tool-intent',
      '.maka-tool-count',
      // the `<details>` card base + its status / open / summary selectors
      '.maka-tool {',
      '.maka-tool >',
      '.maka-tool[open]',
      '.maka-tool[data-status',
    ]) {
      assert.ok(
        !css.includes(selector),
        `retired tool-card selector "${selector}" still present in renderer CSS`,
      );
    }

    // Adjacent concern that PR3b must leave alone: the shared inline-code base.
    // (The error banner `.maka-tool-error*` was PR3b-era out-of-scope but has since
    // retired onto the `Alert` primitive in PR3c, and the result-preview renderers
    // `.maka-tool-diff*` / `.maka-tool-terminal*` onto `previewVariants` in PR4, so
    // neither is asserted as kept here anymore.)
    for (const kept of [
      '.maka-code',
    ]) {
      assert.ok(
        css.includes(kept),
        `PR3b must not retire the out-of-scope selector "${kept}"`,
      );
    }
  });

  it('keeps the @keyframes maka-tool-pulse ring frames (the dot breath the diff cannot see)', async () => {
    const tokens = stripCssComments(await readFile(TOKENS_FILE, 'utf8'));
    assert.ok(
      tokens.includes('@keyframes maka-tool-pulse'),
      '`@keyframes maka-tool-pulse` must stay in maka-tokens.css — a keyframe is a global rule, not an element property',
    );
    const pulse = tokens.slice(
      tokens.indexOf('@keyframes maka-tool-pulse'),
      tokens.indexOf('@keyframes maka-tool-pulse') + 220,
    );
    // The box-shadow RING grows 3px → 5px and fades 0.15 → 0.06. This is the
    // running dot's zero-visual proof; it can't be machine-diffed, so it is pinned.
    for (const frame of [
      'box-shadow: 0 0 0 3px oklch(from var(--status-running) l c h / 0.15)',
      'box-shadow: 0 0 0 5px oklch(from var(--status-running) l c h / 0.06)',
    ]) {
      assert.ok(pulse.includes(frame), `maka-tool-pulse must pin the retired ring frame "${frame}"`);
    }
  });

  it('keeps only the marker reset residue, re-keyed onto [data-slot="tool"]', async () => {
    const tokens = stripCssComments(await readFile(TOKENS_FILE, 'utf8'));
    assert.ok(
      !tokens.includes('.maka-tool {') && !tokens.includes('@starting-style {\n    .maka-tool'),
      'the retired `.maka-tool` class must not return',
    );
    assert.ok(!tokens.includes('@starting-style'), 'decorative tool-card entrance styles are banned');
    for (const residue of [
      '[data-slot="tool"] {',
      'transform: translateY(0)',
      'transition: border-color var(--duration-base) var(--ease-out-strong);',
      '[data-slot="tool"] > summary::-webkit-details-marker { display: none; }',
      "[data-slot=\"tool\"] > summary::marker { content: ''; }",
    ]) {
      assert.ok(
        tokens.includes(residue),
        `tool-card residue must keep "${residue}" on the [data-slot="tool"] hook`,
      );
    }
  });

  it('keeps the computed-style fixture covering every production tool status', async () => {
    // The zero-visual proof is only as complete as the statuses it renders. The
    // truth source is tool-activity.tsx's `STATUS_LABEL` (a `Record` over the full
    // `ToolActivityItem['status']` union — its keys ARE every production status).
    // The harness must render a card for each: a new status that escapes the
    // fixture would have NO diffed row, so its tint could drift unseen (the
    // `pending` gap this guard was added to close). No card-level exclusions —
    // even `running` renders a card; only its animated DOT id is left out of IDS.
    const componentsSrc = await readFile(
      resolve(REPO_ROOT, 'packages', 'ui', 'src', 'tool-activity.tsx'),
      'utf8',
    );
    // Anchor on the FULL `ToolActivityItem` signature — a bare `const STATUS_LABEL`
    // prefix-matches the unrelated session-status `STATUS_LABEL_BY_STATUS` map.
    const labelStart = componentsSrc.indexOf("const STATUS_LABEL: Record<ToolActivityItem['status']");
    assert.ok(labelStart !== -1, 'failed to locate the tool STATUS_LABEL declaration in tool-activity.tsx');
    const labelBlock = componentsSrc.slice(labelStart, componentsSrc.indexOf('};', labelStart));
    const statuses = [...labelBlock.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    assert.ok(statuses.length >= 5, 'failed to parse STATUS_LABEL keys from tool-activity.tsx');

    const harnessSrc = await readFile(
      resolve(REPO_ROOT, 'scripts', 'check-chat-marker-computed-style.mjs'),
      'utf8',
    );
    const statBlock = harnessSrc.slice(harnessSrc.indexOf('const STAT ='));
    const stat = [...statBlock.slice(0, statBlock.indexOf(']')).matchAll(/'([^']+)'/g)].map((m) => m[1]);
    for (const status of statuses) {
      assert.ok(
        stat.includes(status),
        `computed-style fixture STAT must render the "${status}" card so its zero-visual proof has a diffed row`,
      );
    }
  });

  it('pins the running-dot escape literals in chat.tsx + guards against scale drift', async () => {
    const rawSrc = await readFile(
      resolve(REPO_ROOT, 'packages', 'ui', 'src', 'primitives', 'chat.tsx'),
      'utf8',
    );
    const chatSrc = rawSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const start = chatSrc.indexOf('const toolVariants');
    const block = chatSrc.slice(start, chatSrc.indexOf('export { toolVariants }', start));
    assert.ok(start !== -1 && block.length > 0, 'toolVariants table must exist in chat.tsx');

    // The diff harness proves the static shell; the running dot's animation is the
    // one part it cannot reach. Pin the breath + its leaf box-shadow ring here.
    for (const literal of [
      '[animation:maka-tool-pulse_1.5s_ease-in-out_infinite]',
      '[box-shadow:0_0_0_3px_oklch(from_var(--status-running)_l_c_h_/_0.15)]',
    ]) {
      assert.ok(
        block.includes(literal),
        `running dot must carry the literal "${literal}" mirroring the retired CSS`,
      );
    }
    // The dot must never fall back to Tailwind's built-in `animate-pulse` (a
    // different opacity-only keyframe) nor reuse the LiveIndicator breath — the
    // tool dot's ring pulse is a distinct keyframe.
    for (const banned of ['animate-pulse', 'maka-pulse_']) {
      assert.ok(
        !block.includes(banned),
        `tool dot must use the governed maka-tool-pulse ring, not "${banned}"`,
      );
    }
    // The open/collapsed divider — the one card surface that differs by state
    // (the collapsed default has no bottom border). The computed-diff proves both
    // states, but that harness is manual (no CI), so pin the `[open]>summary`
    // literal here as the automated guard.
    assert.ok(
      block.includes('[&[open]>summary]:[border-bottom:1px_solid_var(--border)]'),
      'item must keep the `[open]>summary` divider literal (collapsed default has none)',
    );
    // Anti-drift: pin the distinctive literals and ban the semantic-scale
    // forms they would be swapped for. Radius uses the `--radius-surface`
    // token per #406 gap 4. Spacing now uses the Tailwind scale (gap-2.5)
    // per #430 PR3 spacing converge — arbitrary px literals are banned.
    for (const literal of ['rounded-[var(--radius-surface)]', 'text-[12.5px]', 'gap-2.5', 'min-w-[22px]']) {
      assert.ok(block.includes(literal), `toolVariants must keep the literal "${literal}"`);
    }
    for (const scale of ['rounded-lg', 'rounded-xl', 'text-sm', 'text-xs']) {
      assert.ok(
        !block.includes(scale),
        `toolVariants must stay literal, not adopt the semantic-scale "${scale}"`,
      );
    }

    // The `waiting_permission` status must keep the `String.raw` `\_` escape: a
    // bare `data-[status=waiting_permission]` compiles to `[data-status="waiting
    // permission"]` (Tailwind `_`→space) and silently falls back to the base
    // color — a zero-visual break the diff harness caught but a careless
    // "simplification" could reintroduce. Assert the escaped form is present and
    // the bare form is absent across the whole module.
    assert.ok(
      chatSrc.includes('waiting\\_permission'),
      'waiting_permission must keep its `String.raw` `\\_` escape so the emitted class matches',
    );
    assert.ok(
      !chatSrc.includes('data-[status=waiting_permission]'),
      'the bare (underscore-as-space) `data-[status=waiting_permission]` form must never appear',
    );
  });
});
