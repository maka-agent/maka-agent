import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { stableStringify } from './request-shape.js';

export interface HistoryCompactCheckpointCoverage {
  eventCount: number;
  turnCount: number;
  through: {
    runId: string;
    turnId: string;
    runtimeEventId: string;
  };
  sourceDigest: string;
}

export interface HistoryCompactCheckpoint {
  kind: 'maka.history_compact_checkpoint';
  version: 2;
  checkpointId: string;
  sessionId: string;
  createdAt: number;
  highWaterName: string;
  highWaterSeq: number;
  coverage: HistoryCompactCheckpointCoverage;
  summary: string;
  limitations: string[];
  estimatedTokens: number;
  previousCheckpointId?: string;
  requestShapeHashBefore?: string;
  requestShapeHashAfter?: string;
}

export interface BuildHistoryCompactCheckpointInput {
  sessionId: string;
  coveredRuntimeEvents: readonly RuntimeEvent[];
  summary: string;
  highWaterName?: string;
  highWaterSeq?: number;
  maxSummaryEstimatedTokens?: number;
  previousCheckpointId?: string;
  requestShapeHashBefore?: string;
  requestShapeHashAfter?: string;
  now?: number;
  charsPerToken?: number;
}

export type HistoryCompactCheckpointPrefixMatch =
  | { coveredEventCount: number; coveredRuntimeEvents: RuntimeEvent[]; reason?: undefined }
  | { coveredEventCount: 0; coveredRuntimeEvents: []; reason: 'invalid_checkpoint' | 'coverage_miss' | 'source_hash_mismatch' };

export function buildHistoryCompactCheckpoint(
  input: BuildHistoryCompactCheckpointInput,
): HistoryCompactCheckpoint {
  if (input.coveredRuntimeEvents.length === 0) {
    throw new Error('History compact checkpoint requires covered RuntimeEvents');
  }
  const summary = input.summary.trim();
  if (summary.length === 0) {
    throw new Error('History compact checkpoint requires a non-empty summary');
  }
  const charsPerToken = input.charsPerToken ?? 4;
  const maxSummaryChars = Math.max(80, (input.maxSummaryEstimatedTokens ?? 1_024) * Math.max(1, charsPerToken));
  const boundedSummary = summary.length <= maxSummaryChars
    ? summary
    : `${summary.slice(0, Math.max(0, maxSummaryChars - 1)).trimEnd()}…`;
  const lastEvent = input.coveredRuntimeEvents.at(-1)!;
  const createdAt = input.coveredRuntimeEvents.reduce(
    (latest, event) => Math.max(latest, event.ts),
    input.now ?? 1,
  );
  const coverage: HistoryCompactCheckpointCoverage = {
    eventCount: input.coveredRuntimeEvents.length,
    turnCount: new Set(input.coveredRuntimeEvents.map((event) => event.turnId)).size,
    through: {
      runId: lastEvent.runId,
      turnId: lastEvent.turnId,
      runtimeEventId: lastEvent.id,
    },
    sourceDigest: historyCompactSourceDigest(input.coveredRuntimeEvents),
  };
  const highWaterName = input.highWaterName ?? 'history-compact-high-water';
  const highWaterSeq = input.highWaterSeq ?? createdAt;
  const checkpointId = `hcheckpoint-${sha256(stableStringify({
    version: 2,
    sessionId: input.sessionId,
    highWaterName,
    highWaterSeq,
    coverage,
    summary: boundedSummary,
    previousCheckpointId: input.previousCheckpointId,
  })).slice(0, 32)}`;
  const checkpoint: HistoryCompactCheckpoint = {
    kind: 'maka.history_compact_checkpoint',
    version: 2,
    checkpointId,
    sessionId: input.sessionId,
    createdAt,
    highWaterName,
    highWaterSeq,
    coverage,
    summary: boundedSummary,
    limitations: [
      'Replay-time summary of the covered RuntimeEvent prefix.',
      'RuntimeEvent ledger remains the source of truth when exact wording matters.',
    ],
    estimatedTokens: 0,
    ...(input.previousCheckpointId ? { previousCheckpointId: input.previousCheckpointId } : {}),
    ...(input.requestShapeHashBefore ? { requestShapeHashBefore: input.requestShapeHashBefore } : {}),
    ...(input.requestShapeHashAfter ? { requestShapeHashAfter: input.requestShapeHashAfter } : {}),
  };
  checkpoint.estimatedTokens = estimateTokens(renderHistoryCompactCheckpoint(checkpoint).length, charsPerToken);
  return checkpoint;
}

export function renderHistoryCompactCheckpoint(checkpoint: HistoryCompactCheckpoint): string {
  return [
    `<maka_history_compact_checkpoint id="${escapeAttribute(checkpoint.checkpointId)}" high_water="${escapeAttribute(checkpoint.highWaterName)}" seq="${checkpoint.highWaterSeq}" version="${checkpoint.version}">`,
    `summary: ${checkpoint.summary}`,
    `coverage: ${checkpoint.coverage.eventCount} runtime events across ${checkpoint.coverage.turnCount} turns`,
    `limitations: ${checkpoint.limitations.join('; ')}`,
    '</maka_history_compact_checkpoint>',
  ].join('\n');
}

