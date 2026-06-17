import { generalizedErrorMessage } from '@maka/core/redaction';
import type {
  CacheMissInputSource,
  ContextBudgetDiagnostic,
  PrefixChangeReason,
  PromptSegmentEstimate,
  ToolSchemaChangeReason,
  ToolSourceEconomyDiagnostic,
} from '@maka/core/usage-stats/types';

export type RunTracePhase = 'turn' | 'model' | 'tool' | 'permission' | 'abort' | 'usage';

export type RunTraceEventType =
  | 'turn_started'
  | 'model_resolved'
  | 'model_resolve_failed'
  | 'model_stream_started'
  | 'model_stream_completed'
  | 'model_stream_failed'
  | 'tool_started'
  | 'tool_completed'
  | 'tool_failed'
  | 'permission_requested'
  | 'permission_decided'
  | 'permission_failed'
  | 'abort_requested'
  | 'usage_recorded';

export interface RunTraceEvent {
  id: string;
  sessionId: string;
  turnId: string;
  ts: number;
  phase: RunTracePhase;
  type: RunTraceEventType;
  message: string;
  data?: Record<string, unknown>;
}

export type RunTraceRecorder = (event: RunTraceEvent) => void;

export interface RunTraceInput {
  sessionId: string;
  turnId: string;
  connectionSlug: string;
  providerId: string;
  modelId: string;
  newId: () => string;
  now: () => number;
  record?: RunTraceRecorder;
}

export class RunTrace {
  constructor(private readonly input: RunTraceInput) {}

  emit(
    phase: RunTracePhase,
    type: RunTraceEventType,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    const event: RunTraceEvent = {
      id: this.input.newId(),
      sessionId: this.input.sessionId,
      turnId: this.input.turnId,
      ts: this.input.now(),
      phase,
      type,
      message,
      ...(data ? { data: sanitizeTraceData(data) } : {}),
    };
    try {
      this.input.record?.(event);
    } catch {
      // Tracing is diagnostic-only and must not perturb model/tool execution.
    }
  }

  turnStarted(): void {
    this.emit('turn', 'turn_started', 'Turn started', {
      connectionSlug: this.input.connectionSlug,
      providerId: this.input.providerId,
      modelId: this.input.modelId,
    });
  }

  modelResolved(): void {
    this.emit('model', 'model_resolved', 'Model resolved', {
      connectionSlug: this.input.connectionSlug,
      providerId: this.input.providerId,
      modelId: this.input.modelId,
    });
  }

  modelResolveFailed(error: unknown): void {
    this.emit('model', 'model_resolve_failed', 'Model resolution failed', {
      error: explainError(error),
    });
  }

  modelStreamStarted(
    activeTools: readonly string[],
    prefix?: {
      prefixHash: string;
      prefixChangeReason: PrefixChangeReason;
      requestShapeHash?: string;
      requestShapeChangeReason?: PrefixChangeReason;
      toolSchemaChangeReason?: ToolSchemaChangeReason;
      toolSourceEconomy?: ToolSourceEconomyDiagnostic;
      promptSegments?: PromptSegmentEstimate[];
      contextBudget?: ContextBudgetDiagnostic;
    },
  ): void {
    this.emit('model', 'model_stream_started', 'Model stream started', {
      activeTools: [...activeTools],
      ...(prefix !== undefined ? prefix : {}),
    });
  }

  modelStreamCompleted(stopReason: string): void {
    this.emit('model', 'model_stream_completed', 'Model stream completed', {
      stopReason,
    });
  }

  modelStreamFailed(errorClass: string | undefined, error: unknown): void {
    this.emit('model', 'model_stream_failed', 'Model stream failed', {
      ...(errorClass ? { errorClass } : {}),
      error: explainError(error),
    });
  }

  usageRecorded(usage: {
    inputTokens: number;
    outputTokens: number;
    cacheHitInputTokens: number;
    cacheMissInputTokens: number;
    cacheMissInputSource?: CacheMissInputSource;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    rawFinishReason?: string;
    prefixHash?: string;
    prefixChangeReason?: PrefixChangeReason;
    requestShapeHash?: string;
    requestShapeChangeReason?: PrefixChangeReason;
    toolSchemaChangeReason?: ToolSchemaChangeReason;
    toolSourceEconomy?: ToolSourceEconomyDiagnostic;
  }): void {
    this.emit('usage', 'usage_recorded', 'Token usage recorded', {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheHitInputTokens: usage.cacheHitInputTokens,
      cacheMissInputTokens: usage.cacheMissInputTokens,
      ...(usage.cacheMissInputSource !== undefined ? { cacheMissInputSource: usage.cacheMissInputSource } : {}),
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteInputTokens: usage.cacheWriteInputTokens,
      reasoningTokens: usage.reasoningTokens,
      totalTokens: usage.totalTokens,
      ...(usage.rawFinishReason !== undefined ? { rawFinishReason: usage.rawFinishReason } : {}),
      ...(usage.prefixHash !== undefined ? { prefixHash: usage.prefixHash } : {}),
      ...(usage.prefixChangeReason !== undefined ? { prefixChangeReason: usage.prefixChangeReason } : {}),
      ...(usage.requestShapeHash !== undefined ? { requestShapeHash: usage.requestShapeHash } : {}),
      ...(usage.requestShapeChangeReason !== undefined
        ? { requestShapeChangeReason: usage.requestShapeChangeReason }
        : {}),
      ...(usage.toolSchemaChangeReason !== undefined ? { toolSchemaChangeReason: usage.toolSchemaChangeReason } : {}),
      ...(usage.toolSourceEconomy !== undefined ? { toolSourceEconomy: usage.toolSourceEconomy } : {}),
    });
  }

  abortRequested(reason: string): void {
    this.emit('abort', 'abort_requested', 'Abort requested', { reason });
  }
}

export interface RunTraceLike {
  emit(
    phase: RunTracePhase,
    type: RunTraceEventType,
    message: string,
    data?: Record<string, unknown>,
  ): void;
}

export function explainError(error: unknown): string {
  return generalizedErrorMessage(error);
}

function sanitizeTraceData(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  );
}
