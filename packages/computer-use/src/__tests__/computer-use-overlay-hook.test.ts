// Contract for the CU→overlay hook: the declared-px → logical-screen transform
// (S15, MAIN-side) and action→kind mapping, and that non-coordinate actions keep
// the cursor present without moving it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { CuAction } from '@maka/core';
import { createComputerUseOverlayHook, declaredPxToScreenPoint, type OverlayScreenLike } from '../computer-use-overlay-hook.js';

type MoveArgs = { actionId: string; sessionId: string; screenX: number; screenY: number; kind: string; pressed?: boolean };

function fakeController() {
  const moves: MoveArgs[] = [];
  const ensured: string[] = [];
  const controller = {
    ensure: (id: string) => { ensured.push(id); },
    move: (m: MoveArgs) => { moves.push(m); },
    clearForSession: () => {},
    abort: () => {},
    destroyAll: () => {},
    isActive: () => false,
    getSessionId: () => null,
  };
  return { controller, moves, ensured };
}

const screenAt = (scaleFactor: number, origin = { x: 0, y: 0 }): OverlayScreenLike => ({
  getPrimaryDisplay: () => ({ bounds: { x: origin.x, y: origin.y, width: 1440, height: 900 }, scaleFactor }),
});

test('declaredPxToScreenPoint: 1× identity; 2× halves; offsets by display origin', () => {
  assert.deepEqual(declaredPxToScreenPoint({ x: 300, y: 200 }, { bounds: { x: 0, y: 0, width: 1, height: 1 }, scaleFactor: 1 }), { x: 300, y: 200 });
  assert.deepEqual(declaredPxToScreenPoint({ x: 300, y: 200 }, { bounds: { x: 0, y: 0, width: 1, height: 1 }, scaleFactor: 2 }), { x: 150, y: 100 });
  assert.deepEqual(declaredPxToScreenPoint({ x: 100, y: 100 }, { bounds: { x: 1440, y: 0, width: 1, height: 1 }, scaleFactor: 2 }), { x: 1490, y: 50 });
});

test('click action → controller.move with transformed coords + kind:click', () => {
  const { controller, moves } = fakeController();
  const hook = createComputerUseOverlayHook(controller as never, screenAt(2));
  const action: CuAction = { type: 'left_click', coordinate: { x: 400, y: 300 } };
  hook.onActionBegin(action, { sessionId: 's1', toolCallId: 't1' });
  assert.equal(moves.length, 1);
  assert.deepEqual(moves[0], { actionId: 't1', sessionId: 's1', screenX: 200, screenY: 150, kind: 'click' });
});

test('scroll → kind:scroll, drag → kind:drag, mouse_move → kind:move', () => {
  const { controller, moves } = fakeController();
  const hook = createComputerUseOverlayHook(controller as never, screenAt(1));
  hook.onActionBegin({ type: 'scroll', coordinate: { x: 10, y: 20 }, scrollDirection: 'down', scrollAmount: 3 } as CuAction, { sessionId: 's', toolCallId: 'a' });
  hook.onActionBegin({ type: 'left_click_drag', startCoordinate: { x: 1, y: 1 }, coordinate: { x: 30, y: 40 } } as CuAction, { sessionId: 's', toolCallId: 'b' });
  hook.onActionBegin({ type: 'mouse_move', coordinate: { x: 50, y: 60 } } as CuAction, { sessionId: 's', toolCallId: 'c' });
  assert.deepEqual(moves.map((m) => m.kind), ['scroll', 'drag', 'move']);
  assert.deepEqual([moves[0].screenX, moves[0].screenY], [10, 20]);
});

test('non-coordinate actions keep the cursor present (ensure) but do not move it', () => {
  const { controller, moves, ensured } = fakeController();
  const hook = createComputerUseOverlayHook(controller as never, screenAt(1));
  for (const action of [
    { type: 'type', text: 'hi' },
    { type: 'key', text: 'Return' },
    { type: 'screenshot' },
    { type: 'wait', durationMs: 100 },
  ] as CuAction[]) {
    hook.onActionBegin(action, { sessionId: 's', toolCallId: 'x' });
  }
  assert.equal(moves.length, 0, 'no moves for non-coordinate actions');
  assert.deepEqual(ensured, ['s', 's', 's', 's'], 'each ensures the session cursor');
});
