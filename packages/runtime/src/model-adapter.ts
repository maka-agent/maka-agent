import type {
  ErrorEvent,
  SessionEvent,
  TextDeltaEvent,
  ThinkingDeltaEvent,
  CompleteEvent,
} from '@maka/core/events';
import { providerAuthRequiresSecret, type LlmConnection } from '@maka/core/llm-connections';
import { lookupModelMetadata } from '@maka/core/model-metadata';
import { generalizedErrorMessage } from '@maka/core/redaction';
import type { CacheMissInputSource } from '@maka/core/usage-stats/types';
import type { ModelMessage } from 'ai';

import type { AsyncEventQueue } from './async-queue.js';
import { resolveModelRuntime } from './model-runtime.js';
import { classifyError, errorPresentationFromClass } from './provider-error-classification.js';
import type { ProviderRequestTracker } from './provider-request-telemetry.js';

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
  maxSteps?: number;
  newId: () => string;
  now: () => number;
}

export interface PrepareStepLike {
  steps: ReadonlyArray<{
    toolCalls?: ReadonlyArray<{ toolCallId?: string; toolName: string; input?: unknown }>;
    /** Real provider usage the SDK recorded for this finished step. */
    usage?: AiSdkUsageLike;
  }>;
  stepNumber: number;
  model: unknown;
  messages: ModelMessage[];
  /**
   * Active tool subset for this step. The SDK does not pass it; the composed
   * prepareStep pipeline threads an earlier hook's `activeTools` result through
   * so later hooks (and the final-request estimate owner) can measure the
   * provider-visible tool schema for the step.
   */
  activeTools?: readonly string[];
  instructions?: unknown;
  initialInstructions?: unknown;
  initialMessages?: ModelMessage[];
  responseMessages?: unknown[];
  runtimeContext?: unknown;
  toolsContext?: unknown;
}

export interface PrepareStepResultLike {
  activeTools?: string[];
  messages?: ModelMessage[];
  model?: unknown;
  toolChoice?: unknown;
  instructions?: unknown;
  providerOptions?: Record<string, unknown>;
  runtimeContext?: unknown;
  toolsContext?: unknown;
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
  /**
   * Per-call step budget override. The step limit is a SEND-level cap owned by
   * the backend: a reactive overflow retry re-invokes startStream mid-send and
   * must pass only the remaining budget (configured maxSteps minus the steps
   * already completed), or every retry would silently reset the cap. Defaults
   * to the adapter's configured maxSteps.
   */
  maxSteps?: number;
  /** Stop the SDK tool loop after the current provider step completes. */
  stopAfterStep?: () => boolean;
  /** Main-agent provider-call tracker. Auxiliary model calls intentionally omit it. */
  providerRequestTracker?: ProviderRequestTracker;
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

interface ProviderMiddlewareStreamInput {
  doStream: () => PromiseLike<{
    stream: ReadableStream<unknown>;
    request?: unknown;
    response?: unknown;
  }>;
  params: Record<string, unknown> & { abortSignal?: AbortSignal };
  model: { provider: string; modelId: string };
}

export class ModelAdapter {
  constructor(private readonly input: ModelAdapterInput) {}

  runtimeEventReplaySupport(): ModelAdapterRuntimeEventReplaySupport {
    const { adapter } = resolveModelRuntime(this.input.connection, this.input.modelId);
    return {
      toolCalls: true,
      toolResults: true,
      signedThinking: adapter.kind === 'anthropic' || adapter.kind === 'claude-subscription',
    };
  }

  resolveModel(): unknown {
    if (providerAuthRequiresSecret(this.input.connection.providerType) && !this.input.apiKey) {
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
      throw new Error(
        `Failed to load 'ai' package. Run \`npm install ai\`. Inner: ${(err as Error).message}`,
      );
    });
    const { streamText, isStepCount, isLoopFinished, wrapLanguageModel } = ai as unknown as {
      streamText: (opts: Record<string, unknown>) => StreamTextResult;
      isStepCount: (n: number) => unknown;
      isLoopFinished: () => unknown;
      wrapLanguageModel: (input: Record<string, unknown>) => unknown;
    };

