import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CuAction } from '@maka/core';
import {
  adaptToCuAction,
  buildComputerUseTools,
  snapshotComputerParams,
  type CuDispatchBackend,
  type CuRunContext,
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
}> = {}): CuDispatchBackend & {
  last?: CuAction;
  lastContext?: CuRunContext;
} {
  const b: CuDispatchBackend & {
    last?: CuAction;
    lastContext?: CuRunContext;
  } = {
    async preflight() {
      return {
        accessibility: over.accessibility ?? true,
        screenRecording: over.screenRecording ?? true,
      };
    },
    async run(action, _signal, context) {
      b.last = action;
      b.lastContext = context;
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

  test('provider function schema rejects unrelated fields and invalid coordinates', () => {
    const [tool] = buildComputerUseTools({ backend: fakeBackend() });
    const schema = tool.parameters as {
      safeParse(value: unknown): { success: boolean };
    };
    assert.equal(schema.safeParse({ action: 'screenshot', coordinate: [1, 2] }).success, false);
    assert.equal(schema.safeParse({ action: 'left_click', coordinate: [-1, 2] }).success, false);
    assert.equal(schema.safeParse({ action: 'left_click', coordinate: [1.5, 2] }).success, false);
    assert.equal(schema.safeParse({ action: 'left_click', coordinate: [1, 2] }).success, true);
  });
});

test('computer params are copied and frozen before asynchronous policy checks', () => {
  const coordinate = [10, 20] as [number, number];
  const input = { action: 'left_click', coordinate } as never;
  const snapshot = snapshotComputerParams(input);
  coordinate[0] = 999;
  (input as { action: string }).action = 'right_click';

  assert.deepEqual(snapshot, { action: 'left_click', coordinate: [10, 20] });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.coordinate), true);
});

test('computer params reject accessors before policy or execution', () => {
  const input = {};
  Object.defineProperty(input, 'action', {
    enumerable: true,
    get() {
      throw new Error('getter must not run');
    },
  });
  assert.throws(
    () => snapshotComputerParams(input as never),
    /must be a plain data property/,
  );
});

