import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, readAllRendererCss, stripCssComments } from './css-test-helpers.js';

/**
 * Zero-visual governance contract for issue #332 PR2 — the per-turn status /
 * lineage / footer chrome (`summary` / `aborted` / `failed` / `lineage` /
 * `footer`) moved onto the `@maka/ui` `Marker` chat primitive. These lock the
 * two halves of "zero visual change": the bespoke `.maka-turn-*` *marker* shell
 * CSS is retired, while the still-hand-written turn *container* (and the
 * deferred reasoning `<details>`) keep their exact styling.
 */
describe('chat Marker shell migration contract (#332 PR2)', () => {
  it('retires the bespoke turn marker shell selectors', async () => {
    const css = stripCssComments(await readAllRendererCss());
    for (const selector of [
      '.maka-turn-summary',
      '.maka-turn-summary-chip',
      '.maka-turn-summary-chip-switched',
      '.maka-turn-aborted-marker',
      '.maka-turn-failed-banner',
      '.maka-turn-failed-icon',
      '.maka-turn-failed-recovery',
      '.maka-turn-lineage-row',
      '.maka-turn-lineage-row-reverse',
      '.maka-turn-lineage-badge',
      '.maka-turn-footer',
      '.maka-turn-footer-action',
      // The measure-column re-anchor PR1 parked in tool-output.css for PR2 to
      // consume — folded into the Marker container variants, so it's gone too.
      '[data-slot="message"][data-role="assistant"] .maka-turn-footer',
      '[data-slot="message"][data-role="assistant"] .maka-turn-lineage-row',
    ]) {
      assert.ok(
        !css.includes(selector),
        `retired turn-marker selector "${selector}" still present in renderer CSS`,
      );
    }
  });

  it('keeps the turn container + deferred reasoning chrome (out of scope)', async () => {
    const css = await readAllRendererCss();
    for (const selector of [
      // The `.maka-turn` flex/measure container is NOT a marker — it stays.
      '.maka-turn {',
      '.maka-turn-tools',
      '.maka-turn-streaming',
      '.maka-turn[data-search-highlight="true"]',
      // `.maka-turn-thinking` is explicitly deferred (pseudo-element chevron +
      // @starting-style fade don't reduce to leaf utilities); it stays authored.
      '.maka-turn-thinking',
      '.maka-turn-thinking summary',
    ]) {
      assert.ok(css.includes(selector), `out-of-scope turn rule "${selector}" must be preserved`);
    }
  });

  it('pins the Marker variants to the retired turn-marker pixels/tokens', async () => {
    const rawSrc = await readFile(
      resolve(REPO_ROOT, 'packages', 'ui', 'src', 'primitives', 'chat.tsx'),
      'utf8',
    );
    // Strip comments so the assertions reflect real classNames, not prose.
    const chatSrc = rawSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const markerBlock = chatSrc.slice(chatSrc.indexOf('markerVariants'));
    // Each fragment is a LITERAL arbitrary utility that compiles 1:1 to the
    // declaration it replaces on a leaf element — asserting the source string is
    // equivalent to asserting the computed style, no browser. Values mirror the
    // retired `.maka-turn-*` rules exactly (pixels, oklch relative-color tints,
    // var() tokens) and never the semantic scale.
    for (const literal of [
      // summary strip + chip + switched pill (maka-tokens.css)
      'max-w-[var(--maka-chat-measure,680px)]',
      "[&:not(:first-child)]:before:content-['·']",
      '[&_code]:[font-family:var(--font-mono)]',
      'data-[kind=model]:[&_code]:text-[color:var(--foreground-secondary)]',
      // every chip `data-[kind]` conditional is pinned, not just `model`, so
      // dropping the tools tint / duration+tokens tabular-nums / tokens mono
      // fails the contract.
      'data-[kind=tools]:text-[color:var(--muted-foreground)]',
      'data-[kind=duration]:[font-variant-numeric:tabular-nums]',
      'data-[kind=tokens]:[font-family:var(--font-mono)]',
      'data-[state=in-progress]:text-[color:var(--status-running)]',
      'data-[state=in-progress]:font-semibold',
      'bg-[oklch(from_var(--foreground)_l_c_h_/_0.06)]',
      // aborted marker (models.css)
      'bg-[var(--foreground-5)]',
      '[&_em]:italic',
      // failed banner + recovery (models.css)
      'bg-[oklch(from_var(--destructive)_l_c_h_/_0.10)]',
      'border-[oklch(from_var(--destructive)_l_c_h_/_0.28)]',
      "before:content-['·']",
      // lineage badge directions (models.css)
      'data-[direction=forward]:text-[oklch(from_var(--info-text)_calc(l_-_0.06)_c_h)]',
      'data-[direction=reverse]:text-[oklch(from_var(--brand-deep)_calc(l_-_0.04)_c_h)]',
      // footer + footer action (models.css)
      'opacity-[0.72] hover:opacity-100 focus-within:opacity-100',
      'min-h-[28px]',
      // `h-8` (→30px) is folded into the footer-action / lineage-badge shells
      // now that the call sites use `UiButton size="nav"` (bare); it used to
      // come implicitly from `size="sm"`.
      'h-8',
      '[&:hover:not(:disabled)]:bg-[oklch(from_var(--foreground)_l_c_h_/_0.05)]',
      // focus-visible is a non-leaf conflict (the footer action's outline vs
      // UiButton's box-shadow ring), so the rendered-style script can't force
      // it reliably; this exact literalization of the retired
      // `outline: 2px solid var(--focus-ring)` pins it here instead.
      'focus-visible:[outline:2px_solid_var(--focus-ring)]',
      'focus-visible:[outline-offset:2px]',
      'data-[pending=true]:opacity-[0.78]',
      // the combined disabled+pending guards: a copy button can be both
      // `disabled` and `data-pending` (transient copy click), and the retired
      // CSS kept the 0.78 pending dim winning over the 0.45 disabled dim — these
      // raise the specificity so emit order can't flip it.
      'disabled:data-[pending=true]:opacity-[0.78]',
      'aria-disabled:data-[pending=true]:opacity-[0.78]',
      'data-[copy-feedback=copied]:text-[color:var(--link)]',
    ]) {
      assert.ok(
        markerBlock.includes(literal),
        `Marker variant must carry the literal "${literal}" mirroring the retired turn-marker CSS`,
      );
    }
    // Never the semantic scale or a primary/accent recolor of the neutral chips.
    for (const banned of ['rounded-lg', 'rounded-md', 'bg-primary', 'bg-accent', 'text-primary']) {
      assert.ok(
        !markerBlock.includes(banned),
        `Marker variants must stay literal, not the scale/recolor utility "${banned}"`,
      );
    }
  });
});