    const maxSteps = input.maxSteps ?? this.input.maxSteps;
    const maxOutputTokens = selectedModelMaxOutputTokens(
      this.input.connection,
      this.input.modelId,
      this.input.providerOptions,
    );
    const configuredStop = maxSteps === undefined ? isLoopFinished() : isStepCount(maxSteps);
    const stopAfterStep = input.stopAfterStep;
    const trackedModel = input.providerRequestTracker
      ? wrapLanguageModel({
          model: input.model,
          middleware: {
            wrapStream: async ({ doStream, params, model }: ProviderMiddlewareStreamInput) =>
              await input.providerRequestTracker!.trackStream({
                providerId: model.provider,
                modelId: model.modelId,
                params,
                abortSignal: input.abortSignal,
                doStream,
              }),
          },
        })
      : input.model;
    return streamText({
      model: trackedModel,
      messages: input.messages,
      tools: input.tools,
      activeTools: input.activeTools,
      ...(input.prepareStep ? { prepareStep: input.prepareStep } : {}),
      repairToolCall: input.repairToolCall,
      ...(input.system ? { instructions: input.system } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      providerOptions: this.input.providerOptions,
      // streamText defaults to one step when stopWhen is omitted. Its exported
      // non-stopping condition is required for an unbounded tool loop.
      stopWhen: stopAfterStep ? [configuredStop, () => stopAfterStep()] : configuredStop,
      abortSignal: input.abortSignal,
      // The SDK default onError console.errors the raw error object (stack,
      // request bodies), which lands on the terminal outside the TUI
      // transcript. Stream failures already surface through the stream
      // `error` chunk → ErrorEvent path, so silence the default.
      onError: () => {},
    });
  }

