import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bindCuaAction, CuaFrameState } from '../cua-frame-state.js';

function createState(): CuaFrameState {
  let nextFrameId = 1;
  return new CuaFrameState(() => `frame-${nextFrameId++}`);
}

describe('CuaFrameState', () => {
  test('creates a new frame identity for every observation', () => {
    const state = createState();

    assert.deepEqual(state.observe(), { frameId: 'frame-1', epoch: 0 });
    assert.deepEqual(state.observe(), { frameId: 'frame-2', epoch: 0 });
  });

  test('binds an action fingerprint to its observed frame', () => {
    const state = createState();
    const first = bindCuaAction(state.observe(), 'click:10,20');
    const second = bindCuaAction(state.observe(), 'click:10,20');

    assert.notEqual(first.fingerprint, second.fingerprint);
    assert.equal(first.frameId, 'frame-1');
    assert.equal(second.frameId, 'frame-2');
  });

  test('rejects an action from a superseded frame', () => {
    const state = createState();
    const oldAction = bindCuaAction(state.observe(), 'click:10,20');
    state.observe();

    assert.deepEqual(state.claimAction(oldAction), {
      ok: false,
      reason: 'stale_frame',
    });
  });

  test('rejects the same action twice on one frame', () => {
    const state = createState();
    const action = bindCuaAction(state.observe(), 'click:10,20');

    assert.deepEqual(state.claimAction(action), { ok: true });
    assert.deepEqual(state.claimAction(action), {
      ok: false,
      reason: 'duplicate_action',
    });
  });

  test('rejects old actions after invalidation', () => {
    const state = createState();
    const action = bindCuaAction(state.observe(), 'click:10,20');

    assert.equal(state.invalidate(), 1);
    assert.deepEqual(state.claimAction(action), {
      ok: false,
      reason: 'no_active_frame',
    });
    assert.deepEqual(state.observe(), { frameId: 'frame-2', epoch: 1 });
    assert.deepEqual(state.claimAction(action), {
      ok: false,
      reason: 'stale_epoch',
    });
  });

  test('advances the epoch only after confirming a claimed action', () => {
    const state = createState();
    const action = bindCuaAction(state.observe(), 'type:hello');

    assert.deepEqual(state.confirmAction(action), {
      ok: false,
      reason: 'action_not_claimed',
    });
    assert.deepEqual(state.claimAction(action), { ok: true });
    assert.deepEqual(state.confirmAction(action), { ok: true, epoch: 1 });
    assert.deepEqual(state.observe(), { frameId: 'frame-2', epoch: 1 });
  });
});
