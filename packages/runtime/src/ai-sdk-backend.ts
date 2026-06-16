/**
 * AiSdkBackend — single backend for all LLM providers via Vercel AI SDK.
 *
 * Provides one `streamText` API across Anthropic / OpenAI / Google / DeepSeek /
 * OpenAI-compatible endpoints, while keeping all of our home-grown
 * machinery: PermissionEngine (policy + park/resume), materializer,
 * AsyncEventQueue, SessionStore JSONL persistence.
 *
 * The agent loop (multi-step tool calling) is owned by ai-sdk's
 * `streamText` with `stopWhen: stepCountIs(N)`. Permission gating happens
 * inside each tool's `execute()` callback — that's the seam where we
 * consult PermissionEngine and either run, deny synthetically, or park
 * awaiting user.
 *
 * Design:
 *   send()
 *     ├─ build AsyncEventQueue<SessionEvent>
 *     ├─ resolve LanguageModelV2 via deps.modelFactory(connection, modelId)
 *     ├─ wrap each MakaTool's execute() with permission round-trip
 *     ├─ background task: pump streamText.fullStream → normalize → queue
 *     └─ yield from queue
 *
 *   tool.execute(args)
 *     ├─ append ToolCallMessage  (§6.2: tool_call written BEFORE permission)
 *     ├─ emit ToolStartEvent
 *     ├─ engine.evaluate(...)
 *     │     ├─ allow:  run impl → append ToolResult → emit ToolResult
 *     │     ├─ block:  synth error → append ToolResult{isError:true} → emit
 *     │     └─ prompt: emit PermissionRequest → await parked
 *     │                ├─ allow:  run impl → ... (same as allow)
 *     │                └─ deny:   synth "User denied" → append → emit
 *     └─ return result back to ai-sdk
 */

import type {
  SessionEvent,
  CompleteEvent,
  AbortEvent,
  ErrorEvent,
  TextCompleteEvent,
  TokenUsageEvent,
} from '@maka/core/events';
import { createHash } from 'node:crypto';
import type {
  StoredMessage,
  AssistantMessage,
  ToolCallMessage,
  ToolResultMessage,
  PermissionDecisionMessage,
  TokenUsageMessage,
  BackendKind,
  SessionHeader,
} from '@maka/core/session';
import type {
  BackendSendInput,
  PermissionDecision,
} from '@maka/core/backend-types';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { LlmCallRecord, ToolInvocationRecord } from '@maka/core/usage-stats/types';
import type {
  ContextBudgetDiagnostic,
  PromptSegmentEstimate,
} from '@maka/core/usage-stats/types';
import type { JSONValue, ModelMessage } from 'ai';
import { z } from 'zod';

import { PermissionEngine } from './permission-engine.js';
import { AsyncEventQueue } from './async-queue.js';
import { StreamWatchdog, formatStreamWatchdogError } from './stream-watchdog.js';
import {
  MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN,
  TOOL_ERROR_RESULT_MAX_CHARS,
  ToolRuntime,
  formatSyntheticToolErrorText,
  type MakaTool,
  type MakaToolContext,
} from './tool-runtime.js';
import {
  ModelAdapter,
  normalizeAiSdkUsage,
  rawFinishReasonString,
  type ModelFactory,
  type ModelFactoryInput,
  type NormalizedAiSdkUsage,
  type RepairableAiSdkToolCall,
} from './model-adapter.js';
import type { ToolArtifactRecorder } from './tool-artifacts.js';
import { RunTrace, type RunTraceRecorder } from './run-trace.js';
import {
  buildRuntimeEventModelReplayPlan,
  formatTextWithAttachmentRefs,
  type RuntimeEventModelReplayItem,
  type RuntimeEventModelReplayPlan,
  type RuntimeEventReplayFallbackGate,
} from './model-history.js';
import {
  canonicalizeToolSet,
  computeRequestShapeDiagnostic,
  toolSchemaCharsForDiagnostics,
  type RequestShapeDiagnostic,
} from './request-shape.js';
import {
  ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
  applyRuntimeEventContextBudget,
  buildPromptSegmentEstimates,
  collectStaleToolResultArchiveCandidates,
  estimateRuntimeEventsTokens,
  rawEvidenceRequestReason,
  retrieveArchivedToolResultsForReplay,
  retrieveRuntimeEventHistoryAround,
  selectSynthesisCacheForReplay,
  type ContextBudgetPolicy,
  type StaleToolResultArchiveCandidate,
  type SynthesisCacheBlock,
  type SynthesisSourceRef,
  type ArchiveRetrievalMode,
  type ToolResultArchiveReader,
  type ToolResultArchiveRef,
} from './context-budget.js';

export {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN,
  TOOL_ERROR_RESULT_MAX_CHARS,
  formatSyntheticToolErrorText,
} from './tool-runtime.js';
export type { MakaTool, MakaToolContext } from './tool-runtime.js';
export { normalizeAiSdkUsage } from './model-adapter.js';
export type { ModelFactory, ModelFactoryInput, RepairableAiSdkToolCall } from './model-adapter.js';
export type { RunTraceEvent, RunTraceRecorder } from './run-trace.js';

type AiSdkToolResultOutput =
  | { type: 'text'; value: string }
  | { type: 'json'; value: JSONValue }
  | { type: 'error-text'; value: string }
  | { type: 'error-json'; value: JSONValue };

// ============================================================================
// AgentBackend interface
// ============================================================================

export interface AgentBackend {
  readonly kind: BackendKind;
  readonly sessionId: string;
  send(input: BackendSendInput): AsyncIterable<SessionEvent>;
  stop(reason: 'user_stop' | 'redirect'): Promise<void>;
  respondToPermission(decision: PermissionDecision): Promise<void>;
  dispose(): Promise<void>;
}

export const INVALID_TOOL_NAME = 'invalid';

// ============================================================================
// Constructor input — single object matches @kabi's BackendRegistry call site
// ============================================================================

/**
 * Append-message writer — usually `(m) => store.appendMessage(sessionId, m)`.
 * Allows callers to inject a custom queueing/buffering strategy if needed.
 */
