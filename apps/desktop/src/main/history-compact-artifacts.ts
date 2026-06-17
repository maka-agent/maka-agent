import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { ArtifactRecord } from '@maka/core';
import {
  buildHistoryCompactBlockFromSummary,
  estimateTokens,
  validateHistoryCompactBlockShape,
  type HistoryCompactBlock,
  type HistoryCompactLoadInput,
  type HistoryCompactLoadResult,
  type HistoryCompactSourceArchiveRef,
  type HistoryCompactWriteInput,
  type HistoryCompactWriteResult,
} from '@maka/runtime';
import type { ArtifactStore } from '@maka/storage';

export interface PersistHistoryCompactBlocksDeps {
  now?: () => number;
  summarize?: (input: HistoryCompactWriteInput) => Promise<string | undefined> | string | undefined;
  onArtifactCreated?: (artifact: ArtifactRecord) => void | Promise<void>;
}

export async function persistHistoryCompactBlocksToArtifacts(
  artifactStore: Pick<ArtifactStore, 'create'>,
  input: HistoryCompactWriteInput,
  deps: PersistHistoryCompactBlocksDeps = {},
): Promise<HistoryCompactWriteResult> {
  const now = deps.now?.() ?? Date.now();
  const sourceArchiveRefs: HistoryCompactSourceArchiveRef[] = [];
  for (const event of input.source.foldedRuntimeEvents) {
    const serializedBody = serializeHistoryCompactSourceBody(event.content ?? {});
    const bodySha256 = sha256(serializedBody);
    const artifact = await artifactStore.create({
      sessionId: input.sessionId,
      turnId: event.turnId,
      name: `history-compact-source-${event.id}.json`,
      kind: 'file',
      content: JSON.stringify(event, null, 2),
      mimeType: 'application/json',
      source: 'history_compact_source',
      summary: 'Archived RuntimeEvent source for history compact replay',
      now,
    });
    await deps.onArtifactCreated?.(artifact);
    sourceArchiveRefs.push({
      runtimeEventId: event.id,
      artifactId: artifact.id,
      bodySha256,
      originalEstimatedTokens: estimateTokens(serializedBody.length, input.limits.charsPerToken),
      originalBytes: Buffer.byteLength(serializedBody, 'utf8'),
    });
  }

  const hostSummary = await Promise.resolve(deps.summarize?.(input));
  const block = buildHistoryCompactBlockFromSummary({
    sessionId: input.sessionId,
    foldedRuntimeEvents: input.source.foldedRuntimeEvents,
    summary: hostSummary ?? input.source.draftBlock.summary,
    highWaterName: input.source.draftBlock.highWaterName,
    highWaterSeq: input.source.draftBlock.highWaterSeq,
    maxSummaryEstimatedTokens: input.limits.maxBlockEstimatedTokens,
    sourceArchiveRefs,
    requestShapeHashBefore: input.requestShapeHashBefore,
    requestShapeHashAfter: input.requestShapeHashAfter,
    now,
    charsPerToken: input.limits.charsPerToken,
  });
  if ((block.estimatedTokens ?? 0) > input.limits.maxBlockEstimatedTokens) {
    return { blocks: [], skipped: 1, skippedReasonCounts: { max_block_tokens: 1 } };
  }
  if ((block.estimatedTokens ?? 0) > input.limits.maxEstimatedTokens) {
    return { blocks: [], skipped: 1, skippedReasonCounts: { max_total_tokens: 1 } };
  }
  const artifact = await artifactStore.create({
    sessionId: input.sessionId,
    turnId: input.turnId,
    name: `history-compact-${block.blockId}.json`,
    kind: 'file',
    content: JSON.stringify(block, null, 2),
    mimeType: 'application/json',
    source: 'history_compact_block',
    summary: 'History compact block for context budget replay',
    now,
  });
  await deps.onArtifactCreated?.(artifact);
  return { blocks: [block] };
}

export async function loadHistoryCompactBlocksFromArtifacts(
  artifactStore: Pick<ArtifactStore, 'list' | 'readText'>,
  input: HistoryCompactLoadInput,
): Promise<HistoryCompactLoadResult> {
  const maxBlocks = input.maxBlocks ?? 1;
  const maxEstimatedTokens = input.maxEstimatedTokens ?? 2_048;
  const maxBytes = input.maxBytes ?? maxEstimatedTokens * 4;
  const skippedReasonCounts: Record<string, number> = {};
  const blocks: HistoryCompactBlock[] = [];
  const records = await artifactStore.list(input.sessionId, { includeDeleted: true });
  for (const record of records) {
    if (record.status !== 'live') {
      incrementHistoryCompactCount(skippedReasonCounts, 'deleted');
      continue;
    }
    if (record.source !== 'history_compact_block' || record.kind !== 'file') {
      continue;
    }
    if (record.sessionId !== input.sessionId) {
      incrementHistoryCompactCount(skippedReasonCounts, 'session_mismatch');
      continue;
    }
    if (blocks.length >= maxBlocks) {
      incrementHistoryCompactCount(skippedReasonCounts, 'max_blocks');
      continue;
    }
    if (record.sizeBytes > maxBytes) {
      incrementHistoryCompactCount(skippedReasonCounts, 'max_bytes');
      continue;
    }
    const read = await artifactStore.readText(record.id, { maxBytes });
    if (!read.ok) {
      incrementHistoryCompactCount(skippedReasonCounts, read.reason);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.text) as unknown;
    } catch {
      incrementHistoryCompactCount(skippedReasonCounts, 'invalid_json');
      continue;
    }
    if (hasSessionId(parsed) && parsed.sessionId !== input.sessionId) {
      incrementHistoryCompactCount(skippedReasonCounts, 'session_mismatch');
      continue;
    }
    if (!validateHistoryCompactBlockShape(parsed, input.sessionId)) {
      incrementHistoryCompactCount(skippedReasonCounts, 'invalid_schema_version');
      continue;
    }
    const estimatedTokens = parsed.estimatedTokens ?? estimateTokens(read.text.length, 4);
    if (estimatedTokens > maxEstimatedTokens) {
      incrementHistoryCompactCount(skippedReasonCounts, 'max_total_tokens');
      continue;
    }
    blocks.push({ ...parsed, estimatedTokens });
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

function serializeHistoryCompactSourceBody(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function incrementHistoryCompactCount(counts: Record<string, number>, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}
