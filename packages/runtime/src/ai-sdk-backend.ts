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
  ToolStartEvent,
  ToolResultEvent,
  ToolResultContent,
  ToolOutputStream,
  TextDeltaEvent,
  TextCompleteEvent,
  ThinkingDeltaEvent,
  ThinkingCompleteEvent,
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
import type { ToolCategory } from '@maka/core/permission';
import { PROVIDER_DEFAULTS, type LlmConnection } from '@maka/core/llm-connections';
import { generalizedErrorMessage, redactSecrets } from '@maka/core/redaction';
import type { LlmCallRecord, ToolInvocationRecord } from '@maka/core/usage-stats/types';
import { z } from 'zod';

import { PermissionEngine } from './permission-engine.js';
import { AsyncEventQueue } from './async-queue.js';
import {
  recordToolArtifactsSafely,
  type ToolArtifactRecorder,
} from './tool-artifacts.js';
import { createToolOutputDeltaEmitter } from './tool-output-delta.js';
import { StreamWatchdog, formatStreamWatchdogError } from './stream-watchdog.js';

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

// ============================================================================
// MakaTool: our wrapper around ai-sdk's tool definition.
//
// We carry the Zod schema and an `impl` callback. The backend wraps `impl`
// with permission gating before passing to ai-sdk's `streamText({ tools })`.
// ============================================================================

export interface MakaTool<P = unknown, R = unknown> {
  /** Canonical (Claude-SDK-style) name. Pi adapter → translate to canonical. */
  name: string;
  /** Human-readable description shown to the model. */
  description: string;
  /** Zod schema describing the tool's argument shape. Carried as `unknown`
   *  here so this file does not have a hard zod dependency; runtime callers
   *  may pass a `z.ZodTypeAny`. */
  parameters: unknown;
  /**
   * If `false`, the wrap layer skips PermissionEngine.evaluate() entirely
   * and runs impl directly. Use for read-only / search tools (Read / Glob /
   * Grep). Defaults to `true` (always go through the engine).
   */
  permissionRequired?: boolean;
  /** Optional UI display name. */
  displayName?: string;
  /** Optional trusted category override for custom tools. */
  categoryHint?: ToolCategory;
  /** Real tool implementation. Called only after permission allows. */
  impl: (args: any, ctx: MakaToolContext) => Promise<R> | R;
}

export interface MakaToolContext {
  sessionId: string;
  turnId: string;
  /** Session working directory. */
  cwd: string;
  toolCallId: string;
  abortSignal: AbortSignal;
  emitOutput: (stream: ToolOutputStream, chunk: string) => void;
}

// ============================================================================
// Model factory contract (implemented elsewhere — @kabi)
// ============================================================================

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

export const TOOL_ERROR_RESULT_MAX_CHARS = 4000;
export const INVALID_TOOL_NAME = 'invalid';
export const MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN = 5;
const SUBAGENT_TOOL_LIMIT_MESSAGE = '只读探索并发过多：同一轮最多 5 个子代理。请等待已有探索完成后再继续。';

