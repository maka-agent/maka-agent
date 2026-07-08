import type {
  ErrorEvent,
  SessionEvent,
  TextDeltaEvent,
  ThinkingDeltaEvent,
  CompleteEvent,
} from '@maka/core/events';
import { PROVIDER_DEFAULTS, type LlmConnection } from '@maka/core/llm-connections';
import { generalizedErrorMessage } from '@maka/core/redaction';
import type { CacheMissInputSource } from '@maka/core/usage-stats/types';
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

export interface PrepareStepLike {
  steps: ReadonlyArray<{
    toolCalls?: ReadonlyArray<{ toolCallId?: string; toolName: string; input?: unknown }>;
  }>;
  stepNumber: number;
  model: unknown;
  messages: ModelMessage[];
  experimental_context: unknown;
}

export interface PrepareStepResultLike {
  activeTools?: string[];
  messages?: ModelMessage[];
  model?: unknown;
  toolChoice?: unknown;
  system?: unknown;
  providerOptions?: Record<string, unknown>;
  experimental_context?: unknown;
}

export type PrepareStepFunctionLike = (
  options: PrepareStepLike,
) => PrepareStepResultLike | undefined | PromiseLike<PrepareStepResultLike | undefined>;

export interface CompactSummaryRequest {
  model: unknown;
  system: string;
  messages: readonly ModelMessage[];
  maxOutputTokens: number;
  abortSignal?: AbortSignal;
}

export interface CompactSummaryResult {
  text: string;
  usage?: NormalizedAiSdkUsage;
  finishReason?: string;
  providerRequestId?: string;
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
  /**
   * Optional per-step active-tool override for deferred tool loading. Recomputes
   * `activeTools` before each step so a tool loaded mid-turn becomes advertised
   * on the next step without mutating the cached tools prefix.
   */
  prepareStep?: PrepareStepFunctionLike;
}

export interface ModelAdapterStreamCallbacks {
  onText: (text: string) => void;
  onTextComplete: (text: string) => void;
  onThinking: (text: string) => void;
  /**
   * Provider-signed reasoning signature (Anthropic). Delivered out-of-band from
   * the thinking text: the provider emits it on a separate reasoning chunk
   * (empty delta) or on `reasoning-end`, so the caller records it without
   * disturbing the accumulated thinking text. The final `thinking_complete`
   * SessionEvent is emitted by the backend's turn-finalization seam (mirroring
   * `text_complete`), carrying the accumulated text plus this signature.
   */
  onThinkingSignature: (signature: string) => void;
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
      ...(input.prepareStep ? { prepareStep: input.prepareStep } : {}),
      experimental_repairToolCall: input.repairToolCall,
      system: input.system,
      providerOptions: this.input.providerOptions,
      stopWhen: stepCountIs(this.input.maxSteps),
      abortSignal: input.abortSignal,
    });
  }

  async generateCompactSummary(input: CompactSummaryRequest): Promise<CompactSummaryResult> {
    const ai = await import('ai').catch((err) => {
      throw new Error(`Failed to load 'ai' package. Run \`npm install ai\`. Inner: ${(err as Error).message}`);
    });
    const { generateText } = ai as unknown as {
      generateText: (opts: Record<string, unknown>) => Promise<{
        text?: string;
        usage?: AiSdkUsageLike;
        totalUsage?: AiSdkUsageLike;
        finishReason?: unknown;
        providerMetadata?: unknown;
        response?: { id?: string };
      }>;
    };

    const result = await generateText({
      model: input.model,
      system: input.system,
      messages: input.messages,
      maxOutputTokens: input.maxOutputTokens,
      abortSignal: input.abortSignal,
    });
    const usage = normalizeAiSdkUsage(result.totalUsage ?? result.usage, {
      rawFinishReason: result.finishReason,
    });
    return {
      text: result.text ?? '',
      ...(usage ? { usage } : {}),
      ...(result.finishReason !== undefined ? { finishReason: rawFinishReasonString(result.finishReason) } : {}),
      ...(typeof result.response?.id === 'string' ? { providerRequestId: result.response.id } : {}),
    };
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
        const signature = reasoningSignatureFromChunk(chunk);
        if (signature) callbacks.onThinkingSignature(signature);
        // The signed reasoning chunk arrives as a standalone delta with empty
        // text; only stream a thinking_delta when there is actual text so the
        // signature carrier does not surface as an empty reasoning fragment.
        if (text) {
          callbacks.onThinking(text);
          queue.push({
            type: 'thinking_delta',
            id: this.input.newId(),
            turnId,
            ts,
            messageId: assistantMessageId,
            text,
          } satisfies ThinkingDeltaEvent);
        }
        break;
      }
      case 'reasoning-end': {
        const signature = reasoningSignatureFromChunk(chunk);
        if (signature) callbacks.onThinkingSignature(signature);
        break;
      }
      case 'reasoning-start':
        break;
      // Step boundaries (AI SDK v6 emits `start-step` / `finish-step`; older
      // `step-finish` kept for compatibility) and the terminal `finish` carry no
      // text/thinking to stream. The backend owns step accounting: it counts and
      // flushes one AssistantMessage per step and rotates the messageId at each
      // `finish-step`. Handling them here would double-count, so they are no-ops.
      case 'start-step':
      case 'finish-step':
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
  finishReason?: unknown;
  error?: unknown;
  /** Provider-specific metadata; carries the Anthropic reasoning signature. */
  providerMetadata?: unknown;
}

