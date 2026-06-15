import type {
  ErrorEvent,
  SessionEvent,
  TextDeltaEvent,
  ThinkingDeltaEvent,
  CompleteEvent,
} from '@maka/core/events';
import { PROVIDER_DEFAULTS, type LlmConnection } from '@maka/core/llm-connections';
import { generalizedErrorMessage } from '@maka/core/redaction';
import type { ModelMessage } from 'ai';

import type { AsyncEventQueue } from './async-queue.js';
import { classifyError, errorReasonFromClass } from './tool-runtime.js';

/**
 * Build an ai-sdk LanguageModel from a single input object.
 * Matches the signature exported by `runtime/model-factory.ts` (@kabi):
 *   `getAIModel(input: ModelFactoryInput): LanguageModelV2`
 *
 * We type-erase the return as `unknown` here to avoid pulling ai-sdk's
 * `LanguageModelV2` type into core's dependency graph.
 */
export interface ModelFactoryInput {
  connection: LlmConnection;
  apiKey: string;
  modelId: string;
}
export type ModelFactory = (input: ModelFactoryInput) => unknown;

export interface RepairableAiSdkToolCall {
  toolCallId: string;
  toolName: string;
  input: string;
  providerExecuted?: boolean;
  providerMetadata?: unknown;
}

export interface ModelAdapterInput {
  connection: LlmConnection;
  apiKey: string;
  modelId: string;
  modelFactory: ModelFactory;
  providerOptions?: Record<string, unknown>;
  maxSteps: number;
  newId: () => string;
  now: () => number;
}

export interface ModelAdapterStreamInput {
  model: unknown;
  messages: ModelMessage[];
  tools: Record<string, unknown>;
  activeTools: string[];
  system?: string;
  abortSignal: AbortSignal;
  repairToolCall: (input: {
    toolCall: RepairableAiSdkToolCall;
    error: unknown;
  }) => RepairableAiSdkToolCall | null | Promise<RepairableAiSdkToolCall | null>;
}

export interface ModelAdapterStreamCallbacks {
  onText: (text: string) => void;
  onTextComplete: (text: string) => void;
  onThinking: (text: string) => void;
  onThinkingComplete: (text: string, signature?: string) => void;
}

export class ModelAdapter {
  constructor(private readonly input: ModelAdapterInput) {}

  runtimeEventReplaySupport(): ModelAdapterRuntimeEventReplaySupport {
    const protocol = PROVIDER_DEFAULTS[this.input.connection.providerType].protocol;
    return {
      toolCalls: true,
      toolResults: true,
      signedThinking: protocol === 'anthropic',
    };
  }

  resolveModel(): unknown {
    if (PROVIDER_DEFAULTS[this.input.connection.providerType].authKind !== 'none' && !this.input.apiKey) {
      throw new Error(`No API key stored for connection "${this.input.connection.slug}"`);
    }
    return this.input.modelFactory({
      connection: this.input.connection,
      apiKey: this.input.apiKey,
      modelId: this.input.modelId,
    });
  }

  async startStream(input: ModelAdapterStreamInput): Promise<StreamTextResult> {
    const ai = await import('ai').catch((err) => {
      throw new Error(`Failed to load 'ai' package. Run \`npm install ai\`. Inner: ${(err as Error).message}`);
    });
    const { streamText, stepCountIs } = ai as unknown as {
      streamText: (opts: Record<string, unknown>) => StreamTextResult;
      stepCountIs: (n: number) => unknown;
    };

    return streamText({
      model: input.model,
      messages: input.messages,
      tools: input.tools,
      activeTools: input.activeTools,
      experimental_repairToolCall: input.repairToolCall,
      system: input.system,
      providerOptions: this.input.providerOptions,
      stopWhen: stepCountIs(this.input.maxSteps),
      abortSignal: input.abortSignal,
    });
  }