export type AppendMessageFn = (m: StoredMessage) => Promise<void>;
export type LlmTelemetryRecorder = (record: LlmCallRecord) => void;
export type ToolTelemetryRecorder = (record: ToolInvocationRecord) => void;
export interface ToolResultArchiveRecorderInput extends StaleToolResultArchiveCandidate {
  sessionId: string;
  bodySha256: string;
}
export type ToolResultArchiveRecorder = (
  input: ToolResultArchiveRecorderInput,
) => Promise<{ artifactId: string } | void> | { artifactId: string } | void;
export interface SynthesisCacheLoadInput {
  sessionId: string;
  maxBlocks?: number;
  maxBytes?: number;
  maxEstimatedTokens?: number;
}
export interface SynthesisCacheLoadResult {
  blocks: SynthesisCacheBlock[];
  skipped?: number;
  skippedReasonCounts?: Record<string, number>;
  evicted?: number;
  evictionReasonCounts?: Record<string, number>;
}
export interface SynthesisCacheWriteInput {
  sessionId: string;
  turnId: string;
  source: {
    createdFrom: 'gated_archive_retrieval' | 'eager_archive_retrieval';
    query: string;
    hydratedRuntimeEvents: RuntimeEvent[];
    retrievedArchiveRefs: SynthesisSourceRef[];
    archiveRetrievalMode: ArchiveRetrievalMode;
  };
  limits: {
    maxBlocks: number;
    maxBlockEstimatedTokens: number;
    maxEstimatedTokens: number;
    charsPerToken: number;
  };
  requestShapeHashBefore?: string;
  requestShapeHashAfter?: string;
}
export interface SynthesisCacheWriteResult {
  blocks: SynthesisCacheBlock[];
  skipped?: number;
  skippedReasonCounts?: Record<string, number>;
}
export type SynthesisCacheLoader = (
  input: SynthesisCacheLoadInput,
) => Promise<SynthesisCacheLoadResult> | SynthesisCacheLoadResult;
export type SynthesisCacheWriter = (
  input: SynthesisCacheWriteInput,
) => Promise<SynthesisCacheWriteResult | void> | SynthesisCacheWriteResult | void;

export interface AiSdkBackendInput {
  // ── Session context ────────────────────────────────────────────────────
  sessionId: string;
  header: SessionHeader;
  /** Append-message function bound to this session (e.g. SessionStore wrapper). */
  appendMessage: AppendMessageFn;

  // ── Provider / model resolution (resolved by BackendRegistry) ──────────
  connection: LlmConnection;
  apiKey: string;
  modelId: string;

  // ── Process-singleton deps ─────────────────────────────────────────────
  permissionEngine: PermissionEngine;
  modelFactory: ModelFactory;
  /** Canonical-named tools available this session. Backend wraps each with
   *  permission gating before passing to ai-sdk. */
  tools: MakaTool[];

  // ── Optional knobs (defaults shown) ────────────────────────────────────
  /** ID generator; default `crypto.randomUUID()`. */
  newId?: () => string;
  /** Clock; default `Date.now()`. */
  now?: () => number;
  /** Cap on tool-call steps per turn; default 50. */
  maxSteps?: number;
  /** Timeout before first SDK stream event; default 30s. */
  streamConnectTimeoutMs?: number;
  /** Timeout between SDK/tool events; paused while waiting on permission. Default 120s. */
  streamIdleTimeoutMs?: number;
  /** Timeout for a renderer/user permission decision. Default 300s. */
  permissionTimeoutMs?: number;
  /** Optional system prompt (skills + workspace AGENTS.md merged upstream). */
  systemPrompt?: string | ((context: SystemPromptContext) => string | undefined | Promise<string | undefined>);
  /** Optional provider-visible current-turn tail kept out of the durable system prefix. */
  turnTailPrompt?: string | ((context: SystemPromptContext) => string | undefined | Promise<string | undefined>);
  /** Provider-native options passed through to ai-sdk. */
  providerOptions?: Record<string, unknown>;
  /** Optional prior-history budget. Keeps whole turns to preserve tool-call/result pairs. */
  contextBudget?: ContextBudgetPolicy;
  /** Optional fire-and-forget telemetry hooks. Tool implementations remain unaware. */
  recordLlmCall?: LlmTelemetryRecorder;
  recordToolInvocation?: ToolTelemetryRecorder;
  /** Optional diagnostic trace hook for explaining a runtime turn without changing renderer events. */
  recordRunTrace?: RunTraceRecorder;
  /**
   * Optional artifact recorder. Runtime derives only deterministic candidates
   * from structured tool results / explicit redirects; desktop main owns
   * file-backed persistence.
   */
  recordToolArtifacts?: ToolArtifactRecorder;
  /**
   * Optional archive writer for replay-only stale tool-result pruning. The
   * runtime rewrites only candidates whose original body has been durably
   * archived by this callback.
   */
  archiveToolResult?: ToolResultArchiveRecorder;
  /**
   * Optional archive reader for replay-only stale tool-result retrieval. The
   * runtime never mutates persisted RuntimeEvents; successful reads hydrate
   * the current model request only.
   */
  readToolResultArchive?: ToolResultArchiveReader;
  /** Optional best-effort source-bearing synthesis cache loader. */
  loadSynthesisCache?: SynthesisCacheLoader;
  /** Optional best-effort source-bearing synthesis cache writer. */
  writeSynthesisCache?: SynthesisCacheWriter;
}

export interface SystemPromptContext {
  sessionId: string;
  cwd: string;
  workspaceRoot: string;
}

// ============================================================================
// Implementation
// ============================================================================

export class AiSdkBackend implements AgentBackend {
  readonly kind: BackendKind = 'ai-sdk';
  readonly sessionId: string;

  // Pulled out of the input for ergonomic access on hot paths.
  private readonly input: AiSdkBackendInput;
  private readonly newId: () => string;
  private readonly now: () => number;
  private readonly maxSteps: number;
  private readonly toolRuntime: ToolRuntime;
  private readonly modelAdapter: ModelAdapter;

  private aborted = false;
  private abortController: AbortController | null = null;
  private currentTurnId: string | null = null;
  /** Side-channel for tool.execute() callbacks to push events into the iterator. */
  private currentQueue: AsyncEventQueue<SessionEvent> | null = null;
  /** Paused while the backend is waiting on a user permission decision. */
  private currentWatchdog: StreamWatchdog | null = null;
  private currentRunTrace: RunTrace | null = null;
  private priorRequestShape: RequestShapeDiagnostic | undefined;

  constructor(input: AiSdkBackendInput) {
    this.input = input;
    this.sessionId = input.sessionId;
    this.newId = input.newId ?? (() => crypto.randomUUID());
    this.now = input.now ?? (() => Date.now());
    this.maxSteps = input.maxSteps ?? 50;
    this.modelAdapter = new ModelAdapter({
      connection: input.connection,
      apiKey: input.apiKey,
      modelId: input.modelId,
      modelFactory: input.modelFactory,
      providerOptions: input.providerOptions,
      maxSteps: this.maxSteps,
      newId: this.newId,
      now: this.now,
    });
    this.toolRuntime = new ToolRuntime({
      sessionId: input.sessionId,
      header: input.header,
      connection: input.connection,
      modelId: input.modelId,
      appendMessage: input.appendMessage,
      permissionEngine: input.permissionEngine,
      newId: this.newId,
      now: this.now,
      getPermissionPauseTarget: () => this.currentWatchdog,
      getRunTrace: () => this.currentRunTrace,
      permissionTimeoutMs: input.permissionTimeoutMs,
      recordToolInvocation: input.recordToolInvocation,
      recordToolArtifacts: input.recordToolArtifacts,
    });
  }

  // --------------------------------------------------------------------------
  // send()
  // --------------------------------------------------------------------------

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const turnId = input.turnId;
    this.currentTurnId = turnId;
    this.input.permissionEngine.beginTurn(turnId);
    this.abortController = new AbortController();

    const queue = new AsyncEventQueue<SessionEvent>();
    this.currentQueue = queue;