/**
 * Extract the provider-signed reasoning signature from a stream chunk.
 * Anthropic delivers it via `providerMetadata.anthropic.signature`; other
 * providers omit it and this returns undefined.
 */
function reasoningSignatureFromChunk(chunk: AiSdkStreamChunk): string | undefined {
  const meta = chunk.providerMetadata;
  if (!meta || typeof meta !== 'object') return undefined;
  const anthropic = (meta as { anthropic?: unknown }).anthropic;
  if (!anthropic || typeof anthropic !== 'object') return undefined;
  const signature = (anthropic as { signature?: unknown }).signature;
  return typeof signature === 'string' && signature.length > 0 ? signature : undefined;
}

export interface StreamTextResult {
  fullStream: AsyncIterable<AiSdkStreamChunk>;
  usage: Promise<AiSdkUsageLike | undefined>;
  totalUsage?: Promise<AiSdkUsageLike | undefined>;
  finishReason: Promise<unknown>;
}

type TokenCountBreakdown = {
  total?: number;
  noCache?: number;
  cacheRead?: number;
  cacheWrite?: number;
  text?: number;
  reasoning?: number;
};

export interface AiSdkRawUsageFields {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
}

export interface AiSdkUsageLike {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  inputTokens?: number | TokenCountBreakdown;
  outputTokens?: number | TokenCountBreakdown;
  cacheHitInputTokens?: number;
  cacheMissInputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
  inputTokenDetails?: {
    cachedTokens?: number;
    cacheMissTokens?: number;
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  };
  outputTokenDetails?: {
    reasoningTokens?: number;
  };
  raw?: AiSdkRawUsageFields;
}

export interface NormalizedAiSdkUsage {
  inputTokens: number;
  outputTokens: number;
  cacheHitInputTokens: number;
  cacheMissInputTokens: number;
  cacheMissInputSource: CacheMissInputSource;
  cacheWriteInputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  rawFinishReason?: string;
  raw?: AiSdkRawUsageFields;
  /** Backward-compatible alias for cacheHitInputTokens. */
  cachedInputTokens: number;
}

export function normalizeAiSdkUsage(
  usage: AiSdkUsageLike | undefined,
  options: { rawFinishReason?: unknown } = {},
): NormalizedAiSdkUsage | undefined {
  if (!usage) return undefined;
  const inputTokens =
    finiteTokenFromValueOrBreakdown(usage.inputTokens, 'total')
    ?? finiteToken(usage.promptTokens)
    ?? finiteToken(usage.raw?.prompt_tokens)
    ?? finiteToken(usage.prompt_tokens)
    ?? 0;
  const outputTokens =
    finiteTokenFromValueOrBreakdown(usage.outputTokens, 'total')
    ?? finiteToken(usage.completionTokens)
    ?? finiteToken(usage.raw?.completion_tokens)
    ?? finiteToken(usage.completion_tokens)
    ?? 0;
  const cacheHitInputTokens =
    finiteToken(usage.cacheHitInputTokens)
    ?? finiteToken(usage.cachedInputTokens)
    ?? finiteToken(usage.cacheReadInputTokens)
    ?? finiteToken(usage.raw?.prompt_cache_hit_tokens)
    ?? finiteToken(usage.prompt_cache_hit_tokens)
    ?? finiteToken(usage.raw?.prompt_tokens_details?.cached_tokens)
    ?? finiteToken(usage.prompt_tokens_details?.cached_tokens)
    ?? finiteTokenFromBreakdown(usage.inputTokens, 'cacheRead')
    ?? finiteToken(usage.inputTokenDetails?.cacheReadTokens)
    ?? finiteToken(usage.inputTokenDetails?.cachedTokens)
    ?? 0;
  const cacheWriteInputTokens =
    finiteToken(usage.cacheWriteInputTokens)
    ?? finiteToken(usage.cacheCreationInputTokens)
    ?? finiteTokenFromBreakdown(usage.inputTokens, 'cacheWrite')
    ?? finiteToken(usage.inputTokenDetails?.cacheWriteTokens)
    ?? 0;
  const explicitCacheMissInputTokens =
    finiteToken(usage.cacheMissInputTokens)
    ?? finiteToken(usage.raw?.prompt_cache_miss_tokens)
    ?? finiteToken(usage.prompt_cache_miss_tokens)
    ?? finiteTokenFromBreakdown(usage.inputTokens, 'noCache')
    ?? finiteToken(usage.inputTokenDetails?.noCacheTokens)
    ?? finiteToken(usage.inputTokenDetails?.cacheMissTokens);
  const cacheMissInputTokens =
    explicitCacheMissInputTokens
    ?? Math.max(0, inputTokens - cacheHitInputTokens - cacheWriteInputTokens);
  const cacheMissInputSource: CacheMissInputSource =
    explicitCacheMissInputTokens !== undefined ? 'explicit' : 'derived';
  const reasoningTokens =
    finiteToken(usage.reasoningTokens)
    ?? finiteTokenFromBreakdown(usage.outputTokens, 'reasoning')
    ?? finiteToken(usage.outputTokenDetails?.reasoningTokens)
    ?? finiteToken(usage.raw?.completion_tokens_details?.reasoning_tokens)
    ?? finiteToken(usage.completion_tokens_details?.reasoning_tokens)
    ?? finiteToken(usage.inputTokenDetails?.reasoningTokens)
    ?? 0;
  const totalTokens =
    finiteToken(usage.totalTokens)
    ?? finiteToken(usage.raw?.total_tokens)
    ?? finiteToken(usage.total_tokens)
    ?? inputTokens + outputTokens;
  const raw = rawUsageFields(usage);
  const rawFinishReason = rawFinishReasonString(options.rawFinishReason);
  return {
    inputTokens,
    outputTokens,
    cacheHitInputTokens,
    cacheMissInputTokens,
    cacheMissInputSource,
    cacheWriteInputTokens,
    reasoningTokens,
    totalTokens,
    ...(rawFinishReason !== undefined ? { rawFinishReason } : {}),
    ...(raw !== undefined ? { raw } : {}),
    cachedInputTokens: cacheHitInputTokens,
  };
}

