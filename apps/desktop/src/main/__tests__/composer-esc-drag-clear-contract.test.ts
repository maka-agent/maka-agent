/**
 * Source-grounded contract for PR-COMPOSER-ESC-DRAG-CLEAR-0
 * (resume of WAWQAQ goal 751c4f47).
 *
 * Composer + OnboardingHero both render a drag-active highlight
 * (`data-drag-active="true"`). A useEffect listens for window
 * `blur` / `dragend` / `drop` to clear that state, but not for
 * `keydown`. A user who hits Esc to cancel a stuck drag gesture
 * would otherwise see the highlight linger until they blurred the
 * window or completed a real drop somewhere.
 *
 * The fix wires Esc → `setDragActive(false)` in both surfaces.
 * This contract pins that handler so a future refactor doesn't
 * silently regress it.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const COMPOSER_SOURCE = resolve(REPO_ROOT, 'packages', 'ui', 'src', 'composer.tsx');
const ONBOARDING_HERO_SOURCE = resolve(
  REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'OnboardingHero.tsx',
);

describe('Esc clears stuck drag-active highlight (PR-COMPOSER-ESC-DRAG-CLEAR-0)', () => {
  it('Composer onTextareaKeyDown handles Esc + dragActive before the streaming branch', async () => {
    const src = await readFile(COMPOSER_SOURCE, 'utf8');
    // Find the keydown handler body.
    const keydown = src.match(/function onTextareaKeyDown\([\s\S]*?\n  \}/);
    assert.ok(keydown, 'onTextareaKeyDown must exist on Composer');
    // Must include an Esc + dragActive → setDragActive(false) branch.
    assert.match(
      keydown[0],
      /event\.key === 'Escape' && dragActive\)[\s\S]*?setDragActive\(false\)/,
      'Composer Esc handler must clear dragActive when the highlight is showing',
    );
  });

  it('OnboardingHero handleKey handles Esc + dragActive alongside Enter→submit', async () => {
    const src = await readFile(ONBOARDING_HERO_SOURCE, 'utf8');
    // Find the handleKey body.
    const handler = src.match(/const handleKey = useCallback\([\s\S]*?\n  \);\n\n  const prefillSuggestion/);
    assert.ok(handler, 'handleKey must exist on OnboardingHero');
    assert.match(
      handler[0],
      /event\.key === 'Escape' && dragActive\)[\s\S]*?setDragActive\(false\)/,
      'OnboardingHero Esc handler must clear dragActive when the highlight is showing',
    );
    // Dependency array must include dragActive so the callback observes
    // the current value.
    assert.match(
      handler[0],
      /\[[\s\S]*?\bdragActive\b[\s\S]*?\bsubmit\b[\s\S]*?\],\s*\);/,
      'handleKey deps must include dragActive and submit',
    );
  });
});