export interface RepairableAiSdkToolCall {
  toolCallId: string;
  toolName: string;
  input: string;
  providerExecuted?: boolean;
  providerMetadata?: unknown;
}

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
  /** Optional system prompt (skills + workspace AGENTS.md merged upstream). */
  systemPrompt?: string | ((context: SystemPromptContext) => string | undefined | Promise<string | undefined>);
  /** Optional fire-and-forget telemetry hooks. Tool implementations remain unaware. */
  recordLlmCall?: LlmTelemetryRecorder;
  recordToolInvocation?: ToolTelemetryRecorder;
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

  private aborted = false;
  private abortController: AbortController | null = null;
  private currentTurnId: string | null = null;
  /** Side-channel for tool.execute() callbacks to push events into the iterator. */
  private currentQueue: AsyncEventQueue<SessionEvent> | null = null;
  /** Paused while the backend is waiting on a user permission decision. */
  private currentWatchdog: StreamWatchdog | null = null;
  /** PawWork borrow: keep read-only subagent fan-out bounded per active turn. */
  private activeSubagentToolCount = 0;

  constructor(input: AiSdkBackendInput) {
    this.input = input;
    this.sessionId = input.sessionId;
    this.newId = input.newId ?? (() => crypto.randomUUID());
    this.now = input.now ?? (() => Date.now());
    this.maxSteps = input.maxSteps ?? 50;
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
    let tokenUsage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;
    let streamStatus: LlmCallRecord['status'] = 'success';
    let streamErrorClass: string | undefined;

    // --- Resolve model (API key already attached at construct time) ---
    let model: unknown;
    try {
      if (PROVIDER_DEFAULTS[this.input.connection.providerType].authKind !== 'none' && !this.input.apiKey) {
        throw new Error(`No API key stored for connection "${this.input.connection.slug}"`);
      }
      model = this.input.modelFactory({
        connection: this.input.connection,
        apiKey: this.input.apiKey,
        modelId: this.input.modelId,
      });
    } catch (err) {
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

    // --- Lazy import of ai-sdk (~150ms cold) ---
    const ai = await import('ai').catch((err) => {
      throw new Error(`Failed to load 'ai' package. Run \`npm install ai\`. Inner: ${(err as Error).message}`);
    });
    const { streamText, stepCountIs } = ai as unknown as {
      streamText: (opts: Record<string, unknown>) => StreamTextResult;
      stepCountIs: (n: number) => unknown;
    };

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

    // --- Build messages from context (StoredMessage[] → ai-sdk format) ---
    const messages = this.materializePriorMessages(
      input.context.filter((message) => message.turnId !== input.turnId),
    );
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
            this.abortController?.abort(watchdogTimeoutError);
          },
        });
        this.currentWatchdog = watchdog;
        watchdog.start();

        const result = streamText({
          model,
          messages,
          tools: aiSdkTools,
          activeTools: this.input.tools.map((tool) => tool.name),
          experimental_repairToolCall: async (
            { toolCall, error }: { toolCall: RepairableAiSdkToolCall; error: unknown },
          ) => {
            return repairMakaToolCall({
              toolCall,
              availableToolNames: this.input.tools.map((tool) => tool.name),
              error,
            });
          },
          system: await this.resolveSystemPrompt(),
          stopWhen: stepCountIs(this.maxSteps),
          abortSignal: this.abortController!.signal,
        });

        for await (const chunk of result.fullStream) {
          if (this.aborted) break;
          watchdog.markActivity();
          this.handleStreamChunk(chunk, turnId, assistantMessageId, queue, {
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
          const usage = await result.usage;
          tokenUsage = usage;
          if (usage) {
            const tu: TokenUsageMessage = {
              type: 'token_usage',
              id: this.newId(),
              turnId,
              ts: this.now(),
              input: usage.promptTokens ?? 0,
              output: usage.completionTokens ?? 0,
              ...(usage.totalTokens !== undefined ? {} : {}),
            };
            await this.input.appendMessage(tu).catch(() => {});
            queue.push({
              type: 'token_usage',
              id: this.newId(),
              turnId,
              ts: this.now(),
              input: usage.promptTokens ?? 0,
              output: usage.completionTokens ?? 0,
            } satisfies TokenUsageEvent);
          }
        } catch {
          // best-effort; ai-sdk usage promise may reject on abort
        }

        const finishReason = await result.finishReason.catch(() => 'stop');
        queue.push({
          type: 'complete',
          id: this.newId(),
          turnId,
          ts: this.now(),
          stopReason: this.mapFinishReason(finishReason),
        } satisfies CompleteEvent);
      } catch (err) {
        streamStatus = this.aborted ? 'aborted' : 'error';
        streamErrorClass = classifyError(watchdogTimeoutError ?? err);
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
          inputTokens: tokenUsage?.promptTokens ?? 0,
          outputTokens: tokenUsage?.completionTokens ?? 0,
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
    return async (
      args: unknown,
      ctx: { toolCallId: string; abortSignal: AbortSignal },
    ): Promise<unknown> => {
      const toolUseId = ctx.toolCallId;
      const now = this.now();
      const toolIntent = describeToolIntent(tool, args);

      // 1. Always write tool_call FIRST (§6.2 invariant).
      const callMsg: ToolCallMessage = {
        type: 'tool_call',
        id: toolUseId,
        turnId,
        ts: now,
        toolName: tool.name,
        ...(tool.displayName ? { displayName: tool.displayName } : {}),
        ...(toolIntent ? { intent: toolIntent } : {}),
        args,
      };
      await this.input.appendMessage(callMsg);
      const startEv: ToolStartEvent = {
        type: 'tool_start',
        id: this.newId(),
        turnId,
        ts: now,
        toolUseId,
        toolName: tool.name,
        args,
        ...(tool.displayName ? { displayName: tool.displayName } : {}),
        ...(toolIntent ? { intent: toolIntent } : {}),
      };
      queue.push(startEv);

      // 2. PermissionEngine evaluate — skipped for tools marked permissionRequired=false
      //    (Read / Glob / Grep). We still write tool_call/tool_result messages
      //    so the materializer renders them just like permission-gated tools.
      if (tool.permissionRequired === false) {
        // Fast path: jump straight to impl. Fall through to step 3 below.
      } else {
      const verdict = this.input.permissionEngine.evaluate({
        sessionId: this.sessionId,
        turnId,
        toolUseId,
        toolName: tool.name,
        args,
        ...(tool.categoryHint !== undefined ? { categoryHint: tool.categoryHint } : {}),
        mode: this.input.header.permissionMode,
      });

      if (verdict.kind === 'block') {
        await this.writeSyntheticToolResult(toolUseId, turnId, verdict.reason, queue);
        return this.errorReturn(verdict.reason);
      }

      if (verdict.kind === 'prompt') {
        // Surface request to UI via queue, then await user response.
        queue.push(verdict.event);
        let response: PermissionDecision;
        try {
          this.currentWatchdog?.pause();
          response = await verdict.parked;
          this.currentWatchdog?.resume();
        } catch (err) {
          this.currentWatchdog?.resume();
          const msg = formatSyntheticToolErrorText(err);
          const reason = formatSyntheticToolErrorText(`Permission flow aborted: ${msg}`);
          await this.writeSyntheticToolResult(toolUseId, turnId, reason, queue);
          return this.errorReturn(reason);
        }

        // Persist the decision and ack it on the event stream.
        const decisionMsg: PermissionDecisionMessage = {
          type: 'permission_decision',
          id: response.requestId,
          turnId,
          ts: this.now(),
          toolUseId,
          toolName: tool.name,
          decision: response.decision,
          ...(response.rememberForTurn !== undefined ? { rememberForTurn: response.rememberForTurn } : {}),
        };
        await this.input.appendMessage(decisionMsg);
        queue.push({
          type: 'permission_decision_ack',
          id: this.newId(),
          turnId,
          ts: this.now(),
          requestId: response.requestId,
          toolUseId,
          decision: response.decision,
          ...(response.rememberForTurn !== undefined ? { rememberForTurn: response.rememberForTurn } : {}),
        });

        if (response.decision === 'deny') {
          const reason = 'User denied permission';
          await this.writeSyntheticToolResult(toolUseId, turnId, reason, queue);
          return this.errorReturn(reason);
        }
      }
      } // end of: permissionRequired === false ? skip : evaluate

      // 3. Permission allowed (or skipped) → run the real impl.
      const reservedSubagentSlot = this.reserveSubagentSlot(tool);
      if (!reservedSubagentSlot) {
        await this.writeSyntheticToolResult(toolUseId, turnId, SUBAGENT_TOOL_LIMIT_MESSAGE, queue);
        return this.errorReturn(SUBAGENT_TOOL_LIMIT_MESSAGE);
      }
      const startedAt = this.now();
      const output = createToolOutputDeltaEmitter({
        sessionId: this.sessionId,
        turnId,
        toolUseId,
        newId: this.newId,
        now: this.now,
        push: (event) => queue.push(event),
      });
      try {
        const result = await tool.impl(args as never, {
          sessionId: this.sessionId,
          turnId,
          cwd: this.input.header.cwd,
          toolCallId: toolUseId,
          abortSignal: ctx.abortSignal,
          emitOutput: output.emit,
        });
        output.flush();
        const durationMs = this.now() - startedAt;

        // Coerce impl's return into ToolResultContent for storage + event.
        const content = this.coerceResultContent(result);
        const toolResultStatus = deriveToolResultStatus(content);
        const resultMsg: ToolResultMessage = {
          type: 'tool_result',
          id: this.newId(),
          turnId,
          ts: this.now(),
          toolUseId,
          isError: toolResultStatus !== 'success',
          content,
          durationMs,
        };
        await this.input.appendMessage(resultMsg);
        queue.push({
          type: 'tool_result',
          id: this.newId(),
          turnId,
          ts: this.now(),
          toolUseId,
          isError: toolResultStatus !== 'success',
          content,
          durationMs,
        } satisfies ToolResultEvent);

        this.input.recordToolInvocation?.({
          sessionId: this.sessionId,
          turnId,
          toolCallId: toolUseId,
          toolName: tool.name,
          providerId: this.input.connection.providerType,
          modelId: this.input.modelId,
          durationMs,
          status: toolResultStatus,
          argsSummary: summarizeArgs(args),
          bytesIn: byteLength(args),
          bytesOut: byteLength(result),
          startedAt,
        });

        void recordToolArtifactsSafely(
          {
            sessionId: this.sessionId,
            turnId,
            toolUseId,
            toolName: tool.name,
            cwd: this.input.header.cwd,
            args,
            result,
          },
          this.input.recordToolArtifacts,
          (message) => {
            queue.push({
              type: 'tool_progress',
              id: this.newId(),
              turnId,
              ts: this.now(),
              toolUseId,
              chunk: message,
            });
          },
        );

        return result;
      } catch (err) {
        output.flush();
        const terminalFailure = this.coerceTerminalFailure(tool, args, err);
        if (terminalFailure) {
          const durationMs = Math.max(0, this.now() - startedAt);
          const resultMsg: ToolResultMessage = {
            type: 'tool_result',
            id: this.newId(),
            turnId,
            ts: this.now(),
            toolUseId,
            isError: true,
            content: terminalFailure.content,
            durationMs,
          };
          await this.input.appendMessage(resultMsg);
          queue.push({
            type: 'tool_result',
            id: this.newId(),
            turnId,
            ts: this.now(),
            toolUseId,
            isError: true,
            content: terminalFailure.content,
            durationMs,
          } satisfies ToolResultEvent);
          this.input.recordToolInvocation?.({
            sessionId: this.sessionId,
            turnId,
            toolCallId: toolUseId,
            toolName: tool.name,
            providerId: this.input.connection.providerType,
            modelId: this.input.modelId,
            durationMs,
            status: 'error',
            errorClass: classifyError(err),
            argsSummary: summarizeArgs(args),
            bytesIn: byteLength(args),
            bytesOut: byteLength(terminalFailure.content),
            startedAt,
          });
          return this.errorReturn(terminalFailure.message);
        }
        const msg = formatSyntheticToolErrorText(err);
        await this.writeSyntheticToolResult(toolUseId, turnId, msg, queue);
        this.input.recordToolInvocation?.({
          sessionId: this.sessionId,
          turnId,
          toolCallId: toolUseId,
          toolName: tool.name,
          providerId: this.input.connection.providerType,
          modelId: this.input.modelId,
          durationMs: Math.max(0, this.now() - startedAt),
          status: 'error',
          errorClass: classifyError(err),
          argsSummary: summarizeArgs(args),
          bytesIn: byteLength(args),
          bytesOut: 0,
          startedAt,
        });
        return this.errorReturn(msg);
      } finally {
        if (reservedSubagentSlot) this.releaseSubagentSlot(tool);
      }
    };
  }

  // --------------------------------------------------------------------------
  // Stream chunk normalizer — ai-sdk fullStream → SessionEvent
  // --------------------------------------------------------------------------

  private handleStreamChunk(
    chunk: AiSdkStreamChunk,
    turnId: string,
    assistantMessageId: string,
    queue: AsyncEventQueue<SessionEvent>,
    cb: {
      onText: (t: string) => void;
      onTextComplete: (t: string) => void;
      onThinking: (t: string) => void;
      onThinkingComplete: (t: string, sig?: string) => void;
    },
  ): void {
    const ts = this.now();
    switch (chunk.type) {
      case 'text-delta': {
        const text = chunk.text ?? chunk.textDelta ?? chunk.delta ?? '';
        cb.onText(text);
        queue.push({
          type: 'text_delta',
          id: this.newId(),
          turnId,
          ts,
          messageId: assistantMessageId,
          text,
        } satisfies TextDeltaEvent);
        break;
      }
      case 'reasoning':
      case 'reasoning-delta': {
        // Anthropic / OpenAI o-series style thinking
        const text = chunk.text ?? chunk.textDelta ?? chunk.delta ?? '';
        cb.onThinking(text);
        queue.push({
          type: 'thinking_delta',
          id: this.newId(),
          turnId,
          ts,
          messageId: assistantMessageId,
          text,
        } satisfies ThinkingDeltaEvent);
        break;
      }
      case 'step-finish': {
        // ai-sdk fires step-finish after each turn step (incl. between tool calls).
        // We don't need to emit anything here; tool results already streamed.
        break;
      }
      case 'finish': {
        // Final usage handled in pump's await result.usage path. Emit text_complete
        // (we don't have a per-message complete in ai-sdk; aggregate from cb).
        // Note: aggregated text is captured by the pump via cb.onText.
        break;
      }
      case 'tool-call':
      case 'tool-result':
        // These are emitted by ai-sdk after our wrapped execute() runs.
        // Our wrapped execute already emitted tool_start + tool_result to the
        // queue, so we ignore these chunks to avoid double-emission.
        break;
      case 'error':
        queue.push(this.makeErrorEvent(turnId, chunk.error));
        break;
      default:
        // Unrecognized chunk type — forward-compat: ignore.
        break;
    }
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

  private async writeSyntheticToolResult(
    toolUseId: string,
    turnId: string,
    text: string,
    queue: AsyncEventQueue<SessionEvent>,
  ): Promise<void> {
    const content: ToolResultContent = { kind: 'text', text: formatSyntheticToolErrorText(text) };
    const msg: ToolResultMessage = {
      type: 'tool_result',
      id: this.newId(),
      turnId,
      ts: this.now(),
      toolUseId,
      isError: true,
      content,
    };
    await this.input.appendMessage(msg);
    queue.push({
      type: 'tool_result',
      id: this.newId(),
      turnId,
      ts: this.now(),
      toolUseId,
      isError: true,
      content,
    } satisfies ToolResultEvent);
  }

  /** Coerce arbitrary tool impl return into ToolResultContent for storage. */
  private coerceResultContent(raw: unknown): ToolResultContent {
    if (typeof raw === 'string') return { kind: 'text', text: raw };
    if (raw && typeof raw === 'object') {
      const obj = raw as { kind?: string; text?: string };
      if (typeof obj.kind === 'string') return raw as ToolResultContent;
      if (typeof obj.text === 'string') return { kind: 'text', text: obj.text };
      return { kind: 'json', value: raw };
    }
    return { kind: 'text', text: String(raw ?? '') };
  }

  private coerceTerminalFailure(
    tool: MakaTool,
    args: unknown,
    err: unknown,
  ): { content: Extract<ToolResultContent, { kind: 'terminal' }>; message: string } | null {
    if (tool.name !== 'Bash' || !err || typeof err !== 'object') return null;
    const error = err as { code?: unknown; stdout?: unknown; stderr?: unknown };
    if (typeof error.code !== 'number') return null;
    const command = args && typeof args === 'object' && typeof (args as { command?: unknown }).command === 'string'
      ? (args as { command: string }).command
      : '';
    return {
      content: {
        kind: 'terminal',
        cwd: this.input.header.cwd,
        cmd: redactSecrets(command),
        exitCode: error.code,
        stdout: redactSecrets(String(error.stdout ?? '')),
        stderr: redactSecrets(String(error.stderr ?? '')),
      },
      message: `命令退出码 ${error.code}`,
    };
  }

  private reserveSubagentSlot(tool: MakaTool): boolean {
    if (tool.categoryHint !== 'subagent') return true;
    if (this.activeSubagentToolCount >= MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN) return false;
    this.activeSubagentToolCount += 1;
    return true;
  }

  private releaseSubagentSlot(tool: MakaTool): void {
    if (tool.categoryHint !== 'subagent') return;
    this.activeSubagentToolCount = Math.max(0, this.activeSubagentToolCount - 1);
  }

  /** Build the value we return to ai-sdk from a synthetic-error tool call. */
  private errorReturn(message: string): unknown {
    return { error: message };
  }

  /** Map ai-sdk finishReason → our CompleteEvent.stopReason. */
  private mapFinishReason(reason: unknown): CompleteEvent['stopReason'] {
    switch (reason) {
      case 'stop':           return 'end_turn';
      case 'length':         return 'max_tokens';
      case 'content-filter': return 'error';
      case 'error':          return 'error';
      case 'tool-calls':     return 'end_turn';   // ai-sdk auto-loops; if this leaks out, treat as end
      default:               return 'end_turn';
    }
  }

  private makeErrorEvent(turnId: string, err: unknown): ErrorEvent {
    const message = generalizedErrorMessage(err);
    const reason = errorReasonFromClass(classifyError(err));
    const code = err instanceof Error && 'code' in err
      ? String((err as { code?: unknown }).code)
      : undefined;
    return {
      type: 'error',
      id: this.newId(),
      turnId,
      ts: this.now(),
      recoverable: false,
      ...(code !== undefined ? { code } : {}),
      ...(reason !== undefined ? { reason } : {}),
      message,
    };
  }

  /** Materialize stored messages into ai-sdk's message format.
   *  V0.1: text-only round-tripping. Tool calls / results within stored
   *  history are deliberately NOT replayed — ai-sdk's streamText starts
   *  fresh each turn and the tool state isn't part of the prompt. */
  private materializePriorMessages(stored: readonly StoredMessage[]): Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
  }> {
    const out: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];
    for (const m of stored) {
      if (m.type === 'user') out.push({ role: 'user', content: m.text });
      else if (m.type === 'assistant') out.push({ role: 'assistant', content: m.text });
      // tool_call / tool_result / permission_decision / token_usage / system_note skipped
    }
    return out;
  }

  /** Build the user content payload for the current turn (text + attachment refs). */
  private buildUserContent(text: string, attachments?: AttachmentRef[]): string {
    if (!attachments || attachments.length === 0) return text;
    const refs = attachments.map((a) => `[attachment: ${a.name} (${a.mimeType})]`).join(' ');
    return `${text}\n\n${refs}`;
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
    this.activeSubagentToolCount = 0;
    this.aborted = false;
  }
}