    const assistantMessageId = this.newId();
    let assistantText = '';
    let thinkingText = '';
    let thinkingSignature: string | undefined;
    const startedAt = this.now();
    let tokenUsage: NormalizedAiSdkUsage | undefined;
    let streamStatus: LlmCallRecord['status'] = 'success';
    let streamErrorClass: string | undefined;
    let rawFinishReason: string | undefined;
    let requestShapeForTelemetry: RequestShapeDiagnostic | undefined;
    let promptSegmentsForTelemetry: PromptSegmentEstimate[] = [];
    let contextBudgetForTelemetry: ContextBudgetDiagnostic | undefined;
    const trace = new RunTrace({
      sessionId: this.sessionId,
      turnId,
      connectionSlug: this.input.connection.slug,
      providerId: this.input.connection.providerType,
      modelId: this.input.modelId,
      newId: this.newId,
      now: this.now,
      record: this.input.recordRunTrace,
    });
    this.currentRunTrace = trace;
    trace.turnStarted();

    // --- Resolve model (API key already attached at construct time) ---
    let model: unknown;
    try {
      model = this.modelAdapter.resolveModel();
      trace.modelResolved();
    } catch (err) {
      trace.modelResolveFailed(err);
      queue.push(this.makeErrorEvent(turnId, err));
      queue.push({
        type: 'complete',
        id: this.newId(),
        turnId,
        ts: this.now(),
        stopReason: 'error',
      } satisfies CompleteEvent);
      queue.close();
      this.cleanupAfterTurn(turnId);
      yield* this.drain(queue);
      return;
    }

    // --- Build ai-sdk tools dict with permission-wrapped execute ---
    const canonicalTools = canonicalizeToolSet(this.input.tools, buildInvalidMakaTool());
    const aiSdkTools: Record<string, unknown> = {};
    for (const t of canonicalTools.providerTools) {
      aiSdkTools[t.name] = {
        description: t.description,
        inputSchema: t.parameters,
        execute: this.wrapToolExecute(t, turnId, queue),
      };
    }

    // --- Build messages from RuntimeEvent history and its compatibility projection. ---
    const priorReplay = await this.buildPriorMessages(input);