  async generateCompactSummary(input: CompactSummaryRequest): Promise<CompactSummaryResult> {
    const ai = await import('ai').catch((err) => {
      throw new Error(
        `Failed to load 'ai' package. Run \`npm install ai\`. Inner: ${(err as Error).message}`,
      );
    });
    const { generateText } = ai as unknown as {
      generateText: (opts: Record<string, unknown>) => Promise<{
        text?: string;
        usage?: AiSdkUsageLike;
        finishReason?: unknown;
        providerMetadata?: unknown;
        finalStep?: { response?: { id?: string } };
      }>;
    };

    const result = await generateText({
      model: input.model,
      instructions: input.system,
      messages: input.messages,
      maxOutputTokens: input.maxOutputTokens,
      abortSignal: input.abortSignal,
    });
    const usage = normalizeAiSdkUsage(result.usage, {
      rawFinishReason: result.finishReason,
    });
    return {
      text: result.text ?? '',
      ...(usage ? { usage } : {}),
      ...(result.finishReason !== undefined
        ? { finishReason: rawFinishReasonString(result.finishReason) }
        : {}),
      ...(typeof result.finalStep?.response?.id === 'string'
        ? { providerRequestId: result.finalStep.response.id }
        : {}),
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
      // Step boundaries (`start-step` / `finish-step`) and the terminal
      // `finish` carry no
      // text/thinking to stream. The backend owns step accounting: it counts and
      // flushes one AssistantMessage per step and rotates the messageId at each
      // `finish-step`. Handling them here would double-count, so they are no-ops.
      case 'start-step':
      case 'finish-step':
      case 'step-finish': // legacy replay fixture compatibility
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
    const errorClass = classifyError(err);
    const presentation = errorPresentationFromClass(errorClass);
    const message = presentation.message ?? generalizedErrorMessage(err);
    const code =
      err instanceof Error && 'code' in err ? String((err as { code?: unknown }).code) : undefined;
    return {
      type: 'error',
      id: this.input.newId(),
      turnId,
      ts: this.input.now(),
      recoverable: false,
      ...(code !== undefined ? { code } : {}),
      ...(presentation.reason !== undefined ? { reason: presentation.reason } : {}),
      message,
    };
  }

  classifyError(error: unknown): string {
    return classifyError(error);
  }

  mapFinishReason(reason: unknown): CompleteEvent['stopReason'] {
    switch (reason) {
      case 'stop':
        return 'end_turn';
      case 'length':
        return 'max_tokens';
      case 'content-filter':
        return 'error';
      case 'error':
        return 'error';
      case 'tool-calls':
        return 'end_turn';
      default:
        return 'end_turn';
    }
  }
}

function selectedModelMaxOutputTokens(
  connection: LlmConnection,
  modelId: string,
  providerOptions: Record<string, unknown> | undefined,
): number | undefined {
  const { adapter, apiProtocol } = resolveModelRuntime(connection, modelId);
  const usesAnthropicMessages =
    adapter.kind === 'anthropic' ||
    adapter.kind === 'claude-subscription' ||
    (adapter.kind === 'github-copilot' && apiProtocol === 'anthropic-messages');
  if (!usesAnthropicMessages) return undefined;
  const wireOutputLimit =
    connection.models?.find((model) => model.id === modelId)?.maxOutputTokens ??
    lookupModelMetadata(connection.providerType, modelId).maxOutputTokens;
  if (wireOutputLimit === undefined) return undefined;
  return wireOutputLimit - fixedAnthropicThinkingBudget(providerOptions);
}

function fixedAnthropicThinkingBudget(
  providerOptions: Record<string, unknown> | undefined,
): number {
  const anthropic = providerOptions?.anthropic;
  if (!anthropic || typeof anthropic !== 'object' || Array.isArray(anthropic)) return 0;
  const thinking = (anthropic as { thinking?: unknown }).thinking;
  if (!thinking || typeof thinking !== 'object' || Array.isArray(thinking)) return 0;
  const { type, budgetTokens } = thinking as { type?: unknown; budgetTokens?: unknown };
  return type === 'enabled' && typeof budgetTokens === 'number' ? budgetTokens : 0;
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
  stream: AsyncIterable<AiSdkStreamChunk>;
  usage: Promise<AiSdkUsageLike | undefined>;
  finalStep: Promise<{ usage?: AiSdkUsageLike } | undefined>;
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
    textTokens?: number;
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
  const reportedInputTokens =
    finiteTokenFromValueOrBreakdown(usage.inputTokens, 'total') ??
    finiteTokenBreakdownSum(usage.inputTokens, ['noCache', 'cacheRead', 'cacheWrite']) ??
    finiteToken(usage.promptTokens) ??
    finiteToken(usage.raw?.prompt_tokens) ??
    finiteToken(usage.prompt_tokens) ??
    finiteTokenSum([
      usage.inputTokenDetails?.noCacheTokens,
      usage.inputTokenDetails?.cacheReadTokens,
      usage.inputTokenDetails?.cacheWriteTokens,
    ]);
  const reportedOutputTokens =
    finiteTokenFromValueOrBreakdown(usage.outputTokens, 'total') ??
    finiteTokenBreakdownSum(usage.outputTokens, ['text', 'reasoning']) ??
    finiteToken(usage.completionTokens) ??
    finiteToken(usage.raw?.completion_tokens) ??
    finiteToken(usage.completion_tokens) ??
    finiteTokenSum([
      usage.outputTokenDetails?.textTokens,
      usage.outputTokenDetails?.reasoningTokens,
    ]);
  const reportedCacheHitInputTokens =
    finiteToken(usage.cacheHitInputTokens) ??
    finiteToken(usage.cachedInputTokens) ??
    finiteToken(usage.cacheReadInputTokens) ??
    finiteToken(usage.raw?.prompt_cache_hit_tokens) ??
    finiteToken(usage.prompt_cache_hit_tokens) ??
    finiteToken(usage.raw?.prompt_tokens_details?.cached_tokens) ??
    finiteToken(usage.prompt_tokens_details?.cached_tokens) ??
    finiteTokenFromBreakdown(usage.inputTokens, 'cacheRead') ??
    finiteToken(usage.inputTokenDetails?.cacheReadTokens) ??
    finiteToken(usage.inputTokenDetails?.cachedTokens);
  const reportedCacheWriteInputTokens =
    finiteToken(usage.cacheWriteInputTokens) ??
    finiteToken(usage.cacheCreationInputTokens) ??
    finiteTokenFromBreakdown(usage.inputTokens, 'cacheWrite') ??
    finiteToken(usage.inputTokenDetails?.cacheWriteTokens);
  const explicitCacheMissInputTokens =
    finiteToken(usage.cacheMissInputTokens) ??
    finiteToken(usage.raw?.prompt_cache_miss_tokens) ??
    finiteToken(usage.prompt_cache_miss_tokens) ??
    finiteTokenFromBreakdown(usage.inputTokens, 'noCache') ??
    finiteToken(usage.inputTokenDetails?.noCacheTokens) ??
    finiteToken(usage.inputTokenDetails?.cacheMissTokens);
  const reportedReasoningTokens =
    finiteToken(usage.reasoningTokens) ??
    finiteTokenFromBreakdown(usage.outputTokens, 'reasoning') ??
    finiteToken(usage.outputTokenDetails?.reasoningTokens) ??
    finiteToken(usage.raw?.completion_tokens_details?.reasoning_tokens) ??
    finiteToken(usage.completion_tokens_details?.reasoning_tokens) ??
    finiteToken(usage.inputTokenDetails?.reasoningTokens);
  const reportedTotalTokens =
    finiteToken(usage.totalTokens) ??
    finiteToken(usage.raw?.total_tokens) ??
    finiteToken(usage.total_tokens);
  const inputTokens =
    reportedInputTokens ??
    (reportedTotalTokens !== undefined &&
    reportedOutputTokens !== undefined &&
    reportedTotalTokens >= reportedOutputTokens
      ? reportedTotalTokens - reportedOutputTokens
      : undefined);
  const outputTokens =
    reportedOutputTokens ??
    (reportedTotalTokens !== undefined &&
    reportedInputTokens !== undefined &&
    reportedTotalTokens >= reportedInputTokens
      ? reportedTotalTokens - reportedInputTokens
      : undefined);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cacheHitInputTokens = reportedCacheHitInputTokens ?? 0;
  const cacheWriteInputTokens = reportedCacheWriteInputTokens ?? 0;
  const cacheMissInputTokens =
    explicitCacheMissInputTokens ??
    Math.max(0, inputTokens - cacheHitInputTokens - cacheWriteInputTokens);
  const cacheMissInputSource: CacheMissInputSource =
    explicitCacheMissInputTokens !== undefined ? 'explicit' : 'derived';
  const reasoningTokens = reportedReasoningTokens ?? 0;
  const totalTokens = reportedTotalTokens ?? inputTokens + outputTokens;
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

function finiteTokenBreakdownSum(
  value: number | TokenCountBreakdown | undefined,
  keys: readonly (keyof TokenCountBreakdown)[],
): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const parts = keys.map((key) => finiteToken(value[key]));
  return parts.every((part) => part === undefined)
    ? undefined
    : parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
}

function finiteTokenSum(values: readonly unknown[]): number | undefined {
  const tokens = values.map(finiteToken);
  return tokens.every((token) => token === undefined)
    ? undefined
    : tokens.reduce<number>((sum, token) => sum + (token ?? 0), 0);
}

function rawUsageFields(usage: AiSdkUsageLike): AiSdkRawUsageFields | undefined {
  const raw: AiSdkRawUsageFields = {};
  const promptTokens = finiteToken(usage.prompt_tokens) ?? finiteToken(usage.raw?.prompt_tokens);
  if (promptTokens !== undefined) raw.prompt_tokens = promptTokens;
  const completionTokens =
    finiteToken(usage.completion_tokens) ?? finiteToken(usage.raw?.completion_tokens);
  if (completionTokens !== undefined) raw.completion_tokens = completionTokens;
  const totalTokens = finiteToken(usage.total_tokens) ?? finiteToken(usage.raw?.total_tokens);
  if (totalTokens !== undefined) raw.total_tokens = totalTokens;
  const promptCacheHitTokens =
    finiteToken(usage.prompt_cache_hit_tokens) ?? finiteToken(usage.raw?.prompt_cache_hit_tokens);
  if (promptCacheHitTokens !== undefined) raw.prompt_cache_hit_tokens = promptCacheHitTokens;
  const promptCacheMissTokens =
    finiteToken(usage.prompt_cache_miss_tokens) ?? finiteToken(usage.raw?.prompt_cache_miss_tokens);
  if (promptCacheMissTokens !== undefined) raw.prompt_cache_miss_tokens = promptCacheMissTokens;
  const cachedTokens =
    finiteToken(usage.prompt_tokens_details?.cached_tokens) ??
    finiteToken(usage.raw?.prompt_tokens_details?.cached_tokens);
  if (cachedTokens !== undefined) raw.prompt_tokens_details = { cached_tokens: cachedTokens };
  const reasoningTokens =
    finiteToken(usage.completion_tokens_details?.reasoning_tokens) ??
    finiteToken(usage.raw?.completion_tokens_details?.reasoning_tokens);
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
