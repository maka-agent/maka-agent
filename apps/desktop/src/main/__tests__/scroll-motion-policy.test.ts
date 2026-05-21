/**
 * Tests for scroll motion policy helper (PR109f).
 *
 * @kenji + @xuan review gate: the lineage badge click + future
 * branch-banner navigation must collapse smooth scrolling to `auto`
 * inside the visual-smoke fixture so screenshots stay deterministic.
 * @xuan confirmed on main that visual-smoke ALWAYS writes
 * `data-maka-visual-smoke="true"` but `data-maka-reduced-motion="true"`
 * is only on the reduced variant — so the visual-smoke flag is the
 * primary signal, not the reduced-motion attribute.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  resolveScrollMotionBehavior,
  type ScrollMotionPolicyInputs,
} from '../../renderer/scroll-motion-policy.js';

function inputs(partial: Partial<ScrollMotionPolicyInputs>): ScrollMotionPolicyInputs {
  return {
    reducedMotionAttr: false,
    visualSmokeAttr: false,
    prefersReducedMotion: false,
    ...partial,
  };
}

describe('resolveScrollMotionBehavior', () => {
  it('returns "smooth" when no triggers are set', () => {
    assert.equal(resolveScrollMotionBehavior(inputs({})), 'smooth');
  });

  it('returns "auto" when reduced-motion attr is set (PR-IR-04 reduced variant)', () => {
    assert.equal(
      resolveScrollMotionBehavior(inputs({ reducedMotionAttr: true })),
      'auto',
    );
  });

  it('returns "auto" when visual-smoke attr is set (any PR-IR-02 capture)', () => {
    // @xuan PR109f: visual-smoke fixture writes this attribute on every
    // capture, regardless of variant. We must collapse smooth scroll
    // even if reduced-motion attr is absent.
    assert.equal(
      resolveScrollMotionBehavior(inputs({ visualSmokeAttr: true })),
      'auto',
    );
  });

  it('returns "auto" when prefers-reduced-motion media query matches', () => {
    assert.equal(
      resolveScrollMotionBehavior(inputs({ prefersReducedMotion: true })),
      'auto',
    );
  });

  it('returns "auto" when any combination of triggers is set', () => {
    for (const combo of [
      { reducedMotionAttr: true, visualSmokeAttr: true },
      { reducedMotionAttr: true, prefersReducedMotion: true },
      { visualSmokeAttr: true, prefersReducedMotion: true },
      { reducedMotionAttr: true, visualSmokeAttr: true, prefersReducedMotion: true },
    ] as Array<Partial<ScrollMotionPolicyInputs>>) {
      assert.equal(resolveScrollMotionBehavior(inputs(combo)), 'auto');
    }
  });

  it('@xuan PR109f: visual-smoke alone is sufficient (reduced-motion attr NOT required)', () => {
    // Regression: an earlier version only checked reduced-motion attr,
    // which let smooth scrolling leak into the unmodified visual-smoke
    // capture path. Confirm visual-smoke alone triggers `auto`.
    assert.equal(
      resolveScrollMotionBehavior(
        inputs({
          reducedMotionAttr: false,
          visualSmokeAttr: true,
          prefersReducedMotion: false,
        }),
      ),
      'auto',
    );
  });
});