function finiteToken(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function finiteTokenFromBreakdown(
  value: number | TokenCountBreakdown | undefined,
  key: keyof TokenCountBreakdown,
): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return finiteToken(value[key]);
}

function finiteTokenFromValueOrBreakdown(
  value: number | TokenCountBreakdown | undefined,
  key: keyof TokenCountBreakdown,
): number | undefined {
  return finiteToken(value) ?? finiteTokenFromBreakdown(value, key);
}

function rawUsageFields(usage: AiSdkUsageLike): AiSdkRawUsageFields | undefined {
  const raw: AiSdkRawUsageFields = {};
  const promptTokens =
    finiteToken(usage.prompt_tokens)
    ?? finiteToken(usage.raw?.prompt_tokens);
  if (promptTokens !== undefined) raw.prompt_tokens = promptTokens;
  const completionTokens =
    finiteToken(usage.completion_tokens)
    ?? finiteToken(usage.raw?.completion_tokens);
  if (completionTokens !== undefined) raw.completion_tokens = completionTokens;
  const totalTokens =
    finiteToken(usage.total_tokens)
    ?? finiteToken(usage.raw?.total_tokens);
  if (totalTokens !== undefined) raw.total_tokens = totalTokens;
  const promptCacheHitTokens =
    finiteToken(usage.prompt_cache_hit_tokens)
    ?? finiteToken(usage.raw?.prompt_cache_hit_tokens);
  if (promptCacheHitTokens !== undefined) raw.prompt_cache_hit_tokens = promptCacheHitTokens;
  const promptCacheMissTokens =
    finiteToken(usage.prompt_cache_miss_tokens)
    ?? finiteToken(usage.raw?.prompt_cache_miss_tokens);
  if (promptCacheMissTokens !== undefined) raw.prompt_cache_miss_tokens = promptCacheMissTokens;
  const cachedTokens =
    finiteToken(usage.prompt_tokens_details?.cached_tokens)
    ?? finiteToken(usage.raw?.prompt_tokens_details?.cached_tokens);
  if (cachedTokens !== undefined) raw.prompt_tokens_details = { cached_tokens: cachedTokens };
  const reasoningTokens =
    finiteToken(usage.completion_tokens_details?.reasoning_tokens)
    ?? finiteToken(usage.raw?.completion_tokens_details?.reasoning_tokens);
  if (reasoningTokens !== undefined) {
    raw.completion_tokens_details = { reasoning_tokens: reasoningTokens };
  }
  return Object.keys(raw).length > 0 ? raw : undefined;
}

export function rawFinishReasonString(reason: unknown): string | undefined {
  if (typeof reason === 'string') return reason;
  if (reason && typeof reason === 'object') {
    const raw = (reason as { raw?: unknown }).raw;
    if (typeof raw === 'string') return raw;
    const unified = (reason as { unified?: unknown }).unified;
    if (typeof unified === 'string') return unified;
  }
  return undefined;
}
