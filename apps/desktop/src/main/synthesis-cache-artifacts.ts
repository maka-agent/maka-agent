import type { ArtifactRecord } from '@maka/core';
import {
  buildSynthesisCacheBlocksFromHydratedArchives,
  estimateTokens,
  validateSynthesisCacheBlockShape,
  type SynthesisCacheBlock,
  type SynthesisCacheLoadInput,
  type SynthesisCacheLoadResult,
  type SynthesisCacheWriteInput,
  type SynthesisCacheWriteResult,
} from '@maka/runtime';
import type { ArtifactStore } from '@maka/storage';

export interface PersistSynthesisCacheBlocksDeps {
  now?: () => number;
  onArtifactCreated?: (artifact: ArtifactRecord) => void | Promise<void>;
}

export async function persistSynthesisCacheBlocksToArtifacts(
  artifactStore: Pick<ArtifactStore, 'create'>,
  input: SynthesisCacheWriteInput,
  deps: PersistSynthesisCacheBlocksDeps = {},
): Promise<SynthesisCacheWriteResult> {
  const now = deps.now?.() ?? Date.now();
  const built = buildSynthesisCacheBlocksFromHydratedArchives({
    sessionId: input.sessionId,
    query: input.source.query,
    hydratedRuntimeEvents: input.source.hydratedRuntimeEvents,
    retrievedArchiveRefs: input.source.retrievedArchiveRefs,
    archiveRetrievalMode: input.source.archiveRetrievalMode,
    limits: input.limits,
    ...(input.requestShapeHashBefore ? { requestShapeHashBefore: input.requestShapeHashBefore } : {}),
    ...(input.requestShapeHashAfter ? { requestShapeHashAfter: input.requestShapeHashAfter } : {}),
    now,
  });
  const persisted: SynthesisCacheBlock[] = [];
  for (const block of built.blocks) {
    const artifact = await artifactStore.create({
      sessionId: input.sessionId,
      turnId: input.turnId,
      name: `synthesis-cache-${block.blockId}.json`,
      kind: 'file',
      content: JSON.stringify(block, null, 2),
      mimeType: 'application/json',
      source: 'synthesis_cache_block',
      summary: 'Synthesis cache block for context budget replay',
      now,
    });
    await deps.onArtifactCreated?.(artifact);
    persisted.push(block);
  }
  return {
    blocks: persisted,
    ...(built.skipped > 0 ? { skipped: built.skipped } : {}),
    ...(built.skippedReasonCounts ? { skippedReasonCounts: built.skippedReasonCounts } : {}),
  };
}

export async function loadSynthesisCacheBlocksFromArtifacts(
  artifactStore: Pick<ArtifactStore, 'list' | 'readText'>,
  input: SynthesisCacheLoadInput,
): Promise<SynthesisCacheLoadResult> {
  const maxBlocks = input.maxBlocks ?? 1;
  const maxEstimatedTokens = input.maxEstimatedTokens ?? 2_048;
  const maxBytes = input.maxBytes ?? maxEstimatedTokens * 4;
  const skippedReasonCounts: Record<string, number> = {};
  const blocks: SynthesisCacheBlock[] = [];
  const records = await artifactStore.list(input.sessionId, { includeDeleted: true });
  for (const record of records) {
    if (record.status !== 'live') {
      incrementSynthesisCacheCount(skippedReasonCounts, 'deleted');
      continue;
    }
    if (record.source !== 'synthesis_cache_block' || record.kind !== 'file') {
      continue;
    }
    if (record.sessionId !== input.sessionId) {
      incrementSynthesisCacheCount(skippedReasonCounts, 'session_mismatch');
      continue;
    }
    if (blocks.length >= maxBlocks) {
      incrementSynthesisCacheCount(skippedReasonCounts, 'max_blocks');
      continue;
    }
    if (record.sizeBytes > maxBytes) {
      incrementSynthesisCacheCount(skippedReasonCounts, 'max_bytes');
      continue;
    }
    const read = await artifactStore.readText(record.id, { maxBytes });
    if (!read.ok) {
      incrementSynthesisCacheCount(skippedReasonCounts, read.reason);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.text) as unknown;
    } catch {
      incrementSynthesisCacheCount(skippedReasonCounts, 'invalid_json');
      continue;
    }
    if (hasSessionId(parsed) && parsed.sessionId !== input.sessionId) {
      incrementSynthesisCacheCount(skippedReasonCounts, 'session_mismatch');
      continue;
    }
    if (!validateSynthesisCacheBlockShape(parsed, input.sessionId)) {
      incrementSynthesisCacheCount(skippedReasonCounts, 'invalid_schema_version');
      continue;
    }
    const block = parsed as SynthesisCacheBlock;
    const estimatedTokens = block.estimatedTokens ?? estimateTokens(read.text.length, 4);
    if (estimatedTokens > maxEstimatedTokens) {
      incrementSynthesisCacheCount(skippedReasonCounts, 'max_total_tokens');
      continue;
    }
    blocks.push({
      ...block,
      estimatedTokens,
    });
  }
  const skipped = Object.values(skippedReasonCounts).reduce((total, count) => total + count, 0);
  return {
    blocks,
    ...(skipped > 0 ? { skipped } : {}),
    ...(skipped > 0 ? { skippedReasonCounts } : {}),
  };
}

function hasSessionId(value: unknown): value is { sessionId: string } {
  return !!value
    && typeof value === 'object'
    && 'sessionId' in value
    && typeof (value as { sessionId?: unknown }).sessionId === 'string';
}

function incrementSynthesisCacheCount(counts: Record<string, number>, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}
