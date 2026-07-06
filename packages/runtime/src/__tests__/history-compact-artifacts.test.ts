import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, test } from 'node:test';
import type { ArtifactRecord } from '@maka/core';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { buildHistoryCompactBlockFromSummary } from '../context-budget.js';
import type { HistoryCompactWriteInput } from '../ai-sdk-backend.js';
import {
  loadHistoryCompactBlocksFromArtifacts,
  persistHistoryCompactBlocksToArtifacts,
  type HistoryCompactArtifactStore,
} from '../history-compact-artifacts.js';

describe('history compact artifacts', () => {
  test('persists a compact block within default limits when the fold covers many events', async () => {
    const store = memoryArtifactStore();
    const foldedEvents = Array.from({ length: 60 }, (_, index) =>
      textEvent(`old-${index}`, `turn-${Math.floor(index / 4)}`, `folded fact number ${index}`));
    const input: HistoryCompactWriteInput = {
      sessionId: 'session-1',
      turnId: 'turn-write',
      source: {
        draftBlock: buildHistoryCompactBlockFromSummary({
          sessionId: 'session-1',
          foldedRuntimeEvents: foldedEvents,
          summary: 'deterministic fallback',
          highWaterName: 'test-history-compact',
          highWaterSeq: 1,
          now: 1_800_000_000_000,
          charsPerToken: 4,
        }),
        foldedRuntimeEvents: foldedEvents,
      },
      limits: {
        maxBlocks: 1,
        maxBlockEstimatedTokens: 1_024,
        maxEstimatedTokens: 2_048,
        charsPerToken: 4,
      },
    };

    const write = await persistHistoryCompactBlocksToArtifacts(store, input, {
      now: () => 1_800_000_000_100,
      summarize: () => 'short summary of a long session',
    });

    assert.deepEqual(write.skippedReasonCounts, undefined);
    assert.equal(write.blocks.length, 1);
    assert.ok((write.blocks[0]?.estimatedTokens ?? 0) <= 1_024);
    assert.equal(write.blocks[0]?.sourceArchiveRefs?.length, 60);
  });

  test('loads a metadata-heavy block without an explicit byte cap', async () => {
    const store = memoryArtifactStore();
    const foldedEvents = Array.from({ length: 60 }, (_, index) =>
      textEvent(`old-${index}`, `turn-${Math.floor(index / 4)}`, `folded fact number ${index}`));
    const write = await persistHistoryCompactBlocksToArtifacts(store, {
      sessionId: 'session-1',
      turnId: 'turn-write',
      source: {
        draftBlock: buildHistoryCompactBlockFromSummary({
          sessionId: 'session-1',
          foldedRuntimeEvents: foldedEvents,
          summary: 'deterministic fallback',
          highWaterName: 'test-history-compact',
          highWaterSeq: 1,
          now: 1_800_000_000_000,
          charsPerToken: 4,
        }),
        foldedRuntimeEvents: foldedEvents,
      },
      limits: {
        maxBlocks: 1,
        maxBlockEstimatedTokens: 1_024,
        maxEstimatedTokens: 2_048,
        charsPerToken: 4,
      },
    }, {
      now: () => 1_800_000_000_100,
      summarize: () => 'short summary of a long session',
    });
    assert.equal(write.blocks.length, 1);

    const loaded = await loadHistoryCompactBlocksFromArtifacts(store, {
      sessionId: 'session-1',
      maxBlocks: 1,
      maxEstimatedTokens: 2_048,
    });

    assert.deepEqual(loaded.skippedReasonCounts, undefined);
    assert.equal(loaded.blocks[0]?.blockId, write.blocks[0]?.blockId);
  });
});

function memoryArtifactStore(): HistoryCompactArtifactStore {
  const records = new Map<string, { record: ArtifactRecord; content: string }>();
  return {
    async create(input) {
      const id = input.id ?? `artifact-${records.size + 1}`;
      const record: ArtifactRecord = {
        id,
        sessionId: input.sessionId,
        turnId: input.turnId,
        createdAt: input.now ?? 0,
        name: input.name,
        kind: input.kind,
        relativePath: input.name,
        sizeBytes: Buffer.byteLength(input.content, 'utf8'),
        mimeType: input.mimeType,
        source: input.source,
        summary: input.summary,
        status: 'live',
      };
      records.set(id, { record, content: input.content });
      return record;
    },
    async delete(artifactId) {
      const entry = records.get(artifactId);
      if (entry) entry.record.status = 'deleted';
    },
    async list() {
      return [...records.values()].map((entry) => entry.record);
    },
    async readText(artifactId) {
      const entry = records.get(artifactId);
      if (!entry) return { ok: false, reason: 'not_found' };
      return { ok: true, text: entry.content };
    },
  };
}

function textEvent(id: string, turnId: string, text: string): RuntimeEvent {
  return {
    id,
    sessionId: 'session-1',
    runId: 'run-1',
    turnId,
    invocationId: 'invocation-1',
    ts: 1_800_000_000_000,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text },
  };
}
