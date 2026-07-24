import { readFile } from 'node:fs/promises';
import { decodeAgentRunEvent } from '@maka/core';
import {
  findFirstChangedCacheableSegment,
  type ProviderRequestAttemptRecord,
  type PreparedRequestSegment,
  type PreparedRequestSegmentRef,
} from '@maka/runtime';

export interface ProviderRequestTraceCaptureAnalysis {
  traceId: string;
  captureId: string;
  artifactId: string;
  turnId: string;
  step: number;
  providerId: string;
  modelId: string;
  requestHash: string;
  requestPayloadWithoutProviderOptionsHash: string;
  requestBytes: number;
  segments: PreparedRequestSegment[];
  firstChangedCacheableSegment?: PreparedRequestSegmentRef;
}

export interface ProviderRequestTraceAnalysis {
  traceId?: string;
  captures: ProviderRequestTraceCaptureAnalysis[];
  attempts: ProviderRequestTraceAttemptAnalysis[];
}

export type ProviderRequestTraceAttemptAnalysis = Omit<ProviderRequestAttemptRecord, 'segments'>;

/** Read Harbor's existing AgentRun events.jsonl; no provider-proxy sidecar is required. */
export async function readProviderRequestTrace(
  traceEventsPath: string,
): Promise<ProviderRequestTraceAnalysis> {
  const text = await readFile(traceEventsPath, 'utf8');
  const captures: ProviderRequestTraceCaptureAnalysis[] = [];
  const attempts: ProviderRequestTraceAttemptAnalysis[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event: ReturnType<typeof decodeAgentRunEvent>;
    try {
      event = decodeAgentRunEvent(JSON.parse(line));
    } catch {
      continue;
    }
    if (event.type === 'provider_request_captured') {
      const capture = captureFromEvent(event.turnId, event.data);
      if (!capture) continue;
      const prior = captures.at(-1);
      captures.push({
        ...capture,
        ...(prior
          ? {
              firstChangedCacheableSegment: findFirstChangedCacheableSegment(capture, prior),
            }
          : {}),
      });
    } else if (event.type === 'provider_request_attempt_recorded') {
      const attempt = attemptFromEvent(event.turnId, event.data);
      if (attempt) attempts.push(attempt);
    }
  }
  return {
    ...(captures[0]?.traceId || attempts[0]?.traceId
      ? { traceId: captures[0]?.traceId ?? attempts[0]?.traceId }
      : {}),
    captures,
    attempts,
  };
}

function attemptFromEvent(
  turnId: string,
  data: Record<string, unknown> | undefined,
): ProviderRequestTraceAttemptAnalysis | undefined {
  if (!data) return undefined;
  const requiredStrings = [
    'traceId',
    'attemptId',
    'captureId',
    'captureArtifactId',
    'providerId',
    'modelId',
    'requestHash',
  ] as const;
  if (
    requiredStrings.some((key) => typeof data[key] !== 'string') ||
    !isNonNegativeInteger(data.step) ||
    !isPositiveInteger(data.attempt) ||
    !isNonNegativeInteger(data.requestBytes) ||
    !isNonNegativeInteger(data.startedAt) ||
    !isNonNegativeInteger(data.completedAt) ||
    !['completed', 'failed', 'interrupted', 'aborted'].includes(String(data.status)) ||
    !isNonNegativeInteger(data.latencyMs) ||
    (data.finishReason !== undefined && typeof data.finishReason !== 'string') ||
    (data.timeToFirstTokenMs !== undefined && !isNonNegativeInteger(data.timeToFirstTokenMs))
  ) {
    return undefined;
  }
  const optionalTokens = [
    'inputTokens',
    'cacheReadInputTokens',
    'cacheMissInputTokens',
    'cacheWriteInputTokens',
    'outputTokens',
    'reasoningTokens',
  ] as const;
  if (
    optionalTokens.some((key) => data[key] !== undefined && !isNonNegativeInteger(data[key])) ||
    !validSource(data.cacheReadInputSource) ||
    !validSource(data.cacheMissInputSource) ||
    !validSource(data.cacheWriteInputSource)
  ) {
    return undefined;
  }
  const { segments: _segments, turnId: _dataTurnId, ...attempt } = data;
  return {
    ...(attempt as unknown as ProviderRequestTraceAttemptAnalysis),
    turnId,
  };
}

function captureFromEvent(
  turnId: string,
  data: Record<string, unknown> | undefined,
): ProviderRequestTraceCaptureAnalysis | undefined {
  if (!data) return undefined;
  const segments = Array.isArray(data.segments)
    ? data.segments.map(segmentFromValue).filter((value) => value !== undefined)
    : [];
  if (
    typeof data.traceId !== 'string' ||
    typeof data.captureId !== 'string' ||
    typeof data.artifactId !== 'string' ||
    !isNonNegativeInteger(data.step) ||
    typeof data.providerId !== 'string' ||
    typeof data.modelId !== 'string' ||
    typeof data.requestHash !== 'string' ||
    typeof data.requestPayloadWithoutProviderOptionsHash !== 'string' ||
    !isNonNegativeInteger(data.requestBytes) ||
    segments.length !== (Array.isArray(data.segments) ? data.segments.length : 0)
  ) {
    return undefined;
  }
  return {
    traceId: data.traceId,
    captureId: data.captureId,
    artifactId: data.artifactId,
    turnId,
    step: data.step,
    providerId: data.providerId,
    modelId: data.modelId,
    requestHash: data.requestHash,
    requestPayloadWithoutProviderOptionsHash: data.requestPayloadWithoutProviderOptionsHash,
    requestBytes: data.requestBytes,
    segments,
  };
}

function segmentFromValue(value: unknown): PreparedRequestSegment | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const segment = value as Record<string, unknown>;
  if (
    !['tool_schema', 'system_prompt', 'message', 'provider_options'].includes(
      String(segment.kind),
    ) ||
    !isNonNegativeInteger(segment.index) ||
    typeof segment.cacheable !== 'boolean' ||
    typeof segment.hash !== 'string' ||
    !isNonNegativeInteger(segment.bytes) ||
    (segment.role !== undefined && typeof segment.role !== 'string')
  ) {
    return undefined;
  }
  return segment as unknown as PreparedRequestSegment;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function validSource(value: unknown): boolean {
  return value === undefined || value === 'provider' || value === 'derived';
}
