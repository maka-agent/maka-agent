import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CuAction } from '@maka/core';
import {
  adaptToCuAction,
  buildComputerUseTools,
  snapshotComputerParams,
  type CuDispatchBackend,
  type CuObservation,
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

function observation(over: Partial<CuObservation> = {}): CuObservation {
  return {
    observationId: 'backend-obs-1',
    appId: 'Fixture',
    pid: 42,
    windowId: 7,
    elements: [{
      elementId: '5',
      role: 'AXButton',
      label: 'Continue',
      identity: { token: 'button-token', role: 'AXButton', label: 'Continue' },
    }],
    screenshot: {
      base64: 'AA==',
      mimeType: 'image/png',
      widthPx: 100,
      heightPx: 80,
    },
    ...over,
  };
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
    assert.equal(schema.safeParse({ action: 'screenshot', coordinate: [1, 2] }).success, true);
    assert.equal(schema.safeParse({ action: 'left_click', coordinate: [-1, 2] }).success, false);
    assert.equal(schema.safeParse({ action: 'left_click', coordinate: [1.5, 2] }).success, false);
    assert.equal(schema.safeParse({ action: 'left_click', coordinate: [1, 2] }).success, true);
  });

  test('runtime strict parsing rejects fields that are irrelevant to the selected action', async () => {
    const [tool] = buildComputerUseTools({ backend: fakeBackend() });
    await assert.rejects(
      () => Promise.resolve(
        tool.impl({ action: 'screenshot', coordinate: [1, 2] } as never, ctx()),
      ),
    );
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

describe('buildComputerUseTools — the `maka_computer` MakaTool', () => {
  test('uses the Maka-owned function name in the computer_use category', () => {
    const [tool] = buildComputerUseTools({ backend: fakeBackend() });
    assert.equal(tool.name, 'maka_computer');
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
    assert.equal(tool.providerBinding?.wireMode, 'function');
    assert.deepEqual(tool.providerBinding?.resolveDisplay(), {
      widthPx: 1920,
      heightPx: 1200,
    });
  });

  test('list_apps and observe expose one provider-neutral Sky-like surface', async () => {
    const backend = fakeBackend() as CuDispatchBackend & {
      listApps: NonNullable<CuDispatchBackend['listApps']>;
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
    };
    backend.listApps = async () => [{
      appId: 'Fixture',
      pid: 42,
      name: 'Fixture',
      windowCount: 1,
      windows: [{ windowId: 7, title: 'Fixture Window' }],
    }];
    backend.observeApp = async () => ({
      observationId: 'obs-1',
      appId: 'Fixture',
      pid: 42,
      windowId: 7,
      windowTitle: 'Fixture Window',
      elements: [{
        elementId: '5',
        role: 'AXButton',
        label: 'Continue',
      }],
      screenshot: {
        base64: 'AA==',
        mimeType: 'image/png',
        widthPx: 100,
        heightPx: 80,
      },
    });
    const [tool] = buildComputerUseTools({ backend });

    const apps = await tool.impl({ action: 'list_apps' } as never, ctx()) as { text: string };
    assert.deepEqual(JSON.parse(apps.text), {
      apps: [{
        app_id: 'Fixture',
        pid: 42,
        name: 'Fixture',
        window_count: 1,
        windows: [{ window_id: 7, title: 'Fixture Window' }],
      }],
    });
    const observation = await tool.impl({
      action: 'observe',
      app: 'Fixture',
      window_id: 7,
    } as never, ctx()) as { text: string; screenshot?: unknown };
    assert.deepEqual({
      ...JSON.parse(observation.text),
      observation_id: '<runtime-generated>',
    }, {
      observation_id: '<runtime-generated>',
      app: 'Fixture',
      pid: 42,
      window_id: 7,
      window_title: 'Fixture Window',
      elements: [{ element_id: '5', role: 'AXButton', label: 'Continue' }],
    });
    assert.ok(observation.screenshot);
  });

  test('semantic action uses the runtime observation id, forwards identity hints, and returns fresh state', async () => {
    const seen: Array<{ action: unknown; context: CuRunContext }> = [];
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      runSemantic: NonNullable<CuDispatchBackend['runSemantic']>;
    };
    backend.observeApp = async () => observation();
    backend.runSemantic = async (action, _signal, context) => {
      seen.push({ action, context });
      return {
        outcome: { ok: true, tier: 'ax', verified: true },
        observation: observation({
          observationId: 'backend-obs-2',
          elements: [{ elementId: '8', role: 'AXStaticText', label: 'Done' }],
        }),
      };
    };
    const [tool] = buildComputerUseTools({ backend });
    const observed = await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx()) as {
      text: string;
    };
    const observationId = JSON.parse(observed.text).observation_id as string;

    const result = await tool.impl({
      action: 'click_element',
      observation_id: observationId,
      element_id: '5',
    } as never, ctx()) as { text: string };

    assert.equal((seen[0]?.action as { observationId: string }).observationId, 'backend-obs-1');
    assert.deepEqual((seen[0]?.action as { elementIdentity?: unknown }).elementIdentity, {
      token: 'button-token',
      role: 'AXButton',
      label: 'Continue',
    });
    assert.equal(seen[0]?.context.boundAction?.target?.windowId, 7);
    assert.match(result.text, /Fresh observation/);
    assert.doesNotMatch(result.text, new RegExp(observationId));
  });

  test('coordinate action is bound to a window-local screenshot and consumes the observation', async () => {
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      captureObservation: NonNullable<CuDispatchBackend['captureObservation']>;
      lastContext?: CuRunContext;
    };
    backend.observeApp = async () => observation();
    backend.captureObservation = async () => observation({
      observationId: 'backend-obs-2',
    });
    const [tool] = buildComputerUseTools({ backend });
    const observed = await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx()) as {
      text: string;
    };
    const observationId = JSON.parse(observed.text).observation_id as string;

    const result = await tool.impl({
      action: 'left_click',
      observation_id: observationId,
      coordinate: [25, 30],
    } as never, ctx()) as { text: string };

    assert.equal(backend.lastContext?.boundAction?.coordinateSpace, 'window-screenshot-local');
    assert.deepEqual(backend.lastContext?.boundAction?.windowCoordinate, { x: 25, y: 30 });
    assert.match(result.text, /Fresh observation/);

    const replay = await tool.impl({
      action: 'left_click',
      observation_id: observationId,
      coordinate: [25, 30],
    } as never, ctx()) as { text: string };
    assert.match(replay.text, /duplicate_action|stale_frame/);
  });

  test('successful bound action fails closed without a fresh full observation', async () => {
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
    };
    backend.observeApp = async () => observation();
    const [tool] = buildComputerUseTools({ backend });
    const observed = await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx()) as {
      text: string;
    };
    const observationId = JSON.parse(observed.text).observation_id as string;

    const result = await tool.impl({
      action: 'left_click',
      observation_id: observationId,
      coordinate: [25, 30],
    } as never, ctx()) as { text: string };

    assert.match(result.text, /capture_failed/);
  });

  test('zoom consumes the source observation and cannot reuse crop coordinates as the old frame', async () => {
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
    };
    backend.observeApp = async () => observation();
    const [tool] = buildComputerUseTools({ backend });
    const observed = await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx()) as {
      text: string;
    };
    const observationId = JSON.parse(observed.text).observation_id as string;

    const zoom = await tool.impl({
      action: 'zoom',
      observation_id: observationId,
      region: [0, 0, 50, 40],
    } as never, ctx()) as { text: string };
    assert.match(zoom.text, /capture_failed/);

    const click = await tool.impl({
      action: 'left_click',
      observation_id: observationId,
      coordinate: [10, 10],
    } as never, ctx()) as { text: string };
    assert.match(click.text, /stale_frame|no_active_frame/);
  });

  test('runtime does not infer user intervention from observation content changes', async () => {
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      runSemantic: NonNullable<CuDispatchBackend['runSemantic']>;
    };
    backend.observeApp = async () => observation({ contentFingerprint: 'tree-a' });
    backend.runSemantic = async () => ({
      outcome: { ok: true, tier: 'ax', verified: false },
      observation: observation({
        observationId: 'backend-obs-2',
        contentFingerprint: 'tree-completely-different',
      }),
    });
    const [tool] = buildComputerUseTools({ backend });
    const observed = await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx()) as {
      text: string;
    };
    const observationId = JSON.parse(observed.text).observation_id as string;

    const result = await tool.impl({
      action: 'click_element',
      observation_id: observationId,
      element_id: '5',
    } as never, ctx()) as { text: string };

    assert.doesNotMatch(result.text, /user_intervened/);
    assert.match(result.text, /verified=false/);
  });

  test('press_key binds the observation window without requiring an element id', async () => {
    const seen: Array<{ action: unknown; context: CuRunContext }> = [];
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      runSemantic: NonNullable<CuDispatchBackend['runSemantic']>;
    };
    backend.observeApp = async () => observation();
    backend.runSemantic = async (action, _signal, context) => {
      seen.push({ action, context });
      return {
        outcome: { ok: true, tier: 'ax', verified: true },
        observation: observation({ observationId: 'backend-obs-2' }),
      };
    };
    const [tool] = buildComputerUseTools({ backend });
    const observed = await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx()) as {
      text: string;
    };
    const observationId = JSON.parse(observed.text).observation_id as string;

    const result = await tool.impl({
      action: 'press_key',
      observation_id: observationId,
      text: 'ENTER',
    } as never, ctx()) as { text: string };

    assert.deepEqual(seen[0]?.action, {
      type: 'press_key',
      observationId: 'backend-obs-1',
      key: 'ENTER',
    });
    assert.equal(seen[0]?.context.boundAction?.elementId, undefined);
    assert.equal(seen[0]?.context.boundAction?.target?.windowId, 7);
    assert.match(result.text, /Fresh observation/);
  });

  test('select_text forwards the identity hint for unique semantic refetch', async () => {
    const seen: unknown[] = [];
    const backend = fakeBackend() as CuDispatchBackend & {
      observeApp: NonNullable<CuDispatchBackend['observeApp']>;
      runSemantic: NonNullable<CuDispatchBackend['runSemantic']>;
    };
    backend.observeApp = async () => observation();
    backend.runSemantic = async (action) => {
      seen.push(action);
      return {
        outcome: { ok: true, tier: 'ax', verified: true },
        observation: observation({ observationId: 'backend-obs-2' }),
      };
    };
    const [tool] = buildComputerUseTools({ backend });
    const observed = await tool.impl({ action: 'observe', app: 'Fixture' } as never, ctx()) as {
      text: string;
    };
    const observationId = JSON.parse(observed.text).observation_id as string;

    await tool.impl({
      action: 'select_text',
      observation_id: observationId,
      element_id: '5',
      text: 'hello',
    } as never, ctx());

    assert.deepEqual((seen[0] as { elementIdentity?: unknown }).elementIdentity, {
      token: 'button-token',
      role: 'AXButton',
      label: 'Continue',
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
    const r = await callComputer(fakeBackend({ accessibility: false }), { action: 'wait' });
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
    const r = await callComputer(backend, { action: 'wait', duration: 0.01 });
    assert.deepEqual(backend.last, { type: 'wait', durationMs: 10 });
    assert.match(r.text, /computer\.wait ok via ax/);
  });

  test('passes the full runtime context to the dispatch backend', async () => {
    const backend = fakeBackend();
    await callComputer(backend, { action: 'wait' });
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
      { action: 'wait' } as never,
      { ...ctx(), toolCallId: 'call-wait-1' },
    );
    const second = tool.impl(
      { action: 'wait' } as never,
      { ...ctx(), toolCallId: 'call-wait-2' },
    );
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(events, ['preflight:1:start']);

    releaseFirstPreflight();
    await Promise.all([first, second]);
    assert.deepEqual(events, [
      'preflight:1:start',
      'preflight:1:end',
      'run:wait',
      'preflight:2:start',
      'preflight:2:end',
      'run:wait',
    ]);
  });

  test('S17: surfaces the typed backend failure code without leaking raw driver text', async () => {
    const backend = fakeBackend({ result: { outcome: { ok: false, error: 'capture_failed', message: 'AXPress err -25202', completedSubSteps: 0 } } });
    const r = await callComputer(backend, { action: 'wait' });
    assert.match(r.text, /failed: capture_failed/);
    assert.doesNotMatch(r.text, /AXPress err -25202/);
  });

  test('an unverified dispatch tells the model to re-screenshot (no silent success)', async () => {
    const backend = fakeBackend({ result: { outcome: { ok: true, tier: 'ax', verified: false } } });
    const r = await callComputer(backend, { action: 'wait' });
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
    }), { action: 'wait' });
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
    const r = await callComputer(backend, { action: 'wait' });
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
