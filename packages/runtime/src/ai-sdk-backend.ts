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
  AttachmentRef,
} from '@maka/core/events';
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
import type { LlmCallRecord, ToolInvocationRecord } from '@maka/core/usage-stats/types';
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
  /** Provider-native options passed through to ai-sdk. */
  providerOptions?: Record<string, unknown>;
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
    const aiSdkTools: Record<string, unknown> = {};
    const allTools = [...this.input.tools, buildInvalidMakaTool()];
    for (const t of allTools) {
      aiSdkTools[t.name] = {
        description: t.description,
        inputSchema: t.parameters,
        execute: this.wrapToolExecute(t, turnId, queue),
      };
    }

    // --- Build messages from context, preferring durable RuntimeEvents when usable. ---
    const priorReplay = this.buildPriorMessages(input);
    const messages = priorReplay.messages;
    messages.push({
      role: 'user',
      content: this.buildUserContent(input.text, input.attachments),
    });

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
        const activeTools = this.input.tools.map((tool) => tool.name);
        trace.modelStreamStarted(activeTools);

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
              availableToolNames: this.input.tools.map((tool) => tool.name),
              error,
            });
          },
          system: await this.resolveSystemPrompt(),
          abortSignal: this.abortController!.signal,
        });

        for await (const chunk of result.fullStream) {
          if (this.aborted) break;
          watchdog.markActivity();
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
          tokenUsage = normalizeAiSdkUsage(await result.usage);
          if (tokenUsage) {
            trace.usageRecorded(tokenUsage);
            const tu: TokenUsageMessage = {
              type: 'token_usage',
              id: this.newId(),
              turnId,
              ts: this.now(),
              input: tokenUsage.inputTokens,
              output: tokenUsage.outputTokens,
              ...(tokenUsage.cachedInputTokens > 0 ? { cacheRead: tokenUsage.cachedInputTokens } : {}),
              ...(tokenUsage.cacheWriteInputTokens > 0 ? { cacheCreation: tokenUsage.cacheWriteInputTokens } : {}),
            };
            await this.input.appendMessage(tu).catch(() => {});
            queue.push({
              type: 'token_usage',
              id: this.newId(),
              turnId,
              ts: this.now(),
              input: tokenUsage.inputTokens,
              output: tokenUsage.outputTokens,
              ...(tokenUsage.cachedInputTokens > 0 ? { cacheRead: tokenUsage.cachedInputTokens } : {}),
              ...(tokenUsage.cacheWriteInputTokens > 0 ? { cacheCreation: tokenUsage.cacheWriteInputTokens } : {}),
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
          cachedInputTokens: tokenUsage?.cachedInputTokens ?? 0,
          cacheWriteInputTokens: tokenUsage?.cacheWriteInputTokens ?? 0,
          reasoningTokens: tokenUsage?.reasoningTokens ?? 0,
          totalTokens: tokenUsage?.totalTokens,
          latencyMs: Math.max(0, this.now() - startedAt),
          status: streamStatus,
          ...(streamErrorClass ? { errorClass: streamErrorClass } : {}),
          startedAt,
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

  /** Materialize stored messages into ai-sdk's message format.
   *  V0.1: text-only round-tripping. Tool calls / results within stored
   *  history are deliberately NOT replayed — ai-sdk's streamText starts
   *  fresh each turn and the tool state isn't part of the prompt. */
  private buildPriorMessages(input: BackendSendInput): {
    messages: ModelMessage[];
    gate: RuntimeEventReplayFallbackGate | 'legacy_stored_messages';
    diagnostics: RuntimeEventModelReplayPlan['diagnostics'];
  } {
    const legacyMessages = this.materializePriorMessages(
      input.context.filter((message) => message.turnId !== input.turnId),
    );
    if (!input.runtimeContext) {
      return { messages: legacyMessages, gate: 'legacy_stored_messages', diagnostics: [] };
    }

    const plan = buildRuntimeEventModelReplayPlan(
      input.runtimeContext.filter((event) => event.turnId !== input.turnId),
    );
    if (plan.items.length === 0) {
      return { messages: legacyMessages, gate: 'legacy_stored_messages', diagnostics: plan.diagnostics };
    }

    if (hasBlockingReplayDiagnostics(plan)) {
      return {
        messages: legacyMessages,
        gate: 'runtime_replay_unsupported_semantics',
        diagnostics: plan.diagnostics,
      };
    }

    if (!plan.hasProviderNativeSemantics) {
      return {
        messages: plan.textMessages,
        gate: 'runtime_replay_text_only',
        diagnostics: plan.diagnostics,
      };
    }

    if (!this.canReplayProviderNative(plan)) {
      return {
        messages: legacyMessages,
        gate: 'runtime_replay_unsupported_semantics',
        diagnostics: plan.diagnostics,
      };
    }

    return {
      messages: this.materializeRuntimeReplayPlan(plan),
      gate: 'runtime_replay_provider_native',
      diagnostics: plan.diagnostics,
    };
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

  /** Build the user content payload for the current turn (text + attachment refs). */
  private buildUserContent(text: string, attachments?: AttachmentRef[]): string {
    return formatTextWithAttachmentRefs(text, attachments);
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

function hasBlockingReplayDiagnostics(plan: RuntimeEventModelReplayPlan): boolean {
  return plan.diagnostics.some((diagnostic) =>
    diagnostic.code === 'unsupported_role' ||
    diagnostic.code === 'unsupported_content' ||
    diagnostic.code === 'unsigned_thinking' ||
    diagnostic.code === 'unmatched_tool_result' ||
    diagnostic.code === 'tool_id_mismatch'
  );
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
