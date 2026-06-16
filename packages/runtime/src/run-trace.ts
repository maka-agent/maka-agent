import { generalizedErrorMessage } from '@maka/core/redaction';

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

  modelStreamStarted(activeTools: readonly string[]): void {
    this.emit('model', 'model_stream_started', 'Model stream started', {
      activeTools: [...activeTools],
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
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    rawFinishReason?: string;
  }): void {
    this.emit('usage', 'usage_recorded', 'Token usage recorded', {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheHitInputTokens: usage.cacheHitInputTokens,
      cacheMissInputTokens: usage.cacheMissInputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteInputTokens: usage.cacheWriteInputTokens,
      reasoningTokens: usage.reasoningTokens,
      totalTokens: usage.totalTokens,
      ...(usage.rawFinishReason !== undefined ? { rawFinishReason: usage.rawFinishReason } : {}),
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
