/**
 * Tests for scroll motion policy helper (PR109f).
 *
 * @kenji + @xuan review gate: the lineage badge click + future
 * branch-banner navigation must collapse smooth scrolling to `auto`
 * inside the e2e-fixture fixture so screenshots stay deterministic.
 * @xuan confirmed on main that e2e-fixture ALWAYS writes
 * `data-maka-e2e-fixture="true"` but `data-maka-reduced-motion="true"`
 * is only on the reduced variant — so the e2e-fixture flag is the
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
    e2eFixtureAttr: false,
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

  it('returns "auto" when e2e-fixture attr is set (any PR-IR-02 capture)', () => {
    // @xuan PR109f: e2e-fixture fixture writes this attribute on every
    // capture, regardless of variant. We must collapse smooth scroll
    // even if reduced-motion attr is absent.
    assert.equal(
      resolveScrollMotionBehavior(inputs({ e2eFixtureAttr: true })),
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
      { reducedMotionAttr: true, e2eFixtureAttr: true },
      { reducedMotionAttr: true, prefersReducedMotion: true },
      { e2eFixtureAttr: true, prefersReducedMotion: true },
      { reducedMotionAttr: true, e2eFixtureAttr: true, prefersReducedMotion: true },
    ] as Array<Partial<ScrollMotionPolicyInputs>>) {
      assert.equal(resolveScrollMotionBehavior(inputs(combo)), 'auto');
    }
  });

  it('@xuan PR109f: e2e-fixture alone is sufficient (reduced-motion attr NOT required)', () => {
    // Regression: an earlier version only checked reduced-motion attr,
    // which let smooth scrolling leak into the unmodified e2e-fixture
    // capture path. Confirm e2e-fixture alone triggers `auto`.
    assert.equal(
      resolveScrollMotionBehavior(
        inputs({
          reducedMotionAttr: false,
          e2eFixtureAttr: true,
          prefersReducedMotion: false,
        }),
      ),
      'auto',
    );
  });
});