export function historyCompactCheckpointToRuntimeEvent(checkpoint: HistoryCompactCheckpoint): RuntimeEvent {
  return {
    id: `history-compact:${checkpoint.checkpointId}`,
    sessionId: checkpoint.sessionId,
    runId: `history-compact:${checkpoint.checkpointId}`,
    turnId: `history-compact:${checkpoint.highWaterSeq}`,
    invocationId: `history-compact:${checkpoint.checkpointId}`,
    ts: checkpoint.createdAt,
    partial: false,
    role: 'user',
    author: 'system',
    content: { kind: 'text', text: renderHistoryCompactCheckpoint(checkpoint) },
  };
}

export function validateHistoryCompactCheckpointShape(
  value: unknown,
  sessionId?: string,
): value is HistoryCompactCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const checkpoint = value as Partial<HistoryCompactCheckpoint>;
  const coverage = checkpoint.coverage as Partial<HistoryCompactCheckpointCoverage> | undefined;
  const through = coverage?.through as Partial<HistoryCompactCheckpointCoverage['through']> | undefined;
  return checkpoint.kind === 'maka.history_compact_checkpoint'
    && checkpoint.version === 2
    && nonEmpty(checkpoint.checkpointId)
    && nonEmpty(checkpoint.sessionId)
    && (sessionId === undefined || checkpoint.sessionId === sessionId)
    && Number.isFinite(checkpoint.createdAt)
    && nonEmpty(checkpoint.highWaterName)
    && Number.isFinite(checkpoint.highWaterSeq)
    && Number.isInteger(coverage?.eventCount)
    && (coverage?.eventCount ?? 0) > 0
    && Number.isInteger(coverage?.turnCount)
    && (coverage?.turnCount ?? 0) > 0
    && nonEmpty(through?.runId)
    && nonEmpty(through?.turnId)
    && nonEmpty(through?.runtimeEventId)
    && nonEmpty(coverage?.sourceDigest)
    && typeof checkpoint.summary === 'string'
    && checkpoint.summary.trim().length > 0
    && Array.isArray(checkpoint.limitations)
    && checkpoint.limitations.every(nonEmpty)
    && Number.isFinite(checkpoint.estimatedTokens)
    && (checkpoint.estimatedTokens ?? -1) >= 0
    && (checkpoint.previousCheckpointId === undefined || nonEmpty(checkpoint.previousCheckpointId));
}

export function selectFurthestHistoryCompactCheckpoint(
  current: HistoryCompactCheckpoint | undefined,
  candidate: HistoryCompactCheckpoint,
): HistoryCompactCheckpoint {
  if (!current) return candidate;
  if (canReplaceHistoryCompactCheckpoint(current, candidate)) return candidate;
  return current;
}

/** Accept forward progress, or a compare-and-swap rewrite of the exact same source coverage. */
export function canReplaceHistoryCompactCheckpoint(
  current: HistoryCompactCheckpoint | undefined,
  candidate: HistoryCompactCheckpoint,
): boolean {
  if (!current || candidate.coverage.eventCount > current.coverage.eventCount) return true;
  if (
    candidate.coverage.eventCount !== current.coverage.eventCount
    || candidate.previousCheckpointId !== current.checkpointId
  ) {
    return false;
  }
  return candidate.coverage.turnCount === current.coverage.turnCount
    && candidate.coverage.sourceDigest === current.coverage.sourceDigest
    && candidate.coverage.through.runId === current.coverage.through.runId
    && candidate.coverage.through.turnId === current.coverage.through.turnId
    && candidate.coverage.through.runtimeEventId === current.coverage.through.runtimeEventId;
}

export function matchHistoryCompactCheckpointPrefix(
  checkpoint: HistoryCompactCheckpoint,
  events: readonly RuntimeEvent[],
): HistoryCompactCheckpointPrefixMatch {
  if (!validateHistoryCompactCheckpointShape(checkpoint)) {
    return { coveredEventCount: 0, coveredRuntimeEvents: [], reason: 'invalid_checkpoint' };
  }
  const coveredRuntimeEvents = events.slice(0, checkpoint.coverage.eventCount);
  const lastEvent = coveredRuntimeEvents.at(-1);
  if (
    coveredRuntimeEvents.length !== checkpoint.coverage.eventCount
    || !lastEvent
    || lastEvent.runId !== checkpoint.coverage.through.runId
    || lastEvent.turnId !== checkpoint.coverage.through.turnId
    || lastEvent.id !== checkpoint.coverage.through.runtimeEventId
  ) {
    return { coveredEventCount: 0, coveredRuntimeEvents: [], reason: 'coverage_miss' };
  }
  if (historyCompactSourceDigest(coveredRuntimeEvents) !== checkpoint.coverage.sourceDigest) {
    return { coveredEventCount: 0, coveredRuntimeEvents: [], reason: 'source_hash_mismatch' };
  }
  return { coveredEventCount: coveredRuntimeEvents.length, coveredRuntimeEvents };
}

function historyCompactSourceDigest(events: readonly RuntimeEvent[]): string {
  const hash = createHash('sha256');
  for (const event of events) {
    const serialized = stableStringify(event);
    hash.update(String(Buffer.byteLength(serialized, 'utf8')));
    hash.update(':');
    hash.update(serialized);
    hash.update(';');
  }
  return `sha256:${hash.digest('hex')}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function estimateTokens(charCount: number, charsPerToken: number): number {
  if (charCount <= 0) return 0;
  return Math.max(1, Math.ceil(charCount / Math.max(1, charsPerToken)));
}
