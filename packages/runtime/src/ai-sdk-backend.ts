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
import type { AgentSpec } from '@maka/core/runtime-inputs';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { LlmCallRecord, PricingConfig, ToolInvocationRecord } from '@maka/core/usage-stats/types';
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
  type PrepareStepFunctionLike,
  type PrepareStepLike,
  type PrepareStepResultLike,
  type RepairableAiSdkToolCall,
} from './model-adapter.js';
import {
  rewriteActiveToolResultsInMessages,
  type ActiveToolResultPruneDiagnosticPatch,
} from './active-tool-result-prune.js';
import type { ToolArtifactRecorder } from './tool-artifacts.js';
import { RunTrace, type RunTraceRecorder } from './run-trace.js';
import { computeCost } from './telemetry/cost.js';
import { getBuiltinPricing } from './telemetry/builtin-pricing.js';
import {
  buildRuntimeEventModelReplayPlan,
  formatTextWithAttachmentRefs,
  type RuntimeEventModelReplayItem,
  type RuntimeEventModelReplayPlan,
  type RuntimeEventReplayFallbackGate,
} from './model-history.js';
import {
  computeRequestShapeDiagnostic,
  toolSchemaCharsForDiagnostics,
  type RequestShapeDiagnostic,
} from './request-shape.js';
import {
  ToolAvailabilityRuntime,
  type ToolAvailabilityConfig,
} from './tool-availability.js';
import {
  ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
  applyRuntimeEventContextBudget,
  buildPromptSegmentEstimates,
  collectStaleToolResultArchiveCandidates,
  estimateRuntimeEventsTokens,
  historyCompactBlockToRuntimeEvent,
  rawEvidenceRequestReason,
  retrieveArchivedToolResultsForReplay,
  retrieveRuntimeEventHistoryAround,
  searchRuntimeEventHistory,
  selectSynthesisCacheForReplay,
  type ContextBudgetPolicy,
  type HistoryCompactBlock,
  type ActiveArchivedToolResultPlaceholder,
  type ActiveToolResultArchiveCandidate,
  type RuntimeEventHistoryAroundResult,
  type RuntimeEventHistorySearchPolicy,
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

export function composePrepareStep(
  toolAvailability: PrepareStepFunctionLike | undefined,
  activeToolResultPrune: PrepareStepFunctionLike | undefined,
): PrepareStepFunctionLike | undefined {
  if (!toolAvailability && !activeToolResultPrune) return undefined;
  return async (options: PrepareStepLike): Promise<PrepareStepResultLike | undefined> => {
    const availabilityResult = await Promise.resolve(toolAvailability?.(options));
    const pruneResult = await Promise.resolve(activeToolResultPrune?.(options));
    if (!availabilityResult) return pruneResult;
    if (!pruneResult) return availabilityResult;
    return {
      ...availabilityResult,
      ...pruneResult,
      activeTools: pruneResult.activeTools ?? availabilityResult.activeTools,
    };
  };
}

function activeToolResultArchiveKey(
  candidate: ActiveToolResultArchiveCandidate & { bodySha256: string },
): string {
  return `active:${candidate.turnId}:${candidate.toolCallId}:${candidate.bodySha256}`;
}

function collectPrepareStepToolCallIds(steps: PrepareStepLike['steps']): Set<string> {
  const out = new Set<string>();
  for (const step of steps) {
    for (const call of step.toolCalls ?? []) {
      if (typeof call.toolCallId === 'string' && call.toolCallId.length > 0) {
        out.add(call.toolCallId);
      }
    }
  }
  return out;
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
export type ToolResultArchiveRecorderInput = (
  | StaleToolResultArchiveCandidate
  | (ActiveToolResultArchiveCandidate & { runtimeEventId: string })
) & {
  sessionId: string;
  bodySha256: string;
};
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
export interface HistoryCompactLoadInput {
  sessionId: string;
  maxBlocks?: number;
  maxBytes?: number;
  maxEstimatedTokens?: number;
}
export interface HistoryCompactLoadResult {
  blocks: HistoryCompactBlock[];
  skipped?: number;
  skippedReasonCounts?: Record<string, number>;
}
export interface HistoryCompactWriteInput {
  sessionId: string;
  turnId: string;
  source: {
    draftBlock: HistoryCompactBlock;
    foldedRuntimeEvents: RuntimeEvent[];
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
export interface HistoryCompactWriteResult {
  blocks: HistoryCompactBlock[];
  skipped?: number;
  skippedReasonCounts?: Record<string, number>;
}
export type HistoryCompactLoader = (
  input: HistoryCompactLoadInput,
) => Promise<HistoryCompactLoadResult> | HistoryCompactLoadResult;
export type HistoryCompactWriter = (
  input: HistoryCompactWriteInput,
) => Promise<HistoryCompactWriteResult | void> | HistoryCompactWriteResult | void;

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
  /**
   * Optional unified tool-availability config (issue #37). With `economy: true`,
   * only core + ungrouped tools are advertised each turn; each group's tools are
   * withheld until the model activates the group via `load_tools`, which takes
   * effect same-turn through `prepareStep` and persists across turns via the
   * RuntimeEvent ledger. Omitted or `economy: false` advertises every tool every
   * turn (full surface). The runtime owns the catalog, connector, activation,
   * gating, and diagnostics.
   */
  toolAvailability?: ToolAvailabilityConfig;

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
  /** Optional pricing lookup shared with telemetry; defaults to builtin public pricing. */
  lookupPricing?: (modelKey: string) => PricingConfig | null;
  spawnChildAgent?: (input: {
    parentRunId: string;
    spec: AgentSpec;
    prompt: string;
    abortSignal: AbortSignal;
  }) => Promise<unknown>;
  listChildAgents?: () => Promise<unknown>;
  readChildAgentOutput?: (input: { runId?: string; turnId?: string; maxEvents?: number }) => Promise<unknown>;
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
  /** Optional best-effort source-bearing history compact block loader. */
  loadHistoryCompact?: HistoryCompactLoader;
  /** Optional best-effort source-bearing history compact block writer/summarizer. */
  writeHistoryCompact?: HistoryCompactWriter;
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
  private readonly toolAvailabilityRuntime: ToolAvailabilityRuntime;

  private aborted = false;
  private abortController: AbortController | null = null;
  private currentTurnId: string | null = null;
  private currentRunId: string | null = null;
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
    this.toolAvailabilityRuntime = new ToolAvailabilityRuntime(
      input.tools,
      input.toolAvailability,
      buildInvalidMakaTool(),
    );
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
      getCurrentRunId: () => this.currentRunId ?? undefined,
      spawnChildAgent: input.spawnChildAgent,
      listChildAgents: input.listChildAgents,
      readChildAgentOutput: input.readChildAgentOutput,
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
    this.currentRunId = input.runId ?? null;
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
    let tokenUsageCostUsd: number | undefined;
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
    // One runtime owns provider-visible tool availability (issue #37): the
    // catalog, the `load_tools` connector, same-turn activation via prepareStep,
    // the execute-boundary gating, and the diagnostics. Seed prior-turn group
    // activations from the durable ledger (the current turn is excluded — it has
    // not committed yet) so a group loaded earlier stays advertised.
    const plan = this.toolAvailabilityRuntime.prepare(
      (input.runtimeContext ?? []).filter((event) => event.turnId !== turnId),
    );
    const providerTools = plan.providerTools;
    let activeToolResultPruneDiagnosticPatch: ActiveToolResultPruneDiagnosticPatch = {};
    const prepareStep = composePrepareStep(
      plan.prepareStep,
      this.buildActiveToolResultPrunePrepareStep(turnId, (patch) => {
        activeToolResultPruneDiagnosticPatch = mergeActiveToolResultPruneDiagnosticPatches(
          activeToolResultPruneDiagnosticPatch,
          patch,
        );
      }),
    );
    // Tool names the repair path matches a mis-cased call against — follows the
    // current step's snapshot so a group loaded mid-turn is repairable on the
    // step it becomes active, not routed to `invalid`.
    const currentRepairToolNames = plan.currentRepairToolNames;
    // Establish clean per-turn ToolRuntime state at the START of the turn, then
    // install this turn's gating. cleanupAfterTurn() also resets at turn end, but
    // that runs in send()'s finally and so depends on the consumer draining (or
    // .return()-ing) the generator; resetting here makes each turn's state — the
    // loop-gate streak, subagent count, gating — depend only on this turn, not on
    // the previous turn's teardown.
    this.toolRuntime.resetTurnState();
    if (plan.gating) {
      this.toolRuntime.setGating(plan.gating);
    }

    const aiSdkTools: Record<string, unknown> = {};
    for (const t of providerTools) {
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
        const activeTools = plan.activeTools;
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
        // Diagnostics describe the provider-visible (active) tool subset. A group
        // loaded *this* turn expands that subset on later steps (via prepareStep),
        // so the durable cost record is refined against the final active set once
        // the stream is consumed (see below). Both computations classify against
        // the same pre-turn baseline. The availability runtime builds the tool
        // diagnostic from the same per-step active set + schema-char measurement.
        contextBudgetForTelemetry = priorReplay.contextBudget;
        const priorShapeBaseline = this.priorRequestShape;
        const computeTurnDiagnostics = (active: readonly string[]) => {
          const toolSchemaChars = toolSchemaCharsForDiagnostics(providerTools, active);
          const toolAvailabilityDiagnostic = plan.diagnostics(active, toolSchemaChars);
          return {
            promptSegments: buildPromptSegmentEstimates({
              systemPrompt,
              toolSchemaChars,
              toolCount: active.length,
              priorMessages: priorReplay.messages,
              priorRuntimeEventCount: priorReplay.runtimeEventCount,
              currentUserContent,
              turnTailPrompt,
            }),
            requestShape: computeRequestShapeDiagnostic({
              connection: this.input.connection,
              modelId: this.input.modelId,
              systemPrompt,
              providerOptions: this.input.providerOptions,
              providerTools,
              activeTools: active,
              priorMessages: priorReplay.messages,
              ...(toolAvailabilityDiagnostic !== undefined
                ? { toolAvailability: toolAvailabilityDiagnostic }
                : {}),
            }, priorShapeBaseline),
          };
        };
        // Publish a diagnostics snapshot to every telemetry sink at once so the
        // cost record, the prefix baseline, and the context-budget high-water
        // "after" hash never diverge — they must all describe the same active
        // tool set. A same-turn deferred load re-publishes the final snapshot
        // below; the high-water "before" hash is the pre-turn baseline, set once.
        let turnDiagnostics = computeTurnDiagnostics(activeTools);
        const publishTurnDiagnostics = (diag: typeof turnDiagnostics): void => {
          turnDiagnostics = diag;
          promptSegmentsForTelemetry = diag.promptSegments;
          requestShapeForTelemetry = diag.requestShape;
          this.priorRequestShape = diag.requestShape;
          if (priorReplay.contextBudget?.highWaterReason) {
            priorReplay.contextBudget.highWaterRequestShapeHashAfter = diag.requestShape.requestShapeHash;
          }
        };
        // Step-0 (turn-start) view: literally what the first request carries, so
        // the stream-start trace reports it as the prefix actually sent.
        if (priorReplay.contextBudget?.highWaterReason) {
          priorReplay.contextBudget.highWaterRequestShapeHashBefore = priorShapeBaseline?.requestShapeHash;
        }
        publishTurnDiagnostics(turnDiagnostics);
        trace.modelStreamStarted(activeTools, {
          systemPromptHash: turnDiagnostics.requestShape.componentHashes.systemPromptHash,
          prefixHash: turnDiagnostics.requestShape.prefixHash,
          prefixChangeReason: turnDiagnostics.requestShape.prefixChangeReason,
          requestShapeHash: turnDiagnostics.requestShape.requestShapeHash,
          requestShapeChangeReason: turnDiagnostics.requestShape.requestShapeChangeReason,
          ...(turnDiagnostics.requestShape.toolSchemaChangeReason !== undefined
            ? { toolSchemaChangeReason: turnDiagnostics.requestShape.toolSchemaChangeReason }
            : {}),
          ...(turnDiagnostics.requestShape.toolAvailability !== undefined
            ? { toolAvailability: turnDiagnostics.requestShape.toolAvailability }
            : {}),
          promptSegments: turnDiagnostics.promptSegments,
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
              availableToolNames: currentRepairToolNames(),
              error,
            });
          },
          system: systemPrompt,
          abortSignal: this.abortController!.signal,
          ...(prepareStep ? { prepareStep } : {}),
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

        // Same-turn deferred load: prepareStep expanded the provider tool set on
        // later steps, so refine the durable cost record + prefix baseline against
        // the final active set — otherwise this turn under-reports the loaded
        // schema and the cache reset would surface a turn late. No-op when nothing
        // loaded this turn (the active set length is unchanged; the ratchet only
        // grows it).
        const finalActiveTools = currentRepairToolNames();
        if (finalActiveTools.length !== activeTools.length) {
          publishTurnDiagnostics(computeTurnDiagnostics(finalActiveTools));
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

        // Final usage event. AI SDK `usage` is the last step only; `totalUsage`
        // is the billing-relevant sum across all internal tool-loop steps.
        try {
          tokenUsage = normalizeAiSdkUsage(await (result.totalUsage ?? result.usage), { rawFinishReason });
          if (tokenUsage) {
            const systemPromptHash = turnDiagnostics.requestShape.componentHashes.systemPromptHash;
            tokenUsageCostUsd = this.computeTokenUsageCostUsd(tokenUsage);
            trace.usageRecorded({
              ...tokenUsage,
              ...(tokenUsageCostUsd !== undefined ? { costUsd: tokenUsageCostUsd } : {}),
              systemPromptHash,
              prefixHash: turnDiagnostics.requestShape.prefixHash,
              prefixChangeReason: turnDiagnostics.requestShape.prefixChangeReason,
              requestShapeHash: turnDiagnostics.requestShape.requestShapeHash,
              requestShapeChangeReason: turnDiagnostics.requestShape.requestShapeChangeReason,
              ...(turnDiagnostics.requestShape.toolSchemaChangeReason !== undefined
                ? { toolSchemaChangeReason: turnDiagnostics.requestShape.toolSchemaChangeReason }
                : {}),
              ...(turnDiagnostics.requestShape.toolAvailability !== undefined
                ? { toolAvailability: turnDiagnostics.requestShape.toolAvailability }
                : {}),
            });
            const contextBudgetForUsage = contextBudgetWithActiveToolResultPruneDiagnostics(
              contextBudgetForTelemetry,
              activeToolResultPruneDiagnosticPatch,
            );
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
              ...(tokenUsageCostUsd !== undefined ? { costUsd: tokenUsageCostUsd } : {}),
              systemPromptHash,
              prefixHash: turnDiagnostics.requestShape.prefixHash,
              prefixChangeReason: turnDiagnostics.requestShape.prefixChangeReason,
              requestShapeHash: turnDiagnostics.requestShape.requestShapeHash,
              requestShapeChangeReason: turnDiagnostics.requestShape.requestShapeChangeReason,
              promptSegments: turnDiagnostics.promptSegments,
              ...(contextBudgetForUsage ? { contextBudget: contextBudgetForUsage } : {}),
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
              ...(tokenUsageCostUsd !== undefined ? { costUsd: tokenUsageCostUsd } : {}),
              systemPromptHash,
              prefixHash: turnDiagnostics.requestShape.prefixHash,
              prefixChangeReason: turnDiagnostics.requestShape.prefixChangeReason,
              requestShapeHash: turnDiagnostics.requestShape.requestShapeHash,
              requestShapeChangeReason: turnDiagnostics.requestShape.requestShapeChangeReason,
              promptSegments: turnDiagnostics.promptSegments,
              ...(contextBudgetForUsage ? { contextBudget: contextBudgetForUsage } : {}),
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
        contextBudgetForTelemetry = contextBudgetWithActiveToolResultPruneDiagnostics(
          contextBudgetForTelemetry,
          activeToolResultPruneDiagnosticPatch,
        );
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
            systemPromptHash: requestShapeForTelemetry.componentHashes.systemPromptHash,
            prefixHash: requestShapeForTelemetry.prefixHash,
            prefixChangeReason: requestShapeForTelemetry.prefixChangeReason,
            requestShapeHash: requestShapeForTelemetry.requestShapeHash,
            requestShapeChangeReason: requestShapeForTelemetry.requestShapeChangeReason,
            ...(requestShapeForTelemetry.toolSchemaChangeReason !== undefined
              ? { toolSchemaChangeReason: requestShapeForTelemetry.toolSchemaChangeReason }
              : {}),
            ...(requestShapeForTelemetry.toolAvailability !== undefined
              ? { toolAvailability: requestShapeForTelemetry.toolAvailability }
              : {}),
          } : {}),
          ...(tokenUsageCostUsd !== undefined ? { costUsd: tokenUsageCostUsd } : {}),
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

  private computeTokenUsageCostUsd(usage: NormalizedAiSdkUsage): number | undefined {
    try {
      return computeCost(
        {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheHitInputTokens: usage.cacheHitInputTokens,
          cacheMissInputTokens: usage.cacheMissInputTokens,
          cacheWriteInputTokens: usage.cacheWriteInputTokens,
        },
        (this.input.lookupPricing ?? getBuiltinPricing)(`${this.input.connection.providerType}:${this.input.modelId}`),
      ).totalCost;
    } catch {
      return undefined;
    }
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
    if (
      budgeted?.historyCompactBlocks?.length &&
      contextBudget?.historyCompact?.mode === 'read_write' &&
      this.input.writeHistoryCompact
    ) {
      const loadedBlockIds = new Set((contextBudget.historyCompact.blocks ?? []).map((block) => block.blockId));
      const draftBlocks = budgeted.historyCompactBlocks.filter((block) => !loadedBlockIds.has(block.blockId));
      if (draftBlocks.length > 0) {
        const writePatch = await this.writeHistoryCompactBlocks({
          turnId: input.turnId,
          contextBudget,
          priorRuntimeContext,
          draftBlocks,
        });
        if (writePatch.replacementBlocks.length > 0) {
          runtimeContext = replaceHistoryCompactReplayBlocks(runtimeContext, writePatch.replacementBlocks);
        }
        contextBudgetDiagnostic = mergeContextBudgetDiagnostic(
          contextBudgetDiagnostic ?? buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
          writePatch.diagnosticPatch,
        );
      }
    }

    const historySearchSource = buildHistorySearchSource(priorRuntimeContext, contextBudget);
    const historyAround = contextBudget?.archiveRetrieval?.mode === 'history_search_gated'
      ? retrieveReplayHistoryAroundSearchSource(
          historySearchSource,
          priorRuntimeContext,
          input.text,
          contextBudget?.historySearch,
          { charsPerToken: contextBudget?.charsPerToken },
        )
      : retrieveRuntimeEventHistoryAround(
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
        const archiveRefs = new Map<string, ToolResultArchiveRef>();
        const existingArchiveRefs = nextPolicy.staleToolResultPrune?.archiveRefs;
        if (Array.isArray(existingArchiveRefs)) {
          for (const ref of existingArchiveRefs) archiveRefs.set(ref.runtimeEventId, ref);
        } else if (existingArchiveRefs) {
          for (const ref of Object.values(existingArchiveRefs)) archiveRefs.set(ref.runtimeEventId, ref);
        }
        for (const candidate of candidates) {
          const bodySha256 = sha256(candidate.serializedResult);
          const archived = await Promise.resolve(this.input.archiveToolResult?.({
            ...candidate,
            sessionId: this.sessionId,
            bodySha256,
          })).catch(() => undefined);
          if (!archived?.artifactId) continue;
          archiveRefs.set(candidate.runtimeEventId, {
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
            archiveRefs: [...archiveRefs.values()],
          },
        };
      }
    }

    const compactLoadPatch = await this.loadHistoryCompactBlocks(nextPolicy);
    if (compactLoadPatch.policy !== nextPolicy) nextPolicy = compactLoadPatch.policy;
    const loadPatch = await this.loadSynthesisCacheBlocks(nextPolicy);
    if (loadPatch.policy !== nextPolicy) nextPolicy = loadPatch.policy;
    const diagnosticPatch = mergeContextBudgetDiagnosticPatches(
      compactLoadPatch.diagnosticPatch,
      loadPatch.diagnosticPatch,
    );
    return {
      policy: nextPolicy,
      ...(diagnosticPatch ? { diagnosticPatch } : {}),
    };
  }

  private buildActiveToolResultPrunePrepareStep(
    turnId: string,
    onDiagnosticPatch?: (patch: ActiveToolResultPruneDiagnosticPatch) => void,
  ): PrepareStepFunctionLike | undefined {
    const policy = this.input.contextBudget?.activeToolResultPrune;
    if (policy?.enabled !== true) return undefined;

    const archivedPlaceholders = new Map<string, ActiveArchivedToolResultPlaceholder>();
    return async (options) => {
      const eligibleToolCallIds = collectPrepareStepToolCallIds(options.steps);
      if (eligibleToolCallIds.size === 0) return undefined;
      const rewritten = await rewriteActiveToolResultsInMessages({
        messages: options.messages,
        policy,
        stepNumber: options.stepNumber,
        turnId,
        charsPerToken: this.input.contextBudget?.charsPerToken,
        eligibleToolCallIds,
        archivedPlaceholders,
        archiveToolResult: async (candidate) => {
          return await Promise.resolve(this.input.archiveToolResult?.({
            ...candidate,
            sessionId: this.sessionId,
            runtimeEventId: candidate.runtimeEventId ?? activeToolResultArchiveKey(candidate),
          }));
        },
      });
      if (hasActiveToolResultPruneDiagnosticPatch(rewritten.diagnosticPatch)) {
        onDiagnosticPatch?.(rewritten.diagnosticPatch);
      }
      return rewritten.rewritten > 0 ? { messages: rewritten.messages } : undefined;
    };
  }

  private async loadHistoryCompactBlocks(
    policy: ContextBudgetPolicy,
  ): Promise<{ policy: ContextBudgetPolicy; diagnosticPatch?: Partial<ContextBudgetDiagnostic> }> {
    const historyCompact = policy.historyCompact;
    if (historyCompact?.enabled !== true || !this.input.loadHistoryCompact) {
      return { policy };
    }
    if ((historyCompact.blocks?.length ?? 0) > 0) {
      return { policy };
    }
    try {
      const result = await Promise.resolve(this.input.loadHistoryCompact({
        sessionId: this.sessionId,
        maxBlocks: historyCompact.maxBlocks,
        maxEstimatedTokens: historyCompact.maxEstimatedTokens,
        maxBytes: (historyCompact.maxEstimatedTokens ?? 2_048) * (policy.charsPerToken ?? 4),
      }));
      const blocks = result.blocks ?? [];
      return {
        policy: {
          ...policy,
          historyCompact: {
            ...historyCompact,
            blocks,
          },
        },
        diagnosticPatch: {
          historyCompactEnabled: true,
          historyCompactMode: historyCompact.mode ?? 'deterministic',
          historyCompactBlocksLoaded: blocks.length,
          historyCompactBlocksAvailable: blocks.length,
          ...(result.skipped && result.skipped > 0 ? { historyCompactLoadSkipped: result.skipped } : {}),
          ...(result.skippedReasonCounts ? { historyCompactLoadSkippedReasonCounts: result.skippedReasonCounts } : {}),
        },
      };
    } catch {
      return {
        policy,
        diagnosticPatch: {
          historyCompactEnabled: true,
          historyCompactMode: historyCompact.mode ?? 'deterministic',
          historyCompactLoadFailures: 1,
        },
      };
    }
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

  private async writeHistoryCompactBlocks(input: {
    turnId: string;
    contextBudget: ContextBudgetPolicy;
    priorRuntimeContext: readonly RuntimeEvent[];
    draftBlocks: HistoryCompactBlock[];
  }): Promise<{
    diagnosticPatch: Partial<ContextBudgetDiagnostic>;
    replacementBlocks: HistoryCompactBlock[];
  }> {
    const historyCompact = input.contextBudget.historyCompact;
    if (historyCompact?.enabled !== true || historyCompact.mode !== 'read_write' || !this.input.writeHistoryCompact) {
      return { diagnosticPatch: {}, replacementBlocks: [] };
    }
    const limits = {
      maxBlocks: historyCompact.maxBlocks ?? 1,
      maxBlockEstimatedTokens:
        historyCompact.maxBlockEstimatedTokens ?? historyCompact.maxSummaryEstimatedTokens ?? 1_024,
      maxEstimatedTokens: historyCompact.maxEstimatedTokens ?? 2_048,
      charsPerToken: input.contextBudget.charsPerToken ?? 4,
    };
    const replacementBlocks: HistoryCompactBlock[] = [];
    let writesAttempted = 0;
    let written = 0;
    let skipped = 0;
    const skippedReasonCounts: Record<string, number> = {};
    try {
      for (const draftBlock of input.draftBlocks.slice(0, limits.maxBlocks)) {
        const foldedIds = new Set(draftBlock.coverage.runtimeEventIds);
        const foldedRuntimeEvents = input.priorRuntimeContext.filter((event) => foldedIds.has(event.id));
        if (foldedRuntimeEvents.length === 0) {
          skipped += 1;
          incrementRecord(skippedReasonCounts, 'source_missing');
          continue;
        }
        writesAttempted += 1;
        const result = await Promise.resolve(this.input.writeHistoryCompact({
          sessionId: this.sessionId,
          turnId: input.turnId,
          source: {
            draftBlock,
            foldedRuntimeEvents,
          },
          limits,
          requestShapeHashBefore: this.priorRequestShape?.requestShapeHash,
        }));
        const blocks = result?.blocks ?? [];
        if (result?.skipped && result.skipped > 0) {
          skipped += result.skipped;
          mergeCountsInto(skippedReasonCounts, result.skippedReasonCounts);
        }
        for (const block of blocks) {
          replacementBlocks.push(block);
          written += 1;
        }
      }
      const estimatedTokens = replacementBlocks.reduce((total, block) => total + (block.estimatedTokens ?? 0), 0);
      return {
        replacementBlocks,
        diagnosticPatch: {
          historyCompactEnabled: true,
          historyCompactMode: 'read_write',
          historyCompactWritesAttempted: writesAttempted,
          historyCompactBlocksWritten: written,
          ...(replacementBlocks.length > 0
            ? {
                historyCompactWrittenBlockIds: replacementBlocks.map((block) => block.blockId),
                historyCompactWriteEstimatedTokens: estimatedTokens,
                historyCompactBlockIds: replacementBlocks.map((block) => block.blockId),
                historyCompactedEstimatedTokensAfter: estimatedTokens,
                highWaterName: replacementBlocks[0]!.highWaterName,
                highWaterSeq: replacementBlocks[0]!.highWaterSeq,
                highWaterReason: 'history_compact',
              }
            : {}),
          ...(skipped > 0 ? { historyCompactWriteSkipped: skipped } : {}),
          ...(Object.keys(skippedReasonCounts).length > 0
            ? { historyCompactWriteSkippedReasonCounts: skippedReasonCounts }
            : {}),
        },
      };
    } catch {
      return {
        replacementBlocks: [],
        diagnosticPatch: {
          historyCompactEnabled: true,
          historyCompactMode: 'read_write',
          historyCompactWritesAttempted: writesAttempted || 1,
          historyCompactWriteFailures: 1,
        },
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
    this.currentRunId = null;
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

function retrieveReplayHistoryAroundSearchSource(
  replayEvents: readonly RuntimeEvent[],
  searchEvents: readonly RuntimeEvent[],
  query: string,
  policy: RuntimeEventHistorySearchPolicy | undefined,
  options: { charsPerToken?: number } = {},
): RuntimeEventHistoryAroundResult {
  if (policy?.enabled !== true) {
    return { events: [], hits: [], diagnosticPatch: {} };
  }
  const charsPerToken = options.charsPerToken ?? 4;
  const around = Math.max(0, Math.floor(policy.around ?? 1));
  const maxEstimatedTokens = typeof policy.maxEstimatedTokens === 'number'
    && Number.isFinite(policy.maxEstimatedTokens)
    && policy.maxEstimatedTokens > 0
    ? Math.floor(policy.maxEstimatedTokens)
    : 4_096;
  const hits = searchRuntimeEventHistory(searchEvents, policy.query ?? query, policy);
  const selectedIndexes = new Set<number>();
  const indexesByEventId = new Map(replayEvents.map((event, index) => [event.id, index]));
  let skipped = 0;
  for (const hit of hits) {
    const index = indexesByEventId.get(hit.eventId);
    if (index === undefined) {
      skipped += 1;
      continue;
    }
    for (let cursor = Math.max(0, index - around); cursor <= Math.min(replayEvents.length - 1, index + around); cursor += 1) {
      selectedIndexes.add(cursor);
    }
  }

  const selectedEvents: RuntimeEvent[] = [];
  let selectedTokens = 0;
  for (const index of [...selectedIndexes].sort((a, b) => a - b)) {
    const event = replayEvents[index]!;
    const estimate = estimateRuntimeEventsTokens([event], charsPerToken);
    if (selectedTokens + estimate > maxEstimatedTokens) {
      skipped += 1;
      continue;
    }
    selectedEvents.push(event);
    selectedTokens += estimate;
  }

  return {
    events: selectedEvents,
    hits,
    diagnosticPatch: {
      historySearchMatches: hits.length,
      historyAroundRetrievedEvents: selectedEvents.length,
      historyAroundEstimatedTokens: selectedTokens,
      ...(skipped > 0 ? { historyAroundSkippedEvents: skipped } : {}),
    },
  };
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
    historyCompactSkippedReasonCounts: mergeCountRecords(
      base.historyCompactSkippedReasonCounts,
      patch.historyCompactSkippedReasonCounts,
    ),
    historyCompactLoadSkippedReasonCounts: mergeCountRecords(
      base.historyCompactLoadSkippedReasonCounts,
      patch.historyCompactLoadSkippedReasonCounts,
    ),
    historyCompactWriteSkippedReasonCounts: mergeCountRecords(
      base.historyCompactWriteSkippedReasonCounts,
      patch.historyCompactWriteSkippedReasonCounts,
    ),
  };
}

function mergeContextBudgetDiagnosticPatches(
  left: Partial<ContextBudgetDiagnostic> | undefined,
  right: Partial<ContextBudgetDiagnostic> | undefined,
): Partial<ContextBudgetDiagnostic> | undefined {
  if (!left && !right) return undefined;
  if (!left) return right;
  if (!right) return left;
  return mergeContextBudgetDiagnostic(left as ContextBudgetDiagnostic, right);
}

function mergeActiveToolResultPruneDiagnosticPatches(
  left: ActiveToolResultPruneDiagnosticPatch,
  right: ActiveToolResultPruneDiagnosticPatch,
): ActiveToolResultPruneDiagnosticPatch {
  return {
    ...sumOptionalCounts('activePrunedToolResults', left, right),
    ...sumOptionalCounts('activeArchiveFailures', left, right),
    ...sumOptionalCounts('activeEstimatedTokensSaved', left, right),
  };
}

function sumOptionalCounts<K extends keyof ActiveToolResultPruneDiagnosticPatch>(
  key: K,
  left: ActiveToolResultPruneDiagnosticPatch,
  right: ActiveToolResultPruneDiagnosticPatch,
): Pick<ActiveToolResultPruneDiagnosticPatch, K> | Record<string, never> {
  const total = (left[key] ?? 0) + (right[key] ?? 0);
  return total > 0 ? { [key]: total } as Pick<ActiveToolResultPruneDiagnosticPatch, K> : {};
}

function hasActiveToolResultPruneDiagnosticPatch(
  patch: ActiveToolResultPruneDiagnosticPatch,
): boolean {
  return (patch.activePrunedToolResults ?? 0) > 0
    || (patch.activeArchiveFailures ?? 0) > 0
    || (patch.activeEstimatedTokensSaved ?? 0) > 0;
}

function contextBudgetWithActiveToolResultPruneDiagnostics(
  base: ContextBudgetDiagnostic | undefined,
  patch: ActiveToolResultPruneDiagnosticPatch,
): ContextBudgetDiagnostic | undefined {
  if (!hasActiveToolResultPruneDiagnosticPatch(patch)) return base;
  return {
    ...(base ?? minimalContextBudgetDiagnostic()),
    ...patch,
  } as ContextBudgetDiagnostic;
}

function minimalContextBudgetDiagnostic(): ContextBudgetDiagnostic {
  return {
    enabled: true,
    estimatedTokensBefore: 0,
    estimatedTokensAfter: 0,
    keptTurns: 0,
    droppedTurns: 0,
    keptEvents: 0,
    droppedEvents: 0,
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

function replaceHistoryCompactReplayBlocks(
  events: readonly RuntimeEvent[],
  blocks: readonly HistoryCompactBlock[],
): RuntimeEvent[] {
  if (blocks.length === 0) return [...events];
  return [
    ...blocks.map((block) => historyCompactBlockToRuntimeEvent(block)),
    ...events.filter((event) => !event.id.startsWith('history-compact:')),
  ];
}

function incrementRecord(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function mergeCountsInto(target: Record<string, number>, source: Record<string, number> | undefined): void {
  for (const [key, value] of Object.entries(source ?? {})) {
    target[key] = (target[key] ?? 0) + value;
  }
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
