import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  REPO_ROOT,
  TOKENS_FILE,
  RENDERER_STYLES_DIR,
  STYLES_FILE,
  readCssTree,
  stripCssComments,
} from './css-test-helpers.js';

// Issue #499 P0-3 — tab component governance.
// One tab spec: shared `maka-tab` class + `underline`/`pill` variants on the Base
// UI Tabs primitive, active/hover repointed to --state-selected-bg /
// --state-hover-bg (no brand token, no per-surface hand-written tab CSS).
//
// This file grows one slice at a time. Slice 1 covers the primitive + the
// first consumer (plan tabs).

const TABS_FILE = resolve(REPO_ROOT, 'packages/ui/src/primitives/tabs.tsx');
const PLAN_PANEL_FILE = resolve(REPO_ROOT, 'packages/ui/src/plan-reminder-panel.tsx');
const PLAN_CSS_FILE = resolve(
  REPO_ROOT,
  'apps/desktop/src/renderer/styles/module-pages/plan-reminders.css',
);
const PROVIDERS_PANEL_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/settings/ProvidersPanel.tsx');
const MODELS_CSS_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/styles/settings/models.css');
const PROVIDER_EDITOR_CSS_FILE = resolve(
  REPO_ROOT,
  'apps/desktop/src/renderer/styles/settings/provider-editor.css',
);
const SKILLS_PANEL_FILE = resolve(REPO_ROOT, 'packages/ui/src/skills-panel.tsx');
const SKILLS_CSS_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/styles/module-pages/skills.css');

const BRAND_STATE_TOKEN_RE =
  /var\(--nav-active\)|var\(--accent\)|var\(--toast-accent\)|var\(--bot-brand-color\)|var\(--bot-brand-default\)/;