  handleStreamChunk(
    chunk: AiSdkStreamChunk,
    turnId: string,
    assistantMessageId: string,
    queue: AsyncEventQueue<SessionEvent>,
    callbacks: ModelAdapterStreamCallbacks,
  ): void {
    const ts = this.input.now();
    switch (chunk.type) {
      case 'text-delta': {
        const text = chunk.text ?? chunk.textDelta ?? chunk.delta ?? '';
        callbacks.onText(text);
        queue.push({
          type: 'text_delta',
          id: this.input.newId(),
          turnId,
          ts,
          messageId: assistantMessageId,
          text,
        } satisfies TextDeltaEvent);
        break;
      }
      case 'reasoning':
      case 'reasoning-delta': {
        const text = chunk.text ?? chunk.textDelta ?? chunk.delta ?? '';
        callbacks.onThinking(text);
        queue.push({
          type: 'thinking_delta',
          id: this.input.newId(),
          turnId,
          ts,
          messageId: assistantMessageId,
          text,
        } satisfies ThinkingDeltaEvent);
        break;
      }
      case 'step-finish':
      case 'finish':
        break;
      case 'tool-call':
      case 'tool-result':
        break;
      case 'error':
        queue.push(this.makeErrorEvent(turnId, chunk.error));
        break;
      default:
        break;
    }
  }

  makeErrorEvent(turnId: string, err: unknown): ErrorEvent {
    const message = generalizedErrorMessage(err);
    const reason = errorReasonFromClass(classifyError(err));
    const code = err instanceof Error && 'code' in err
      ? String((err as { code?: unknown }).code)
      : undefined;
    return {
      type: 'error',
      id: this.input.newId(),
      turnId,
      ts: this.input.now(),
      recoverable: false,
      ...(code !== undefined ? { code } : {}),
      ...(reason !== undefined ? { reason } : {}),
      message,
    };
  }

  classifyError(error: unknown): string {
    return classifyError(error);
  }

  mapFinishReason(reason: unknown): CompleteEvent['stopReason'] {
    switch (reason) {
      case 'stop':           return 'end_turn';
      case 'length':         return 'max_tokens';
      case 'content-filter': return 'error';
      case 'error':          return 'error';
      case 'tool-calls':     return 'end_turn';
      default:               return 'end_turn';
    }
  }
}

export interface ModelAdapterRuntimeEventReplaySupport {
  toolCalls: boolean;
  toolResults: boolean;
  signedThinking: boolean;
}

export interface AiSdkStreamChunk {
  type: string;
  text?: string;
  delta?: string;
  textDelta?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  usage?: AiSdkUsageLike;
  finishReason?: string;
  error?: unknown;
}

export interface StreamTextResult {
  fullStream: AsyncIterable<AiSdkStreamChunk>;
  usage: Promise<AiSdkUsageLike | undefined>;
  finishReason: Promise<string>;
}

export interface AiSdkUsageLike {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  inputTokenDetails?: {
    cachedTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  };
  outputTokenDetails?: {
    reasoningTokens?: number;
  };
}

export interface NormalizedAiSdkUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export function normalizeAiSdkUsage(usage: AiSdkUsageLike | undefined): NormalizedAiSdkUsage | undefined {
  if (!usage) return undefined;
  const inputTokens = finiteToken(usage.inputTokens) ?? finiteToken(usage.promptTokens) ?? 0;
  const outputTokens = finiteToken(usage.outputTokens) ?? finiteToken(usage.completionTokens) ?? 0;
  const cachedInputTokens =
    finiteToken(usage.cachedInputTokens)
    ?? finiteToken(usage.cacheReadInputTokens)
    ?? finiteToken(usage.inputTokenDetails?.cacheReadTokens)
    ?? finiteToken(usage.inputTokenDetails?.cachedTokens)
    ?? 0;
  const cacheWriteInputTokens =
    finiteToken(usage.cacheWriteInputTokens)
    ?? finiteToken(usage.cacheCreationInputTokens)
    ?? finiteToken(usage.inputTokenDetails?.cacheWriteTokens)
    ?? 0;
  const reasoningTokens =
    finiteToken(usage.reasoningTokens)
    ?? finiteToken(usage.outputTokenDetails?.reasoningTokens)
    ?? finiteToken(usage.inputTokenDetails?.reasoningTokens)
    ?? 0;
  const totalTokens = finiteToken(usage.totalTokens) ?? inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    reasoningTokens,
    totalTokens,
  };
}

function finiteToken(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
