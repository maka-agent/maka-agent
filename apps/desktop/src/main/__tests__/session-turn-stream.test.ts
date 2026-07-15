import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  GoalContinuationCoordinator,
  GoalManager,
  SessionActivityRegistry,
} from '@maka/runtime';
import type { SessionEvent } from '@maka/core';
import {
  startDesktopSessionTurn,
  type DesktopSessionTurnStart,
  type SessionGoalBoundary,
} from '../session-turn-stream.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('Desktop session turn Goal boundary', () => {
  test('external settles once only after the complete stream drains and releases activity', async () => {
    const registry = new SessionActivityRegistry();
    const release = deferred<void>();
    const observed: string[] = [];
    async function* events(): AsyncIterable<SessionEvent> {
      yield {
        type: 'text_delta', id: 'delta', turnId: 'turn-1', ts: 1,
        messageId: 'message-1', text: 'working',
      };
      await release.promise;
      yield { type: 'complete', id: 'complete', turnId: 'turn-1', ts: 2, stopReason: 'end_turn' };
    }

    const started = startDesktopSessionTurn({
      sessionId: 'session-1',
      events: events(),
      turnId: 'turn-1',
      goalBoundary: 'external',
      activities: registry,
      beginExternalTurn: () => ({
        kind: 'registered',
        settle: async (outcome) => {
          assert.equal(registry.whenIdle('session-1'), undefined);
          observed.push(`settled:${outcome.kind}`);
          return { kind: 'no_goal' };
        },
      }),
      onEvent: (event) => { observed.push(event.type); },
      onStreamError: () => { assert.fail('stream must not fail'); },
      onDrained: () => { observed.push('drained'); },
    });
    const resultPromise = startedCompletion(started);

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(observed, ['text_delta']);
    release.resolve();
    const result = await resultPromise;

    assert.deepEqual(result.outcome, { kind: 'completed', turnId: 'turn-1' });
    assert.deepEqual(observed, ['text_delta', 'complete', 'drained', 'settled:completed']);
  });

  test('archive revokes an external stream before it can settle a replacement Goal', async () => {
    const manager = new GoalManager({ generateId: () => 'goal', now: () => 1 });
    let evaluations = 0;
    const coordinator = new GoalContinuationCoordinator({
      goalManager: manager,
      evaluator: {
        evaluate: async () => {
          evaluations++;
          return '{"met":true,"reason":"old stream must not evaluate"}';
        },
      },
      getRecentContext: async () => 'old evidence',
      admitTurn: () => assert.fail('replacement Goal must not continue'),
    });
    manager.create('session-1', 'old Goal');
    const registry = new SessionActivityRegistry();
    const streamStarted = deferred<void>();
    const release = deferred<void>();
    async function* events(): AsyncIterable<SessionEvent> {
      streamStarted.resolve();
      yield {
        type: 'text_delta', id: 'delta', turnId: 'turn-old', ts: 1,
        messageId: 'message-old', text: 'working',
      };
      await release.promise;
      yield { type: 'complete', id: 'complete', turnId: 'turn-old', ts: 2, stopReason: 'end_turn' };
    }

    const started = startDesktopSessionTurn({
      sessionId: 'session-1',
      events: events(),
      turnId: 'turn-old',
      goalBoundary: 'external',
      activities: registry,
      beginExternalTurn: (sessionId, turnId) => coordinator.beginExternalTurn(sessionId, turnId),
      onEvent: () => {},
      onStreamError: (error) => { assert.fail(String(error)); },
      onDrained: () => {},
    });
    const drain = startedCompletion(started);
    await streamStarted.promise;

    const archive = coordinator.beginSessionClose('session-1', 'archive');
    assert.equal(manager.removeGoal('session-1'), true);
    archive.commit();
    coordinator.unarchiveSession('session-1');
    assert.equal(manager.create('session-1', 'replacement').kind, 'created');
    release.resolve();
    await drain;

    assert.equal(manager.get('session-1')?.condition, 'replacement');
    assert.equal(manager.get('session-1')?.status, 'active');
    assert.equal(manager.hasSettledTurn('session-1', 'turn-old'), true);
    assert.equal(evaluations, 0);
    assert.equal(registry.whenIdle('session-1'), undefined);
    coordinator.dispose();
    manager.dispose();
  });

  test('coordinator-owned and non-turn streams never notify the external boundary', async (t) => {
    for (const goalBoundary of ['coordinator', 'none'] satisfies SessionGoalBoundary[]) {
      await t.test(goalBoundary, async () => {
        const registry = new SessionActivityRegistry();
        let settlements = 0;
        async function* events(): AsyncIterable<SessionEvent> {
          yield { type: 'complete', id: 'complete', turnId: 'turn-1', ts: 1, stopReason: 'end_turn' };
        }

        const started = startDesktopSessionTurn({
          sessionId: 'session-1',
          events: events(),
          turnId: 'turn-1',
          goalBoundary,
          activities: registry,
          beginExternalTurn: () => {
            settlements++;
            return { kind: 'duplicate' };
          },
          onEvent: () => {},
          onStreamError: () => { assert.fail('stream must not fail'); },
          onDrained: () => {},
        });
        const result = await startedCompletion(started);

        assert.equal(result.outcome.kind, 'completed');
        assert.equal(settlements, 0);
        assert.equal(registry.whenIdle('session-1'), undefined);
      });
    }
  });

  test('external permission handoff pauses at the boundary instead of looking complete', async () => {
    const registry = new SessionActivityRegistry();
    let settled: unknown;
    async function* events(): AsyncIterable<SessionEvent> {
      yield {
        type: 'permission_request', kind: 'tool_permission',
        id: 'permission', turnId: 'turn-1', ts: 1,
        requestId: 'request-1', toolUseId: 'tool-1', toolName: 'Bash',
        category: 'shell_unsafe', reason: 'shell_dangerous', args: {},
        rememberForTurnAllowed: true,
      };
      yield {
        type: 'complete', id: 'handoff', turnId: 'turn-1', ts: 2,
        stopReason: 'permission_handoff',
      };
    }

    const started = startDesktopSessionTurn({
      sessionId: 'session-1',
      events: events(),
      turnId: 'turn-1',
      goalBoundary: 'external',
      activities: registry,
      beginExternalTurn: () => ({
        kind: 'registered',
        settle: async (outcome) => {
          settled = outcome;
          return { kind: 'no_goal' };
        },
      }),
      onEvent: () => {},
      onStreamError: () => { assert.fail('stream must not fail'); },
      onDrained: () => {},
    });
    const result = await startedCompletion(started);

    const expected = {
      kind: 'suspended',
      turnId: 'turn-1',
      reason: 'Turn is waiting for user permission.',
    };
    assert.deepEqual(result.outcome, expected);
    assert.deepEqual(settled, expected);
  });

  test('duplicate registration is rejected before activity reservation or iterator start', () => {
    const registry = new SessionActivityRegistry();
    let iteratorStarted = false;
    async function* events(): AsyncIterable<SessionEvent> {
      iteratorStarted = true;
      yield { type: 'complete', id: 'complete', turnId: 'turn-1', ts: 1, stopReason: 'end_turn' };
    }

    const started = startDesktopSessionTurn({
      sessionId: 'session-1',
      events: events(),
      turnId: 'turn-1',
      goalBoundary: 'external',
      activities: registry,
      beginExternalTurn: () => ({ kind: 'duplicate' }),
      onEvent: () => {},
      onStreamError: () => {},
      onDrained: () => {},
    });

    assert.equal(started.kind, 'unavailable');
    assert.equal(iteratorStarted, false);
    assert.equal(registry.whenIdle('session-1'), undefined);
  });

  test('a closed session is rejected before activity reservation or iterator start', () => {
    const manager = new GoalManager({ generateId: () => 'goal', now: () => 1 });
    const coordinator = new GoalContinuationCoordinator({
      goalManager: manager,
      evaluator: { evaluate: async () => assert.fail('closed session must not evaluate') },
      getRecentContext: async () => 'unused',
      admitTurn: () => assert.fail('closed session must not admit a turn'),
    });
    coordinator.beginSessionClose('session-1', 'archive').commit();
    const registry = new SessionActivityRegistry();
    let iteratorStarted = false;
    async function* events(): AsyncIterable<SessionEvent> {
      iteratorStarted = true;
      yield { type: 'complete', id: 'complete', turnId: 'turn-closed', ts: 1, stopReason: 'end_turn' };
    }

    const started = startDesktopSessionTurn({
      sessionId: 'session-1',
      events: events(),
      turnId: 'turn-closed',
      goalBoundary: 'external',
      activities: registry,
      beginExternalTurn: (sessionId, turnId) => coordinator.beginExternalTurn(sessionId, turnId),
      onEvent: () => {},
      onStreamError: () => {},
      onDrained: () => {},
    });

    assert.deepEqual(started, {
      kind: 'unavailable',
      reason: 'Goal continuation session is closed.',
    });
    assert.equal(iteratorStarted, false);
    assert.equal(registry.whenIdle('session-1'), undefined);
    assert.equal(manager.removeSession('session-1'), false);
  });
});

function startedCompletion(start: DesktopSessionTurnStart) {
  assert.equal(start.kind, 'started');
  return start.completion;
}