describe('issue #499 P0-3 tab spec contract', () => {
  it('tabs primitive exposes maka-tab class on TabsTab and underline|pill variants on TabsList', async () => {
    const src = await readFile(TABS_FILE, 'utf8');
    assert.match(src, /"underline"/, 'TabsVariant must include "underline"');
    assert.match(src, /"pill"/, 'TabsVariant must include "pill" (currently only default|underline)');
    assert.match(src, /\bmaka-tab\b/, 'TabsTab must emit the shared maka-tab class');
  });

  it('.maka-tab active/hover use neutral state tokens, no brand token', async () => {
    const allCss = [TOKENS_FILE, ...(await readCssTree(RENDERER_STYLES_DIR)), STYLES_FILE];
    let foundMakaTab = false;
    let foundActiveBg = false;
    let foundHoverBg = false;
    const brandInTab: string[] = [];
    for (const file of allCss) {
      const source = stripCssComments(await readFile(file, 'utf8'));
      for (const ruleMatch of source.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
        const selector = ruleMatch[1]!;
        const body = ruleMatch[2]!;
        if (!/\.maka-tab\b/.test(selector)) continue;
        foundMakaTab = true;
        if ((/\[data-active\]/.test(selector) || /:active\b/.test(selector)) && /background(?:-color)?:/.test(body)) {
          if (/var\(--state-selected-bg\)/.test(body)) foundActiveBg = true;
        }
        if (/:hover/.test(selector) && /background(?:-color)?:/.test(body)) {
          if (/var\(--state-hover-bg\)/.test(body)) foundHoverBg = true;
        }
        if (BRAND_STATE_TOKEN_RE.test(body)) {
          brandInTab.push(`${file}: ${selector.trim()}`);
        }
      }
    }
    assert.ok(foundMakaTab, 'a .maka-tab rule must exist');
    assert.ok(foundActiveBg, '.maka-tab active must use --state-selected-bg');
    assert.ok(foundHoverBg, '.maka-tab hover must use --state-hover-bg');
    assert.deepEqual(
      brandInTab,
      [],
      `.maka-tab must not use brand tokens (--nav-active/--accent/--toast-accent/--bot-brand-*):\n${brandInTab.join('\n')}`,
    );
  });

  it('plan tabs consume maka-tab + underline variant; no hand-written .maka-plan-tab active/under-bar CSS', async () => {
    const panel = await readFile(PLAN_PANEL_FILE, 'utf8');
    assert.match(
      panel,
      /TabsList[^>]*variant="underline"/,
      'plan TabsList must pass variant="underline"',
    );
    assert.match(
      panel,
      /TabsTrigger[^>]*className="[^"]*\bmaka-tab\b/,
      'plan TabsTrigger must carry the maka-tab class',
    );
    const css = stripCssComments(await readFile(PLAN_CSS_FILE, 'utf8'));
    // The active state + under-bar move to .maka-tab; surface-specific layout
    // rules (.maka-plan-tab height/padding/font-size) may remain, but the
    // hand-written [data-state="active"] selectors (currently dead — Base UI
    // sets data-active, not data-state) must be gone.
    assert.doesNotMatch(
      css,
      /\.maka-plan-tab\[data-state\s*=\s*"active"\]/,
      'plan hand-written [data-state="active"] selector must be removed (active state moves to .maka-tab)',
    );
    assert.doesNotMatch(
      css,
      /\.maka-plan-tab\[data-state\s*=\s*"active"\]::after/,
      'plan hand-written under-bar ::after must be removed',
    );
  });

  it('catalog tabs consume maka-tab + pill variant + TabsPanel; no hand-written catalogTab/catalogPillTabs active/hover/indicator CSS', async () => {
    const panel = await readFile(PROVIDERS_PANEL_FILE, 'utf8');
    assert.match(
      panel,
      /PrimitiveTabsList[^>]*variant="pill"/,
      'catalog TabsList must pass variant="pill"',
    );
    assert.match(
      panel,
      /PrimitiveTabsTrigger[^>]*className="[^"]*\bmaka-tab\b/,
      'catalog TabsTrigger must carry the maka-tab class',
    );
    assert.match(
      panel,
      /PrimitiveTabsPanel/,
      'catalog content must render through PrimitiveTabsPanel (not bare conditional render)',
    );
    // data-active hand-written boolean removed (Base UI sets data-active on the
    // active tab); data-catalog-tab stays (locked by model-oauth-section contract
    // as the tab identifier, not a manual focus query).
    assert.doesNotMatch(
      panel,
      /data-active=\{catalogTab === tab\.id\}/,
      'catalog hand-written data-active={catalogTab === tab.id} must be removed (Base UI sets data-active)',
    );
    assert.match(
      panel,
      /data-catalog-tab=\{tab\.id\}/,
      'data-catalog-tab={tab.id} must stay (tab identifier used by model-oauth contract)',
    );

    const modelsCss = stripCssComments(await readFile(MODELS_CSS_FILE, 'utf8'));
    assert.doesNotMatch(
      modelsCss,
      /\.catalogPillTabs button\[data-active/,
      'catalog hand-written .catalogPillTabs button[data-active] must be removed (active moves to .maka-tab)',
    );
    assert.doesNotMatch(
      modelsCss,
      /\.catalogPillTabs button:hover/,
      'catalog hand-written .catalogPillTabs button:hover must be removed (hover moves to .maka-tab)',
    );
    assert.doesNotMatch(
      modelsCss,
      /\.catalogPillTabs \[data-slot="tab-indicator"\]/,
      'catalog hand-written indicator display:none must be removed (pill variant hides the indicator in tabs.tsx)',
    );

    const providerEditorCss = stripCssComments(await readFile(PROVIDER_EDITOR_CSS_FILE, 'utf8'));
    assert.doesNotMatch(
      providerEditorCss,
      /\.catalogTab\[data-active/,
      'catalog hand-written .catalogTab[data-active] must be removed (active moves to .maka-tab)',
    );
    assert.doesNotMatch(
      providerEditorCss,
      /\.catalogTab:hover/,
      'catalog hand-written .catalogTab:hover must be removed (hover moves to .maka-tab)',
    );
  });

  it('skill tabs migrate from hand-rolled buttons to maka-tab + underline variant + TabsPanel', async () => {
    const panel = await readFile(SKILLS_PANEL_FILE, 'utf8');
    assert.match(
      panel,
      /TabsList[^>]*variant="underline"/,
      'skill TabsList must pass variant="underline"',
    );
    assert.match(
      panel,
      /TabsTrigger[^>]*className="[^"]*\bmaka-tab\b/,
      'skill TabsTrigger must carry the maka-tab class',
    );
    assert.match(
      panel,
      /TabsPanel/,
      'skill content must render through TabsPanel',
    );
    // hand-rolled tab-switcher markers removed (Base UI TabsTrigger carries the
    // tab role + aria-selected; the aria-pressed segmented-switcher pattern goes).
    assert.doesNotMatch(
      panel,
      /aria-pressed=\{activeSkillTab === tab\}/,
      'skill hand-rolled aria-pressed switcher must be removed',
    );
    assert.doesNotMatch(
      panel,
      /data-state=\{activeSkillTab === tab \? 'active' : 'inactive'\}/,
      'skill hand-rolled data-state switcher must be removed',
    );
    const css = stripCssComments(await readFile(SKILLS_CSS_FILE, 'utf8'));
    assert.doesNotMatch(
      css,
      /\.maka-skill-tab\[data-state\s*=\s*"active"\]/,
      'skill hand-written [data-state=active] selector must be removed (active moves to .maka-tab)',
    );
    assert.doesNotMatch(
      css,
      /\.maka-skill-tab\[data-state\s*=\s*"active"\]::after/,
      'skill hand-written under-bar ::after must be removed (underline variant uses the Base UI indicator)',
    );
  });
});