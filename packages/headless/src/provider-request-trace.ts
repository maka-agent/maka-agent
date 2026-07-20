import { readFile } from 'node:fs/promises';
import { decodeAgentRunEvent } from '@maka/core';
import {
  findFirstChangedCacheableSegment,
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
  requestBytes: number;
  segments: PreparedRequestSegment[];
  firstChangedCacheableSegment?: PreparedRequestSegmentRef;
}

export interface ProviderRequestTraceAnalysis {
  traceId?: string;
  captures: ProviderRequestTraceCaptureAnalysis[];
}

/** Read Harbor's existing AgentRun events.jsonl; no provider-proxy sidecar is required. */
export async function readProviderRequestTrace(
  traceEventsPath: string,
): Promise<ProviderRequestTraceAnalysis> {
  const text = await readFile(traceEventsPath, 'utf8');
  const captures: ProviderRequestTraceCaptureAnalysis[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event: ReturnType<typeof decodeAgentRunEvent>;
    try {
      event = decodeAgentRunEvent(JSON.parse(line));
    } catch {
      continue;
    }
    if (event.type !== 'provider_request_captured') continue;
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
  }
  return {
    ...(captures[0] ? { traceId: captures[0].traceId } : {}),
    captures,
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
