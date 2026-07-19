import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CuAction } from '@maka/core';
import {
  bindCuaAction,
  bindCuaActionToObservation,
  bindCuaSemanticActionToObservation,
  CuaFrameState,
} from '../cua-frame-state.js';

function createState(): CuaFrameState {
  let nextFrameId = 1;
  return new CuaFrameState(() => `frame-${nextFrameId++}`);
}

function observation() {
  return {
    capturedAt: 1,
    displays: [],
    target: { pid: 42, windowId: 7 },
  };
}

describe('CuaFrameState', () => {
  test('creates a new frame identity for every observation', () => {
    const state = createState();

    assert.deepEqual(
      { frameId: state.observe(observation()).frameId, epoch: state.activeObservation()?.epoch },
      { frameId: 'frame-1', epoch: 0 },
    );
    assert.deepEqual(
      { frameId: state.observe(observation()).frameId, epoch: state.activeObservation()?.epoch },
      { frameId: 'frame-2', epoch: 0 },
    );
  });

  test('binds an action fingerprint to its observed frame', () => {
    const state = createState();
    const firstFrame = state.observe(observation());
    const first = bindCuaAction(firstFrame, 'click:10,20', firstFrame.target);
    const secondFrame = state.observe(observation());
    const second = bindCuaAction(secondFrame, 'click:10,20', secondFrame.target);

    assert.notEqual(first.fingerprint, second.fingerprint);
    assert.equal(first.frameId, 'frame-1');
    assert.equal(second.frameId, 'frame-2');
  });

  test('rejects an action from a superseded frame', () => {
    const state = createState();
    const oldFrame = state.observe(observation());
    const oldAction = bindCuaAction(oldFrame, 'click:10,20', oldFrame.target);
    state.observe(observation());

    assert.deepEqual(state.claimAction(oldAction), {
      ok: false,
      reason: 'stale_frame',
    });
  });

  test('rejects the same action twice on one frame', () => {
    const state = createState();
    const frame = state.observe(observation());
    const action = bindCuaAction(frame, 'click:10,20', frame.target);

    assert.deepEqual(state.claimAction(action), { ok: true });
    assert.deepEqual(state.claimAction(action), {
      ok: false,
      reason: 'duplicate_action',
    });
  });

  test('rejects old actions after invalidation', () => {
    const state = createState();
    const frame = state.observe(observation());
    const action = bindCuaAction(frame, 'click:10,20', frame.target);

    assert.equal(state.invalidate(), 1);
    assert.deepEqual(state.claimAction(action), {
      ok: false,
      reason: 'no_active_frame',
    });
    assert.deepEqual((({ frameId, epoch }) => ({ frameId, epoch }))(state.observe(observation())), {
      frameId: 'frame-2',
      epoch: 1,
    });
    assert.deepEqual(state.claimAction(action), {
      ok: false,
      reason: 'stale_epoch',
    });
  });

  test('advances the epoch only after confirming a claimed action', () => {
    const state = createState();
    const frame = state.observe(observation());
    const action = bindCuaAction(frame, 'type:hello', frame.target);

    assert.deepEqual(state.confirmAction(action), {
      ok: false,
      reason: 'action_not_claimed',
    });
    assert.deepEqual(state.claimAction(action), { ok: true });
    assert.deepEqual(state.confirmAction(action), { ok: true, epoch: 1 });
    assert.deepEqual((({ frameId, epoch }) => ({ frameId, epoch }))(state.observe(observation())), {
      frameId: 'frame-2',
      epoch: 1,
    });
  });

  test('binds coordinates to the immediately preceding window screenshot space', () => {
    const state = createState();
    const observation = state.observe({
      capturedAt: 1,
      screenshotWidthPx: 800,
      screenshotHeightPx: 600,
      displays: [],
      target: {
        pid: 42,
        windowId: 7,
        bounds: { x: 100, y: 200, width: 800, height: 600 },
        sourceBoundsPx: { x: 0, y: 0, width: 800, height: 600 },
      },
    });
    const action: CuAction = {
      type: 'left_click',
      coordinate: { x: 25, y: 30 },
    };

    const bound = bindCuaActionToObservation(observation, action);

    assert.equal(bound?.target?.windowId, 7);
    assert.deepEqual(bound?.windowCoordinate, { x: 25, y: 30 });
    assert.equal(bound?.coordinateSpace, 'window-screenshot-local');
  });

  test('rejects a coordinate outside the bound window screenshot', () => {
    const state = createState();
    const observation = state.observe({
      capturedAt: 1,
      screenshotWidthPx: 800,
      screenshotHeightPx: 600,
      displays: [],
      target: { pid: 42, windowId: 7 },
    });

    assert.equal(
      bindCuaActionToObservation(observation, {
        type: 'left_click',
        coordinate: { x: 801, y: 30 },
      }),
      undefined,
    );
  });

  test('semantic actions bind element identity to the observed window', () => {
    const state = createState();
    const observation = state.observe({
      capturedAt: 1,
      displays: [],
      target: { pid: 42, windowId: 7 },
    });

    const bound = bindCuaSemanticActionToObservation(observation, {
      type: 'click_element',
      elementId: 'old-index-5',
    });

    assert.equal(bound?.target?.windowId, 7);
    assert.equal(bound?.elementId, 'old-index-5');
  });
});
