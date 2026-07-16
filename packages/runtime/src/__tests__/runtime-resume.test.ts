import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { RuntimeEvent } from '@maka/core/runtime-event';

import {
  RUNTIME_RESUME_FAILPOINTS,
  buildResumePlanFromRuntimeEvents,
  buildResumeReplayRuntimeEvents,
  projectToolOperationsFromRuntimeEvents,
} from '../runtime-resume.js';

describe('runtime resume phase 0 projection', () => {
  test('publishes the stable P0-P11 crash failpoint catalog', () => {
    assert.deepEqual(
      RUNTIME_RESUME_FAILPOINTS.map((failpoint) => failpoint.id),
      ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P11'],
    );
    assert.deepEqual(
      [...new Set(RUNTIME_RESUME_FAILPOINTS.map((failpoint) => failpoint.committedPrefix))],
      ['before_function_call', 'after_function_call', 'after_function_response', 'after_terminal_event'],
    );
  });

  test('projects deterministic tool operations from legal RuntimeEvent prefixes', () => {
    const events = [
      callEvent('call-1', 'tool-1', 'Bash', { command: 'npm test' }),
      responseEvent('result-1', 'tool-1', 'Bash', { ok: false }, true),
      callEvent('call-2', 'tool-2', 'Read', { file_path: 'README.md' }),
    ];

    const first = projectToolOperationsFromRuntimeEvents(events);
    const second = projectToolOperationsFromRuntimeEvents(events);

    assert.deepEqual(first, second);
    assert.deepEqual(first.map((operation) => ({
      toolCallId: operation.toolCallId,
      toolName: operation.toolName,
      status: operation.status,
      callRuntimeEventId: operation.callRuntimeEventId,
      responseRuntimeEventId: operation.responseRuntimeEventId,
    })), [
      {
        toolCallId: 'tool-1',
        toolName: 'Bash',
        status: 'failed',
        callRuntimeEventId: 'call-1',
        responseRuntimeEventId: 'result-1',
      },
      {
        toolCallId: 'tool-2',
        toolName: 'Read',
        status: 'indeterminate',
        callRuntimeEventId: 'call-2',
        responseRuntimeEventId: undefined,
      },
    ]);
  });

  test('distinguishes committed failed results from indeterminate missing results', () => {
    const failed = buildResumePlanFromRuntimeEvents([
      callEvent('call-1', 'tool-1', 'Bash', { command: 'exit 1' }),
      responseEvent('result-1', 'tool-1', 'Bash', { exitCode: 1 }, true),
    ]);
    const indeterminate = buildResumePlanFromRuntimeEvents([
      callEvent('call-2', 'tool-2', 'Bash', { command: 'touch marker' }),
    ]);

    assert.equal(failed.disposition, 'safe_replay');
    assert.equal(failed.operations[0]?.status, 'failed');
    assert.equal(indeterminate.disposition, 'blocked');
    assert.equal(indeterminate.operations[0]?.status, 'indeterminate');
    assert.equal(indeterminate.requiresVerification, true);
    assert.deepEqual(indeterminate.rejectionReasons, ['dangling_tool_state']);
    assert.equal(indeterminate.sourceRuntimeEventHighWater, 1);
    assert.ok(indeterminate.directive);
    assert.match(indeterminate.directive, /Do not retry/i);
    assert.match(indeterminate.directive, /read-only/i);
  });

  test('excludes unresolved tool calls from provider replay history', () => {
    const events = [
      textEvent('user-1', 'user', 'hello'),
      callEvent('call-1', 'tool-1', 'Bash', { command: 'touch marker' }),
      textEvent('system-1', 'system', 'diagnostic'),
    ];

    const replayEvents = buildResumeReplayRuntimeEvents(events);

    assert.deepEqual(replayEvents.map((event) => event.id), ['user-1', 'system-1']);
  });

  test('blocks replay on unmatched tool results rather than inventing provider history', () => {
    const plan = buildResumePlanFromRuntimeEvents([
      responseEvent('result-1', 'tool-1', 'Bash', { ok: true }, false),
    ]);

    assert.equal(plan.disposition, 'blocked');
    assert.equal(plan.requiresVerification, false);
    assert.deepEqual(plan.rejectionReasons, ['dangling_tool_state']);
    assert.deepEqual(plan.diagnostics.map((diagnostic) => diagnostic.code), ['unmatched_tool_result']);
    assert.deepEqual(buildResumeReplayRuntimeEvents(plan.runtimeEvents).map((event) => event.id), []);
  });

  test('rejects runtime high-water mismatches with a stable fallback reason', () => {
    const plan = buildResumePlanFromRuntimeEvents([
      textEvent('user-1', 'user', 'hello'),
    ], {
      expectedRuntimeEventHighWater: 2,
    });

    assert.equal(plan.disposition, 'blocked');
    assert.deepEqual(plan.rejectionReasons, ['runtime_offset_mismatch']);
    assert.deepEqual(plan.diagnostics.map((diagnostic) => diagnostic.code), ['runtime_offset_mismatch']);
  });
});

function base(overrides: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    id: 'event-1',
    sessionId: 'session-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    author: 'agent',
    role: 'system',
    ...overrides,
  };
}

function callEvent(id: string, toolCallId: string, name: string, args: unknown): RuntimeEvent {
  return base({
    id,
    author: 'agent',
    role: 'model',
    content: { kind: 'function_call', id: toolCallId, name, args },
  });
}

function responseEvent(
  id: string,
  toolCallId: string,
  name: string,
  response: unknown,
  isError: boolean,
): RuntimeEvent {
  return base({
    id,
    author: 'tool',
    role: 'tool',
    content: { kind: 'function_response', id: toolCallId, name, result: response, isError },
  });
}

function textEvent(id: string, role: 'user' | 'system', text: string): RuntimeEvent {
  return base({
    id,
    author: role === 'user' ? 'user' : 'system',
    role,
    content: { kind: 'text', text },
  });
}
