import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, TOKENS_FILE, RENDERER_STYLES_DIR, STYLES_FILE, readCssTree, stripCssComments } from './css-test-helpers.js';

function readCssToken(source: string, selector: ':root' | '.dark', token: string): string {
  const block = source.match(new RegExp(`${selector.replace('.', '\\.')}(?:\\s*,\\s*[^{]+)?\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
  return block.match(new RegExp(`--${token}:\\s*([^;]+);`))?.[1].trim() ?? '';
}

describe('issue #499 state-token governance contract', () => {
  // Brand tokens banned in interaction-state surfaces (hover/selected/active).
  // Single-sourced so the hover and selected/active layers stay in sync:
  // --nav-active / --accent are the primary brand pair; --toast-accent and
  // --bot-brand-color / --bot-brand-default are --accent aliases used by toast
  // and per-bot surfaces. Base-brand controls (hover allowlist) and onboarding
  // brand emphasis (selected/active allowlist) keep a brand state.
  const BRAND_STATE_TOKEN_RE = /var\(--nav-active\)|var\(--accent\)|var\(--toast-accent\)|var\(--bot-brand-color\)|var\(--bot-brand-default\)/;

  it('defines --state-hover-bg (4%) and --state-selected-bg (6.5%) in :root', async () => {
    // --state-* are foreground-alpha derivations; like --border/--hover/--active
    // they are defined once in :root and auto-follow .dark via the relative-color
    // var(--foreground) lazy substitution. No .dark override needed.
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    const hover = readCssToken(tokens, ':root', 'state-hover-bg');
    const selected = readCssToken(tokens, ':root', 'state-selected-bg');
    assert.match(
      hover, /^oklch\(from var\(--foreground\) l c h \/ 0\.04\)$/,
      ':root --state-hover-bg must be 4% foreground alpha',
    );
    assert.match(
      selected, /^oklch\(from var\(--foreground\) l c h \/ 0\.065\)$/,
      ':root --state-selected-bg must be 6.5% foreground alpha',
    );
  });

  it('retires --hover and --active: no definition and no var() consumer in renderer CSS', async () => {
    const allCss = [
      TOKENS_FILE,
      ...(await readCssTree(RENDERER_STYLES_DIR)),
      STYLES_FILE,
    ];
    const violations: string[] = [];
    for (const file of allCss) {
      const source = stripCssComments(await readFile(file, 'utf8'));
      if (source.includes('var(--hover)')) violations.push(`${file}: var(--hover) consumer`);
      if (source.includes('var(--active)')) violations.push(`${file}: var(--active) consumer`);
      // Bare --hover: / --active: token definitions must be gone.
      // --color-hover / --color-active Tailwind bridges are fine (different name).
      for (const defMatch of source.matchAll(/^\s*--(hover|active):\s*/gm)) {
        violations.push(`${file}: --${defMatch[1]}: definition still present`);
      }
    }
    assert.deepEqual(violations, [], `--hover/--active must be fully retired:\n${violations.join('\n')}`);
  });

  it(':hover backgrounds use --state-hover-bg, not --foreground-N, inline oklch, or brand tokens (allowlist: base-brand controls whose hover stays brand)', async () => {
    const allCss = [TOKENS_FILE, ...(await readCssTree(RENDERER_STYLES_DIR)), STYLES_FILE];
    // Base-brand controls keep a brand hover (consistent with their brand base);
    // base-neutral controls must use --state-hover-bg. Allowlist is base-brand
    // controls only, not selected/active state surfaces.
    const HOVER_BRAND_ALLOWLIST = /(.maka-chat-header-memory-pill|\.modelTableDefaultHint|\.settingsBotAction|\.settingsWechatQrSecondary)/;
    const violations: string[] = [];
    for (const file of allCss) {
      const source = stripCssComments(await readFile(file, 'utf8'));
      // Walk rule blocks: selector { body }. For each block whose selector
      // contains :hover, check its background declaration.
      for (const ruleMatch of source.matchAll(/([^{}]*?):hover[^{]*\{([^}]*)\}/g)) {
        const selector = ruleMatch[1];
        if (HOVER_BRAND_ALLOWLIST.test(selector)) continue;
        const body = ruleMatch[2];
        for (const bgMatch of body.matchAll(/background(?:-color)?:\s*([^;]+);/g)) {
          const bg = bgMatch[1].trim();
          if (/var\(--foreground-(2|3|5|8|10)\)/.test(bg) || /^oklch\(from var\(--foreground\) l c h \/ 0\.0/.test(bg) || BRAND_STATE_TOKEN_RE.test(bg)) {
            violations.push(`${file}: :hover background ${bg}`);
          }
        }
      }
    }
    assert.deepEqual(violations, [], `:hover backgrounds must use --state-hover-bg, not --foreground-N, inline oklch, or brand tokens --nav-active/--accent/--toast-accent/--bot-brand-* (allowlist: base-brand controls):\n${violations.join('\n')}`);
  });

  it('selected/active surfaces use neutral tokens, not brand tokens --nav-active/--accent/--toast-accent/--bot-brand-* (allowlist: onboarding brand emphasis)', async () => {
    const allCss = [TOKENS_FILE, ...(await readCssTree(RENDERER_STYLES_DIR)), STYLES_FILE];
    // --nav-active stays only for onboarding brand emphasis (selected/active
    // selectors): .maka-firstrun-step, .maka-onboarding-setup-steps. Tab
    // surfaces migrated to the tab spec (#499 P0-3) now use neutral state
    // tokens, so they no longer need an allowlist entry.
    const ALLOWLIST_SELECTOR = /(\.maka-firstrun-step\b|\.maka-onboarding-setup-steps\b)/;
    const SELECTED_ACTIVE = /\[data-active|\[data-checked|\[data-default|\[data-pressed|\[data-selected|\[data-state\s*=\s*"active"|aria-selected\s*=\s*"true"/;
    const violations: string[] = [];
    for (const file of allCss) {
      const source = stripCssComments(await readFile(file, 'utf8'));
      for (const ruleMatch of source.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
        const selector = ruleMatch[1];
        const body = ruleMatch[2];
        if (!SELECTED_ACTIVE.test(selector)) continue;
        if (ALLOWLIST_SELECTOR.test(selector)) continue;
        if (BRAND_STATE_TOKEN_RE.test(body)) {
          violations.push(`${file}: ${selector.trim()} uses brand token (--nav-active/--accent/--toast-accent/--bot-brand-*)`);
        }
      }
    }
    assert.deepEqual(violations, [], `selected/active must not use brand tokens --nav-active/--accent/--toast-accent/--bot-brand-* (allowlist: onboarding brand emphasis):\n${violations.join('\n')}`);
  });
});
