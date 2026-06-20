import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { RuntimeEvent } from '@maka/core';
import type { InvocationResult } from '@maka/runtime';
import {
  buildHarborCellOutput,
  validateHarborCellOutput,
} from '../index.js';

describe('Harbor cell output contract', () => {
  test('summarizes runtime outcome, prompt hash, token cost, and event path', () => {
    const events: RuntimeEvent[] = [
      runtimeEvent({ id: 'user-event' }),
      runtimeEvent({
        id: 'usage-1',
        actions: {
          tokenUsage: {
            input: 10,
            output: 5,
            reasoning: 2,
            total: 17,
            costUsd: 0.00123,
            systemPromptHash: 'sha256:prompt-a',
          },
        },
      }),
      runtimeEvent({
        id: 'usage-2',
        actions: {
          tokenUsage: {
            input: 3,
            output: 7,
            total: 10,
            costUsd: 0.004,
            systemPromptHash: 'sha256:prompt-a',
          },
        },
      }),
    ];
    const invocation: InvocationResult = {
      invocationId: 'inv-1',
      runId: 'run-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      status: 'completed',
      events,
      startedAt: 100,
      finishedAt: 250,
    };

    const output = buildHarborCellOutput({
      invocation,
      runtimeEventsPath: '/logs/agent/runtime-events.jsonl',
    });

    assert.deepEqual(validateHarborCellOutput(output), output);
    assert.deepEqual(output, {
      schemaVersion: 1,
      status: 'completed',
      runtimeEventsPath: '/logs/agent/runtime-events.jsonl',
      promptHash: 'sha256:prompt-a',
      tokenSummary: {
        input: 13,
        output: 12,
        reasoning: 2,
        total: 27,
        costUsd: 0.00523,
      },
      steps: 3,
      durationMs: 150,
      startedAt: 100,
      finishedAt: 250,
      runtimeRefs: {
        invocationId: 'inv-1',
        sessionId: 'session-1',
        runId: 'run-1',
        turnId: 'turn-1',
      },
    });
  });

  test('keeps output when runtime emits more than one prompt hash', () => {
    const output = buildHarborCellOutput({
      invocation: {
        invocationId: 'inv-1',
        runId: 'run-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        status: 'completed',
        events: [
          runtimeEvent({
            id: 'usage-1',
            actions: { tokenUsage: { input: 1, output: 0, systemPromptHash: 'sha256:prompt-a' } },
          }),
          runtimeEvent({
            id: 'usage-2',
            actions: { tokenUsage: { input: 0, output: 1, systemPromptHash: 'sha256:prompt-b' } },
          }),
        ],
        startedAt: 100,
        finishedAt: 250,
      },
      runtimeEventsPath: '/logs/agent/runtime-events.jsonl',
    });

    assert.equal(output.promptHash, 'sha256:prompt-a');
  });
});

function runtimeEvent(extra: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    id: extra.id ?? 'event',
    sessionId: 'session-1',
    invocationId: 'inv-1',
    runId: 'run-1',
    turnId: 'turn-1',
    ts: 100,
    partial: false,
    role: 'model',
    author: 'agent',
    ...extra,
  };
}
