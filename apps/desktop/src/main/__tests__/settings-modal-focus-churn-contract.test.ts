/**
 * Regression contract: Settings focus management must not churn with
 * parent re-renders, and must follow the active section.
 *
 * Bug 1 (focus churn): the modal's focus-on-open effect was keyed on
 * `[props.onClose]`. `onClose` (app-shell.tsx's `closeSettings`) is a
 * plain function recreated on every AppShell render, and AppShell
 * re-renders on every streamed token (`streamingBySession` state). So
 * while a session streamed, the effect tore down and re-ran per token,
 * each run calling `.focus()` -- yanking focus back to the settings nav
 * dozens of times a second and closing any focus-managed popup opened
 * inside Settings ("clicking inside Settings does nothing").
 *
 * Bug 2 (focus-follows-section, found in review of #513): a mount-only
 * ([]) focus effect fixed the churn but dropped focus-follows-selection
 * for ⌘K palette jumps -- openSettingsSection() switches sections via
 * `requestedSection` WITHOUT remounting the modal, so a mount-only
 * effect never refocuses the newly active nav button.
 *
 * The contract: focus is owned by settings-surface.tsx, keyed on
 * `section` (runs on mount AND on section change), and NO focus side
 * effect anywhere in the settings tree is keyed on a parent callback
 * prop like onClose.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';

describe('Settings focus management contract', () => {
  it('focus follows the active section via a section-keyed effect in settings-surface', async () => {
    const src = await readSettingsCombinedSource();

    assert.match(
      src,
      /useEffect\(\(\) => \{\s*props\.initialFocusRef\.current\?\.focus\(\);[\s\S]*?\}, \[section\]\);/,
      'settings-surface must focus the active nav button keyed on [section] -- covering both mount and ⌘K section jumps (which do NOT remount the modal)',
    );
  });

  it('no settings focus side effect is keyed on a parent callback prop', async () => {
    const src = await readSettingsCombinedSource();

    // Find every useEffect body that calls .focus() and assert none of them
    // depend on props.onClose (or any onXxx callback) -- parent callbacks
    // are recreated on every AppShell render (per streamed token), which
    // would re-run the focus and steal it from popups opened in Settings.
    const focusEffects = src.match(/useEffect\(\(\) => \{[\s\S]*?\}, \[[^\]]*\]\);/g) ?? [];
    for (const effect of focusEffects) {
      if (!effect.includes('.focus()')) continue;
      assert.doesNotMatch(
        effect,
        /\}, \[[^\]]*props\.on[A-Z][^\]]*\]\);/,
        `a focus-calling effect must not be keyed on a parent callback prop (unstable identity re-runs it per streamed token):\n${effect}`,
      );
    }

    // The Escape-key listener may (and should) stay keyed on onClose -- it
    // only adds/removes a DOM listener, no focus side effect -- so Escape
    // always calls the current closure rather than a stale one.
    const escapeEffect = src.match(
      /useEffect\(\(\) => \{\s*function onKey\([\s\S]*?\}, \[props\.onClose\]\);/,
    );
    assert.ok(escapeEffect, 'the Escape-key listener effect must exist, keyed on [props.onClose]');
    assert.doesNotMatch(
      escapeEffect![0],
      /\.focus\(\)/,
      'the onClose-keyed Escape effect must NOT also call .focus() -- that reintroduces the focus-churn bug',
    );
  });
});