    // --- Background pump: streamText → fullStream → normalize → queue ---
    const pumpDone: Promise<void> = (async () => {
      let watchdog: StreamWatchdog | null = null;
      let watchdogTimeoutError: Error | null = null;
      try {
        watchdog = new StreamWatchdog({
          now: this.now,
          connectTimeoutMs: this.input.streamConnectTimeoutMs,
          idleTimeoutMs: this.input.streamIdleTimeoutMs,
          onTimeout: (timeout) => {
            const message = formatStreamWatchdogError(timeout);
            watchdogTimeoutError = new Error(message);
            queue.push(this.makeErrorEvent(turnId, watchdogTimeoutError));
            trace.modelStreamFailed('Timeout', watchdogTimeoutError);
            this.abortController?.abort(watchdogTimeoutError);
          },
        });
        this.currentWatchdog = watchdog;
        watchdog.start();
        const activeTools = canonicalTools.activeTools;
        const systemPrompt = await this.resolveSystemPrompt();
        const turnTailPrompt = await this.resolveTurnTailPrompt();
        const currentUserContent = formatTextWithAttachmentRefs(input.text, input.attachments);
        const messages = [
          ...priorReplay.messages,
          {
            role: 'user' as const,
            content: this.appendTurnTailPrompt(currentUserContent, turnTailPrompt),
          },
        ];
        const promptSegments = buildPromptSegmentEstimates({
          systemPrompt,
          toolSchemaChars: toolSchemaCharsForDiagnostics(canonicalTools.providerTools, activeTools),
          toolCount: canonicalTools.providerTools.length,
          priorMessages: priorReplay.messages,
          priorRuntimeEventCount: priorReplay.runtimeEventCount,
          currentUserContent,
          turnTailPrompt,
        });
        promptSegmentsForTelemetry = promptSegments;
        contextBudgetForTelemetry = priorReplay.contextBudget;
        const requestShape = computeRequestShapeDiagnostic({
          connection: this.input.connection,
          modelId: this.input.modelId,
          systemPrompt,
          providerOptions: this.input.providerOptions,
          providerTools: canonicalTools.providerTools,
          activeTools,
          priorMessages: priorReplay.messages,
        }, this.priorRequestShape);
        if (priorReplay.contextBudget?.highWaterReason) {
          priorReplay.contextBudget.highWaterRequestShapeHashBefore = this.priorRequestShape?.requestShapeHash;
          priorReplay.contextBudget.highWaterRequestShapeHashAfter = requestShape.requestShapeHash;
        }
        requestShapeForTelemetry = requestShape;
        this.priorRequestShape = requestShape;
        trace.modelStreamStarted(activeTools, {
          prefixHash: requestShape.prefixHash,
          prefixChangeReason: requestShape.prefixChangeReason,
          requestShapeHash: requestShape.requestShapeHash,
          requestShapeChangeReason: requestShape.requestShapeChangeReason,
          promptSegments,
          ...(priorReplay.contextBudget ? { contextBudget: priorReplay.contextBudget } : {}),
        });

        const result = await this.modelAdapter.startStream({
          model,
          messages,
          tools: aiSdkTools,
          activeTools,
          repairToolCall: async (
            { toolCall, error }: { toolCall: RepairableAiSdkToolCall; error: unknown },
          ) => {
            return repairMakaToolCall({
              toolCall,
              availableToolNames: activeTools,
              error,
            });
          },
          system: systemPrompt,
          abortSignal: this.abortController!.signal,
        });

        for await (const chunk of result.fullStream) {
          if (this.aborted) break;
          watchdog.markActivity();
          if (chunk.type === 'finish' || chunk.type === 'step-finish') {
            rawFinishReason = rawFinishReasonString(chunk.finishReason) ?? rawFinishReason;
          }
          this.modelAdapter.handleStreamChunk(chunk, turnId, assistantMessageId, queue, {
            onText: (t) => { assistantText += t; },
            onTextComplete: (t) => { assistantText = t; },
            onThinking: (t) => { thinkingText += t; },
            onThinkingComplete: (t, sig) => { thinkingText = t; thinkingSignature = sig; },
          });
        }

        // PR-AGENT-ITERATION-GRACE-0 (external bot research #A1): when the
        // ai-sdk loop exits with `finishReason === 'tool-calls'` it
        // means we tripped `stopWhen: stepCountIs(maxSteps)` mid-loop
        // — the model wanted to keep calling tools but we capped it.
        // The user previously saw no closing assistant text in that
        // path; just the last tool result. Inject a deterministic
        // "step cap reached" notice so the UI has SOMETHING and the
        // user can choose to send "继续" for a fresh turn.
        const finishReasonForGrace = await result.finishReason.catch(() => 'stop');
        rawFinishReason = rawFinishReason ?? rawFinishReasonString(finishReasonForGrace);
        if (
          !this.aborted
          && assistantText.length === 0
          && finishReasonForGrace === 'tool-calls'
        ) {
          assistantText =
            `⚠️ 已达到本轮 ${this.maxSteps} 步工具调用上限。\n\n`
            + '上一步工具调用已落盘；如果还需要继续，请发一条新消息让对话进入下一回合（可以直接输入「继续」）。';
        }

        // Persist assistant message if we got one.
        if (assistantText.length > 0) {
          const msg: AssistantMessage = {
            type: 'assistant',
            id: assistantMessageId,
            turnId,
            ts: this.now(),
            text: assistantText,
            modelId: this.input.modelId,
            ...(thinkingText.length > 0
              ? {
                  thinking: {
                    text: thinkingText,
                    ...(thinkingSignature !== undefined ? { signature: thinkingSignature } : {}),
                  },
                }
              : {}),
          };
          await this.input.appendMessage(msg);
          queue.push({
            type: 'text_complete',
            id: this.newId(),
            turnId,
            ts: this.now(),
            messageId: assistantMessageId,
            text: assistantText,
          } satisfies TextCompleteEvent);
        }

        // Final usage event (await result.usage which resolves once stream ends).
        try {
          tokenUsage = normalizeAiSdkUsage(await result.usage, { rawFinishReason });
          if (tokenUsage) {
            trace.usageRecorded({
              ...tokenUsage,
              prefixHash: requestShape.prefixHash,
              prefixChangeReason: requestShape.prefixChangeReason,
              requestShapeHash: requestShape.requestShapeHash,
              requestShapeChangeReason: requestShape.requestShapeChangeReason,
            });
            const tu: TokenUsageMessage = {
              type: 'token_usage',
              id: this.newId(),
              turnId,
              ts: this.now(),
              input: tokenUsage.inputTokens,
              output: tokenUsage.outputTokens,
              cacheHitInput: tokenUsage.cacheHitInputTokens,
              cacheMissInput: tokenUsage.cacheMissInputTokens,
              cacheMissInputSource: tokenUsage.cacheMissInputSource,
              cacheWriteInput: tokenUsage.cacheWriteInputTokens,
              reasoning: tokenUsage.reasoningTokens,
              total: tokenUsage.totalTokens,
              ...(tokenUsage.rawFinishReason !== undefined ? { rawFinishReason: tokenUsage.rawFinishReason } : {}),
              ...(tokenUsage.cachedInputTokens > 0 ? { cacheRead: tokenUsage.cachedInputTokens } : {}),
              ...(tokenUsage.cacheWriteInputTokens > 0 ? { cacheCreation: tokenUsage.cacheWriteInputTokens } : {}),
              prefixHash: requestShape.prefixHash,
              prefixChangeReason: requestShape.prefixChangeReason,
              requestShapeHash: requestShape.requestShapeHash,
              requestShapeChangeReason: requestShape.requestShapeChangeReason,
              promptSegments,
              ...(priorReplay.contextBudget ? { contextBudget: priorReplay.contextBudget } : {}),
            };
            await this.input.appendMessage(tu).catch(() => {});
            queue.push({
              type: 'token_usage',
              id: this.newId(),
              turnId,
              ts: this.now(),
              input: tokenUsage.inputTokens,
              output: tokenUsage.outputTokens,
              cacheHitInput: tokenUsage.cacheHitInputTokens,
              cacheMissInput: tokenUsage.cacheMissInputTokens,
              cacheMissInputSource: tokenUsage.cacheMissInputSource,
              cacheWriteInput: tokenUsage.cacheWriteInputTokens,
              reasoning: tokenUsage.reasoningTokens,
              total: tokenUsage.totalTokens,
              ...(tokenUsage.rawFinishReason !== undefined ? { rawFinishReason: tokenUsage.rawFinishReason } : {}),
              ...(tokenUsage.cachedInputTokens > 0 ? { cacheRead: tokenUsage.cachedInputTokens } : {}),
              ...(tokenUsage.cacheWriteInputTokens > 0 ? { cacheCreation: tokenUsage.cacheWriteInputTokens } : {}),
              prefixHash: requestShape.prefixHash,
              prefixChangeReason: requestShape.prefixChangeReason,
              requestShapeHash: requestShape.requestShapeHash,
              requestShapeChangeReason: requestShape.requestShapeChangeReason,
              promptSegments,
              ...(priorReplay.contextBudget ? { contextBudget: priorReplay.contextBudget } : {}),
            } satisfies TokenUsageEvent);
          }
        } catch {
          // best-effort; ai-sdk usage promise may reject on abort
        }

        const finishReason = await result.finishReason.catch(() => 'stop');
        const stopReason = this.mapFinishReason(finishReason);
        trace.modelStreamCompleted(stopReason);
        queue.push({
          type: 'complete',
          id: this.newId(),
          turnId,
          ts: this.now(),
          stopReason,
        } satisfies CompleteEvent);
      } catch (err) {
        streamStatus = this.aborted ? 'aborted' : 'error';
        streamErrorClass = this.modelAdapter.classifyError(watchdogTimeoutError ?? err);
        if (this.aborted) {
          queue.push({
            type: 'abort',
            id: this.newId(),
            turnId,
            ts: this.now(),
            reason: 'user_stop',
          } satisfies AbortEvent);
          queue.push({
            type: 'complete',
            id: this.newId(),
            turnId,
            ts: this.now(),
            stopReason: 'user_stop',
          } satisfies CompleteEvent);
        } else {
          if (!watchdogTimeoutError) {
            queue.push(this.makeErrorEvent(turnId, err));
            trace.modelStreamFailed(streamErrorClass, err);
          }
          queue.push({
            type: 'complete',
            id: this.newId(),
            turnId,
            ts: this.now(),
            stopReason: 'error',
          } satisfies CompleteEvent);
        }
      } finally {
        watchdog?.stop();
        if (this.currentWatchdog === watchdog) this.currentWatchdog = null;
        this.input.recordLlmCall?.({
          sessionId: this.sessionId,
          turnId,
          connectionSlug: this.input.connection.slug,
          providerId: this.input.connection.providerType,
          modelId: this.input.modelId,
          inputTokens: tokenUsage?.inputTokens ?? 0,
          outputTokens: tokenUsage?.outputTokens ?? 0,
          cacheHitInputTokens: tokenUsage?.cacheHitInputTokens ?? 0,
          cacheMissInputTokens: tokenUsage?.cacheMissInputTokens ?? 0,
          ...(tokenUsage?.cacheMissInputSource !== undefined
            ? { cacheMissInputSource: tokenUsage.cacheMissInputSource }
            : {}),
          cachedInputTokens: tokenUsage?.cachedInputTokens ?? 0,
          cacheWriteInputTokens: tokenUsage?.cacheWriteInputTokens ?? 0,
          reasoningTokens: tokenUsage?.reasoningTokens ?? 0,
          totalTokens: tokenUsage?.totalTokens,
          ...(tokenUsage?.rawFinishReason !== undefined ? { rawFinishReason: tokenUsage.rawFinishReason } : {}),
          ...(tokenUsage?.raw !== undefined ? { rawUsage: tokenUsage.raw } : {}),
          latencyMs: Math.max(0, this.now() - startedAt),
          status: streamStatus,
          ...(streamErrorClass ? { errorClass: streamErrorClass } : {}),
          startedAt,
          ...(requestShapeForTelemetry !== undefined ? {
            prefixHash: requestShapeForTelemetry.prefixHash,
            prefixChangeReason: requestShapeForTelemetry.prefixChangeReason,
            requestShapeHash: requestShapeForTelemetry.requestShapeHash,
            requestShapeChangeReason: requestShapeForTelemetry.requestShapeChangeReason,
          } : {}),
          ...(promptSegmentsForTelemetry.length > 0 ? { promptSegments: promptSegmentsForTelemetry } : {}),
          ...(contextBudgetForTelemetry !== undefined ? { contextBudget: contextBudgetForTelemetry } : {}),
        });
        queue.close();
      }
    })();

