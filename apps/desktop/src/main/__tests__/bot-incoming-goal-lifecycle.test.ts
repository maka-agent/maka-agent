import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { BotIncomingMessage, BotRegistry, SessionManager } from '@maka/runtime';
import {
  GoalContinuationCoordinator,
  GoalManager,
  SessionActivityRegistry,
  buildGoalTools,
  type MakaToolContext,
} from '@maka/runtime';
import type { SessionEvent } from '@maka/core';
import { createBotIncomingMainService } from '../bot-incoming-main.js';
import { startDesktopSessionTurn } from '../session-turn-stream.js';

const SESSION_ID = 'bot-session';

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('bot incoming Goal lifecycle', () => {
  test('settles a bot turn through the Desktop activity and Goal boundary', async () => {
    let now = 1;
    const manager = new GoalManager({
      generateId: () => 'goal-1',
      now: () => now++,
    });
    const coordinator = new GoalContinuationCoordinator({
      goalManager: manager,
      evaluator: {
        evaluate: async () => JSON.stringify({
          met: true,
          impossible: false,
          progress: true,
          waiting: false,
          reason: 'bot result verified',
        }),
      },
      getRecentContext: async () => 'bot result exists',
      admitTurn: () => assert.fail('an achieved Goal must not admit another turn'),
    });
    const activities = new SessionActivityRegistry();
    const goalSet = buildGoalTools({
      goalManager: manager,
      goalContinuation: coordinator,
    }).find((tool) => tool.name === 'GoalSet');
    assert.ok(goalSet);
    const replies: string[] = [];
    let runnerCalls = 0;
    let observedTurnId = '';

    const runtime = {
      async createSession() {
        return { id: SESSION_ID };
      },
      sendMessage(_sessionId: string, input: { turnId: string }) {
        observedTurnId = input.turnId;
        return (async function* (): AsyncIterable<SessionEvent> {
          await goalSet.impl({ condition: 'bot result is verified' }, {
            sessionId: SESSION_ID,
            turnId: input.turnId,
            cwd: '/repo',
            toolCallId: 'goal-set',
            abortSignal: new AbortController().signal,
            emitOutput: () => {},
          } satisfies MakaToolContext);
          yield {
            type: 'text_complete', id: 'text', turnId: input.turnId, ts: now++,
            messageId: 'assistant', text: 'Bot reply',
          };
          yield {
            type: 'complete', id: 'complete', turnId: input.turnId, ts: now++,
            stopReason: 'end_turn',
          };
        })();
      },
    } as unknown as SessionManager;

    const service = createBotIncomingMainService({
      runtime,
      createSession: (input) => runtime.createSession(input),
      botRegistry: {
        async sendMessage(_platform: string, _chatId: string, text: string) {
          replies.push(text);
          return 'bot-message-1';
        },
        async sendTypingIndicator() {
          return true;
        },
      } as unknown as BotRegistry,
      getCurrentProjectRoot: async () => '/repo',
      getDefaultConnectionSlug: async () => 'provider',
      getReadyConnection: async () => ({ connection: { slug: 'provider' }, model: 'model' }),
      readSessionHeader: async () => ({ permissionMode: 'explore' }),
      ensureSessionCanSend: async () => {},
      emitSessionsChanged() {},
      async runAgentTurn(input) {
        runnerCalls++;
        const started = startDesktopSessionTurn({
          sessionId: input.sessionId,
          events: input.iterator,
          turnId: input.turnId,
          goalBoundary: 'external',
          activities,
          beginExternalTurn: (sessionId, turnId) => coordinator.beginExternalTurn(sessionId, turnId),
          onEvent: input.onEvent,
          onStreamError: (error) => { assert.fail(String(error)); },
          onDrained: () => {},
        });
        assert.equal(started.kind, 'started');
        const result = await started.completion;
        const outcome = result.outcome;
        return {
          outcome,
          ...((outcome.kind === 'errored' || outcome.kind === 'suspended')
            ? { error: outcome.reason }
            : {}),
        };
      },
    });

    await service.handleBotIncomingMessage({
      platform: 'telegram',
      userId: 'user',
      userName: 'User',
      chatId: 'chat',
      isGroup: false,
      text: 'verify the result',
      sourceMessageId: 'source',
      receivedAt: now++,
    } as BotIncomingMessage);

    await waitFor(() => manager.get(SESSION_ID)?.status === 'achieved', 'bot turn did not settle its Goal');
    await waitFor(() => replies.length === 1, 'bot reply was not delivered');
    assert.equal(runnerCalls, 1);
    assert.ok(observedTurnId);
    assert.equal(manager.hasSettledTurn(SESSION_ID, observedTurnId), true);
    assert.equal(activities.whenIdle(SESSION_ID), undefined);
    assert.deepEqual(replies, ['Bot reply']);

    coordinator.dispose();
    manager.dispose();
  });

  test('does not start a bot stream closed between preparation and the canonical boundary', async () => {
    const manager = new GoalManager({ generateId: () => 'goal', now: () => 1 });
    const coordinator = new GoalContinuationCoordinator({
      goalManager: manager,
      evaluator: { evaluate: async () => assert.fail('closed bot turn must not evaluate') },
      getRecentContext: async () => 'unused',
      admitTurn: () => assert.fail('closed bot turn must not admit a continuation'),
    });
    const activities = new SessionActivityRegistry();
    const replies: string[] = [];
    let iteratorStarted = false;

    const runtime = {
      async createSession() {
        return { id: SESSION_ID };
      },
      sendMessage() {
        coordinator.beginSessionClose(SESSION_ID, 'archive').commit();
        return (async function* (): AsyncIterable<SessionEvent> {
          iteratorStarted = true;
          yield {
            type: 'complete', id: 'complete', turnId: 'turn-closed', ts: 1,
            stopReason: 'end_turn',
          };
        })();
      },
    } as unknown as SessionManager;

    const service = createBotIncomingMainService({
      runtime,
      createSession: (input) => runtime.createSession(input),
      botRegistry: {
        async sendMessage(_platform: string, _chatId: string, text: string) {
          replies.push(text);
          return 'bot-message-1';
        },
        async sendTypingIndicator() {
          return true;
        },
      } as unknown as BotRegistry,
      getCurrentProjectRoot: async () => '/repo',
      getDefaultConnectionSlug: async () => 'provider',
      getReadyConnection: async () => ({ connection: { slug: 'provider' }, model: 'model' }),
      readSessionHeader: async () => ({ permissionMode: 'explore' }),
      ensureSessionCanSend: async () => {},
      emitSessionsChanged() {},
      async runAgentTurn(input) {
        const started = startDesktopSessionTurn({
          sessionId: input.sessionId,
          events: input.iterator,
          turnId: input.turnId,
          goalBoundary: 'external',
          activities,
          beginExternalTurn: (sessionId, turnId) => coordinator.beginExternalTurn(sessionId, turnId),
          onEvent: input.onEvent,
          onStreamError: (error) => { assert.fail(String(error)); },
          onDrained: () => {},
        });
        if (started.kind === 'unavailable') throw new Error(started.reason);
        const { outcome } = await started.completion;
        return { outcome };
      },
    });

    await service.handleBotIncomingMessage({
      platform: 'telegram',
      userId: 'user',
      userName: 'User',
      chatId: 'chat',
      isGroup: false,
      text: 'continue',
      sourceMessageId: 'source',
      receivedAt: 1,
    } as BotIncomingMessage);

    assert.equal(iteratorStarted, false);
    assert.equal(activities.whenIdle(SESSION_ID), undefined);
    assert.equal(manager.hasSettledTurn(SESSION_ID, 'turn-closed'), false);
    assert.equal(manager.removeSession(SESSION_ID), false);
    await waitFor(() => replies.length === 1, 'closed bot turn did not report the rejection');

    coordinator.dispose();
    manager.dispose();
  });
});
