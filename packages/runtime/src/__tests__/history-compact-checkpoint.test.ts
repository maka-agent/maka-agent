import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AgentRunEvent, AgentRunHeader, AgentRunStore } from '@maka/core';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  buildHistoryCompactCheckpoint,
  matchHistoryCompactCheckpointPrefix,
  validateHistoryCompactCheckpointShape,
} from '../history-compact-checkpoint.js';
import { loadLatestHistoryCompactCheckpointFromRunLedger } from '../history-compact-ledger.js';
import { applyRuntimeEventHistoryCompact } from '../context-budget.js';

describe('history compact checkpoint', () => {
  test('keeps 10K-event coverage bounded and validates the exact ordered prefix', () => {
    const events = Array.from({ length: 10_000 }, (_, index) => textEvent(index));
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: events,
      summary: 'A bounded continuation summary.',
      now: 1_800_000_010_000,
    });

    assert.equal(validateHistoryCompactCheckpointShape(checkpoint, 'session-1'), true);
    assert.ok(Buffer.byteLength(JSON.stringify(checkpoint), 'utf8') < 64 * 1024);
    assert.equal(checkpoint.coverage.eventCount, 10_000);
    assert.equal(checkpoint.coverage.turnCount, 5_000);
    assert.equal(checkpoint.coverage.through.runtimeEventId, 'event-9999');
    assert.equal(matchHistoryCompactCheckpointPrefix(checkpoint, events).coveredEventCount, 10_000);
    const replay = applyRuntimeEventHistoryCompact([...events, textEvent(10_000)], {
      maxHistoryEstimatedTokens: 1_000_000,
      charsPerToken: 1,
      historyCompact: {
        enabled: true,
        mode: 'read_write',
        checkpoints: [checkpoint],
        highWaterRatio: 0.000001,
        tailEstimatedTokens: 1,
      },
    });
    assert.equal(replay.checkpoints[0]?.checkpointId, checkpoint.checkpointId);
    assert.ok(Buffer.byteLength(JSON.stringify(replay.diagnosticPatch), 'utf8') < 16 * 1024);

    const changed = [...events];
    changed[4_999] = {
      ...changed[4_999]!,
      content: { kind: 'text', text: 'changed source fact' },
    };
    assert.equal(matchHistoryCompactCheckpointPrefix(checkpoint, changed).reason, 'source_hash_mismatch');
    assert.equal(
      matchHistoryCompactCheckpointPrefix(checkpoint, [events[1]!, events[0]!, ...events.slice(2)]).reason,
      'source_hash_mismatch',
    );
  });

  test('rejects blank summaries instead of persisting an unusable checkpoint', () => {
    assert.throws(() => buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0)],
      summary: '   ',
    }), /non-empty summary/);
  });

  test('loads the latest valid checkpoint from the run ledger', async () => {
    const first = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0)],
      summary: 'first',
      now: 10,
    });
    const latest = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0), textEvent(1)],
      summary: 'latest',
      previousCheckpointId: first.checkpointId,
      now: 20,
    });
    const store = new StubAgentRunStore([
      run('run-1', 10),
      run('run-2', 20),
      run('run-3', 30),
    ], new Map([
      ['run-1', [checkpointEvent('ledger-1', 'run-1', first, 10)]],
      ['run-2', [checkpointEvent('ledger-2', 'run-2', latest, 20)]],
      ['run-3', [{ ...checkpointEvent('ledger-3', 'run-3', latest, 30), data: { checkpoint: { ...latest, summary: ' ' } } }]],
    ]));

    const loaded = await loadLatestHistoryCompactCheckpointFromRunLedger(store, 'session-1');

    assert.equal(loaded?.checkpointId, latest.checkpointId);
  });

  test('replays a matching checkpoint with only the uncovered raw tail', () => {
    const events = Array.from({ length: 8 }, (_, index) => textEvent(index));
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: events.slice(0, 4),
      summary: 'checkpoint summary',
    });

    const replay = applyRuntimeEventHistoryCompact(events, {
      maxHistoryEstimatedTokens: 1_000,
      charsPerToken: 1,
      historyCompact: {
        enabled: true,
        mode: 'read_write',
        checkpoints: [checkpoint],
        highWaterRatio: 0.01,
        tailEstimatedTokens: 1,
      },
    });

    assert.equal(replay.events[0]?.id, `history-compact:${checkpoint.checkpointId}`);
    assert.match(
      replay.events[0]?.content?.kind === 'text' ? replay.events[0].content.text : '',
      /checkpoint summary/,
    );
    assert.deepEqual(replay.events.slice(1).map((event) => event.id), events.slice(4).map((event) => event.id));
    assert.equal(replay.checkpoints[0]?.checkpointId, checkpoint.checkpointId);
  });
});

function textEvent(index: number): RuntimeEvent {
  return {
    id: `event-${index}`,
    sessionId: 'session-1',
    runId: `run-${Math.floor(index / 2)}`,
    turnId: `turn-${Math.floor(index / 2)}`,
    invocationId: `invocation-${Math.floor(index / 2)}`,
    ts: 1_800_000_000_000 + index,
    partial: false,
    role: index % 2 === 0 ? 'user' : 'model',
    author: index % 2 === 0 ? 'user' : 'agent',
    content: { kind: 'text', text: `payload-${index}` },
  };
}

function run(runId: string, createdAt: number): AgentRunHeader {
  return {
    runId,
    sessionId: 'session-1',
    turnId: `turn-${runId}`,
    status: 'completed',
    backendKind: 'ai-sdk',
    llmConnectionSlug: 'test',
    modelId: 'test',
    cwd: '/tmp',
    permissionMode: 'ask',
    createdAt,
    updatedAt: createdAt,
  };
}

function checkpointEvent(
  id: string,
  runId: string,
  checkpoint: ReturnType<typeof buildHistoryCompactCheckpoint>,
  ts: number,
): AgentRunEvent {
  return {
    type: 'history_compact_checkpoint_recorded',
    id,
    runId,
    sessionId: 'session-1',
    turnId: `turn-${runId}`,
    ts,
    data: { checkpoint },
  };
}

class StubAgentRunStore implements AgentRunStore {
  constructor(
    private readonly runs: AgentRunHeader[],
    private readonly events: Map<string, AgentRunEvent[]>,
  ) {}

  async listSessionRuns(): Promise<AgentRunHeader[]> {
    return this.runs;
  }

  async readEvents(_sessionId: string, runId: string): Promise<AgentRunEvent[]> {
    return this.events.get(runId) ?? [];
  }

  async createRun(): Promise<AgentRunHeader> { throw new Error('not implemented'); }
  async updateRun(): Promise<AgentRunHeader> { throw new Error('not implemented'); }
  async readRun(): Promise<AgentRunHeader> { throw new Error('not implemented'); }
  async appendEvent(): Promise<void> { throw new Error('not implemented'); }
}