    try {
      for await (const ev of queue) yield ev;
    } finally {
      await pumpDone.catch(() => {});
      this.cleanupAfterTurn(turnId);
    }
  }

  // --------------------------------------------------------------------------
  // wrapToolExecute — the permission-gating seam
  // --------------------------------------------------------------------------

  private wrapToolExecute(
    tool: MakaTool,
    turnId: string,
    queue: AsyncEventQueue<SessionEvent>,
  ) {
    return this.toolRuntime.wrapToolExecute(tool, turnId, queue);
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  async stop(_reason: 'user_stop' | 'redirect'): Promise<void> {
    this.aborted = true;
    this.abortController?.abort();
    if (this.currentTurnId !== null) {
      this.input.permissionEngine.endTurn(this.currentTurnId, 'aborted');
    }
    this.currentRunTrace?.abortRequested(_reason);
  }

  async respondToPermission(decision: PermissionDecision): Promise<void> {
    if (this.currentTurnId === null) return;
    this.input.permissionEngine.recordResponse(this.currentTurnId, decision);
    // PermissionDecisionMessage + ack event are written inside wrapToolExecute
    // after parked.resolve() returns, so no further work here.
  }

  async dispose(): Promise<void> {
    if (!this.aborted) await this.stop('user_stop');
  }

  private writeSyntheticToolResult(
    toolUseId: string,
    turnId: string,
    text: string,
    queue: AsyncEventQueue<SessionEvent>,
  ): Promise<void> {
    return this.toolRuntime.writeSyntheticToolResult(toolUseId, turnId, text, queue);
  }

  /** Map ai-sdk finishReason → our CompleteEvent.stopReason. */
  private mapFinishReason(reason: unknown): CompleteEvent['stopReason'] {
    return this.modelAdapter.mapFinishReason(reason);
  }

  private makeErrorEvent(turnId: string, err: unknown): ErrorEvent {
    return this.modelAdapter.makeErrorEvent(turnId, err);
  }

  /** Materialize RuntimeEvent-derived projections into ai-sdk's message format.
   *  V0.1: text-only round-tripping. Tool calls / results within projected
   *  history are deliberately NOT replayed unless RuntimeEvent native replay
   *  is available for the provider. */
  private async buildPriorMessages(input: BackendSendInput): Promise<{
    messages: ModelMessage[];
    gate: RuntimeEventReplayFallbackGate | 'stored_message_projection';
    diagnostics: RuntimeEventModelReplayPlan['diagnostics'];
    runtimeEventCount?: number;
    contextBudget?: ContextBudgetDiagnostic;
  }> {
    const projectedMessages = this.materializePriorMessages(
      input.context.filter((message) => message.turnId !== input.turnId),
    );
    if (!input.runtimeContext) {
      return { messages: projectedMessages, gate: 'stored_message_projection', diagnostics: [] };
    }
    const priorRuntimeContext = input.runtimeContext.filter((event) => event.turnId !== input.turnId);
    const preparedContextBudget = await this.prepareContextBudgetPolicy(priorRuntimeContext);
    const contextBudget = preparedContextBudget.policy;
    const budgeted = applyRuntimeEventContextBudget(priorRuntimeContext, contextBudget);
    let runtimeContext = budgeted?.events
      ?? priorRuntimeContext;
    let contextBudgetDiagnostic = budgeted?.diagnostic;
    if (preparedContextBudget.diagnosticPatch) {
      contextBudgetDiagnostic = mergeContextBudgetDiagnostic(
        contextBudgetDiagnostic ?? buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
        preparedContextBudget.diagnosticPatch,
      );
    }

    const historySearchSource = buildHistorySearchSource(priorRuntimeContext, contextBudget);
    const historyAround = retrieveRuntimeEventHistoryAround(
      historySearchSource,
      input.text,
      contextBudget?.historySearch,
      { charsPerToken: contextBudget?.charsPerToken },
    );
    const archiveRetrievalAllowedTurnIds = contextBudget?.archiveRetrieval?.mode === 'history_search_gated'
      ? new Set(historyAround.events.map((event) => runtimeEventTurnKey(event)))
      : undefined;
    if (historyAround.events.length > 0) {
      runtimeContext = mergeRuntimeEventsInOriginalOrder(priorRuntimeContext, runtimeContext, historyAround.events);
      contextBudgetDiagnostic = mergeContextBudgetDiagnostic(
        contextBudgetDiagnostic ?? buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
        historyAround.diagnosticPatch,
      );
    } else if (contextBudget?.historySearch?.enabled === true) {
      contextBudgetDiagnostic = mergeContextBudgetDiagnostic(
        contextBudgetDiagnostic ?? buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
        historyAround.diagnosticPatch,
      );
    }

    const synthesis = selectSynthesisCacheForReplay(
      runtimeContext,
      input.text,
      contextBudget?.synthesisCache,
      {
        sessionId: this.sessionId,
        charsPerToken: contextBudget?.charsPerToken,
      },
    );
    runtimeContext = synthesis.events;
    if (contextBudget?.synthesisCache?.enabled === true) {
      contextBudgetDiagnostic = mergeContextBudgetDiagnostic(
        contextBudgetDiagnostic ?? buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
        synthesis.diagnosticPatch,
      );
    }

    if (synthesis.selectedBlocks.length === 0) {
      const retrieval = await retrieveArchivedToolResultsForReplay(
        runtimeContext,
        contextBudget?.archiveRetrieval,
        this.input.readToolResultArchive,
        {
          sessionId: this.sessionId,
          charsPerToken: contextBudget?.charsPerToken,
          allowedTurnIds: archiveRetrievalAllowedTurnIds,
        },
      );
      runtimeContext = retrieval.events;
      if (contextBudget?.archiveRetrieval?.enabled === true) {
        contextBudgetDiagnostic = mergeContextBudgetDiagnostic(
          contextBudgetDiagnostic ?? buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
          retrieval.diagnosticPatch,
        );
      }
      if (
        contextBudget?.synthesisCache?.enabled === true &&
        contextBudget.synthesisCache.mode === 'read_write' &&
        this.input.writeSynthesisCache &&
        (retrieval.retrievedSourceRefs?.length ?? 0) > 0 &&
        (retrieval.diagnosticPatch.retrievedArchiveToolResults ?? 0) > 0
      ) {
        const evidenceRequestReason = rawEvidenceRequestReason(input.text);
        if (evidenceRequestReason) {
          contextBudgetDiagnostic = mergeContextBudgetDiagnostic(
            contextBudgetDiagnostic ?? buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
            {
              synthesisCacheWriteSkipped: 1,
              synthesisCacheWriteSkippedReasonCounts: { [evidenceRequestReason]: 1 },
            },
          );
        } else {
          const writePatch = await this.writeSynthesisCacheBlocks({
            turnId: input.turnId,
            query: input.text,
            hydratedRuntimeEvents: runtimeContext,
            retrievedArchiveRefs: retrieval.retrievedSourceRefs ?? [],
            archiveRetrievalMode: contextBudget.archiveRetrieval?.mode ?? 'eager',
            contextBudget,
          });
          contextBudgetDiagnostic = mergeContextBudgetDiagnostic(
            contextBudgetDiagnostic ?? buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
            writePatch,
          );
        }
      } else if (
        contextBudget?.synthesisCache?.enabled === true &&
        contextBudget.synthesisCache.mode === 'read_write' &&
        synthesis.selectedBlocks.length === 0 &&
        (retrieval.diagnosticPatch.retrievedArchiveToolResults ?? 0) === 0
      ) {
        contextBudgetDiagnostic = mergeContextBudgetDiagnostic(
          contextBudgetDiagnostic ?? buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
          {
            synthesisCacheWriteSkipped: 1,
            synthesisCacheWriteSkippedReasonCounts: { source_missing: 1 },
          },
        );
      }
    }

    const plan = buildRuntimeEventModelReplayPlan(
      runtimeContext,
    );
    if (plan.items.length === 0) {
      return {
        messages: projectedMessages,
        gate: 'stored_message_projection',
        diagnostics: plan.diagnostics,
        runtimeEventCount: runtimeContext.length,
        ...(contextBudgetDiagnostic ? { contextBudget: contextBudgetDiagnostic } : {}),
      };
    }

    if (hasBlockingReplayDiagnostics(plan)) {
      return {
        messages: projectedMessages,
        gate: 'runtime_replay_unsupported_semantics',
        diagnostics: plan.diagnostics,
        runtimeEventCount: runtimeContext.length,
        ...(contextBudgetDiagnostic ? { contextBudget: contextBudgetDiagnostic } : {}),
      };
    }

    if (!plan.hasProviderNativeSemantics) {
      return {
        messages: plan.textMessages,
        gate: 'runtime_replay_text_only',
        diagnostics: plan.diagnostics,
        runtimeEventCount: runtimeContext.length,
        ...(contextBudgetDiagnostic ? { contextBudget: contextBudgetDiagnostic } : {}),
      };
    }

    if (!this.canReplayProviderNative(plan)) {
      return {
        messages: projectedMessages,
        gate: 'runtime_replay_unsupported_semantics',
        diagnostics: plan.diagnostics,
        runtimeEventCount: runtimeContext.length,
        ...(contextBudgetDiagnostic ? { contextBudget: contextBudgetDiagnostic } : {}),
      };
    }

    return {
      messages: this.materializeRuntimeReplayPlan(plan),
      gate: 'runtime_replay_provider_native',
      diagnostics: plan.diagnostics,
      runtimeEventCount: runtimeContext.length,
      ...(contextBudgetDiagnostic ? { contextBudget: contextBudgetDiagnostic } : {}),
    };
  }

  private async prepareContextBudgetPolicy(
    runtimeContext: readonly RuntimeEvent[],
  ): Promise<{ policy: ContextBudgetPolicy | undefined; diagnosticPatch?: Partial<ContextBudgetDiagnostic> }> {
    const policy = this.input.contextBudget;
    if (!policy) return { policy };
    let nextPolicy = policy;

    if (policy.staleToolResultPrune?.enabled === true) {
      const candidates = collectStaleToolResultArchiveCandidates(runtimeContext, policy);
      if (candidates.length > 0) {
        const archiveRefs: ToolResultArchiveRef[] = [];
        for (const candidate of candidates) {
          const bodySha256 = sha256(candidate.serializedResult);
          const archived = await Promise.resolve(this.input.archiveToolResult?.({
            ...candidate,
            sessionId: this.sessionId,
            bodySha256,
          })).catch(() => undefined);
          if (!archived?.artifactId) continue;
          archiveRefs.push({
            runtimeEventId: candidate.runtimeEventId,
            toolCallId: candidate.toolCallId,
            toolName: candidate.toolName,
            artifactId: archived.artifactId,
            bodySha256,
            originalEstimatedTokens: candidate.originalEstimatedTokens,
            originalBytes: candidate.originalBytes,
            rewriteVersion: ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
            reason: candidate.reason,
          });
        }

        nextPolicy = {
          ...nextPolicy,
          staleToolResultPrune: {
            ...nextPolicy.staleToolResultPrune!,
            archiveRefs,
          },
        };
      }
    }

    const loadPatch = await this.loadSynthesisCacheBlocks(nextPolicy);
    if (loadPatch.policy !== nextPolicy) nextPolicy = loadPatch.policy;
    return {
      policy: nextPolicy,
      ...(loadPatch.diagnosticPatch ? { diagnosticPatch: loadPatch.diagnosticPatch } : {}),
    };
  }

  private async loadSynthesisCacheBlocks(
    policy: ContextBudgetPolicy,
  ): Promise<{ policy: ContextBudgetPolicy; diagnosticPatch?: Partial<ContextBudgetDiagnostic> }> {
    const synthesisCache = policy.synthesisCache;
    if (synthesisCache?.enabled !== true || !this.input.loadSynthesisCache) {
      return { policy };
    }
    if ((synthesisCache.blocks?.length ?? 0) > 0) {
      return { policy };
    }
    try {
      const result = await Promise.resolve(this.input.loadSynthesisCache({
        sessionId: this.sessionId,
        maxBlocks: synthesisCache.maxBlocks,
        maxEstimatedTokens: synthesisCache.maxEstimatedTokens,
        maxBytes: (synthesisCache.maxEstimatedTokens ?? 2_048) * (policy.charsPerToken ?? 4),
      }));
      const blocks = result.blocks ?? [];
      return {
        policy: {
          ...policy,
          synthesisCache: {
            ...synthesisCache,
            blocks,
          },
        },
        diagnosticPatch: {
          synthesisCacheEnabled: true,
          synthesisCacheMode: synthesisCache.mode ?? 'lookup',
          synthesisCacheBlocksLoaded: blocks.length,
          synthesisCacheBlocksAvailable: blocks.length,
          ...(result.skipped && result.skipped > 0 ? { synthesisCacheLoadSkipped: result.skipped } : {}),
          ...(result.skippedReasonCounts ? { synthesisCacheLoadSkippedReasonCounts: result.skippedReasonCounts } : {}),
          ...(result.evicted && result.evicted > 0 ? { synthesisCacheEvicted: result.evicted } : {}),
          ...(result.evictionReasonCounts ? { synthesisCacheEvictionReasonCounts: result.evictionReasonCounts } : {}),
        },
      };
    } catch {
      return {
        policy,
        diagnosticPatch: {
          synthesisCacheEnabled: true,
          synthesisCacheMode: synthesisCache.mode ?? 'lookup',
          synthesisCacheLoadFailures: 1,
        },
      };
    }
  }

  private async writeSynthesisCacheBlocks(input: {
    turnId: string;
    query: string;
    hydratedRuntimeEvents: RuntimeEvent[];
    retrievedArchiveRefs: SynthesisSourceRef[];
    archiveRetrievalMode: ArchiveRetrievalMode;
    contextBudget: ContextBudgetPolicy;
  }): Promise<Partial<ContextBudgetDiagnostic>> {
    const synthesisCache = input.contextBudget.synthesisCache;
    if (synthesisCache?.enabled !== true || synthesisCache.mode !== 'read_write' || !this.input.writeSynthesisCache) {
      return {};
    }
    const limits = {
      maxBlocks: synthesisCache.maxBlocks ?? 1,
      maxBlockEstimatedTokens: synthesisCache.maxBlockEstimatedTokens ?? 1_024,
      maxEstimatedTokens: synthesisCache.maxEstimatedTokens ?? 2_048,
      charsPerToken: input.contextBudget.charsPerToken ?? 4,
    };
    try {
      const result = await Promise.resolve(this.input.writeSynthesisCache({
        sessionId: this.sessionId,
        turnId: input.turnId,
        source: {
          createdFrom: input.archiveRetrievalMode === 'history_search_gated'
            ? 'gated_archive_retrieval'
            : 'eager_archive_retrieval',
          query: input.query,
          hydratedRuntimeEvents: input.hydratedRuntimeEvents,
          retrievedArchiveRefs: input.retrievedArchiveRefs,
          archiveRetrievalMode: input.archiveRetrievalMode,
        },
        limits,
        requestShapeHashBefore: this.priorRequestShape?.requestShapeHash,
      }));
      const blocks = result?.blocks ?? [];
      const estimatedTokens = blocks.reduce((total, block) => total + (block.estimatedTokens ?? 0), 0);
      return {
        synthesisCacheEnabled: true,
        synthesisCacheMode: 'read_write',
        synthesisCacheWritesAttempted: 1,
        synthesisCacheBlocksWritten: blocks.length,
        ...(blocks.length > 0 ? {
          synthesisCacheWrittenBlockIds: blocks.map((block) => block.blockId),
          synthesisCacheWriteEstimatedTokens: estimatedTokens,
          highWaterName: blocks[0]!.highWaterName,
          highWaterSeq: blocks[0]!.highWaterSeq,
          highWaterReason: 'synthesis_cache_write',
        } : {}),
        ...(result?.skipped && result.skipped > 0 ? { synthesisCacheWriteSkipped: result.skipped } : {}),
        ...(result?.skippedReasonCounts ? { synthesisCacheWriteSkippedReasonCounts: result.skippedReasonCounts } : {}),
      };
    } catch {
      return {
        synthesisCacheEnabled: true,
        synthesisCacheMode: 'read_write',
        synthesisCacheWritesAttempted: 1,
        synthesisCacheWriteFailures: 1,
      };
    }
  }

  private canReplayProviderNative(plan: RuntimeEventModelReplayPlan): boolean {
    const support = this.modelAdapter.runtimeEventReplaySupport();
    for (const item of plan.items) {
      if (item.kind === 'tool_call' && !support.toolCalls) return false;
      if (item.kind === 'tool_result' && !support.toolResults) return false;
      if (item.kind === 'thinking' && (!support.signedThinking || !item.signature)) return false;
    }
    return true;
  }

  private materializeRuntimeReplayPlan(plan: RuntimeEventModelReplayPlan): ModelMessage[] {
    const out: ModelMessage[] = [];
    for (const item of plan.items) {
      out.push(this.materializeRuntimeReplayItem(item));
    }
    return out;
  }

  private materializeRuntimeReplayItem(item: RuntimeEventModelReplayItem): ModelMessage {
    switch (item.kind) {
      case 'text':
        return { role: item.role, content: item.content };
      case 'thinking':
        return {
          role: 'assistant',
          content: [{
            type: 'reasoning',
            text: item.text,
            providerOptions: {
              anthropic: { signature: item.signature },
            },
          }],
        };
      case 'tool_call':
        return {
          role: 'assistant',
          content: [{
            type: 'tool-call',
            toolCallId: item.toolCallId,
            toolName: item.toolName,
            input: item.input,
          }],
        };
      case 'tool_result':
        return {
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: item.toolCallId,
            toolName: item.toolName,
            output: toolResultOutput(item.output, item.isError),
          }],
        };
    }
  }

  private materializePriorMessages(stored: readonly StoredMessage[]): ModelMessage[] {
    const out: ModelMessage[] = [];
    for (const m of stored) {
      if (m.type === 'user') out.push({ role: 'user', content: m.text });
      else if (m.type === 'assistant') out.push({ role: 'assistant', content: m.text });
      // tool_call / tool_result / permission_decision / token_usage / system_note skipped
    }
    return out;
  }

  /** Append provider-visible volatile turn facts after the durable user content. */
  private appendTurnTailPrompt(content: string, turnTailPrompt?: string): string {
    if (!turnTailPrompt) return content;
    return `${content}\n\n${turnTailPrompt}`;
  }

  private async resolveSystemPrompt(): Promise<string | undefined> {
    if (typeof this.input.systemPrompt === 'function') {
      return await this.input.systemPrompt({
        sessionId: this.sessionId,
        cwd: this.input.header.cwd,
        workspaceRoot: this.input.header.workspaceRoot,
      });
    }
    return this.input.systemPrompt;
  }

  private async resolveTurnTailPrompt(): Promise<string | undefined> {
    if (typeof this.input.turnTailPrompt === 'function') {
      return await this.input.turnTailPrompt({
        sessionId: this.sessionId,
        cwd: this.input.header.cwd,
        workspaceRoot: this.input.header.workspaceRoot,
      });
    }
    return this.input.turnTailPrompt;
  }

  private async *drain(queue: AsyncEventQueue<SessionEvent>): AsyncIterable<SessionEvent> {
    for await (const ev of queue) yield ev;
  }

  private cleanupAfterTurn(turnId: string): void {
    this.input.permissionEngine.endTurn(turnId, this.aborted ? 'aborted' : 'completed');
    this.abortController = null;
    this.currentQueue = null;
    this.currentTurnId = null;
    this.currentRunTrace = null;
    this.toolRuntime.resetTurnState();
    this.aborted = false;
  }
}

