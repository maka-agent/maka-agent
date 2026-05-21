/**
 * Tests for branch banner derivation (PR109f).
 *
 * Locks the contract:
 *  - banner only renders for sessions with parentSessionId set
 *  - banner requires the parent session to be visible in the list
 *  - banner copy uses the parent's display name
 *  - fromAbortedTurn is caller-supplied; helper never guesses
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  deriveBranchBanner,
  type BranchBannerSessionInput,
} from '../../renderer/branch-banner.js';

function session(partial: Partial<BranchBannerSessionInput> & { id: string; name: string }): BranchBannerSessionInput {
  return { ...partial };
}

describe('deriveBranchBanner', () => {
  it('returns undefined for non-branched sessions', () => {
    const active = session({ id: 's1', name: '原会话' });
    const result = deriveBranchBanner(active, [active]);
    assert.equal(result, undefined);
  });

  it('returns undefined when activeSession is undefined', () => {
    const result = deriveBranchBanner(undefined, []);
    assert.equal(result, undefined);
  });

  it('returns undefined when parentSessionId references a hidden session', () => {
    // Parent archived / filtered out of the visible list — better to
    // show no banner than render a banner that clicks into nothing.
    const active = session({ id: 's2', name: '分支会话', parentSessionId: 'parent-not-here' });
    const result = deriveBranchBanner(active, [active]);
    assert.equal(result, undefined);
  });

  it('returns banner with parent name when parent is visible', () => {
    const parent = session({ id: 'p1', name: '父会话' });
    const active = session({ id: 's3', name: '分支会话', parentSessionId: 'p1' });
    const result = deriveBranchBanner(active, [parent, active]);
    assert.deepEqual(result, {
      parentSessionId: 'p1',
      parentSessionName: '父会话',
    });
  });

  it('passes through fromAbortedTurn when caller supplies it', () => {
    const parent = session({ id: 'p2', name: '父会话' });
    const active = session({ id: 's4', name: '分支会话', parentSessionId: 'p2' });
    const result = deriveBranchBanner(active, [parent, active], true);
    assert.deepEqual(result, {
      parentSessionId: 'p2',
      parentSessionName: '父会话',
      fromAbortedTurn: true,
    });
  });

  it('omits fromAbortedTurn when caller passes false / undefined', () => {
    const parent = session({ id: 'p3', name: '父会话' });
    const active = session({ id: 's5', name: '分支会话', parentSessionId: 'p3' });
    const resultFalse = deriveBranchBanner(active, [parent, active], false);
    const resultUndef = deriveBranchBanner(active, [parent, active], undefined);
    assert.equal(resultFalse?.fromAbortedTurn, undefined);
    assert.equal(resultUndef?.fromAbortedTurn, undefined);
  });

  it('does not mutate the input sessions list', () => {
    const parent = session({ id: 'p4', name: '父会话' });
    const active = session({ id: 's6', name: '分支会话', parentSessionId: 'p4' });
    const sessions = [parent, active];
    const before = JSON.stringify(sessions);
    deriveBranchBanner(active, sessions, true);
    assert.equal(JSON.stringify(sessions), before);
  });

  it('uses the parent name verbatim (no truncation, no fallback)', () => {
    // If parent rename is involved later, the banner must reflect the
    // current name so the user sees the same label as in the sidebar.
    const parent = session({ id: 'p5', name: '一个非常长的父会话名称用于测试不截断' });
    const active = session({ id: 's7', name: '分支会话', parentSessionId: 'p5' });
    const result = deriveBranchBanner(active, [parent, active]);
    assert.equal(result?.parentSessionName, '一个非常长的父会话名称用于测试不截断');
  });
});
