import type { ModelMessage, NormalizedUsage, ToolCallPart } from './model-protocol.js';

export interface CompletedProviderStep {
  toolCalls?: readonly ToolCallPart[];
  usage?: NormalizedUsage;
}

export interface RequestProjectionContext {
  completedSteps: readonly CompletedProviderStep[];
  stepNumber: number;
  model: unknown;
  messages: ModelMessage[];
  activeTools?: readonly string[];
}

export interface RequestProjection {
  activeTools?: string[];
  messages?: ModelMessage[];
}

export type RequestProjectionStage = (
  context: RequestProjectionContext,
) => RequestProjection | undefined | PromiseLike<RequestProjection | undefined>;