export function repairMakaToolCall(input: {
  toolCall: RepairableAiSdkToolCall;
  availableToolNames: readonly string[];
  error: unknown;
}): RepairableAiSdkToolCall | null {
  const requestedName = input.toolCall.toolName;
  if (requestedName === INVALID_TOOL_NAME) return null;

  const lowerRequestedName = requestedName.toLowerCase();
  const exactLowercaseMatch = input.availableToolNames.find((name) => name.toLowerCase() === lowerRequestedName);
  if (exactLowercaseMatch && exactLowercaseMatch !== requestedName) {
    return { ...input.toolCall, toolName: exactLowercaseMatch };
  }

  return {
    ...input.toolCall,
    toolName: INVALID_TOOL_NAME,
    input: JSON.stringify({
      tool: requestedName,
      error: formatSyntheticToolErrorText(input.error),
    }),
  };
}

function buildInvalidMakaTool(): MakaTool<{ tool?: string; error?: string }, never> {
  return {
    name: INVALID_TOOL_NAME,
    description: 'Internal repair target for malformed or unknown tool calls. Do not call directly.',
    parameters: z.object({
      tool: z.string().optional(),
      error: z.string().optional(),
    }),
    permissionRequired: false,
    impl: ({ tool, error }) => {
      const requested = tool ? ` "${tool}"` : '';
      throw new Error(`模型请求了不可用或格式错误的工具${requested}：${error || 'tool call could not be parsed'}`);
    },
  };
}

