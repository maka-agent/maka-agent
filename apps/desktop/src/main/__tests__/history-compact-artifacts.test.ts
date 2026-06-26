import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  buildHistoryCompactBlockFromSummary,
  type HistoryCompactBlock,
  type HistoryCompactWriteInput,
} from '@maka/runtime';
import {
  createArtifactStore,
  type ArtifactStore,
} from '@maka/storage';
import {
  loadHistoryCompactBlocksFromArtifacts,
  persistHistoryCompactBlocksToArtifacts,
} from '../history-compact-artifacts.js';

describe('desktop history compact artifact lifecycle', () => {
  test('persists archived RuntimeEvent sources and a compact block', async () => {
    await withStore(async (store) => {
      const foldedEvents = [
        textEvent('old-1', 'turn-1', 'alpha fact'),
        textEvent('old-2', 'turn-2', 'beta fact'),
      ];
      const input: HistoryCompactWriteInput = {
        sessionId: 'session-1',
        turnId: 'turn-write',
        source: {
          draftBlock: historyCompactBlock(foldedEvents, 'deterministic fallback'),
          foldedRuntimeEvents: foldedEvents,
        },
        limits: {
          maxBlocks: 1,
          maxBlockEstimatedTokens: 1_024,
          maxEstimatedTokens: 2_048,
          charsPerToken: 4,
        },
      };

      const createdArtifacts: string[] = [];
      const write = await persistHistoryCompactBlocksToArtifacts(store, input, {
        now: () => 1_800_000_000_100,
        summarize: () => 'host summary alpha beta',
        onArtifactCreated: (artifact) => {
          createdArtifacts.push(artifact.id);
        },
      });

      assert.equal(write.blocks.length, 1);
      assert.match(write.blocks[0]?.summary ?? '', /host summary alpha beta/);
      assert.equal(write.blocks[0]?.sourceArchiveRefs?.length, 2);
      assert.equal(write.blocks[0]?.sourceArchiveRefs?.[0]?.bodySha256, sha256(JSON.stringify({ kind: 'text', text: 'alpha fact' })));
      assert.equal(createdArtifacts.length, 3);

      const records = await store.list('session-1');
      assert.equal(records.filter((record) => record.source === 'history_compact_source').length, 2);
      assert.equal(records.filter((record) => record.source === 'history_compact_block').length, 1);

      const loaded = await loadHistoryCompactBlocksFromArtifacts(store, {
        sessionId: 'session-1',
        maxBlocks: 1,
        maxEstimatedTokens: 2_048,
        maxBytes: 16_384,
      });
      assert.equal(loaded.blocks.length, 1);
      assert.equal(loaded.blocks[0]?.blockId, write.blocks[0]?.blockId);
      assert.equal(loaded.skipped, undefined);
    });
  });

  test('does not leave source artifacts when the compact block exceeds the block token limit', async () => {
    await withStore(async (store) => {
      const foldedEvents = [
        textEvent('old-1', 'turn-1', 'alpha fact'),
        textEvent('old-2', 'turn-2', 'beta fact'),
      ];
      const input: HistoryCompactWriteInput = {
        sessionId: 'session-1',
        turnId: 'turn-write',
        source: {
          draftBlock: historyCompactBlock(foldedEvents, 'deterministic fallback'),
          foldedRuntimeEvents: foldedEvents,
        },
        limits: {
          maxBlocks: 1,
          maxBlockEstimatedTokens: 1,
          maxEstimatedTokens: 2_048,
          charsPerToken: 4,
        },
      };

      const createdArtifacts: string[] = [];
      const write = await persistHistoryCompactBlocksToArtifacts(store, input, {
        now: () => 1_800_000_000_100,
        summarize: () => 'summary that cannot fit in one estimated token',
        onArtifactCreated: (artifact) => {
          createdArtifacts.push(artifact.id);
        },
      });

      assert.equal(write.blocks.length, 0);
      assert.equal(write.skipped, 1);
      assert.deepEqual(write.skippedReasonCounts, { max_block_tokens: 1 });
      assert.deepEqual(createdArtifacts, []);
      assert.deepEqual(await store.list('session-1'), []);
    });
  });

  test('does not leave source artifacts when the compact block exceeds the total token limit', async () => {
    await withStore(async (store) => {
      const foldedEvents = [
        textEvent('old-1', 'turn-1', 'alpha fact'),
        textEvent('old-2', 'turn-2', 'beta fact'),
      ];
      const input: HistoryCompactWriteInput = {
        sessionId: 'session-1',
        turnId: 'turn-write',
        source: {
          draftBlock: historyCompactBlock(foldedEvents, 'deterministic fallback'),
          foldedRuntimeEvents: foldedEvents,
        },
        limits: {
          maxBlocks: 1,
          maxBlockEstimatedTokens: 1_024,
          maxEstimatedTokens: 1,
          charsPerToken: 4,
        },
      };

      const createdArtifacts: string[] = [];
      const write = await persistHistoryCompactBlocksToArtifacts(store, input, {
        now: () => 1_800_000_000_100,
        summarize: () => 'summary that cannot fit in one estimated token',
        onArtifactCreated: (artifact) => {
          createdArtifacts.push(artifact.id);
        },
      });

      assert.equal(write.blocks.length, 0);
      assert.equal(write.skipped, 1);
      assert.deepEqual(write.skippedReasonCounts, { max_total_tokens: 1 });
      assert.deepEqual(createdArtifacts, []);
      assert.deepEqual(await store.list('session-1'), []);
    });
  });

  test('rejects deleted, wrong-source, wrong-session, malformed, wrong-version, and oversized blocks', async () => {
    await withStore(async (store) => {
      await store.create({
        id: 'valid',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'valid.json',
        kind: 'file',
        content: JSON.stringify(historyCompactBlock([textEvent('old-1', 'turn-1', 'alpha')], 'valid')),
        mimeType: 'application/json',
        source: 'history_compact_block',
        now: 100,
      });
      await store.create({
        id: 'wrong-source',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'wrong-source.json',
        kind: 'file',
        content: JSON.stringify(historyCompactBlock([textEvent('old-2', 'turn-2', 'beta')], 'wrong-source')),
        mimeType: 'application/json',
        source: 'tool_result_archive',
        now: 110,
      });
      await store.create({
        id: 'wrong-session',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'wrong-session.json',
        kind: 'file',
        content: JSON.stringify({
          ...historyCompactBlock([textEvent('old-3', 'turn-3', 'gamma')], 'wrong-session'),
          sessionId: 'session-other',
        }),
        mimeType: 'application/json',
        source: 'history_compact_block',
        now: 120,
      });
      await store.create({
        id: 'invalid-json',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'invalid-json.json',
        kind: 'file',
        content: '{not-json',
        mimeType: 'application/json',
        source: 'history_compact_block',
        now: 130,
      });
      await store.create({
        id: 'wrong-version',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'wrong-version.json',
        kind: 'file',
        content: JSON.stringify({ ...historyCompactBlock([textEvent('old-4', 'turn-4', 'delta')], 'wrong-version'), version: 2 }),
        mimeType: 'application/json',
        source: 'history_compact_block',
        now: 140,
      });
      await store.create({
        id: 'bad-estimate',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'bad-estimate.json',
        kind: 'file',
        content: JSON.stringify({
          ...historyCompactBlock([textEvent('old-7', 'turn-7', 'eta')], 'bad-estimate'),
          estimatedTokens: 'tiny',
        }),
        mimeType: 'application/json',
        source: 'history_compact_block',
        now: 145,
      });
      await store.create({
        id: 'oversized',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'oversized.json',
        kind: 'file',
        content: JSON.stringify({
          ...historyCompactBlock([textEvent('old-5', 'turn-5', 'epsilon')], 'oversized'),
          estimatedTokens: 9_999,
        }),
        mimeType: 'application/json',
        source: 'history_compact_block',
        now: 150,
      });
      await store.create({
        id: 'deleted',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'deleted.json',
        kind: 'file',
        content: JSON.stringify(historyCompactBlock([textEvent('old-6', 'turn-6', 'zeta')], 'deleted')),
        mimeType: 'application/json',
        source: 'history_compact_block',
        now: 160,
      });
      await store.delete('deleted');

      const loaded = await loadHistoryCompactBlocksFromArtifacts(store, {
        sessionId: 'session-1',
        maxBlocks: 10,
        maxEstimatedTokens: 1_000,
        maxBytes: 20_000,
      });

      assert.deepEqual(loaded.blocks.map((block) => block.summary), ['valid']);
      assert.equal(loaded.skippedReasonCounts?.deleted, 1);
      assert.equal(loaded.skippedReasonCounts?.session_mismatch, 1);
      assert.equal(loaded.skippedReasonCounts?.invalid_json, 1);
      assert.equal(loaded.skippedReasonCounts?.invalid_schema_version, 2);
      assert.equal(loaded.skippedReasonCounts?.max_total_tokens, 1);
    });
  });
});

async function withStore(fn: (store: ArtifactStore) => Promise<void>): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-history-compact-artifacts-'));
  try {
    await fn(createArtifactStore(workspaceRoot));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
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

function historyCompactBlock(
  events: RuntimeEvent[],
  summary: string,
  overrides: Partial<HistoryCompactBlock> = {},
): HistoryCompactBlock {
  return {
    ...buildHistoryCompactBlockFromSummary({
      sessionId: 'session-1',
      foldedRuntimeEvents: events,
      summary,
      highWaterName: 'test-history-compact',
      highWaterSeq: 1,
      now: 1_800_000_000_000,
      charsPerToken: 4,
    }),
    ...overrides,
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
