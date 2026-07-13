import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBootstrapSelectionLease } from '../../renderer/bootstrap-selection-lease.js';

type Summary = { id: string; lastMessageAt?: number };

function session(id: string, lastMessageAt?: number): Summary {
  return { id, lastMessageAt };
}

function harness(activeId?: string) {
  let active = activeId;
  let revision = 0;
  const lease = createBootstrapSelectionLease<Summary>({
    readActiveId: () => active,
    readSelectionRevision: () => revision,
    select: (next) => {
      revision += 1;
      active = next;
    },
  });
  return {
    lease,
    activeId: () => active,
    select(next: string | undefined) {
      revision += 1;
      active = next;
    },
  };
}

describe('bootstrap selection lease', () => {
  it('lets snapshot A and mounted pull B reconcile while bootstrap still owns selection', () => {
    const state = harness();
    assert.equal(state.lease.reconcile([session('a', 1)]), true);
    assert.equal(state.activeId(), 'a');
    assert.equal(state.lease.reconcile([session('b', 2)]), true);
    assert.equal(state.activeId(), 'b');
  });

  it('cannot select history when the user starts a new task before the first snapshot', () => {
    const state = harness();
    state.select(undefined);
    assert.equal(state.lease.reconcile([session('history', 1)]), false);
    assert.equal(state.activeId(), undefined);
  });

  it('cannot replace a user selection made between snapshot A and B', () => {
    const state = harness();
    state.lease.reconcile([session('a', 1)]);
    state.select('user-choice');
    assert.equal(state.lease.reconcile([session('b', 2)]), false);
    assert.equal(state.activeId(), 'user-choice');
  });

  it('clears a bootstrap-owned selection when the latest snapshot is empty', () => {
    const state = harness();
    state.lease.reconcile([session('a', 1)]);
    assert.equal(state.lease.reconcile([]), true);
    assert.equal(state.activeId(), undefined);
  });

  it('does not reconcile after release', () => {
    const state = harness();
    state.lease.release();
    assert.equal(state.lease.reconcile([session('history', 1)]), false);
    assert.equal(state.activeId(), undefined);
  });
});