function toolResultOutput(value: unknown, isError: boolean): AiSdkToolResultOutput {
  if (isError) {
    return typeof value === 'string'
      ? { type: 'error-text', value }
      : { type: 'error-json', value: jsonValue(value) };
  }
  return typeof value === 'string'
    ? { type: 'text', value }
    : { type: 'json', value: jsonValue(value) };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function hasBlockingReplayDiagnostics(plan: RuntimeEventModelReplayPlan): boolean {
  return plan.diagnostics.some((diagnostic) =>
    diagnostic.code === 'unsupported_role' ||
    diagnostic.code === 'unsupported_content' ||
    diagnostic.code === 'unsigned_thinking' ||
    diagnostic.code === 'unmatched_tool_result' ||
    diagnostic.code === 'tool_id_mismatch'
  );
}

function mergeRuntimeEventsInOriginalOrder(
  original: readonly RuntimeEvent[],
  current: readonly RuntimeEvent[],
  extra: readonly RuntimeEvent[],
): RuntimeEvent[] {
  const wantedIds = new Set<string>();
  const byId = new Map<string, RuntimeEvent>();
  for (const event of current) {
    wantedIds.add(event.id);
    byId.set(event.id, event);
  }
  for (const event of extra) {
    wantedIds.add(event.id);
    if (!byId.has(event.id)) byId.set(event.id, event);
  }
  const out: RuntimeEvent[] = [];
  for (const event of original) {
    if (!wantedIds.has(event.id)) continue;
    out.push(byId.get(event.id) ?? event);
  }
  return out;
}

function buildContextBudgetDiagnosticShell(
  before: readonly RuntimeEvent[],
  after: readonly RuntimeEvent[],
  policy: ContextBudgetPolicy | undefined,
): ContextBudgetDiagnostic {
  const charsPerToken = policy?.charsPerToken ?? 4;
  const turnCountBefore = new Set(before.map((event) => runtimeEventTurnKey(event))).size;
  const turnCountAfter = new Set(after.map((event) => runtimeEventTurnKey(event))).size;
  return {
    enabled: true,
    ...(policy?.name ? { policyName: policy.name } : {}),
    ...(policy?.maxHistoryEstimatedTokens !== undefined
      ? { maxHistoryEstimatedTokens: policy.maxHistoryEstimatedTokens }
      : {}),
    ...(policy?.maxHistoryTurns !== undefined ? { maxHistoryTurns: policy.maxHistoryTurns } : {}),
    estimatedTokensBefore: estimateRuntimeEventsTokens(before, charsPerToken),
    estimatedTokensAfter: estimateRuntimeEventsTokens(after, charsPerToken),
    keptTurns: turnCountAfter,
    droppedTurns: Math.max(0, turnCountBefore - turnCountAfter),
    keptEvents: after.length,
    droppedEvents: Math.max(0, before.length - after.length),
    ...(policy?.historyRewrite?.enabled === true
      ? {
          historyRewriteVersion: policy.historyRewrite.historyRewriteVersion,
          historyRewriteResetReason: policy.historyRewrite.resetReason,
          historyRewriteGate: policy.historyRewrite.name ?? 'history-rewrite',
        }
      : {}),
  };
}

function runtimeEventTurnKey(event: RuntimeEvent): string {
  return event.turnId || '<unknown-turn>';
}

function buildHistorySearchSource(
  events: readonly RuntimeEvent[],
  policy: ContextBudgetPolicy | undefined,
): readonly RuntimeEvent[] {
  if (policy?.staleToolResultPrune?.enabled !== true) return events;
  return applyRuntimeEventContextBudget(events, {
    ...policy,
    maxHistoryEstimatedTokens: undefined,
    maxHistoryTurns: undefined,
    archiveRetrieval: undefined,
    historySearch: undefined,
    historyRewrite: undefined,
  })?.events ?? events;
}

function mergeContextBudgetDiagnostic(
  base: ContextBudgetDiagnostic,
  patch: Partial<ContextBudgetDiagnostic>,
): ContextBudgetDiagnostic {
  return {
    ...base,
    ...patch,
    archiveRetrievalFailureReasonCounts: mergeCountRecords(
      base.archiveRetrievalFailureReasonCounts,
      patch.archiveRetrievalFailureReasonCounts,
    ),
    archiveRetrievalSkippedReasonCounts: mergeCountRecords(
      base.archiveRetrievalSkippedReasonCounts,
      patch.archiveRetrievalSkippedReasonCounts,
    ),
    synthesisCacheSkippedReasonCounts: mergeCountRecords(
      base.synthesisCacheSkippedReasonCounts,
      patch.synthesisCacheSkippedReasonCounts,
    ),
    synthesisCacheInvalidationReasonCounts: mergeCountRecords(
      base.synthesisCacheInvalidationReasonCounts,
      patch.synthesisCacheInvalidationReasonCounts,
    ),
    synthesisCacheLoadSkippedReasonCounts: mergeCountRecords(
      base.synthesisCacheLoadSkippedReasonCounts,
      patch.synthesisCacheLoadSkippedReasonCounts,
    ),
    synthesisCacheWriteSkippedReasonCounts: mergeCountRecords(
      base.synthesisCacheWriteSkippedReasonCounts,
      patch.synthesisCacheWriteSkippedReasonCounts,
    ),
    synthesisCacheEvictionReasonCounts: mergeCountRecords(
      base.synthesisCacheEvictionReasonCounts,
      patch.synthesisCacheEvictionReasonCounts,
    ),
  };
}

function mergeCountRecords(
  left: Record<string, number> | undefined,
  right: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!left && !right) return undefined;
  const out: Record<string, number> = { ...(left ?? {}) };
  for (const [key, value] of Object.entries(right ?? {})) {
    out[key] = (out[key] ?? 0) + value;
  }
  return out;
}

function jsonValue(value: unknown): JSONValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
    || Array.isArray(value)
    || typeof value === 'object'
  ) {
    return value as JSONValue;
  }
  return String(value);
}
