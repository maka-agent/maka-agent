import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CuAction } from '@maka/core';
import {
  adaptToCuAction,
  buildComputerUseTools,
  type CuDispatchBackend,
  type CuRunResult,
} from '../computer-use-tools.js';
import type { MakaToolContext } from '../tool-runtime.js';

function ctx(signal?: AbortSignal): MakaToolContext {
  return {
    sessionId: 's1',
    turnId: 't1',
    cwd: '/tmp',
    toolCallId: 'call1',
    abortSignal: signal ?? new AbortController().signal,
    emitOutput: () => {},
  };
}

/** Fake backend: records the last action, returns a scripted result. */
function fakeBackend(over: Partial<{
  accessibility: boolean;
  screenRecording: boolean;
  result: CuRunResult;
}> = {}): CuDispatchBackend & { last?: CuAction } {
  const b: CuDispatchBackend & { last?: CuAction } = {
    async preflight() {
      return {
        accessibility: over.accessibility ?? true,
        screenRecording: over.screenRecording ?? true,
      };
    },
    async run(action) {
      b.last = action;
      return over.result ?? { outcome: { ok: true, tier: 'ax', verified: true } };
    },
  };
  return b;
}

async function callComputer(backend: CuDispatchBackend, args: Record<string, unknown>, signal?: AbortSignal) {
  const [tool] = buildComputerUseTools({ backend });
  return (await tool.impl(args as never, ctx(signal))) as { kind: string; text: string };
}

describe('adaptToCuAction — flat Anthropic grammar → discriminated CuAction', () => {
  test('screenshot / cursor_position take no coordinate', () => {
    assert.deepEqual(adaptToCuAction({ action: 'screenshot' } as never), { type: 'screenshot' });
    assert.deepEqual(adaptToCuAction({ action: 'cursor_position' } as never), { type: 'cursor_position' });
  });

  test('left_click maps coordinate tuple → {x,y} and carries modifier text', () => {
    const a = adaptToCuAction({ action: 'left_click', coordinate: [12, 34], text: 'super' } as never);
    assert.deepEqual(a, { type: 'left_click', coordinate: { x: 12, y: 34 }, text: 'super' });
  });

  test('scroll fills direction/amount defaults', () => {
    const a = adaptToCuAction({ action: 'scroll', coordinate: [1, 2] } as never) as Extract<CuAction, { type: 'scroll' }>;
    assert.equal(a.scrollDirection, 'down');
    assert.equal(a.scrollAmount, 3);
  });

  test('left_click_drag needs both start and end coordinates', () => {
    const a = adaptToCuAction({ action: 'left_click_drag', start_coordinate: [1, 2], coordinate: [3, 4] } as never);
    assert.deepEqual(a, { type: 'left_click_drag', startCoordinate: { x: 1, y: 2 }, coordinate: { x: 3, y: 4 }, text: undefined });
  });

  test('hold_key/wait convert seconds → ms', () => {
    assert.deepEqual(adaptToCuAction({ action: 'wait', duration: 1.5 } as never), { type: 'wait', durationMs: 1500 });
    assert.deepEqual(adaptToCuAction({ action: 'hold_key', text: 'shift', duration: 2 } as never), { type: 'hold_key', text: 'shift', durationMs: 2000 });
  });

  test('a click without a coordinate throws invalid_coordinate', () => {
    assert.throws(() => adaptToCuAction({ action: 'left_click' } as never), /invalid_coordinate/);
  });

  test('type without text throws', () => {
    assert.throws(() => adaptToCuAction({ action: 'type' } as never), /requires text/);
  });
});

describe('buildComputerUseTools — the `computer` MakaTool', () => {
  test('is named "computer" (the name Anthropic\'s model emits) in the computer_use category', () => {
    const [tool] = buildComputerUseTools({ backend: fakeBackend() });
    assert.equal(tool.name, 'computer');
    assert.equal(tool.categoryHint, 'computer_use');
    assert.ok(tool.parameters, 'carries a zod parameter schema');
  });

  test('S12: re-checks TCC and fails closed when Accessibility is not granted', async () => {
    const r = await callComputer(fakeBackend({ accessibility: false }), { action: 'left_click', coordinate: [1, 1] });
    assert.match(r.text, /permission_missing/);
    assert.match(r.text, /Accessibility/);
  });

  test('S12: a capture action fails closed when Screen Recording is not granted', async () => {
    const r = await callComputer(fakeBackend({ screenRecording: false }), { action: 'screenshot' });
    assert.match(r.text, /permission_missing/);
    assert.match(r.text, /Screen Recording/);
  });

  test('dispatches the adapted action to the backend and summarizes success + tier', async () => {
    const backend = fakeBackend();
    const r = await callComputer(backend, { action: 'left_click', coordinate: [5, 6], text: 'ctrl' });
    assert.deepEqual(backend.last, { type: 'left_click', coordinate: { x: 5, y: 6 }, text: 'ctrl' });
    assert.match(r.text, /computer\.left_click ok via ax/);
  });

  test('S17: surfaces a typed backend failure verbatim', async () => {
    const backend = fakeBackend({ result: { outcome: { ok: false, error: 'capture_failed', message: 'AXPress err -25202', completedSubSteps: 0 } } });
    const r = await callComputer(backend, { action: 'left_click', coordinate: [1, 1] });
    assert.match(r.text, /failed: capture_failed/);
    assert.match(r.text, /AXPress err -25202/);
  });

  test('an unverified dispatch tells the model to re-screenshot (no silent success)', async () => {
    const backend = fakeBackend({ result: { outcome: { ok: true, tier: 'ax', verified: false } } });
    const r = await callComputer(backend, { action: 'left_click', coordinate: [1, 1] });
    assert.match(r.text, /verified=false/);
    assert.match(r.text, /re-screenshot/);
  });

  test('S18: an already-aborted signal short-circuits before any dispatch', async () => {
    const ac = new AbortController();
    ac.abort();
    const backend = fakeBackend();
    const r = await callComputer(backend, { action: 'left_click', coordinate: [1, 1] }, ac.signal);
    assert.match(r.text, /aborted/);
    assert.equal(backend.last, undefined, 'backend.run must not be called after abort');
  });
});
