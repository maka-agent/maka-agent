import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import type { ArtifactRecord, ArtifactSource } from '@maka/core';
import {
  buildHistoryCompactBlockFromSummary,
  estimateTokens,
  validateHistoryCompactBlockShape,
  type HistoryCompactBlock,
  type HistoryCompactSourceArchiveRef,
} from './context-budget.js';
import type {
  HistoryCompactLoadInput,
  HistoryCompactLoadResult,
  HistoryCompactWriteInput,
  HistoryCompactWriteResult,
} from './ai-sdk-backend.js';


export interface HistoryCompactArtifactStore {
  create(input: {
    id?: string;
    sessionId: string;
    turnId: string;
    name: string;
    kind: 'file';
    content: string;
    mimeType?: string;
    source: ArtifactSource;
    summary?: string;
    now?: number;
  }): Promise<ArtifactRecord>;
  delete(artifactId: string): Promise<void>;
  list(sessionId: string, options?: { includeDeleted?: boolean }): Promise<ArtifactRecord[]>;
  readText(artifactId: string, options?: { maxBytes?: number }): Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
}

export interface PersistHistoryCompactBlocksDeps {
  now?: () => number;
  summarize?: (input: HistoryCompactWriteInput) => Promise<string | undefined> | string | undefined;
  onArtifactCreated?: (artifact: ArtifactRecord) => void | Promise<void>;
}

export async function persistHistoryCompactBlocksToArtifacts(
  artifactStore: Pick<HistoryCompactArtifactStore, 'create' | 'delete'>,
  input: HistoryCompactWriteInput,
  deps: PersistHistoryCompactBlocksDeps = {},
): Promise<HistoryCompactWriteResult> {
  throwIfHistoryCompactAborted(input.abortSignal);
  const now = deps.now?.() ?? Date.now();
  const sourceArchives = input.source.foldedRuntimeEvents.map((event) => {
    const serializedBody = serializeHistoryCompactSourceBody(event.content ?? {});
    const bodySha256 = sha256(serializedBody);
    const artifactId = randomUUID();
    const ref: HistoryCompactSourceArchiveRef = {
      runtimeEventId: event.id,
      artifactId,
      bodySha256,
      originalEstimatedTokens: estimateTokens(serializedBody.length, input.limits.charsPerToken),
      originalBytes: Buffer.byteLength(serializedBody, 'utf8'),
    };
    return { event, ref };
  });
  const sourceArchiveRefs = sourceArchives.map((archive) => archive.ref);
  const createdArtifacts: ArtifactRecord[] = [];

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
  try {
    for (const { event, ref } of sourceArchives) {
      throwIfHistoryCompactAborted(input.abortSignal);
      const artifact = await artifactStore.create({
        id: ref.artifactId,
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
      createdArtifacts.push(artifact);
      throwIfHistoryCompactAborted(input.abortSignal);
      await deps.onArtifactCreated?.(artifact);
      throwIfHistoryCompactAborted(input.abortSignal);
    }
    throwIfHistoryCompactAborted(input.abortSignal);
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
    createdArtifacts.push(artifact);
    throwIfHistoryCompactAborted(input.abortSignal);
    await deps.onArtifactCreated?.(artifact);
    throwIfHistoryCompactAborted(input.abortSignal);
    return { blocks: [block] };
  } catch (error) {
    await deleteCreatedArtifacts(artifactStore, createdArtifacts);
    throw error;
  }
}

export async function loadHistoryCompactBlocksFromArtifacts(
  artifactStore: Pick<HistoryCompactArtifactStore, 'list' | 'readText'>,
  input: HistoryCompactLoadInput,
): Promise<HistoryCompactLoadResult> {
  const maxBlocks = input.maxBlocks ?? 1;
  const maxEstimatedTokens = input.maxEstimatedTokens ?? 2_048;
  const maxBytes = input.maxBytes ?? maxEstimatedTokens * 4;
  const skippedReasonCounts: Record<string, number> = {};
  const blocks: HistoryCompactBlock[] = [];
  const records = await artifactStore.list(input.sessionId, { includeDeleted: true });
  for (const record of records) {
    if (record.source !== 'history_compact_block' || record.kind !== 'file') {
      continue;
    }
    if (record.status !== 'live') {
      incrementHistoryCompactCount(skippedReasonCounts, 'deleted');
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
    const block = parsed as HistoryCompactBlock;
    const estimatedTokens = block.estimatedTokens ?? estimateTokens(read.text.length, 4);
    if (estimatedTokens > maxEstimatedTokens) {
      incrementHistoryCompactCount(skippedReasonCounts, 'max_total_tokens');
      continue;
    }
    blocks.push({ ...block, estimatedTokens });
  }
  const skipped = Object.values(skippedReasonCounts).reduce((total, count) => total + count, 0);
  return {
    blocks,
    ...(skipped > 0 ? { skipped } : {}),
    ...(skipped > 0 ? { skippedReasonCounts } : {}),
  };
}

async function deleteCreatedArtifacts(
  artifactStore: Pick<HistoryCompactArtifactStore, 'delete'>,
  artifacts: readonly ArtifactRecord[],
): Promise<void> {
  for (const artifact of [...artifacts].reverse()) {
    await artifactStore.delete(artifact.id).catch(() => {});
  }
}

function throwIfHistoryCompactAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('history compact write aborted');
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
