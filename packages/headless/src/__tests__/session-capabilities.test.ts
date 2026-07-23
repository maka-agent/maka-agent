import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionManager, SpawnChildSessionResult, StopSessionInput } from '@maka/runtime';
import { createHeadlessSessionCapabilityBridge } from '../session-capabilities.js';

const childResult: SpawnChildSessionResult = {
  childSessionId: 'child-session',
  agentId: 'local-read',
  agentName: 'Local Read',
  profile: 'local_read',
  turnId: 'child-turn',
  runId: 'child-run',
  status: 'cancelled',
  permissionMode: 'explore',
  summary: '',
  artifactIds: [],
  startedAt: 1,
  completedAt: 2,
  durationMs: 1,
  eventCount: 1,
};

for (const scenario of [
  { name: 'normal cleanup', input: undefined },
  {
    name: 'deadline cleanup',
    input: { source: 'benchmark_deadline' } satisfies StopSessionInput,
  },
]) {
  test(`${scenario.name} retries a transient stop before draining child work`, async () => {
    let releaseChild!: () => void;
    const child = new Promise<SpawnChildSessionResult>((resolve) => {
      releaseChild = () => resolve(childResult);
    });
    let stopCalls = 0;
    const transientStopError = new Error('transient child stop failure');
    const manager = {
      spawnChildSession: () => child,
      stopSession: async () => {
        stopCalls += 1;
        if (stopCalls === 1) throw transientStopError;
        releaseChild();
      },
    } as unknown as SessionManager;
    const bridge = createHeadlessSessionCapabilityBridge();
    bridge.bind(manager);
    const spawn = bridge.capabilities.spawnChildSession('parent-session', {
      spawnedBy: {
        parentRunId: 'parent-run',
        parentTurnId: 'parent-turn',
        toolCallId: 'tool-call',
      },
      agentProfile: 'local_read',
      prompt: 'wait for cleanup',
    });
    const settle = bridge.settle('parent-session', scenario.input).then(
      () => undefined,
      (error: unknown) => error,
    );

    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const completedBeforeWatchdog = await Promise.race([
      settle.then(() => true),
      new Promise<false>((resolve) => {
        watchdog = setTimeout(() => resolve(false), 750);
      }),
    ]);
    if (watchdog) clearTimeout(watchdog);
    if (!completedBeforeWatchdog) releaseChild();
    const settleError = await settle;
    await spawn;

    assert.equal(completedBeforeWatchdog, true);
    assert.equal(stopCalls, 2);
    assert.equal(settleError, undefined);
  });
}

test('settle preserves the first unrecoverable stop error after one bounded retry', async () => {
  let releaseChild!: () => void;
  const child = new Promise<SpawnChildSessionResult>((resolve) => {
    releaseChild = () => resolve(childResult);
  });
  const firstStopError = new Error('first stop failure');
  const secondStopError = new Error('second stop failure');
  let stopCalls = 0;
  const manager = {
    spawnChildSession: () => child,
    stopSession: async () => {
      stopCalls += 1;
      throw stopCalls === 1 ? firstStopError : secondStopError;
    },
  } as unknown as SessionManager;
  const bridge = createHeadlessSessionCapabilityBridge();
  bridge.bind(manager);
  const spawn = bridge.capabilities.spawnChildSession('parent-session', {
    spawnedBy: {
      parentRunId: 'parent-run',
      parentTurnId: 'parent-turn',
      toolCallId: 'tool-call',
    },
    agentProfile: 'local_read',
    prompt: 'wait for cleanup',
  });
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const settleResult = await Promise.race([
    bridge.settle('parent-session').then(
      () => undefined,
      (error: unknown) => error,
    ),
    new Promise<Error>((resolve) => {
      watchdog = setTimeout(() => resolve(new Error('settle watchdog expired')), 750);
    }),
  ]);
  if (watchdog) clearTimeout(watchdog);
  releaseChild();
  await spawn;

  assert.equal(settleResult, firstStopError);
  assert.equal(stopCalls, 2);
});
