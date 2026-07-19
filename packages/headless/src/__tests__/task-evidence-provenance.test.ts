import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { HeavyTaskCompactEvidenceEnvelope } from '../task-contracts.js';
import { taskEvidenceRuntimeProvenanceLinks } from '../task-evidence-provenance.js';

describe('taskEvidenceRuntimeProvenanceLinks', () => {
  test('links compact evidence to its immutable Runtime call/result range', () => {
    const links = taskEvidenceRuntimeProvenanceLinks({
      ...identity,
      runtimeEvents: [
        runtimeEvent('user-event'),
        runtimeEvent('call-event', {
          role: 'model',
          author: 'agent',
          content: {
            kind: 'function_call',
            id: 'tool-1',
            name: 'Bash',
            args: { command: 'npm test' },
          },
          refs: { toolCallId: 'tool-1' },
        }),
        runtimeEvent('progress-event', {
          partial: true,
          role: 'tool',
          author: 'tool',
          refs: { toolCallId: 'tool-1' },
        }),
        runtimeEvent('result-event', {
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: 'tool-1',
            name: 'Bash',
            result: { exitCode: 0 },
          },
          refs: { toolCallId: 'tool-1' },
        }),
      ],
      evidence: [toolEvidence()],
    });

    assert.equal(links.length, 1);
    assert.deepEqual(links[0]?.provenance.runtimeCoverage, {
      lowWater: {
        ledger: 'runtime_event',
        streamId: 'run-1',
        sequence: 1,
        eventId: 'call-event',
      },
      highWater: {
        ledger: 'runtime_event',
        streamId: 'run-1',
        sequence: 3,
        eventId: 'result-event',
      },
      eventCount: 3,
    });
  });

  test('requires the executor-owned function response before claiming provenance', () => {
    const links = taskEvidenceRuntimeProvenanceLinks({
      ...identity,
      runtimeEvents: [
        runtimeEvent('call-event', {
          role: 'model',
          author: 'agent',
          content: { kind: 'function_call', id: 'tool-1', name: 'Bash', args: {} },
          refs: { toolCallId: 'tool-1' },
        }),
      ],
      evidence: [toolEvidence()],
    });

    assert.deepEqual(links, []);
  });

  test('keeps evidence from another AgentRun or tool name unlinked', () => {
    const runtimeEvents = [
      runtimeEvent('result-event', {
        role: 'tool',
        author: 'tool',
        content: { kind: 'function_response', id: 'tool-1', name: 'Read', result: 'ok' },
        refs: { toolCallId: 'tool-1' },
      }),
    ];

    assert.deepEqual(
      taskEvidenceRuntimeProvenanceLinks({
        ...identity,
        runtimeEvents,
        evidence: [toolEvidence({ source: { ...toolEvidence().source, agentRunId: 'run-2' } })],
      }),
      [],
    );
    assert.deepEqual(
      taskEvidenceRuntimeProvenanceLinks({
        ...identity,
        runtimeEvents,
        evidence: [toolEvidence()],
      }),
      [],
    );
    assert.deepEqual(
      taskEvidenceRuntimeProvenanceLinks({
        ...identity,
        runtimeEvents: [
          runtimeEvent('foreign-result', {
            runId: 'run-2',
            role: 'tool',
            author: 'tool',
            content: { kind: 'function_response', id: 'tool-1', name: 'Bash', result: 'ok' },
            refs: { toolCallId: 'tool-1' },
          }),
        ],
        evidence: [toolEvidence()],
      }),
      [],
    );
  });

  test('links legacy evidence by session and turn without inventing an AgentRun source field', () => {
    const legacy = toolEvidence();
    delete legacy.source.agentRunId;
    const links = taskEvidenceRuntimeProvenanceLinks({
      ...identity,
      runtimeEvents: [
        runtimeEvent('result-event', {
          role: 'tool',
          author: 'tool',
          content: { kind: 'function_response', id: 'tool-1', name: 'Bash', result: 'ok' },
          refs: { toolCallId: 'tool-1' },
        }),
      ],
      evidence: [legacy],
    });

    assert.equal(links[0]?.provenance.execution?.agentRunId, 'run-1');
  });
});

const identity = {
  taskRunId: 'task-run-1',
  attemptId: 'attempt-1',
  sessionId: 'session-1',
  invocationId: 'invocation-1',
  agentRunId: 'run-1',
  turnId: 'turn-1',
};

function toolEvidence(
  overrides: Partial<HeavyTaskCompactEvidenceEnvelope> = {},
): HeavyTaskCompactEvidenceEnvelope {
  return {
    schemaVersion: 1,
    evidenceId: 'evidence-1',
    taskRunId: 'task-run-1',
    attemptId: 'attempt-1',
    ts: 1,
    kind: 'tool',
    public: true,
    source: {
      kind: 'model_tool',
      toolCallId: 'tool-1',
      toolName: 'Bash',
      sessionId: 'session-1',
      agentRunId: 'run-1',
      turnId: 'turn-1',
    },
    tool: {
      name: 'Bash',
      inputSummary: { command: 'npm test' },
      exitCode: 0,
      ok: true,
      outputs: [],
      diff: { status: 'not_applicable' },
    },
    ...overrides,
  };
}

function runtimeEvent(id: string, overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    id,
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text: 'x' },
    ...overrides,
  };
}