// ============================================================================
// Loose stream-chunk shape (intentionally lenient — ai-sdk evolves)
// ============================================================================

interface AiSdkStreamChunk {
  type: string;
  text?: string;
  delta?: string;
  textDelta?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  finishReason?: string;
  error?: unknown;
}

interface StreamTextResult {
  fullStream: AsyncIterable<AiSdkStreamChunk>;
  usage: Promise<{ promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined>;
  finishReason: Promise<string>;
}

function classifyError(error: unknown): string {
  if (!(error instanceof Error)) return 'Other';
  const code = 'code' in error ? String((error as { code?: unknown }).code) : '';
  const text = `${error.name} ${code} ${error.message}`.toLowerCase();
  if (text.includes('abort')) return 'Abort';
  if (text.includes('rate') || code === '429') return 'RateLimit';
  if (text.includes('auth') || code === '401' || code === '403') return 'Auth';
  if (text.includes('timeout')) return 'Timeout';
  if (text.includes('network') || text.includes('fetch')) return 'Network';
  return error.name || 'Other';
}

function errorReasonFromClass(errorClass: string): string | undefined {
  switch (errorClass) {
    case 'Timeout':
      return 'timeout';
    case 'Auth':
      return 'auth';
    case 'RateLimit':
      return 'rate_limit';
    case 'Network':
      return 'network';
    default:
      return undefined;
  }
}

export function formatSyntheticToolErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = redactSecrets(raw || 'Tool failed');
  if (redacted.length <= TOOL_ERROR_RESULT_MAX_CHARS) return redacted;
  return `${redacted.slice(0, TOOL_ERROR_RESULT_MAX_CHARS - 1)}…`;
}

function deriveToolResultStatus(content: ToolResultContent): ToolInvocationRecord['status'] {
  if (content.kind === 'explore_agent' && content.ok === false) {
    return content.reason === 'aborted' ? 'aborted' : 'error';
  }
  if (content.kind === 'office_document' && content.ok === false) return 'error';
  return 'success';
}

function summarizeArgs(args: unknown): string {
  const text = typeof args === 'string' ? args : JSON.stringify(args ?? null);
  return text.length <= 512 ? text : `${text.slice(0, 511)}…`;
}

function describeToolIntent(tool: MakaTool, args: unknown): string | undefined {
  if (tool.categoryHint !== 'subagent' || tool.name !== 'ExploreAgent') return undefined;
  if (!args || typeof args !== 'object') return undefined;
  const objective = (args as { objective?: unknown }).objective;
  if (typeof objective !== 'string') return undefined;
  const normalized = redactSecrets(objective.replace(/\s+/g, ' ').trim());
  if (normalized.length === 0) return undefined;
  const capped = normalized.length <= 180 ? normalized : `${normalized.slice(0, 179)}…`;
  return `只读探索：${capped}`;
}

function byteLength(value: unknown): number {
  if (value === undefined) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return Buffer.byteLength(text, 'utf8');
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