describe('buildComputerUseTools — the `computer` MakaTool', () => {
  test('is named "computer" (the name Anthropic\'s model emits) in the computer_use category', () => {
    const [tool] = buildComputerUseTools({ backend: fakeBackend() });
    assert.equal(tool.name, 'computer');
    assert.equal(tool.categoryHint, 'computer_use');
    assert.ok(tool.parameters, 'carries a zod parameter schema');
  });

  test('declares the host display contract for provider-native compilation', () => {
    const [tool] = buildComputerUseTools({
      backend: fakeBackend(),
      frameAdapter: {
        resolveModelDisplay: () => ({ widthPx: 1920, heightPx: 1200 }),
        toSourceAction: (action) => action,
        prepareScreenshot: (screenshot) => screenshot,
      },
    });
    assert.equal(tool.providerBinding?.kind, 'computer');
    assert.equal(tool.providerBinding?.environment, 'desktop');
    assert.deepEqual(tool.providerBinding?.resolveDisplay(), {
      widthPx: 1920,
      heightPx: 1200,
    });
  });

  test('fails closed when the captured frame disagrees with the declared display', async () => {
    const backend = fakeBackend({
      result: {
        outcome: { ok: true, tier: 'coordinate-background' },
        screenshot: {
          base64: 'AA==',
          mimeType: 'image/png',
          widthPx: 1280,
          heightPx: 800,
        },
      },
    });
    const [tool] = buildComputerUseTools({
      backend,
      frameAdapter: {
        resolveModelDisplay: () => ({ widthPx: 1920, heightPx: 1200 }),
        toSourceAction: (action) => action,
        prepareScreenshot: (screenshot) => {
          if (screenshot.widthPx !== 1920 || screenshot.heightPx !== 1200) {
            throw new Error(
              `declared display 1920x1200 does not match captured frame `
              + `${screenshot.widthPx}x${screenshot.heightPx}`,
            );
          }
          return screenshot;
        },
      },
    });
    const result = await tool.impl({ action: 'screenshot' } as never, ctx()) as { text: string };
    assert.match(result.text, /declared display 1920x1200/);
    assert.match(result.text, /captured frame 1280x800/);
    assert.equal('screenshot' in result, false);
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

  test('passes the full runtime context to the dispatch backend', async () => {
    const backend = fakeBackend();
    await callComputer(backend, { action: 'left_click', coordinate: [5, 6] });
    assert.deepEqual(backend.lastContext, {
      sessionId: 's1',
      turnId: 't1',
      toolCallId: 'call1',
    });
  });

  test('serializes preflight and dispatch in tool-call arrival order', async () => {
    const events: string[] = [];
    let releaseFirstPreflight!: () => void;
    const firstPreflight = new Promise<void>((resolve) => {
      releaseFirstPreflight = resolve;
    });
    let preflightCount = 0;
    const backend: CuDispatchBackend = {
      async preflight() {
        preflightCount += 1;
        const call = preflightCount;
        events.push(`preflight:${call}:start`);
        if (call === 1) await firstPreflight;
        events.push(`preflight:${call}:end`);
        return { accessibility: true, screenRecording: true };
      },
      async run(action) {
        events.push(`run:${action.type}`);
        return { outcome: { ok: true, tier: 'ax', verified: true } };
      },
    };
    const [tool] = buildComputerUseTools({ backend });
    const first = tool.impl(
      { action: 'left_click', coordinate: [5, 6] } as never,
      { ...ctx(), toolCallId: 'call-click' },
    );
    const second = tool.impl(
      { action: 'type', text: 'after-click' } as never,
      { ...ctx(), toolCallId: 'call-type' },
    );
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(events, ['preflight:1:start']);

    releaseFirstPreflight();
    await Promise.all([first, second]);
    assert.deepEqual(events, [
      'preflight:1:start',
      'preflight:1:end',
      'run:left_click',
      'preflight:2:start',
      'preflight:2:end',
      'run:type',
    ]);
  });

  test('S17: surfaces the typed backend failure code without leaking raw driver text', async () => {
    const backend = fakeBackend({ result: { outcome: { ok: false, error: 'capture_failed', message: 'AXPress err -25202', completedSubSteps: 0 } } });
    const r = await callComputer(backend, { action: 'left_click', coordinate: [1, 1] });
    assert.match(r.text, /failed: capture_failed/);
    assert.doesNotMatch(r.text, /AXPress err -25202/);
  });

  test('an unverified dispatch tells the model to re-screenshot (no silent success)', async () => {
    const backend = fakeBackend({ result: { outcome: { ok: true, tier: 'ax', verified: false } } });
    const r = await callComputer(backend, { action: 'left_click', coordinate: [1, 1] });
    assert.match(r.text, /verified=false/);
    assert.match(r.text, /re-screenshot/);
  });

  test('a confirmed effect tells the model not to repeat the action', async () => {
    const r = await callComputer(fakeBackend({
      result: {
        outcome: {
          ok: true,
          tier: 'semantic-background',
          verified: true,
          evidence: { path: 'cdp', effect: 'confirmed' },
        },
      },
    }), { action: 'left_click', coordinate: [5, 6] });
    assert.match(r.text, /effect confirmed/);
    assert.match(r.text, /do not repeat/);
    assert.doesNotMatch(r.text, /re-screenshot/);
  });

  test('surfaces controlled dispatch evidence without escalation reason or AX text', async () => {
    const backend = fakeBackend({
      result: {
        outcome: {
          ok: true,
          tier: 'coordinate-background',
          verified: false,
          evidence: {
            path: 'cgevent',
            effect: 'unverifiable',
            escalation: {
              recommended: 'foreground',
              reason: 'window Secret Draft, api_key=super-secret-value',
            },
          },
        },
      },
    });
    const r = await callComputer(backend, { action: 'left_click', coordinate: [1, 1] });
    assert.match(r.text, /path=cgevent/);
    assert.match(r.text, /effect=unverifiable/);
    assert.match(r.text, /escalation=foreground\(disallowed\)/);
    assert.doesNotMatch(r.text, /Secret Draft/);
    assert.doesNotMatch(r.text, /super-secret-value/);
  });

  test('redacts synthetic tool errors again at the model-output boundary', () => {
    const [tool] = buildComputerUseTools({ backend: fakeBackend() });
    const output = tool.toModelOutput?.({
      output: { error: 'api_key=super-secret-value' },
    } as never) as { value: Array<{ type: string; text?: string }> };
    assert.equal(output.value[0]?.type, 'text');
    assert.match(output.value[0]?.text ?? '', /\[redacted\]/);
    assert.doesNotMatch(output.value[0]?.text ?? '', /super-secret-value/);
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
