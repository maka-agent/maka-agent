import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { buildHistoryCompactBlockFromSummary } from '../context-budget.js';
import { cleanupLegacyHistoryCompactArtifacts } from '../history-compact-cleanup.js';
import { persistHistoryCompactBlocksToArtifacts } from '../history-compact-artifacts.js';
import { buildHistoryCompactCheckpoint } from '../history-compact-checkpoint.js';
import { memoryArtifactStore } from './memory-artifact-store.js';

describe('legacy history compact cleanup', () => {
  test('purges a verified V1 block and its sources after a later V2 checkpoint', async () => {
    const store = memoryArtifactStore();
    const legacyEvents = [textEvent(0), textEvent(1), textEvent(2)];
    await writeLegacyArtifacts(store, legacyEvents);
    const runtimeEvents = [...legacyEvents, textEvent(3)];
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: runtimeEvents,
      summary: 'V2 covers the legacy prefix.',
    });

    const result = await cleanupLegacyHistoryCompactArtifacts({
      sessionId: 'session-1',
      checkpoint,
      runtimeEvents,
      artifactStore: store,
    });

    assert.equal(result.purgedArtifactIds.length, 4);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(await store.list('session-1', { includeDeleted: true }), []);
  });

  test('ignores non-compactable ledger facts when validating V2 coverage', async () => {
    const store = memoryArtifactStore();
    const compactableEvents = [textEvent(0), textEvent(1), textEvent(2)];
    await writeLegacyArtifacts(store, compactableEvents);
    const heartbeat: RuntimeEvent = {
      ...textEvent(99),
      id: 'tool-heartbeat',
      partial: true,
      role: 'tool',
      author: 'tool',
      content: undefined,
      refs: { toolCallId: 'tool-call-1' },
    };
    const runtimeEvents = [compactableEvents[0]!, heartbeat, ...compactableEvents.slice(1)];
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: compactableEvents,
      summary: 'V2 compactable prefix',
    });

    const result = await cleanupLegacyHistoryCompactArtifacts({
      sessionId: 'session-1',
      checkpoint,
      runtimeEvents,
      artifactStore: store,
    });

    assert.equal(result.purgedArtifactIds.length, 4);
    assert.deepEqual(result.skipped, []);
  });

  test('preserves every legacy artifact when the V2 checkpoint no longer matches the ledger', async () => {
    const store = memoryArtifactStore();
    const runtimeEvents = [textEvent(0), textEvent(1), textEvent(2)];
    await writeLegacyArtifacts(store, runtimeEvents);
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: runtimeEvents,
      summary: 'checkpoint before corruption',
    });
    const changedEvents = [...runtimeEvents];
    changedEvents[1] = { ...changedEvents[1]!, content: { kind: 'text', text: 'changed' } };

    const result = await cleanupLegacyHistoryCompactArtifacts({
      sessionId: 'session-1',
      checkpoint,
      runtimeEvents: changedEvents,
      artifactStore: store,
    });

    assert.deepEqual(result.purgedArtifactIds, []);
    assert.equal(result.skipped.length, 4);
    assert.ok(result.skipped.every((item) => item.reason === 'checkpoint_source_hash_mismatch'));
    assert.equal((await store.list('session-1', { includeDeleted: true })).length, 4);
  });

  test('preserves V1 data that extends beyond the valid V2 checkpoint prefix', async () => {
    const store = memoryArtifactStore();
    const runtimeEvents = [textEvent(0), textEvent(1), textEvent(2)];
    await writeLegacyArtifacts(store, runtimeEvents);
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: runtimeEvents.slice(0, 2),
      summary: 'shorter V2 checkpoint',
    });

    const result = await cleanupLegacyHistoryCompactArtifacts({
      sessionId: 'session-1',
      checkpoint,
      runtimeEvents,
      artifactStore: store,
    });

    assert.deepEqual(result.purgedArtifactIds, []);
    assert.ok(result.skipped.some((item) => item.reason === 'block_coverage_mismatch'));
    assert.equal((await store.list('session-1', { includeDeleted: true })).length, 4);
  });

  test('preserves a corrupt V1 block and its unverified source artifacts', async () => {
    const store = memoryArtifactStore();
    const runtimeEvents = [textEvent(0), textEvent(1), textEvent(2)];
    await writeLegacyArtifacts(store, runtimeEvents);
    const records = await store.list('session-1', { includeDeleted: true });
    const block = records.find((record) => record.source === 'history_compact_block')!;
    await store.create({
      id: block.id,
      sessionId: block.sessionId,
      turnId: block.turnId,
      name: block.name,
      kind: 'file',
      content: '{invalid json',
      source: 'history_compact_block',
    });
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: runtimeEvents,
      summary: 'valid V2 checkpoint',
    });
    const diagnostics: unknown[] = [];
    const cleanupInput = {
      sessionId: 'session-1',
      checkpoint,
      runtimeEvents,
      artifactStore: store,
      onDiagnostic: (diagnostic: unknown) => diagnostics.push(diagnostic),
    };

    const result = await cleanupLegacyHistoryCompactArtifacts(cleanupInput);

    assert.deepEqual(result.purgedArtifactIds, []);
    assert.equal(
      result.skipped.find((item) => item.artifactId === block.id)?.reason,
      'block_invalid_json',
    );
    assert.equal(result.skipped.filter((item) => item.reason === 'source_unlinked').length, 3);
    assert.equal((await store.list('session-1', { includeDeleted: true })).length, 4);
    assert.deepEqual(diagnostics, [
      {
        kind: 'skipped',
        artifactCount: 4,
        reasonCounts: {
          block_invalid_json: 1,
          source_unlinked: 3,
        },
      },
    ]);
  });

  test('preserves a V1 group when a linked source no longer matches the canonical event', async () => {
    const store = memoryArtifactStore();
    const runtimeEvents = [textEvent(0), textEvent(1), textEvent(2)];
    await writeLegacyArtifacts(store, runtimeEvents);
    const source = (await store.list('session-1', { includeDeleted: true })).find(
      (record) => record.source === 'history_compact_source',
    )!;
    await store.create({
      id: source.id,
      sessionId: source.sessionId,
      turnId: source.turnId,
      name: source.name,
      kind: 'file',
      content: JSON.stringify({ ...runtimeEvents[0], content: { kind: 'text', text: 'tampered' } }),
      source: 'history_compact_source',
    });
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: runtimeEvents,
      summary: 'valid V2 checkpoint',
    });

    const result = await cleanupLegacyHistoryCompactArtifacts({
      sessionId: 'session-1',
      checkpoint,
      runtimeEvents,
      artifactStore: store,
    });

    assert.deepEqual(result.purgedArtifactIds, []);
    assert.ok(result.skipped.some((item) => item.reason === 'source_content_mismatch'));
    assert.equal((await store.list('session-1', { includeDeleted: true })).length, 4);
  });

  test('purges a safely linked group after one source was soft deleted', async () => {
    const store = memoryArtifactStore();
    const runtimeEvents = [textEvent(0), textEvent(1), textEvent(2)];
    await writeLegacyArtifacts(store, runtimeEvents);
    const source = (await store.list('session-1', { includeDeleted: true })).find(
      (record) => record.source === 'history_compact_source',
    )!;
    await store.delete(source.id);
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: runtimeEvents,
      summary: 'valid V2 checkpoint',
    });

    const first = await cleanupLegacyHistoryCompactArtifacts({
      sessionId: 'session-1',
      checkpoint,
      runtimeEvents,
      artifactStore: store,
    });
    const repeated = await cleanupLegacyHistoryCompactArtifacts({
      sessionId: 'session-1',
      checkpoint,
      runtimeEvents,
      artifactStore: store,
    });

    assert.equal(first.purgedArtifactIds.length, 4);
    assert.deepEqual(first.skipped, []);
    assert.deepEqual(repeated, { purgedArtifactIds: [], skipped: [] });
  });

  test('reports one cleanup failure without changing the thrown error', async () => {
    const store = memoryArtifactStore();
    const runtimeEvents = [textEvent(0)];
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: runtimeEvents,
      summary: 'valid V2 checkpoint',
    });
    const diagnostics: unknown[] = [];

    await assert.rejects(
      () =>
        cleanupLegacyHistoryCompactArtifacts({
          sessionId: 'session-1',
          checkpoint,
          runtimeEvents,
          artifactStore: {
            ...store,
            async list() {
              throw new Error('metadata unreadable');
            },
          },
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        }),
      /metadata unreadable/,
    );
    assert.deepEqual(diagnostics, [
      {
        kind: 'failed',
        message: 'metadata unreadable',
      },
    ]);
  });
});

async function writeLegacyArtifacts(
  store: ReturnType<typeof memoryArtifactStore>,
  events: readonly RuntimeEvent[],
): Promise<void> {
  await persistHistoryCompactBlocksToArtifacts(store, {
    sessionId: 'session-1',
    turnId: 'turn-write',
    source: {
      draftBlock: buildHistoryCompactBlockFromSummary({
        sessionId: 'session-1',
        foldedRuntimeEvents: events,
        summary: 'legacy summary',
      }),
      foldedRuntimeEvents: [...events],
    },
    limits: {
      maxBlocks: 1,
      maxBlockEstimatedTokens: 1_024,
      maxEstimatedTokens: 2_048,
      charsPerToken: 4,
    },
  });
}

function textEvent(index: number): RuntimeEvent {
  return {
    id: `event-${index}`,
    invocationId: `invocation-${index}`,
    runId: `run-${index}`,
    sessionId: 'session-1',
    turnId: `turn-${index}`,
    ts: index + 1,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text: `fact ${index}` },
  };
}
