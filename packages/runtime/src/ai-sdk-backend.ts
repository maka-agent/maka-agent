/**
 * AiSdkBackend — single backend for all LLM providers via Vercel AI SDK.
 *
 * Provides one `streamText` API across Anthropic / OpenAI / Google / DeepSeek /
 * OpenAI-compatible endpoints, while keeping all of our home-grown
 * machinery: PermissionEngine (policy + park/resume), materializer,
 * AsyncEventQueue, SessionStore JSONL persistence.
 *
 * The agent loop (multi-step tool calling) is owned by ai-sdk's `streamText`.
 * An explicit `maxSteps` uses `stopWhen: isStepCount(N)`; otherwise the loop
 * has no step cap. Permission gating happens inside each tool's `execute()`
 * callback — that's the seam where we consult PermissionEngine and either run,
 * deny synthetically, or park awaiting user.
 *
 * Design:
 *   send()
 *     ├─ build AsyncEventQueue<SessionEvent>
 *     ├─ resolve LanguageModelV2 via deps.modelFactory(connection, modelId)
 *     ├─ wrap each MakaTool's execute() with permission round-trip
 *     ├─ background task: pump streamText.stream → normalize → queue
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
  ContextBudgetExhaustedDetail,
  AbortEvent,
  ErrorEvent,
  TextCompleteEvent,
  ThinkingCompleteEvent,
  TokenUsageEvent,
  StorageRef,
  AttachmentRef,
} from '@maka/core/events';
import { createHash } from 'node:crypto';
import type {
  StoredMessage,
  AssistantMessage,
  ToolCallMessage,
  ToolResultMessage,
  PermissionDecisionMessage,
  TokenUsageMessage,
  SystemNoteMessage,
  BackendKind,
  SessionHeader,
} from '@maka/core/session';
import type {
  AgentBackend,
  BackendCompactHistoryInput,
  BackendCompactHistoryResult,
  BackendSendInput,
  PermissionDecision,
} from '@maka/core/backend-types';
import type { AgentSpec } from '@maka/core/runtime-inputs';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { ToolPermissionRule } from '@maka/core/permission';
import type { UserQuestionResponse } from '@maka/core/user-question';
import type { AttachmentByteReader } from '@maka/core/attachments';
import {
  MAX_PROVIDER_IMAGE_REQUEST_BYTES,
  PROVIDER_IMAGE_BUDGET_EXCEEDED_MESSAGE,
} from '@maka/core';
import type {
  LlmCallRecord,
  PricingConfig,
  ToolInvocationRecord,
} from '@maka/core/usage-stats/types';
import type { ContextBudgetDiagnostic, PromptSegmentEstimate } from '@maka/core/usage-stats/types';
import type { JSONValue, ModelMessage } from 'ai';
import { z } from 'zod';

import { PermissionEngine } from './permission-engine.js';
import {
  AiSdkAutoApprovalReviewer,
  ApprovalCoordinator,
  type AutoApprovalReviewer,
} from './approval-reviewer.js';
import { AsyncEventQueue } from './async-queue.js';
import { StreamWatchdog, formatStreamWatchdogError } from './stream-watchdog.js';
import {
  MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN,
  MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN,
  TOOL_ERROR_RESULT_MAX_CHARS,
  ToolRuntime,
  formatSyntheticToolErrorText,
  type MakaTool,
  type MakaToolContext,
  type AgentTeamExecutionContext,
  type ToolModelOutput,
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
  type StreamTextResult,
} from './model-adapter.js';
import {
  activeToolResultLineageIdentity,
  rewriteActiveToolResultsInMessages,
  type ActiveToolResultPruneDiagnosticPatch,
} from './active-tool-result-prune.js';
import { toolResultOutput } from './ai-sdk-tool-output.js';
import {
  buildActiveCompactionHeadAnchor,
  rewriteActiveFullCompactInMessages,
  type ActiveFullCompactBlock,
  type ActiveCompactionHeadAnchor,
} from './active-full-compact.js';
import {
  rewriteSemanticCompactInMessages,
  type SemanticCompactBlock,
  type SemanticCompactControllerState,
} from './semantic-compact.js';
import {
  compactionDecisionDiagnosticPatch,
  historyCompactBlockToCompactionBoundary,
} from './compaction-boundary.js';
import type { ToolArtifactRecorder } from './tool-artifacts.js';
import { RunTrace, type RunTraceRecorder } from './run-trace.js';
import { computeCost } from './telemetry/cost.js';
import { getBuiltinPricing } from './telemetry/builtin-pricing.js';
import {
  buildRuntimeEventModelReplayPlan,
  buildSteeringEnvelope,
  collectToolActivityTurnIds,
  formatTextWithAttachmentRefs,
  steeringMessagesMissingFromBase,
  steeringModelMessage,
  steeringProviderOptions,
  stripSteeringMessages,
  type RuntimeEventModelReplayItem,
  type RuntimeEventModelReplayPlan,
  type RuntimeEventReplayFallbackGate,
} from './model-history.js';
import {
  computeRequestShapeDiagnostic,
  toolSchemaCharsForDiagnostics,
  type RequestShapeDiagnostic,
} from './request-shape.js';
import { ToolAvailabilityRuntime, type ToolAvailabilityConfig } from './tool-availability.js';
import {
  ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
  applyRuntimeEventContextBudget,
  buildContextBudgetDiagnosticShell,
  buildHistoryCompactBlockFromSummary,
  buildHistorySearchSource,
  buildPromptSegmentEstimates,
  collectStaleToolResultArchiveCandidates,
  evaluateHistoryCompactCheckpointReplay,
  estimateRuntimeEventsTokens,
  isHistoryCompactContentEvent,
  mergeContextBudgetDiagnostic,
  mergeContextBudgetDiagnosticPatches,
  mergeRuntimeEventsInOriginalOrder,
  minimalContextBudgetDiagnostic,
  rawEvidenceRequestReason,
  replaceHistoryCompactReplayBlocks,
  retrieveArchivedToolResultsForReplay,
  retrieveReplayHistoryAroundSearchSource,
  retrieveRuntimeEventHistoryAround,
  runtimeEventTurnKey,
  selectSynthesisCacheForReplay,
  shouldAppendContextCompactedNote,
  shouldAppendContextCompactionFailedOpenNote,
  type ContextBudgetPolicy,
  type HistoryCompactBlock,
  type ActiveArchivedToolResultPlaceholder,
  type ActiveToolResultArchiveCandidate,
  type StaleToolResultArchiveCandidate,
  type SynthesisCacheBlock,
  type SynthesisSourceRef,
  type ArchiveRetrievalMode,
  type ToolResultArchiveReader,
  type ToolResultArchiveRef,
} from './context-budget.js';
import { HistoryCompactSummarizerError } from './history-compact-error.js';
import {
  buildHistoryCompactCheckpoint,
  historyCompactCheckpointToRuntimeEvent,
  matchHistoryCompactCheckpointPrefix,
  projectHistoryCompactCheckpointReplay,
  type HistoryCompactCheckpoint,
} from './history-compact-checkpoint.js';
import { resolveSelectedModelContextWindow } from './context-budget-policy.js';
import {
  estimateNextRequestTokens,
  exceedsHighWater,
  planMidTurnCapacityCompaction,
} from './mid-turn-capacity-compact.js';
export {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN,
  MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN,
  TOOL_ERROR_RESULT_MAX_CHARS,
  formatSyntheticToolErrorText,
} from './tool-runtime.js';
export { normalizeAiSdkUsage } from './model-adapter.js';
export type { ModelFactory, ModelFactoryInput, RepairableAiSdkToolCall } from './model-adapter.js';
export type { RunTraceEvent, RunTraceRecorder } from './run-trace.js';

// ============================================================================
// AgentBackend interface — port contract now lives in @maka/core/backend-types;
// re-exported here for backward compatibility with existing import sites.
// ============================================================================

export type {
  AgentBackend,
  BackendCompactHistoryInput,
  BackendCompactHistoryResult,
} from '@maka/core/backend-types';

export const INVALID_TOOL_NAME = 'invalid';

/**
 * Deterministic prepareStep pipeline over ONE provider-visible projection.
 * Order is a contract: mid-turn capacity compaction runs first among the
 * message-shaping hooks so every later mechanism operates on (and re-converges
 * onto) its projection — active tool-result pruning re-archives large tool
 * results in the rebuilt tail, and semantic/active-full compaction sees the
 * already-compacted messages. On a step where the capacity hook replaced the
 * request, semantic/active-full compaction yields (see send()) so two
 * summarizers never run for one step.
 *
 * Every hook here only SHAPES the projection. The pass/terminate capacity
 * verdict is issued once, after the whole pipeline, by the final-request
 * estimate owner (buildMidTurnFinalRequestVerdict) over the actual outgoing
 * (messages, tools) payload — never by an individual hook over an intermediate
 * projection that a later hook could still rescue.
 */
export function composePrepareStep(
  toolAvailability: PrepareStepFunctionLike | undefined,
  midTurnCapacityCompact: PrepareStepFunctionLike | undefined,
  activeToolResultPrune: PrepareStepFunctionLike | undefined,
  activeFullCompact?: PrepareStepFunctionLike | undefined,
): PrepareStepFunctionLike | undefined {
  const hooks = [
    toolAvailability,
    midTurnCapacityCompact,
    activeToolResultPrune,
    activeFullCompact,
  ].filter(Boolean) as PrepareStepFunctionLike[];
  if (hooks.length === 0) return undefined;
  return async (options: PrepareStepLike): Promise<PrepareStepResultLike | undefined> => {
    let result: PrepareStepResultLike | undefined;
    let messages = options.messages;
    for (const hook of hooks) {
      const hookOptions = {
        ...options,
        messages,
        ...(result?.activeTools ? { activeTools: result.activeTools } : {}),
      } as PrepareStepLike;
      const hookResult = await Promise.resolve(hook(hookOptions));
      if (!hookResult) continue;
      result = {
        ...(result ?? {}),
        ...hookResult,
        activeTools: hookResult.activeTools ?? result?.activeTools,
      };
      if (hookResult.messages) messages = hookResult.messages;
    }
    return result;
  };
}

type ActiveCompactionPrepareStepResult = PrepareStepResultLike & {
  makaSemanticCompactStatus?: 'replaced' | 'projected';
};

function composeActiveCompactionPrepareStep(
  attention: PrepareStepFunctionLike | undefined,
  capacity: PrepareStepFunctionLike | undefined,
): PrepareStepFunctionLike | undefined {
  if (!attention) return capacity;
  if (!capacity) return attention;
  return async (options) => {
    const attentionResult = (await Promise.resolve(attention(options))) as
      | ActiveCompactionPrepareStepResult
      | undefined;
    if (attentionResult?.makaSemanticCompactStatus === 'replaced') {
      const { makaSemanticCompactStatus: _status, ...providerResult } = attentionResult;
      return providerResult;
    }
    const capacityResult = await Promise.resolve(
      capacity({
        ...options,
        messages: attentionResult?.messages ?? options.messages,
        ...(attentionResult?.activeTools ? { activeTools: attentionResult.activeTools } : {}),
      }),
    );
    if (!capacityResult) {
      if (!attentionResult) return undefined;
      const { makaSemanticCompactStatus: _status, ...providerResult } = attentionResult;
      return providerResult;
    }
    return {
      ...attentionResult,
      ...capacityResult,
      activeTools: capacityResult.activeTools ?? attentionResult?.activeTools,
      messages: capacityResult.messages ?? attentionResult?.messages,
    };
  };
}

function activeToolResultArchiveKey(
  candidate: ActiveToolResultArchiveCandidate & { bodySha256: string },
): string {
  return `active:${candidate.turnId}:${candidate.toolCallId}:${candidate.bodySha256}`;
}

/**
 * Tool results from the newest completed step have not crossed the provider
 * boundary yet: prepareStep is invoked immediately before the first request
 * that could show those results to the model. By default active pruning defers
 * the newest step and archives only older completed steps, after the model has
 * had one request in which to consume their exact output.
 *
 * `includeNewestStep` widens eligibility to every completed step, including the
 * newest. The caller sets it when mid-turn capacity compaction is active: the
 * final-payload verdict may need an oversized newest result pruned to a
 * placeholder before declaring exhaustion, and capacity/recovery rebuilds
 * re-materialize raw bodies from the ledger that must be re-archived.
 */
function collectPrunablePrepareStepToolCallIds(
  steps: PrepareStepLike['steps'],
  includeNewestStep: boolean,
): Set<string> {
  const out = new Set<string>();
  const prunableSteps = includeNewestStep ? steps : steps.slice(0, -1);
  for (const step of prunableSteps) {
    for (const call of step.toolCalls ?? []) {
      if (typeof call.toolCallId === 'string' && call.toolCallId.length > 0) {
        out.add(call.toolCallId);
      }
    }
  }
  return out;
}

interface ActiveFullCompactPrepareStepProjection {
  sourceSignatures: readonly string[];
  sourceSignatureMode: 'exact' | 'active_prune_lineage';
  projectedMessages: readonly ModelMessage[];
  semanticBlock?: SemanticCompactBlock;
}

function projectAcceptedActiveFullCompactMessages(
  incomingMessages: readonly ModelMessage[],
  acceptedProjection: ActiveFullCompactPrepareStepProjection | undefined,
): ModelMessage[] | undefined {
  if (!acceptedProjection) return undefined;
  const sourceSignature =
    acceptedProjection.sourceSignatureMode === 'active_prune_lineage'
      ? projectionSourceMessageSignature
      : modelMessageSignature;
  if (incomingMessages.length < acceptedProjection.sourceSignatures.length) return undefined;
  for (let index = 0; index < acceptedProjection.sourceSignatures.length; index += 1) {
    if (sourceSignature(incomingMessages[index]!) !== acceptedProjection.sourceSignatures[index]) {
      return undefined;
    }
  }
  return [
    ...acceptedProjection.projectedMessages,
    ...incomingMessages.slice(acceptedProjection.sourceSignatures.length),
  ];
}

// ============================================================================
// Mid-turn capacity compaction — per-send trigger state
// ============================================================================

/**
 * Per-send() state for the mid-turn capacity invariant. The coverage pool is
 * NOT mirrored here: every trigger reads the current turn's persisted
 * RuntimeEvents through the injected durable-read seam, so coverage can only
 * span events the ledger already replays. This class keeps only the trigger's
 * cursor state between steps.
 */
class MidTurnCapacityCompactState {
  /**
   * Chars of the final (system prompt + messages + active tool schema)
   * payload of the LAST prepared request, recorded by the final-request
   * estimate owner at the end of every prepareStep pipeline run. All capacity estimates are signed
   * deltas against this number, so they are anchored to the request the
   * provider actually saw — a compacted projection, a pruned tail, or a
   * same-turn tool-schema expansion all move the delta the same way.
   */
  lastRequestPayloadChars: number | undefined;
  /**
   * The last request's REAL input size: the inputTokens the provider reported
   * for the last finished step. Never input+output — the signed payload delta
   * already carries the step's freshly generated output (assistant text/tool
   * calls) and its tool results, so an output-inclusive baseline would count
   * them twice. Undefined when the last step's usage is missing or unusable
   * (no positive input count); estimates then fall back to the whole-payload
   * cold-start path — an unusable sample is unknown, never zero.
   */
  lastRequestInputTokens: number | undefined;
  /** Latest durable checkpoint (loaded or written) for roll-forward summaries. */
  previousCheckpoint: HistoryCompactCheckpoint | undefined;
  /** Set when the turn must end with a context_budget_exhausted outcome. */
  exhaustedDetail: ContextBudgetExhaustedDetail | undefined;
  /**
   * Step whose request the capacity hook replaced. Semantic/active-full
   * compaction yields on that exact step so one step never runs two
   * summarizers or double-projects.
   */
  replacedStepNumber: number | undefined;
  /**
   * finish-step boundaries the event pump has flushed into the session-event
   * queue. The capacity hook's durability wait needs it: only after the pump
   * has flushed step N's boundary are that step's thinking/text completion
   * events enqueued at all.
   */
  flushedSteps = 0;
  /**
   * Set by the final-request estimate owner to force one capacity re-entry on
   * the current step, bypassing the (deliberately approximate) high-water
   * trigger. Consumed by the capacity hook on its next invocation.
   */
  forcedTriggerEstimate: number | undefined;
  /**
   * The capacity hook's most recent shaping failure. The owner reads it (for
   * the same step only) to pick the terminal detail and diagnostic reason
   * when the final payload is over the window, and to avoid re-entering a
   * shaper that already attempted and failed this step.
   */
  lastShapeFailure:
    | {
        stepNumber: number;
        detail: ContextBudgetExhaustedDetail;
        diagnosticReason: string;
      }
    | undefined;

  constructor(
    readonly headAnchor: RuntimeEvent,
    readonly priorContentEvents: readonly RuntimeEvent[],
    readonly contextWindow: number,
  ) {}
}

/**
 * Char measure of the FULL provider-visible request input: the system prompt
 * (sent through the separate `system` field), the (projected) messages, and
 * the serialized schemas of the active tool subset. The capacity trigger and
 * the final-request estimate owner both measure with this ONE function, so
 * their deltas against `lastRequestPayloadChars` are commensurable and
 * same-turn tool-schema growth (a `load_tools` activation) is counted like
 * any other payload growth. The system prompt is constant between adjacent
 * requests — signed deltas cancel it — but the cold-start estimate (no usable
 * usage sample) is the whole payload, so omitting it would under-estimate by
 * exactly the system prompt and let an over-window request stream.
 */
function midTurnRequestPayloadChars(
  messages: readonly ModelMessage[],
  providerTools: readonly MakaTool[],
  activeTools: readonly string[],
  systemPromptChars: number,
): number {
  return (
    Math.max(0, Math.floor(systemPromptChars)) +
    JSON.stringify(messages).length +
    toolSchemaCharsForDiagnostics(providerTools, activeTools)
  );
}

/**
 * Outcome of folding the durable turn ledger into a replacement projection.
 * Shared by the proactive prepareStep hook (which maps it to keepProjection /
 * shapeFailure / a `context_limit` replacement) and the reactive overflow
 * recovery (which maps it to a retry / a real error terminal, with an
 * `overflow` reason). The verdict/diagnostic is the caller's; this only shapes.
 */
type MidTurnCompactionOutcome =
  | { decision: 'skip' }
  | {
      decision: 'fail';
      detail: ContextBudgetExhaustedDetail;
      diagnosticReason: string;
      recorderCounters?: Partial<ContextBudgetDiagnostic>;
    }
  | {
      decision: 'compacted';
      checkpoint: HistoryCompactCheckpoint;
      replacementMessages: ModelMessage[];
      estimatedTokensBefore: number;
      estimatedTokensAfter: number;
    };

/**
 * The `decision: 'replaced'` diagnostic patch for a durable mid_turn fold,
 * shared by the proactive (`reason: 'context_limit'`) and reactive
 * (`reason: 'overflow'`) triggers so both report the fold identically.
 */
function buildMidTurnReplacedDiagnosticPatch(input: {
  checkpoint: HistoryCompactCheckpoint;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  reason: string;
}): Partial<ContextBudgetDiagnostic> {
  const { checkpoint, estimatedTokensBefore, estimatedTokensAfter, reason } = input;
  return {
    historyCompactEnabled: true,
    historyCompactMode: 'read_write',
    historyCompactWritesAttempted: 1,
    historyCompactBlocksWritten: 1,
    historyCompactWrittenBlockIds: [checkpoint.checkpointId],
    historyCompactWriteEstimatedTokens: checkpoint.estimatedTokens,
    historyCompactBlockIds: [checkpoint.checkpointId],
    historyCompactedTurns: checkpoint.coverage.turnCount,
    historyCompactedEvents: checkpoint.coverage.eventCount,
    historyCompactedEstimatedTokensBefore: estimatedTokensBefore,
    historyCompactedEstimatedTokensAfter: estimatedTokensAfter,
    highWaterName: checkpoint.highWaterName,
    highWaterSeq: checkpoint.highWaterSeq,
    highWaterReason: 'history_compact',
    ...compactionDecisionDiagnosticPatch({
      stage: 'activeStep',
      sourceKind: 'runtimeEvents',
      decision: 'replaced',
      phase: 'mid_turn',
      boundaryKind: 'historyCompact',
      boundaryIds: [checkpoint.checkpointId],
      coverage: { bodySha256: [checkpoint.coverage.sourceDigest] },
      reason,
      estimatedTokensBefore,
      estimatedTokensAfter,
    }),
  };
}

/**
 * Event-driven wait for seq-ack progress: resolves when the queue reports any
 * push/ack/close/wake, or immediately on abort. The caller loops and re-checks
 * its condition — a condition variable, not a poll.
 */
function waitForQueueProgressOrAbort(
  queue: AsyncEventQueue<SessionEvent>,
  abortSignal: AbortSignal | undefined,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      abortSignal?.removeEventListener('abort', settle);
      resolve();
    };
    abortSignal?.addEventListener('abort', settle, { once: true });
    void queue.waitForProgress().then(settle);
  });
}

function joinPromptFragments(fragments: readonly (string | undefined)[]): string | undefined {
  const joined = fragments
    .map((fragment) => fragment?.trim())
    .filter((fragment): fragment is string => Boolean(fragment))
    .join('\n\n');
  return joined.length > 0 ? joined : undefined;
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
  abortSignal?: AbortSignal;
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
export interface HistoryCompactSummaryInput {
  sessionId: string;
  turnId: string;
  source: { foldedRuntimeEvents: RuntimeEvent[] };
  previousCheckpoint?: HistoryCompactCheckpoint;
  newlyFoldedRuntimeEvents?: RuntimeEvent[];
  requestShapeHashBefore?: string;
  abortSignal?: AbortSignal;
}
export type HistoryCompactSummarizer = (
  input: HistoryCompactSummaryInput,
) => Promise<string | undefined> | string | undefined;
export type HistoryCompactCheckpointLoader = () =>
  | Promise<HistoryCompactCheckpoint | undefined>
  | HistoryCompactCheckpoint
  | undefined;
export type HistoryCompactCheckpointRecorder = (
  checkpoint: HistoryCompactCheckpoint,
  turnId: string,
) => void | Promise<void>;
export type ActiveFullCompactBlockRecorder = (
  block: ActiveFullCompactBlock,
) => void | Promise<void>;
export type SemanticCompactBlockRecorder = (block: SemanticCompactBlock) => void | Promise<void>;

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
  /** Optional override for execute-mode automatic permission review. */
  autoApprovalReviewer?: AutoApprovalReviewer;
  modelFactory: ModelFactory;
  /** Canonical-named tools available this session. Backend wraps each with
   *  permission gating before passing to ai-sdk. */
  tools: MakaTool[];
  /** Trusted identity for expert-team lead/member collaboration tools. */
  agentTeam?: AgentTeamExecutionContext;
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
  /** Optional cap on tool-call steps per turn; omitted means no step cap. */
  maxSteps?: number;
  /** Timeout before first SDK stream event; default 30s. */
  streamConnectTimeoutMs?: number;
  /** Timeout between SDK/tool events; paused while waiting on permission. Default 120s. */
  streamIdleTimeoutMs?: number;
  /** Timeout for a renderer/user permission decision. Default 300s. */
  permissionTimeoutMs?: number;
  /** Invocation-local allow/deny rules evaluated before the session mode. */
  permissionRules?: readonly ToolPermissionRule[];
  /** Optional system prompt (skills + workspace AGENTS.md merged upstream). */
  systemPrompt?:
    | string
    | ((context: SystemPromptContext) => string | undefined | Promise<string | undefined>);
  /** Optional provider-visible current-turn tail kept out of the durable system prefix. */
  turnTailPrompt?:
    | string
    | ((context: SystemPromptContext) => string | undefined | Promise<string | undefined>);
  /** Optional volatile ShellRun summary. Not persisted; appended to the current user turn tail only. */
  shellRunContextSummary?: () => string | undefined | Promise<string | undefined>;
  /** Provider-native options passed through to ai-sdk. */
  providerOptions?: Record<string, unknown>;
  /** Optional prior-history budget. Keeps whole turns to preserve tool-call/result pairs. */
  contextBudget?: ContextBudgetPolicy;
  /** Optional fire-and-forget telemetry hooks. Tool implementations remain unaware. */
  recordLlmCall?: LlmTelemetryRecorder;
  recordToolInvocation?: ToolTelemetryRecorder;
  /** Durable session-lifetime cumulative usage checkpoint after each completed provider step. */
  recordUsageCheckpoint?: (
    usage: NormalizedAiSdkUsage & { costUsd?: number },
  ) => void | Promise<void>;
  /** Optional pricing lookup shared with telemetry; defaults to builtin public pricing. */
  lookupPricing?: (modelKey: string) => PricingConfig | null;
  spawnChildAgent?: (input: {
    parentRunId: string;
    spec: AgentSpec;
    prompt: string;
    abortSignal: AbortSignal;
    onReady?: (input: {
      turnId: string;
      agentId: string;
      agentName: string;
    }) => void | Promise<void>;
    onEvent?: (event: SessionEvent) => void;
  }) => Promise<unknown>;
  listChildAgents?: () => Promise<unknown>;
  readChildAgentOutput?: (input: {
    runId?: string;
    turnId?: string;
    maxEvents?: number;
  }) => Promise<unknown>;
  /** Optional diagnostic trace hook for explaining a runtime turn without changing renderer events. */
  recordRunTrace?: RunTraceRecorder;
  /**
   * Optional artifact recorder. Runtime derives only deterministic candidates
   * from structured tool results / explicit redirects; desktop main owns
   * file-backed persistence.
   */
  recordToolArtifacts?: ToolArtifactRecorder;
  /**
   * Optional attachment byte reader. When set, image attachments on the current
   * user turn may be rendered as provider image parts instead of placeholder text.
   * Caller wires this to the session ArtifactStore; runtime never imports storage.
   */
  readAttachmentBytes?: AttachmentByteReader;
  /**
   * Whether the selected model accepts image input. Only explicit true sends
   * image parts; false/unknown stay as text refs with a fallback note.
   */
  supportsVision?: boolean;
  maxProviderImageRequestBytes?: number;
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
  /** Preferred bounded V2 checkpoint loader. Legacy artifact blocks remain a read-only fallback. */
  loadHistoryCompactCheckpoint?: HistoryCompactCheckpointLoader;
  /** Produces a checkpoint summary from the prior summary plus newly evicted RuntimeEvents. */
  summarizeHistoryCompact?: HistoryCompactSummarizer;
  /** Best-effort durable recorder for accepted V2 checkpoints. */
  recordHistoryCompactCheckpoint?: HistoryCompactCheckpointRecorder;
  /**
   * Durable read of the given turn's persisted RuntimeEvents from the
   * authoritative run ledger (same injection seam as the checkpoint
   * loader/recorder). Mid-turn capacity compaction derives its coverage pool
   * from this read: covered events are persisted by construction before the
   * checkpoint that folds them, and their bytes are exactly what recovery
   * replays. A lagging read is NOT fail-safe here — the replacement
   * projection replaces the whole message list, so a missing completed-step
   * event would be silently dropped from the next request; the capacity hook
   * therefore reads only after its seq-ack durability boundary (all enqueued
   * session events processed by the consumer) is satisfied.
   */
  loadTurnRuntimeEvents?: (turnId: string) => Promise<RuntimeEvent[]>;
  /** Optional best-effort durable recorder for accepted active full compact blocks. */
  recordActiveFullCompactBlock?: ActiveFullCompactBlockRecorder;
  /** Optional best-effort durable recorder for accepted semantic compact blocks. */
  recordSemanticCompactBlock?: SemanticCompactBlockRecorder;
}

export interface SystemPromptContext {
  sessionId: string;
  cwd: string;
  workspaceRoot: string;
}

function appendNonVisionImageFallbackNotice(textContent: string): string {
  return `${textContent}\n\n[image attachments omitted: the selected model does not support image input. Tell the user you cannot view the attached image(s) and ask them to describe the image or switch to a vision-capable model.]`;
}

function isImageToolResult(
  value: unknown,
): value is { kind: 'image'; mimeType: string; ref: StorageRef } {
  if (!value || typeof value !== 'object') return false;
  const image = value as { kind?: unknown; mimeType?: unknown; ref?: unknown };
  return (
    image.kind === 'image' &&
    typeof image.mimeType === 'string' &&
    image.ref !== null &&
    typeof image.ref === 'object'
  );
}

function toolResultText(text: string): ToolModelOutput {
  return { type: 'content', value: [{ type: 'text', text }] };
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
  private readonly maxSteps: number | undefined;
  private readonly toolRuntime: ToolRuntime;
  private readonly modelAdapter: ModelAdapter;
  private readonly toolAvailabilityRuntime: ToolAvailabilityRuntime;

  private aborted = false;
  private abortController: AbortController | null = null;
  private historyCompactAbortController: AbortController | null = null;
  private currentTurnId: string | null = null;
  private stopAfterStepRequested = false;
  /**
   * User messages steered into the running turn, drained from the caller's
   * queue at step boundaries. Each entry is the canonical envelope-wrapped
   * user ModelMessage — the SAME form the replay plan projects the persisted
   * steering event as, so the envelope text is the message's identity when
   * deduping against ledger-derived request bases (bare text is not an
   * identity: a steer can equal the current prompt verbatim). Entries are
   * added only AFTER the echoed steering_message event is durably consumed
   * (seq-ack), so a provider request never carries an unpersisted steering
   * directive. Reset per turn.
   */
  private injectedSteeringMessages: ModelMessage[] = [];
  private currentRunId: string | null = null;
  private imageRequestBudget: { used: number; decisions: Map<string, boolean> } | null = null;
  /** Side-channel for tool.execute() callbacks to push events into the iterator. */
  private currentQueue: AsyncEventQueue<SessionEvent> | null = null;
  /** Paused while the backend is waiting on a user permission decision. */
  private currentWatchdog: StreamWatchdog | null = null;
  private currentRunTrace: RunTrace | null = null;
  private currentUserIntent: string | undefined;
  private priorRequestShape: RequestShapeDiagnostic | undefined;
  private cumulativeUsageCheckpoint: NormalizedAiSdkUsage | undefined;
  /**
   * Id of the assistant step currently streaming. Read by ToolRuntime via
   * `getCurrentStepId` so each tool call's `tool_start` carries the step it
   * belongs to. Rotated at every step boundary in `send()`; null between turns.
   */
  private currentStepMessageId: string | null = null;

  constructor(input: AiSdkBackendInput) {
    this.input = input;
    this.sessionId = input.sessionId;
    this.newId = input.newId ?? (() => crypto.randomUUID());
    this.now = input.now ?? (() => Date.now());
    this.maxSteps = input.maxSteps;
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
    const autoApprovalReviewer =
      input.autoApprovalReviewer ??
      new AiSdkAutoApprovalReviewer({
        resolveModel: () => this.modelAdapter.resolveModel(),
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
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
      agentTeam: input.agentTeam,
      getCurrentStepId: () => this.currentStepMessageId ?? undefined,
      permissionRules: input.permissionRules,
      spawnChildAgent: input.spawnChildAgent,
      listChildAgents: input.listChildAgents,
      readChildAgentOutput: input.readChildAgentOutput,
      getRunTrace: () => this.currentRunTrace,
      permissionTimeoutMs: input.permissionTimeoutMs,
      recordToolInvocation: input.recordToolInvocation,
      recordToolArtifacts: input.recordToolArtifacts,
      approvalCoordinator: new ApprovalCoordinator({
        autoReviewer: autoApprovalReviewer,
        observer: {
          onAutoReviewStarted: (request) =>
            this.currentRunTrace?.emit(
              'permission',
              'auto_review_started',
              'Automatic permission review started',
              { requestId: request.requestId, toolUseId: request.toolUseId, kind: request.kind },
            ),
          onAutoReviewDecided: (request, decision) =>
            this.currentRunTrace?.emit(
              'permission',
              'auto_review_decided',
              'Automatic permission review decided',
              {
                requestId: request.requestId,
                toolUseId: request.toolUseId,
                decision: decision.outcome,
                riskLevel: decision.riskLevel,
              },
            ),
          onAutoReviewFailed: (request) =>
            this.currentRunTrace?.emit(
              'permission',
              'auto_review_failed',
              'Automatic permission review failed closed',
              { requestId: request.requestId, toolUseId: request.toolUseId },
            ),
        },
      }),
      getAutoApprovalReviewContext: () => ({
        ...(this.currentUserIntent !== undefined ? { userIntent: this.currentUserIntent } : {}),
      }),
    });
  }

  // --------------------------------------------------------------------------
  // manual history compaction
  // --------------------------------------------------------------------------

  async compactHistory(input: BackendCompactHistoryInput): Promise<BackendCompactHistoryResult> {
    const historyCompactAbortController = new AbortController();
    this.historyCompactAbortController = historyCompactAbortController;
    try {
      const runtimeContext = input.runtimeContext.filter((event) => event.turnId !== input.turnId);
      const policy = this.buildManualHistoryCompactPolicy(runtimeContext);
      if (!policy) return {};

      const contextBudget = policy;
      const budgeted = applyRuntimeEventContextBudget(runtimeContext, contextBudget, {
        historyCompactProtocol: this.hasHistoryCompactCheckpointWriter()
          ? 'checkpoint_v2'
          : 'legacy_v1',
      });
      let contextBudgetDiagnostic = budgeted?.diagnostic;

      if (
        budgeted?.historyCompactBlocks?.length &&
        contextBudget.historyCompact?.mode === 'read_write' &&
        this.hasHistoryCompactWriter()
      ) {
        const loadedBlockIds = new Set(
          (contextBudget.historyCompact.blocks ?? []).map((block) => block.blockId),
        );
        const draftBlocks = budgeted.historyCompactBlocks.filter(
          (block) => !loadedBlockIds.has(block.blockId),
        );
        if (draftBlocks.length > 0) {
          if (this.input.summarizeHistoryCompact && this.input.recordHistoryCompactCheckpoint) {
            let writeContextBudget = contextBudget;
            try {
              const checkpoint = await Promise.resolve(this.input.loadHistoryCompactCheckpoint?.());
              if (checkpoint) {
                writeContextBudget = {
                  ...contextBudget,
                  historyCompact: { ...contextBudget.historyCompact!, checkpoint },
                };
              }
            } catch {
              // A missing previous checkpoint only loses rolling reuse; the current fold remains safe to summarize.
            }
            const writePatch = await this.writeHistoryCompactCheckpoint({
              turnId: input.turnId,
              contextBudget: writeContextBudget,
              priorRuntimeContext: runtimeContext,
              draftBlock: draftBlocks[0]!,
              abortSignal: historyCompactAbortController.signal,
            });
            if (historyCompactAbortController.signal.aborted) return {};
            contextBudgetDiagnostic = mergeContextBudgetDiagnostic(
              contextBudgetDiagnostic ??
                buildContextBudgetDiagnosticShell(runtimeContext, budgeted.events, contextBudget),
              writePatch.diagnosticPatch,
            );
          } else {
            const writePatch = await this.writeHistoryCompactBlocks({
              turnId: input.turnId,
              contextBudget,
              priorRuntimeContext: runtimeContext,
              draftBlocks,
              abortSignal: historyCompactAbortController.signal,
            });
            if (historyCompactAbortController.signal.aborted) return {};
            if (writePatch.replacementBlocks.length === 0) {
              contextBudgetDiagnostic = buildContextBudgetDiagnosticShell(
                runtimeContext,
                runtimeContext,
                contextBudget,
              );
            }
            contextBudgetDiagnostic = mergeContextBudgetDiagnostic(
              contextBudgetDiagnostic ??
                buildContextBudgetDiagnosticShell(runtimeContext, budgeted.events, contextBudget),
              writePatch.diagnosticPatch,
            );
          }
        }
      }

      return contextBudgetDiagnostic ? { contextBudget: contextBudgetDiagnostic } : {};
    } finally {
      if (this.historyCompactAbortController === historyCompactAbortController) {
        this.historyCompactAbortController = null;
      }
    }
  }

  private buildManualHistoryCompactPolicy(
    runtimeContext: readonly RuntimeEvent[],
  ): ContextBudgetPolicy | undefined {
    if (runtimeContext.length === 0 || !this.input.contextBudget || !this.hasHistoryCompactWriter())
      return undefined;
    const base = this.input.contextBudget;
    const charsPerToken = base.charsPerToken ?? 4;
    const estimatedTokens = Math.max(1, estimateRuntimeEventsTokens(runtimeContext, charsPerToken));
    const current = base.historyCompact;
    const currentWithoutBlocks = { ...current };
    delete currentWithoutBlocks.blocks;
    delete currentWithoutBlocks.checkpoint;
    const maxHistoryEstimatedTokens =
      base.maxHistoryEstimatedTokens ?? Math.max(estimatedTokens, 32_000);
    return {
      name: base.name ?? 'manual-history-compact',
      ...(base.charsPerToken !== undefined ? { charsPerToken: base.charsPerToken } : {}),
      maxHistoryEstimatedTokens,
      minRecentTurns: current?.minRecentTurns ?? base.minRecentTurns ?? 1,
      historyCompact: {
        ...currentWithoutBlocks,
        enabled: true,
        mode: 'read_write',
        highWaterRatio: 0.000001,
        targetRatio: current?.targetRatio ?? 0.2,
        tailEstimatedTokens: 1,
        minRecentTurns: current?.minRecentTurns ?? base.minRecentTurns ?? 1,
        maxBlocks: current?.maxBlocks ?? 1,
        maxEstimatedTokens: current?.maxEstimatedTokens ?? 2048,
        maxBlockEstimatedTokens:
          current?.maxBlockEstimatedTokens ?? current?.maxSummaryEstimatedTokens ?? 1024,
        highWaterName: current?.highWaterName ?? `${base.name ?? 'manual'}-manual-history-compact`,
      },
    };
  }

  private hasHistoryCompactWriter(): boolean {
    return Boolean(
      this.input.writeHistoryCompact ||
        (this.input.summarizeHistoryCompact && this.input.recordHistoryCompactCheckpoint),
    );
  }

  private hasHistoryCompactCheckpointWriter(): boolean {
    return Boolean(this.input.summarizeHistoryCompact && this.input.recordHistoryCompactCheckpoint);
  }

  // --------------------------------------------------------------------------
  // send()
  // --------------------------------------------------------------------------

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.aborted = false;
    const turnId = input.turnId;
    this.currentTurnId = turnId;
    this.currentRunId = input.runId ?? null;
    this.currentUserIntent = input.text;
    this.input.permissionEngine.beginTurn(turnId);
    this.toolRuntime.beginTurn(turnId);
    this.abortController = new AbortController();
    this.imageRequestBudget = { used: 0, decisions: new Map() };

    const midTurnState = this.buildMidTurnCapacityCompactState(input);
    const queue = new AsyncEventQueue<SessionEvent>();
    this.currentQueue = queue;
    this.injectedSteeringMessages = [];

    // One AssistantMessage is flushed per AI SDK step (not per turn), so the
    // ledger records the text↔tool timeline at step granularity and each step's
    // Anthropic thinking signature stays paired with its own thinking text. The
    // turn's first step reuses this id; every later step rotates to a fresh one
    // at its step boundary (see the stream loop below).
    this.currentStepMessageId = this.newId();
    let stepText = '';
    let stepThinking = '';
    let stepSignature: string | undefined;
    const startedAt = this.now();

    // Flush the current step's AssistantMessage (text + thinking) and the paired
    // terminal thinking/text events, then clear the per-step accumulators.
    // Persist when the step produced text OR reasoning — a thinking-only step
    // (Anthropic's signed/omitted reasoning has empty text) still round-trips its
    // signed block; a pure-tool step (no text, no thinking) writes nothing, so
    // tool-only steps leave no placeholder assistant row. thinking_complete
    // precedes text_complete so the read-model attaches this step's reasoning to
    // this step's assistant row. Hoisted to send() scope so both the streaming
    // path and the abort/error handler can flush a partial step.
    const flushStep = async (): Promise<void> => {
      const hasThinking = stepThinking.length > 0 || stepSignature !== undefined;
      if (stepText.length === 0 && !hasThinking) return;
      const stepId = this.currentStepMessageId ?? this.newId();
      const msg: AssistantMessage = {
        type: 'assistant',
        id: stepId,
        turnId,
        ts: this.now(),
        text: stepText,
        modelId: this.input.modelId,
        ...(hasThinking
          ? {
              thinking: {
                text: stepThinking,
                ...(stepSignature !== undefined ? { signature: stepSignature } : {}),
              },
            }
          : {}),
      };
      await this.input.appendMessage(msg);
      if (hasThinking) {
        queue.push({
          type: 'thinking_complete',
          id: this.newId(),
          turnId,
          ts: this.now(),
          messageId: stepId,
          text: stepThinking,
          ...(stepSignature !== undefined ? { signature: stepSignature } : {}),
        } satisfies ThinkingCompleteEvent);
      }
      queue.push({
        type: 'text_complete',
        id: this.newId(),
        turnId,
        ts: this.now(),
        messageId: stepId,
        text: stepText,
      } satisfies TextCompleteEvent);
      stepText = '';
      stepThinking = '';
      stepSignature = undefined;
    };
    let tokenUsage: NormalizedAiSdkUsage | undefined;
    let tokenUsageCostUsd: number | undefined;
    // Per-send sum of every COMPLETED step's usage, merged at each finish-step
    // boundary. When the send aborts (mid-turn exhaust, user stop, stream
    // error) the SDK's cumulative `usage` promise may not resolve, but this sum is
    // real provider-reported evidence for the steps that did finish — IF every
    // completed step produced a usable sample. One unusable sample makes the
    // sum a partial cost, and LlmCallRecord has no partial marker, so the flag
    // fails the whole fallback closed (#972: incomplete usage is no usage).
    let completedStepUsage: NormalizedAiSdkUsage | undefined;
    let sawUnusableStepUsage = false;
    // Input tokens from the last completed step — the actual prompt token count
    // of the final API request. Used to compute contextRemaining for the TUI
    // statusline ctx segment (#1067): contextRemaining = contextWindow - this.
    // result.usage.inputTokens is cumulative across steps and would produce
    // misleading >100% percentages, so the per-step value is captured here.
    let lastStepInputTokens: number | undefined;
    let streamStatus: LlmCallRecord['status'] = 'success';
    let streamErrorClass: string | undefined;
    let rawFinishReason: string | undefined;
    let runtimeSteps = 0;
    let requestShapeForTelemetry: RequestShapeDiagnostic | undefined;
    let promptSegmentsForTelemetry: PromptSegmentEstimate[] = [];
    let contextBudgetForTelemetry: ContextBudgetDiagnostic | undefined;
    let contextCompactedNoteWritten = false;
    let contextCompactionFailedOpenNoteWritten = false;
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
    let activeCompactDiagnosticPatch: Partial<ContextBudgetDiagnostic> | undefined;
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
    if (plan.gating) {
      this.toolRuntime.setGating(plan.gating);
    }

    const aiSdkTools: Record<string, unknown> = {};
    let currentStepToolExecutions = 0;
    for (const t of providerTools) {
      const execute = this.wrapToolExecute(t, turnId, queue);
      aiSdkTools[t.name] = {
        description: t.description,
        inputSchema: t.parameters,
        execute: async (
          args: unknown,
          context: { toolCallId: string; abortSignal: AbortSignal },
        ) => {
          // A transport retry may discard an unfinished provider step, but it
          // must never replay a step after a tool could already have changed
          // external state. finish-step resets this guard at the next durable
          // provider-request boundary.
          currentStepToolExecutions += 1;
          const output = await execute(args, context);
          const providerError = providerToolError(output);
          if (providerError) throw new Error(providerError);
          return output;
        },
        toModelOutput:
          t.toModelOutput ??
          (({ toolCallId, output }: { toolCallId: string; output: unknown }) =>
            this.materializeToolResultOutput(output, false, toolCallId)),
      };
    }

    // --- Build messages from RuntimeEvent history and its compatibility projection. ---
    const priorReplay = await this.buildPriorMessages(input);
    if (midTurnState) {
      // Roll-forward seed: the latest durable checkpoint (loaded or written at
      // turn start) so a mid-turn summary only re-reads the newly folded span.
      midTurnState.previousCheckpoint = priorReplay.latestHistoryCompactCheckpoint;
    }

    // --- Background pump: streamText → stream → normalize → queue ---
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
        const turnTailPrompt = joinPromptFragments([
          await this.resolveTurnTailPrompt(),
          await this.resolveShellRunContextSummary(),
        ]);
        const currentUserContent = await this.buildCurrentUserContent(
          input.text,
          input.attachments,
        );
        const messages = [
          ...priorReplay.messages,
          {
            role: 'user' as const,
            content: this.appendTurnTailPrompt(currentUserContent, turnTailPrompt),
          } as ModelMessage,
        ];
        const activeCompactionHeadAnchor = buildActiveCompactionHeadAnchor(
          messages,
          messages.length - 1,
          this.input.contextBudget?.charsPerToken,
        );
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
              currentUserContent: formatTextWithAttachmentRefs(input.text, input.attachments),
              turnTailPrompt,
            }),
            requestShape: computeRequestShapeDiagnostic(
              {
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
              },
              priorShapeBaseline,
            ),
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
            priorReplay.contextBudget.highWaterRequestShapeHashAfter =
              diag.requestShape.requestShapeHash;
          }
        };
        // Step-0 (turn-start) view: literally what the first request carries, so
        // the stream-start trace reports it as the prefix actually sent.
        if (priorReplay.contextBudget?.highWaterReason) {
          priorReplay.contextBudget.highWaterRequestShapeHashBefore =
            priorShapeBaseline?.requestShapeHash;
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

        const stepRequestShapeHash = (
          stepMessages: readonly ModelMessage[],
          activeToolsForStep: readonly string[] | undefined,
        ): string =>
          computeRequestShapeDiagnostic(
            {
              connection: this.input.connection,
              modelId: this.input.modelId,
              systemPrompt,
              providerOptions: this.input.providerOptions,
              providerTools,
              activeTools: activeToolsForStep ?? plan.activeTools,
              priorMessages: stepMessages,
            },
            priorShapeBaseline,
          ).requestShapeHash;
        const activeCompactHook = composeActiveCompactionPrepareStep(
          this.buildSemanticCompactPrepareStep(
            turnId,
            model,
            input.runtimeContext,
            activeCompactionHeadAnchor,
            (messagesForStep, activeToolsForStep) =>
              stepRequestShapeHash(messagesForStep, activeToolsForStep),
            (patch) => {
              activeCompactDiagnosticPatch = mergeContextBudgetDiagnosticPatches(
                activeCompactDiagnosticPatch,
                patch,
              );
            },
          ),
          this.buildActiveFullCompactPrepareStep(
            turnId,
            input.runtimeContext,
            activeCompactionHeadAnchor,
            (messagesForStep, activeToolsForStep) =>
              stepRequestShapeHash(messagesForStep, activeToolsForStep),
            (patch) => {
              activeCompactDiagnosticPatch = mergeContextBudgetDiagnosticPatches(
                activeCompactDiagnosticPatch,
                patch,
              );
            },
          ),
        );
        // Deterministic priority on a capacity-replaced step: the hard window
        // invariant owns the projection, so semantic/active-full compaction
        // yields for that step (recorded as a decision) instead of running a
        // second summarizer over the same request.
        const activeCompactAfterMidTurn =
          activeCompactHook && midTurnState
            ? (options: PrepareStepLike) => {
                if (midTurnState.replacedStepNumber === options.stepNumber) {
                  activeCompactDiagnosticPatch = mergeContextBudgetDiagnosticPatches(
                    activeCompactDiagnosticPatch,
                    compactionDecisionDiagnosticPatch({
                      stage: 'activeStep',
                      sourceKind: 'providerMessages',
                      decision: 'unchanged',
                      boundaryKind: 'historyCompact',
                      reason: 'mid_turn_capacity_precedence',
                      skippedReasonCounts: { mid_turn_capacity_precedence: 1 },
                    }),
                  );
                  return undefined;
                }
                return activeCompactHook(options);
              }
            : activeCompactHook;
        const onMidTurnDiagnosticPatch = (patch: Partial<ContextBudgetDiagnostic>): void => {
          activeCompactDiagnosticPatch = mergeContextBudgetDiagnosticPatches(
            activeCompactDiagnosticPatch,
            patch,
          );
        };
        const midTurnSystemPromptChars = systemPrompt?.length ?? 0;
        const midTurnCapacityHook = this.buildMidTurnCapacityCompactPrepareStep(
          turnId,
          midTurnState,
          queue,
          providerTools,
          () => currentRepairToolNames(),
          turnTailPrompt,
          midTurnSystemPromptChars,
          onMidTurnDiagnosticPatch,
        );
        // When mid-turn capacity compaction is active, the prune must also cover
        // the newest completed step; see collectPrunablePrepareStepToolCallIds.
        const activeToolResultPruneIncludesNewestStep = midTurnState !== undefined;
        const activeToolResultPruneHook = this.buildActiveToolResultPrunePrepareStep(
          turnId,
          activeToolResultPruneIncludesNewestStep,
          (patch) => {
            activeToolResultPruneDiagnosticPatch = mergeActiveToolResultPruneDiagnosticPatches(
              activeToolResultPruneDiagnosticPatch,
              patch,
            );
          },
        );
        const shapedPrepareStep = composePrepareStep(
          plan.prepareStep,
          midTurnCapacityHook,
          activeToolResultPruneHook,
          activeCompactAfterMidTurn,
        );
        // The verdict owner wraps the WHOLE shaping pipeline: hooks shape, one
        // owner measures the final payload and decides pass/terminate.
        const prepareStep =
          midTurnState && midTurnCapacityHook && shapedPrepareStep
            ? this.buildMidTurnFinalRequestVerdict({
                shaped: shapedPrepareStep,
                reentry: composePrepareStep(
                  undefined,
                  midTurnCapacityHook,
                  activeToolResultPruneHook,
                )!,
                state: midTurnState,
                providerTools,
                fallbackActiveTools: () => currentRepairToolNames(),
                charsPerToken: this.input.contextBudget?.charsPerToken ?? 4,
                systemPromptChars: midTurnSystemPromptChars,
                onDiagnosticPatch: onMidTurnDiagnosticPatch,
              })
            : shapedPrepareStep;

        // Reactive overflow recovery (issue #882 PR 2). A request-level
        // provider failure surfaces through the stream — either as an `error`
        // chunk or a thrown stream error — both when
        // the transport throws (finishReason then rejects with
        // NoOutputGeneratedError) and when it streams an error part — after
        // which this stream is dead. Capture it and, at most once, fold the
        // durable ledger and resend on a context-length overflow; otherwise
        // throw the real provider error so the terminal handler closes the turn
        // as an error. Never fall through to the success path, which
        // historically caught the rejected finishReason as `stop` and
        // fabricated an end_turn completion with success telemetry.
        //
        // Attempt→send translation (reviews P1-A and round-3 P1): the SDK
        // scopes BOTH `stepNumber` and `steps` to one streamText call, but
        // every per-step consumer downstream works in SEND units — the
        // capacity hook's durability wait (flushedSteps), replacedStepNumber,
        // lastShapeFailure, the semantic-compact yield, the availability
        // runtime's same-turn `load_tools` activations, and the active
        // tool-result prune's eligible tool-call IDs. This single translation
        // point (a) rebases each attempt's local step numbers onto the
        // send-global clock (completed steps when the attempt started), and
        // (b) presents the send-global steps view: completed steps archived
        // from every prior attempt, then the current attempt's own. Without
        // it a retry resets those clocks/views — an attempt-local wait bound
        // already satisfied by a previous attempt let a post-retry compaction
        // drop not-yet-durable step content, a fresh empty `steps` revoked
        // same-turn tool activations, and the prune's empty eligible set
        // resurrected archived raw tool results from the ledger-rebuilt
        // recovery projection. Consumers stay untouched; any future steps
        // consumer is send-correct by construction. Steps folded into a
        // checkpoint stay in the view: ID-based consumers only act on
        // messages actually present in the projection, so a folded step's
        // entry is inert.
        let attemptStepBase = 0;
        const completedAttemptSteps: PrepareStepLike['steps'][number][] = [];
        let attemptObservedSteps: PrepareStepLike['steps'] = [];
        let attemptRequestMessages: ModelMessage[] = messages;
        const sendScopedPrepareStep: PrepareStepFunctionLike = async (options) => {
          // prepareStep sees every completed step of its own attempt and the
          // exact messages for the next provider request. Keep that request
          // boundary even when no shaping hook is configured: a transient
          // transport retry can resend it without replaying completed tools.
          attemptObservedSteps = options.steps;
          // Step boundary: lease the caller's queued steering, echo each as a
          // user event, ack only after it is durably persisted AND in the
          // injection set (nack on any failure so the queue reclaims it).
          await this.drainSteeringInto(input, turnId, queue);
          // Steering joins the request BEFORE shaping so the capacity owner's
          // verdict measures the payload the provider will actually receive.
          // AI SDK 7 carries a prepareStep messages override into later steps,
          // so append only markers missing from the current SDK projection.
          // Dedupe is by structured identity — the ledger event id carried on
          // every injected and every ledger-derived steering message — never
          // by text, which a verbatim user message could forge or cancel.
          const missingInBase = steeringMessagesMissingFromBase(
            this.injectedSteeringMessages,
            options.messages,
          );
          const baseWithSteering =
            missingInBase.length === 0 ? options.messages : [...options.messages, ...missingInBase];
          const shaped = prepareStep
            ? await prepareStep({
                ...options,
                messages: baseWithSteering,
                stepNumber: attemptStepBase + options.stepNumber,
                steps: [...completedAttemptSteps, ...options.steps],
              })
            : undefined;
          // No re-append after shaping: every shaper preserves the injected
          // steering — ledger-derived replacements replay it with its marker,
          // and the mid-turn fold PINS the current turn's steering events out
          // of the covered span — so the verdict inside `prepareStep` always
          // measured the steering-inclusive payload that actually goes out.
          const finalMessages = shaped?.messages ?? baseWithSteering;
          // Steering-free request boundary (single authority rule): a transport
          // retry resends `attemptRequestMessages` as the next attempt's base,
          // and that attempt's own prepareStep re-appends the accumulator, so
          // storing the injected steering here would double-inject on retry.
          // ONLY the injected set is stripped — a historical ledger-replayed
          // steering message carries the same marker but belongs to the base.
          attemptRequestMessages = stripSteeringMessages(
            finalMessages,
            this.injectedSteeringMessages,
          );
          if (finalMessages === options.messages) return shaped;
          return shaped ? { ...shaped, messages: finalMessages } : { messages: finalMessages };
        };
        let attemptMessages: ModelMessage[] = messages;
        let overflowRetryUsed = false;
        let transportRetryUsed = false;
        let result!: StreamTextResult;
        for (;;) {
          // The step limit is a SEND-level cap: `runtimeSteps` (this send's
          // completed steps across attempts) is its single counter, so a retry
          // attempt gets only the remaining budget — never a fresh full one.
          // It is also the attempt's step base: the pump has consumed every
          // prior attempt's finish-step before the error chunk that ended it,
          // so at this point the counter equals the send's completed steps.
          attemptStepBase = runtimeSteps;
          const remainingStepBudget =
            this.maxSteps === undefined ? undefined : Math.max(0, this.maxSteps - runtimeSteps);
          result = await this.modelAdapter.startStream({
            model,
            messages: attemptMessages,
            tools: aiSdkTools,
            activeTools,
            repairToolCall: async ({
              toolCall,
              error,
            }: {
              toolCall: RepairableAiSdkToolCall;
              error: unknown;
            }) => {
              return repairMakaToolCall({
                toolCall,
                availableToolNames: currentRepairToolNames(),
                error,
              });
            },
            system: systemPrompt,
            abortSignal: this.abortController!.signal,
            stopAfterStep: () => this.stopAfterStepRequested,
            prepareStep: sendScopedPrepareStep,
            ...(remainingStepBudget !== undefined ? { maxSteps: remainingStepBudget } : {}),
          });

          let streamErrorChunk: unknown;
          let sawStreamError = false;
          try {
            for await (const chunk of result.stream) {
              if (this.aborted) break;
              watchdog.markActivity();
              // A request-level error ends this stream; capture it and stop
              // consuming (the synthesized trailer carries no real step) so the
              // recovery decision runs on the outcome, not the trailer.
              if (chunk.type === 'error') {
                streamErrorChunk = chunk.error;
                sawStreamError = true;
                break;
              }
              // Step boundary: AI SDK 7 delimits steps with `start-step` /
              // `finish-step`; `step-finish` remains accepted for replaying an
              // older adapter fixture during the migration window.
              // Missing the boundary would silently degrade back to one message per
              // turn, so match both names. A duplicate boundary is harmless: the
              // second flush no-ops (accumulators already cleared) and one extra id
              // rotation just discards an unused id.
              const isStepFinishChunk =
                chunk.type === 'finish-step' || chunk.type === 'step-finish';
              if (isStepFinishChunk) {
                runtimeSteps += 1;
                const stepUsage = normalizeAiSdkUsage(chunk.usage, {
                  rawFinishReason: chunk.finishReason,
                });
                if (!stepUsage) sawUnusableStepUsage = true;
                // Fail closed: reset on every step boundary so a missing final
                // step's usage does not leave a stale value from an earlier step.
                lastStepInputTokens = stepUsage?.inputTokens;
                if (stepUsage) {
                  completedStepUsage = mergeNormalizedUsage(completedStepUsage, stepUsage);
                  this.cumulativeUsageCheckpoint = mergeNormalizedUsage(
                    this.cumulativeUsageCheckpoint,
                    stepUsage,
                  );
                  await this.input.recordUsageCheckpoint?.({
                    ...this.cumulativeUsageCheckpoint,
                    costUsd: this.computeTokenUsageCostUsd(this.cumulativeUsageCheckpoint),
                  });
                }
              }
              if (chunk.type === 'finish' || isStepFinishChunk) {
                rawFinishReason = rawFinishReasonString(chunk.finishReason) ?? rawFinishReason;
              }
              this.modelAdapter.handleStreamChunk(
                chunk,
                turnId,
                this.currentStepMessageId!,
                queue,
                {
                  onText: (t) => {
                    stepText += t;
                  },
                  onTextComplete: (t) => {
                    stepText = t;
                  },
                  onThinking: (t) => {
                    stepThinking += t;
                  },
                  onThinkingSignature: (sig) => {
                    stepSignature = sig;
                  },
                },
              );
              // The step's text/thinking deltas are all in (the stream is
              // drained in order), so flush this step's AssistantMessage and rotate
              // to a fresh id for the next step. The step's tool calls (appended
              // mid-step via execute()) already carry the pre-rotation id via
              // `getCurrentStepId`, so replay can regroup them with this step's
              // reasoning even though they land before this row in the ledger.
              if (isStepFinishChunk) {
                await flushStep();
                currentStepToolExecutions = 0;
                this.currentStepMessageId = this.newId();
                if (midTurnState) {
                  // Durability clock: step N's thinking/text completion events are
                  // enqueued by flushStep just above, so only after this boundary
                  // can a seq-ack wait for step N mean anything. Wake waiters AFTER
                  // the increment or they would re-check a stale count and sleep.
                  midTurnState.flushedSteps += 1;
                  queue.wake();
                }
              }
            }
          } catch (error) {
            streamErrorChunk = error;
            sawStreamError = true;
          }

          if (sawStreamError && !this.aborted) {
            if (this.stopAfterStepRequested) throw streamErrorChunk;
            // A retry is a fresh provider request that would run at least one
            // more step; with the send-level budget already spent there is
            // nothing left to grant it, so the error is terminal.
            const stepBudgetRemains = this.maxSteps === undefined || runtimeSteps < this.maxSteps;
            const recovered = stepBudgetRemains
              ? await this.recoverFromOverflowError({
                  error: streamErrorChunk,
                  retryAlreadyUsed: overflowRetryUsed,
                  midTurnState,
                  turnId,
                  currentMessages: attemptMessages,
                  providerTools,
                  activeTools: currentRepairToolNames(),
                  systemPromptChars: midTurnSystemPromptChars,
                  turnTailPrompt,
                  queue,
                  onDiagnosticPatch: onMidTurnDiagnosticPatch,
                })
              : undefined;
            if (recovered) {
              overflowRetryUsed = true;
              attemptMessages = recovered.messages;
              // Archive the dead attempt's completed steps into the send view
              // before the next attempt resets the SDK's local `steps`.
              completedAttemptSteps.push(...attemptObservedSteps);
              attemptObservedSteps = [];
              continue;
            }
            const errorClass = this.modelAdapter.classifyError(streamErrorChunk);
            if (
              errorClass === 'Network' &&
              !transportRetryUsed &&
              stepBudgetRemains &&
              currentStepToolExecutions === 0 &&
              stepText.length === 0 &&
              stepThinking.length === 0 &&
              stepSignature === undefined
            ) {
              transportRetryUsed = true;
              // The failed request did not return authoritative usage. Keep
              // effectiveness recoverable, but fail final metering closed.
              sawUnusableStepUsage = true;
              attemptMessages = attemptRequestMessages;
              completedAttemptSteps.push(...attemptObservedSteps);
              attemptObservedSteps = [];
              stepText = '';
              stepThinking = '';
              stepSignature = undefined;
              this.currentStepMessageId = this.newId();
              continue;
            }
            // Unrecoverable (not context-length, latch spent, no seam, or no
            // safe fold): surface the real provider error via the terminal
            // handler — never a fabricated success.
            throw streamErrorChunk;
          }
          break;
        }

        // If the stream loop exited because stop() flipped this.aborted while a
        // provider kept yielding after abort instead of throwing, route to the
        // abort handling below. Without this, the post-stream success path would
        // persist a partial assistant turn and emit a false end_turn completion.
        if (this.aborted) {
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }

        // Mid-turn exhaustion aborts the SDK stream, but streamText ends
        // gracefully on abort instead of throwing; route to the explicit
        // outcome regardless of how the stream wound down.
        if (midTurnState?.exhaustedDetail) {
          throw Object.assign(
            new Error(`mid-turn context budget exhausted: ${midTurnState.exhaustedDetail}`),
            { name: 'MidTurnContextBudgetExhaustedError' },
          );
        }

        // Catch-all: flush any residual step content if the provider closed the
        // stream without a trailing `finish-step` for the last step.
        await flushStep();

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

        // With an explicit maxSteps, `finishReason === 'tool-calls'` means the
        // model wanted another tool step but the configured budget stopped it.
        const finishReason = await result.finishReason.catch(() => 'stop');
        const stepLimit = this.maxSteps;
        const stepLimitReached = stepLimit !== undefined && finishReason === 'tool-calls';
        rawFinishReason = rawFinishReason ?? rawFinishReasonString(finishReason);
        if (stepLimitReached && runtimeSteps < stepLimit) {
          runtimeSteps = stepLimit;
        }

        // Final usage event. AI SDK 7 `usage` is the billing-relevant sum
        // across all internal tool-loop steps; finalStep.usage is last-step only.
        // The send-level usage owner is `completedStepUsage`, the per-step
        // accumulator that spans every attempt: after a reactive overflow
        // retry, the last attempt's usage covers only that attempt, so
        // recording it would silently drop the first attempt's completed
        // steps. result.usage remains the authoritative shorthand only for the
        // single-attempt send, and an unusable step sample in ANY attempt
        // fails the whole record closed (#972) — a later attempt's valid
        // cumulative usage must not wash it back to "complete".
        try {
          const attemptTotalUsage = normalizeAiSdkUsage(await result.usage, { rawFinishReason });
          tokenUsage =
            overflowRetryUsed || transportRetryUsed
              ? sawUnusableStepUsage
                ? undefined
                : completedStepUsage
              : attemptTotalUsage;
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
            const contextBudgetForUsage = contextBudgetWithActivePrepareStepDiagnostics(
              contextBudgetForTelemetry,
              activeToolResultPruneDiagnosticPatch,
              activeCompactDiagnosticPatch,
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
              ...(tokenUsage.rawFinishReason !== undefined
                ? { rawFinishReason: tokenUsage.rawFinishReason }
                : {}),
              ...(runtimeSteps > 0 ? { runtimeSteps } : {}),
              ...(tokenUsage.cachedInputTokens > 0
                ? { cacheRead: tokenUsage.cachedInputTokens }
                : {}),
              ...(tokenUsage.cacheWriteInputTokens > 0
                ? { cacheCreation: tokenUsage.cacheWriteInputTokens }
                : {}),
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
            if (
              !contextCompactionFailedOpenNoteWritten &&
              shouldAppendContextCompactionFailedOpenNote(contextBudgetForUsage)
            ) {
              contextCompactionFailedOpenNoteWritten = true;
              const note: SystemNoteMessage = {
                type: 'system_note',
                id: this.newId(),
                turnId,
                ts: this.now(),
                kind: 'context_compaction_failed_open',
              };
              await this.input.appendMessage(note).catch(() => {});
            }
            if (
              !contextCompactedNoteWritten &&
              shouldAppendContextCompactedNote(contextBudgetForUsage)
            ) {
              contextCompactedNoteWritten = true;
              const note: SystemNoteMessage = {
                type: 'system_note',
                id: this.newId(),
                turnId,
                ts: this.now(),
                kind: 'context_compacted',
              };
              await this.input.appendMessage(note).catch(() => {});
            }
            const contextRemainingForUsage = (() => {
              const contextWindow = resolveSelectedModelContextWindow(
                this.input.connection,
                this.input.modelId,
              );
              if (lastStepInputTokens !== undefined && contextWindow !== undefined) {
                return Math.max(0, contextWindow - lastStepInputTokens);
              }
              return undefined;
            })();
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
              ...(tokenUsage.rawFinishReason !== undefined
                ? { rawFinishReason: tokenUsage.rawFinishReason }
                : {}),
              ...(runtimeSteps > 0 ? { runtimeSteps } : {}),
              ...(tokenUsage.cachedInputTokens > 0
                ? { cacheRead: tokenUsage.cachedInputTokens }
                : {}),
              ...(tokenUsage.cacheWriteInputTokens > 0
                ? { cacheCreation: tokenUsage.cacheWriteInputTokens }
                : {}),
              ...(tokenUsageCostUsd !== undefined ? { costUsd: tokenUsageCostUsd } : {}),
              systemPromptHash,
              prefixHash: turnDiagnostics.requestShape.prefixHash,
              prefixChangeReason: turnDiagnostics.requestShape.prefixChangeReason,
              requestShapeHash: turnDiagnostics.requestShape.requestShapeHash,
              requestShapeChangeReason: turnDiagnostics.requestShape.requestShapeChangeReason,
              promptSegments: turnDiagnostics.promptSegments,
              ...(contextBudgetForUsage ? { contextBudget: contextBudgetForUsage } : {}),
              ...(contextRemainingForUsage !== undefined
                ? { contextRemaining: contextRemainingForUsage }
                : {}),
            } satisfies TokenUsageEvent);
          }
        } catch {
          // best-effort; ai-sdk usage promise may reject on abort
        }

        // Nothing may await between this check and terminal emission: Stop must
        // win even when it arrives during post-stream usage persistence.
        if (this.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        const stopReason =
          this.maxSteps !== undefined && finishReason === 'tool-calls'
            ? 'step_limit'
            : this.mapFinishReason(finishReason);
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
        // Flush the in-flight step's partial text/thinking before the terminal
        // abort/error events. Earlier steps already flushed at their
        // `finish-step`; this keeps their and this step's streamed-out output on
        // BOTH exits — user stop and provider error / watchdog timeout — so
        // partialOutputRetained reflects what the user actually saw.
        await flushStep().catch(() => {});
        if (!this.aborted && midTurnState?.exhaustedDetail) {
          // Mid-turn compaction could not produce a provider-safe request: end
          // the turn with the explicit first-class outcome, not a raw error.
          streamErrorClass = 'ContextBudgetExhausted';
          trace.modelStreamCompleted('context_budget_exhausted');
          queue.push({
            type: 'complete',
            id: this.newId(),
            turnId,
            ts: this.now(),
            stopReason: 'context_budget_exhausted',
            contextBudgetExhaustedDetail: midTurnState.exhaustedDetail,
          } satisfies CompleteEvent);
        } else if (this.aborted) {
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
        contextBudgetForTelemetry = contextBudgetWithActivePrepareStepDiagnostics(
          contextBudgetForTelemetry,
          activeToolResultPruneDiagnosticPatch,
          activeCompactDiagnosticPatch,
        );
        // The terminal record is fail-closed on usage evidence: no evidence,
        // no record. An aborted send may have no final `usage`, but when EVERY
        // completed step produced a usable sample their accumulated usage IS
        // the complete evidence — record it, carrying the real cost of the
        // steps that ran plus the diagnostics riding this record. Otherwise
        // (no finish-step at all, or any unusable sample) the record is
        // skipped: a partial sum posed as the whole call would violate the
        // #972 no-fabrication invariant. The terminal outcome itself does not
        // depend on this record — stopReason and the exhausted detail are
        // durable on the CompleteEvent either way.
        if (!tokenUsage && completedStepUsage && !sawUnusableStepUsage) {
          tokenUsage = completedStepUsage;
          tokenUsageCostUsd = this.computeTokenUsageCostUsd(tokenUsage);
        }
        if (tokenUsage)
          this.input.recordLlmCall?.({
            sessionId: this.sessionId,
            turnId,
            connectionSlug: this.input.connection.slug,
            providerId: this.input.connection.providerType,
            modelId: this.input.modelId,
            inputTokens: tokenUsage.inputTokens,
            outputTokens: tokenUsage.outputTokens,
            cacheHitInputTokens: tokenUsage.cacheHitInputTokens,
            cacheMissInputTokens: tokenUsage.cacheMissInputTokens,
            ...(tokenUsage.cacheMissInputSource !== undefined
              ? { cacheMissInputSource: tokenUsage.cacheMissInputSource }
              : {}),
            cachedInputTokens: tokenUsage.cachedInputTokens,
            cacheWriteInputTokens: tokenUsage.cacheWriteInputTokens,
            reasoningTokens: tokenUsage.reasoningTokens,
            totalTokens: tokenUsage.totalTokens,
            ...(tokenUsage.rawFinishReason !== undefined
              ? { rawFinishReason: tokenUsage.rawFinishReason }
              : {}),
            ...(tokenUsage.raw !== undefined ? { rawUsage: tokenUsage.raw } : {}),
            latencyMs: Math.max(0, this.now() - startedAt),
            status: streamStatus,
            ...(streamErrorClass ? { errorClass: streamErrorClass } : {}),
            startedAt,
            ...(requestShapeForTelemetry !== undefined
              ? {
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
                }
              : {}),
            ...(tokenUsageCostUsd !== undefined ? { costUsd: tokenUsageCostUsd } : {}),
            ...(promptSegmentsForTelemetry.length > 0
              ? { promptSegments: promptSegmentsForTelemetry }
              : {}),
            ...(contextBudgetForTelemetry !== undefined
              ? { contextBudget: contextBudgetForTelemetry }
              : {}),
          });
        queue.close();
      }
    })();

    try {
      // drain() carries the seq-ack semantics (consumer pull = processed ack);
      // every consumer-facing path must go through it.
      yield* this.drain(queue);
    } finally {
      await pumpDone.catch(() => {});
      this.cleanupAfterTurn(turnId);
    }
  }

  // --------------------------------------------------------------------------
  // wrapToolExecute — the permission-gating seam
  // --------------------------------------------------------------------------

  private wrapToolExecute(tool: MakaTool, turnId: string, queue: AsyncEventQueue<SessionEvent>) {
    return this.toolRuntime.wrapToolExecute(tool, turnId, queue);
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  async stop(
    _reason: 'user_stop' | 'redirect',
    mode: 'immediate' | 'after_step' = 'immediate',
  ): Promise<void> {
    if (mode === 'after_step') {
      this.stopAfterStepRequested = true;
      this.currentRunTrace?.abortRequested(_reason);
      return;
    }
    this.aborted = true;
    this.abortController?.abort();
    this.historyCompactAbortController?.abort();
    if (this.currentTurnId !== null) {
      this.input.permissionEngine.endTurn(this.currentTurnId, 'aborted');
      this.toolRuntime.endTurn(this.currentTurnId, 'aborted');
    }
    this.currentRunTrace?.abortRequested(_reason);
  }

  async respondToPermission(decision: PermissionDecision): Promise<void> {
    if (this.currentTurnId === null) return;
    this.input.permissionEngine.recordResponse(this.currentTurnId, decision);
    // PermissionDecisionMessage + ack event are written inside wrapToolExecute
    // after parked.resolve() returns, so no further work here.
  }

  async respondToUserQuestion(response: UserQuestionResponse): Promise<void> {
    if (this.currentTurnId === null) return;
    this.toolRuntime.respondToUserQuestion(this.currentTurnId, response);
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
      const pricing = (this.input.lookupPricing ?? getBuiltinPricing)(
        `${this.input.connection.providerType}:${this.input.modelId}`,
      );
      if (pricing === null) return undefined;
      return computeCost(
        {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheHitInputTokens: usage.cacheHitInputTokens,
          cacheMissInputTokens: usage.cacheMissInputTokens,
          cacheWriteInputTokens: usage.cacheWriteInputTokens,
        },
        pricing,
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
    /** Latest durable checkpoint (loaded or written this turn) for mid-turn roll-forward. */
    latestHistoryCompactCheckpoint?: HistoryCompactCheckpoint;
  }> {
    const priorStored = input.context.filter((message) => message.turnId !== input.turnId);
    if (!input.runtimeContext) {
      return {
        messages: await this.materializePriorMessages(priorStored),
        gate: 'stored_message_projection',
        diagnostics: [],
      };
    }
    const priorRuntimeContext = input.runtimeContext.filter(
      (event) => event.turnId !== input.turnId,
    );
    const projectedMessages = await this.materializePriorMessages(
      priorStored,
      buildSteeringSidecar(priorRuntimeContext),
    );
    const preparedContextBudget = await this.prepareContextBudgetPolicy(priorRuntimeContext);
    const contextBudget = preparedContextBudget.policy;
    const budgeted = applyRuntimeEventContextBudget(priorRuntimeContext, contextBudget, {
      historyCompactProtocol:
        contextBudget?.historyCompact?.checkpoint || this.hasHistoryCompactCheckpointWriter()
          ? 'checkpoint_v2'
          : 'legacy_v1',
    });
    let runtimeContext = budgeted?.events ?? priorRuntimeContext;
    let contextBudgetDiagnostic = budgeted?.diagnostic;
    let latestHistoryCompactCheckpoint = contextBudget?.historyCompact?.checkpoint;
    if (preparedContextBudget.diagnosticPatch) {
      contextBudgetDiagnostic = mergeContextBudgetDiagnostic(
        contextBudgetDiagnostic ??
          buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
        preparedContextBudget.diagnosticPatch,
      );
    }
    if (
      budgeted?.historyCompactBlocks?.length &&
      contextBudget?.historyCompact?.mode === 'read_write' &&
      this.hasHistoryCompactWriter()
    ) {
      const loadedBlockIds = new Set(
        (contextBudget.historyCompact.blocks ?? []).map((block) => block.blockId),
      );
      const draftBlocks = budgeted.historyCompactBlocks.filter(
        (block) => !loadedBlockIds.has(block.blockId),
      );
      if (draftBlocks.length > 0) {
        if (this.input.summarizeHistoryCompact && this.input.recordHistoryCompactCheckpoint) {
          const writePatch = await this.writeHistoryCompactCheckpoint({
            turnId: input.turnId,
            contextBudget,
            priorRuntimeContext,
            draftBlock: draftBlocks[0]!,
            abortSignal: this.abortController?.signal,
          });
          if (writePatch.replacementCheckpoint) {
            latestHistoryCompactCheckpoint = writePatch.replacementCheckpoint;
            runtimeContext = [
              historyCompactCheckpointToRuntimeEvent(writePatch.replacementCheckpoint),
              ...runtimeContext.filter((event) => !event.id.startsWith('history-compact:')),
            ];
          } else {
            runtimeContext = writePatch.fallbackCheckpoint
              ? buildHistoryCompactCheckpointFailOpenContext(
                  writePatch.fallbackCheckpoint,
                  priorRuntimeContext,
                  contextBudget,
                  runtimeContext.filter((event) => !event.id.startsWith('history-compact:')),
                )
              : runtimeContext.filter((event) => !event.id.startsWith('history-compact:'));
          }
          contextBudgetDiagnostic = mergeContextBudgetDiagnostic(
            contextBudgetDiagnostic ??
              buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
            writePatch.diagnosticPatch,
          );
        } else {
          const writePatch = await this.writeHistoryCompactBlocks({
            turnId: input.turnId,
            contextBudget,
            priorRuntimeContext,
            draftBlocks,
            abortSignal: this.abortController?.signal,
          });
          if (writePatch.replacementBlocks.length > 0) {
            runtimeContext = replaceHistoryCompactReplayBlocks(
              runtimeContext,
              writePatch.replacementBlocks,
            );
          } else {
            runtimeContext = priorRuntimeContext;
            contextBudgetDiagnostic = buildContextBudgetDiagnosticShell(
              priorRuntimeContext,
              runtimeContext,
              contextBudget,
            );
          }
          contextBudgetDiagnostic = mergeContextBudgetDiagnostic(
            contextBudgetDiagnostic ??
              buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
            writePatch.diagnosticPatch,
          );
        }
      }
    }

    const historySearchSource = buildHistorySearchSource(priorRuntimeContext, contextBudget);
    const historyAround =
      contextBudget?.archiveRetrieval?.mode === 'history_search_gated'
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
    const archiveRetrievalAllowedTurnIds =
      contextBudget?.archiveRetrieval?.mode === 'history_search_gated'
        ? new Set(historyAround.events.map((event) => runtimeEventTurnKey(event)))
        : undefined;
    if (historyAround.events.length > 0) {
      runtimeContext = mergeRuntimeEventsInOriginalOrder(
        priorRuntimeContext,
        runtimeContext,
        historyAround.events,
      );
      contextBudgetDiagnostic = mergeContextBudgetDiagnostic(
        contextBudgetDiagnostic ??
          buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
        historyAround.diagnosticPatch,
      );
    } else if (contextBudget?.historySearch?.enabled === true) {
      contextBudgetDiagnostic = mergeContextBudgetDiagnostic(
        contextBudgetDiagnostic ??
          buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
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
        contextBudgetDiagnostic ??
          buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
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
          contextBudgetDiagnostic ??
            buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
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
            contextBudgetDiagnostic ??
              buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
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
            contextBudgetDiagnostic ??
              buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
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
          contextBudgetDiagnostic ??
            buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
          {
            synthesisCacheWriteSkipped: 1,
            synthesisCacheWriteSkippedReasonCounts: { source_missing: 1 },
          },
        );
      }
    }

    const plan = buildRuntimeEventModelReplayPlan(
      runtimeContext,
      // `runtimeContext` may be a budget/history-search slice; the tool-turn
      // thinking skip is a whole-history invariant, so seed it from the full
      // prior ledger so a sliced-in tool-turn thinking still gets skipped.
      { toolActivityTurnIds: collectToolActivityTurnIds(priorRuntimeContext) },
    );
    if (plan.items.length === 0) {
      return {
        messages: projectedMessages,
        gate: 'stored_message_projection',
        diagnostics: plan.diagnostics,
        runtimeEventCount: runtimeContext.length,
        ...(contextBudgetDiagnostic ? { contextBudget: contextBudgetDiagnostic } : {}),
        ...(latestHistoryCompactCheckpoint ? { latestHistoryCompactCheckpoint } : {}),
      };
    }

    if (hasBlockingReplayDiagnostics(plan)) {
      return {
        messages: projectedMessages,
        gate: 'runtime_replay_unsupported_semantics',
        diagnostics: plan.diagnostics,
        runtimeEventCount: runtimeContext.length,
        ...(contextBudgetDiagnostic ? { contextBudget: contextBudgetDiagnostic } : {}),
        ...(latestHistoryCompactCheckpoint ? { latestHistoryCompactCheckpoint } : {}),
      };
    }

    if (!plan.hasProviderNativeSemantics) {
      return {
        messages: await this.materializeRuntimeReplayPlan(plan),
        gate: 'runtime_replay_text_only',
        diagnostics: plan.diagnostics,
        runtimeEventCount: runtimeContext.length,
        ...(contextBudgetDiagnostic ? { contextBudget: contextBudgetDiagnostic } : {}),
        ...(latestHistoryCompactCheckpoint ? { latestHistoryCompactCheckpoint } : {}),
      };
    }

    if (!this.canReplayProviderNative(plan)) {
      return {
        messages: projectedMessages,
        gate: 'runtime_replay_unsupported_semantics',
        diagnostics: plan.diagnostics,
        runtimeEventCount: runtimeContext.length,
        ...(contextBudgetDiagnostic ? { contextBudget: contextBudgetDiagnostic } : {}),
        ...(latestHistoryCompactCheckpoint ? { latestHistoryCompactCheckpoint } : {}),
      };
    }

    return {
      messages: await this.materializeRuntimeReplayPlan(plan),
      gate: 'runtime_replay_provider_native',
      diagnostics: plan.diagnostics,
      runtimeEventCount: runtimeContext.length,
      ...(contextBudgetDiagnostic ? { contextBudget: contextBudgetDiagnostic } : {}),
      ...(latestHistoryCompactCheckpoint ? { latestHistoryCompactCheckpoint } : {}),
    };
  }

  private async prepareContextBudgetPolicy(runtimeContext: readonly RuntimeEvent[]): Promise<{
    policy: ContextBudgetPolicy | undefined;
    diagnosticPatch?: Partial<ContextBudgetDiagnostic>;
  }> {
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
          for (const ref of Object.values(existingArchiveRefs))
            archiveRefs.set(ref.runtimeEventId, ref);
        }
        for (const candidate of candidates) {
          const bodySha256 = sha256(candidate.serializedResult);
          const archived = await Promise.resolve(
            this.input.archiveToolResult?.({
              ...candidate,
              sessionId: this.sessionId,
              bodySha256,
            }),
          ).catch(() => undefined);
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
    includeNewestStep: boolean,
    onDiagnosticPatch?: (patch: ActiveToolResultPruneDiagnosticPatch) => void,
  ): PrepareStepFunctionLike | undefined {
    const policy = this.input.contextBudget?.activeToolResultPrune;
    if (policy?.enabled !== true) return undefined;

    const archivedPlaceholders = new Map<string, ActiveArchivedToolResultPlaceholder>();
    return async (options) => {
      const eligibleToolCallIds = collectPrunablePrepareStepToolCallIds(
        options.steps,
        includeNewestStep,
      );
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
          return await Promise.resolve(
            this.input.archiveToolResult?.({
              ...candidate,
              sessionId: this.sessionId,
              runtimeEventId: candidate.runtimeEventId ?? activeToolResultArchiveKey(candidate),
            }),
          );
        },
      });
      if (hasActiveToolResultPruneDiagnosticPatch(rewritten.diagnosticPatch)) {
        onDiagnosticPatch?.(rewritten.diagnosticPatch);
      }
      return rewritten.rewritten > 0 ? { messages: rewritten.messages } : undefined;
    };
  }

  private buildSemanticCompactPrepareStep(
    turnId: string,
    model: unknown,
    runtimeEvents: readonly RuntimeEvent[] | undefined,
    headAnchor: ActiveCompactionHeadAnchor,
    requestShapeHashForMessages: (
      messages: readonly ModelMessage[],
      activeToolsForStep: readonly string[] | undefined,
    ) => string,
    onDiagnosticPatch?: (patch: Partial<ContextBudgetDiagnostic>) => void,
  ): PrepareStepFunctionLike | undefined {
    const policy = this.input.contextBudget?.semanticCompact;
    if (policy?.enabled !== true || policy.mode === 'off') return undefined;

    let acceptedProjection: ActiveFullCompactPrepareStepProjection | undefined;
    const controllerState: SemanticCompactControllerState = {
      consecutiveInvalidSummaries: 0,
      totalInvalidSummaries: 0,
      compactCallCount: 0,
      compactCallTotalTokens: 0,
      acceptedEstimatedTokensSaved: 0,
    };
    return async (options) => {
      const activeToolsForStep = (options as PrepareStepLike & { activeTools?: readonly string[] })
        .activeTools;
      const dryRun = policy.mode === 'validate_only' || policy.mode === 'prepare_step_dry_run';
      const incomingMessages = options.messages;
      const projectedMessages = dryRun
        ? undefined
        : projectAcceptedActiveFullCompactMessages(incomingMessages, acceptedProjection);
      const messagesForRewrite = projectedMessages ?? incomingMessages;
      const summarizerModel = policy.summarizerModel
        ? this.input.modelFactory({
            connection: this.input.connection,
            apiKey: this.input.apiKey,
            modelId: policy.summarizerModel,
          })
        : model;
      const summarizerModelId = policy.summarizerModel ?? this.input.modelId;
      const rewritten = await rewriteSemanticCompactInMessages({
        sessionId: this.sessionId,
        turnId,
        messages: messagesForRewrite,
        policy,
        controllerState,
        runtimeEvents: runtimeEvents?.filter((event) => event.turnId === turnId),
        stepNumber: options.stepNumber,
        now: this.now(),
        charsPerToken: this.input.contextBudget?.charsPerToken,
        requestShapeHashForMessages: (messages) =>
          requestShapeHashForMessages(messages, activeToolsForStep),
        headAnchor,
        ...(acceptedProjection?.semanticBlock
          ? { predecessorBlock: acceptedProjection.semanticBlock }
          : {}),
        abortSignal: this.abortController?.signal,
        summarizer: async (request) => {
          const startedAt = this.now();
          const callId = `semantic_compact_${turnId}_${options.stepNumber}_${startedAt}`;
          try {
            const result = await this.modelAdapter.generateCompactSummary({
              model: summarizerModel,
              system: request.system,
              messages: request.messages,
              maxOutputTokens: request.maxOutputTokens,
              abortSignal: request.abortSignal,
            });
            this.recordSemanticCompactSummaryCall({
              callId,
              turnId,
              modelId: summarizerModelId,
              startedAt,
              latencyMs: Math.max(0, this.now() - startedAt),
              usage: result.usage,
              finishReason: result.finishReason,
              status: 'success',
            });
            return result;
          } catch (error) {
            this.recordSemanticCompactSummaryCall({
              callId,
              turnId,
              modelId: summarizerModelId,
              startedAt,
              latencyMs: Math.max(0, this.now() - startedAt),
              status: request.abortSignal?.aborted ? 'aborted' : 'error',
              errorClass: this.modelAdapter.classifyError(error),
            });
            throw error;
          }
        },
      });
      onDiagnosticPatch?.({
        semanticCompactEnabled: true,
        semanticCompactMode: policy.mode ?? 'replace',
        ...rewritten.diagnosticPatch,
      });
      if (!dryRun && rewritten.decision === 'replaced') {
        if (rewritten.block) this.recordSemanticCompactBlock(rewritten.block);
        acceptedProjection = {
          sourceSignatures: incomingMessages.map(projectionSourceMessageSignature),
          sourceSignatureMode: 'active_prune_lineage',
          projectedMessages: rewritten.messages,
          ...(rewritten.block ? { semanticBlock: rewritten.block } : {}),
        };
        return {
          messages: rewritten.messages,
          makaSemanticCompactStatus: 'replaced',
        } as ActiveCompactionPrepareStepResult;
      }
      return !dryRun && projectedMessages
        ? ({
            messages: projectedMessages,
            makaSemanticCompactStatus: 'projected',
          } as ActiveCompactionPrepareStepResult)
        : undefined;
    };
  }

  private buildActiveFullCompactPrepareStep(
    turnId: string,
    runtimeEvents: readonly RuntimeEvent[] | undefined,
    headAnchor: ActiveCompactionHeadAnchor,
    requestShapeHashForMessages: (
      messages: readonly ModelMessage[],
      activeToolsForStep: readonly string[] | undefined,
    ) => string,
    onDiagnosticPatch?: (patch: Partial<ContextBudgetDiagnostic>) => void,
  ): PrepareStepFunctionLike | undefined {
    const policy = this.input.contextBudget?.activeFullCompact;
    if (policy?.enabled !== true || policy.mode === 'index_only' || policy.mode === 'off')
      return undefined;

    let acceptedProjection: ActiveFullCompactPrepareStepProjection | undefined;
    return (options) => {
      const activeToolsForStep = (options as PrepareStepLike & { activeTools?: readonly string[] })
        .activeTools;
      const dryRun = policy.mode === 'validate_only' || policy.mode === 'prepare_step_dry_run';
      const incomingMessages = options.messages;
      const projectedMessages = dryRun
        ? undefined
        : projectAcceptedActiveFullCompactMessages(incomingMessages, acceptedProjection);
      const messagesForRewrite = projectedMessages ?? incomingMessages;
      const rewritten = rewriteActiveFullCompactInMessages({
        sessionId: this.sessionId,
        turnId,
        messages: messagesForRewrite,
        policy,
        runtimeEvents: runtimeEvents?.filter((event) => event.turnId === turnId),
        stepNumber: options.stepNumber,
        now: this.now(),
        charsPerToken: this.input.contextBudget?.charsPerToken,
        requestShapeHashForMessages: (messages) =>
          requestShapeHashForMessages(messages, activeToolsForStep),
        headAnchor,
        dryRun,
        ...(dryRun ? { dryRunReason: policy.mode } : {}),
      });
      onDiagnosticPatch?.(rewritten.diagnosticPatch);
      if (!dryRun && rewritten.decision === 'replaced') {
        if (rewritten.block) this.recordActiveFullCompactBlock(rewritten.block);
        acceptedProjection = {
          sourceSignatures: incomingMessages.map(modelMessageSignature),
          sourceSignatureMode: 'exact',
          projectedMessages: rewritten.messages,
        };
        return { messages: rewritten.messages };
      }
      return !dryRun && projectedMessages ? { messages: projectedMessages } : undefined;
    };
  }

  /**
   * Mid-turn capacity compaction eligibility (issue #882 PR 1). Explicit
   * opt-in via `historyCompact.midTurn.enabled`; requires the checkpoint
   * writer seams plus the durable turn-ledger read, the persisted head anchor
   * for this turn, and a known model context window.
   */
  private buildMidTurnCapacityCompactState(
    input: BackendSendInput,
  ): MidTurnCapacityCompactState | undefined {
    const policy = this.input.contextBudget;
    if (
      policy?.historyCompact?.enabled !== true ||
      policy.historyCompact.midTurn?.enabled !== true
    ) {
      return undefined;
    }
    if (
      !this.input.summarizeHistoryCompact ||
      !this.input.recordHistoryCompactCheckpoint ||
      !this.input.loadTurnRuntimeEvents
    ) {
      return undefined;
    }
    const headAnchor = input.headAnchorRuntimeEvent;
    if (
      !headAnchor ||
      headAnchor.sessionId !== this.sessionId ||
      headAnchor.turnId !== input.turnId ||
      headAnchor.role !== 'user' ||
      headAnchor.author !== 'user' ||
      !isHistoryCompactContentEvent(headAnchor)
    ) {
      return undefined;
    }
    const contextWindow = resolveSelectedModelContextWindow(
      this.input.connection,
      this.input.modelId,
    );
    if (contextWindow === undefined) return undefined;
    const priorContentEvents = (input.runtimeContext ?? [])
      .filter((event) => event.turnId !== input.turnId)
      .filter(isHistoryCompactContentEvent);
    return new MidTurnCapacityCompactState(headAnchor, priorContentEvents, contextWindow);
  }

  /**
   * prepareStep SHAPING hook for the mid-turn capacity invariant: between
   * steps of one turn, estimate the next provider request (last step's real
   * usage + a signed char/4 payload delta, tool schemas included) against
   * `contextWindow - reserve`; over the high-water, fold a safe completed
   * prefix into a durable mid_turn checkpoint and continue the same turn on
   * `[compact block, verbatim head anchor, preserved tail]`.
   *
   * This hook never terminates the turn: every failure fails open with a
   * diagnostic and records itself for the final-request estimate owner, which
   * re-measures the payload after ALL shaping (including active tool-result
   * pruning, which runs later and can still rescue the step) and issues the
   * context_budget_exhausted verdict only when the request that would really
   * go out exceeds the window. The trigger threshold here is deliberately
   * approximate — a missed or spurious trigger is recoverable; the verdict is
   * not, so it does not live here.
   */
  private buildMidTurnCapacityCompactPrepareStep(
    turnId: string,
    state: MidTurnCapacityCompactState | undefined,
    queue: AsyncEventQueue<SessionEvent>,
    providerTools: readonly MakaTool[],
    fallbackActiveTools: () => readonly string[],
    turnTailPrompt: string | undefined,
    systemPromptChars: number,
    onDiagnosticPatch: (patch: Partial<ContextBudgetDiagnostic>) => void,
  ): PrepareStepFunctionLike | undefined {
    if (!state) return undefined;
    const policy = this.input.contextBudget!;
    const compactPolicy = policy.historyCompact!;
    const midTurn = compactPolicy.midTurn!;
    const charsPerToken = policy.charsPerToken ?? 4;
    const reserveTokens = midTurn.reserveTokens ?? 16_384;
    let acceptedProjection: ActiveFullCompactPrepareStepProjection | undefined;

    return async (options) => {
      const incomingMessages = options.messages;
      const projectedMessages = projectAcceptedActiveFullCompactMessages(
        incomingMessages,
        acceptedProjection,
      );
      const keepProjection = (): PrepareStepResultLike | undefined =>
        projectedMessages ? { messages: projectedMessages } : undefined;
      // Step 0 is shaped by the pre_turn path; the mid-turn trigger only runs
      // between steps, once completed-step usage and events exist.
      if (options.stepNumber < 1 || state.exhaustedDetail) return keepProjection();

      // Real usage for the last finished step, read synchronously from the
      // SDK's own step results (the same numbers the finish-step chunk
      // carries) — no coupling to how far the stream consumer has advanced.
      // Baseline = the last request's INPUT tokens only (see the state field
      // doc: the payload delta already carries the step's output). The
      // adapter fails closed on missing token counts (undefined, #972), and a
      // provider can still report a zero input outright — either way a
      // non-positive input count is unusable for estimation, so clear the
      // baseline and let the estimate fall back to the whole-payload cold
      // start instead of "0 + delta".
      //
      // The usage anchor is only meaningful PAIRED with the payload baseline
      // of the request it was reported for (`lastRequestPayloadChars`). A
      // successful overflow recovery restructures the request and resets that
      // baseline to undefined: the send-global steps view still carries the
      // dead attempt's last usage, but anchoring on it against the rejected
      // request's chars would under-estimate the retry by the whole previous
      // step growth — so a missing baseline forces the whole-payload cold
      // start, exactly like a missing usage sample.
      const lastStepInputTokens = normalizeAiSdkUsage(options.steps.at(-1)?.usage)?.inputTokens;
      state.lastRequestInputTokens =
        state.lastRequestPayloadChars !== undefined &&
        lastStepInputTokens !== undefined &&
        Number.isFinite(lastStepInputTokens) &&
        lastStepInputTokens > 0
          ? lastStepInputTokens
          : undefined;

      // A skipped trigger is never silent: every failure-driven skip records a
      // failedOpen decision. Recorder counters are attached ONLY on the tiers
      // where the recorder was actually invoked — the diagnostics must never
      // claim a write that did not happen.
      const failOpen = (
        failOpenReason: string,
        recorderCounters: Partial<ContextBudgetDiagnostic> = {},
      ): PrepareStepResultLike | undefined => {
        onDiagnosticPatch({
          historyCompactEnabled: true,
          historyCompactMode: 'read_write',
          ...recorderCounters,
          ...compactionDecisionDiagnosticPatch({
            stage: 'activeStep',
            sourceKind: 'runtimeEvents',
            decision: 'failedOpen',
            phase: 'mid_turn',
            boundaryKind: 'historyCompact',
            reason: 'context_limit',
            failOpenReason,
            skippedReasonCounts: { [failOpenReason]: 1 },
          }),
        });
        return keepProjection();
      };
      // A shaping failure additionally records itself for the final-request
      // estimate owner: when the final payload is still over the window, the
      // owner turns this step's failure into the terminal detail instead of
      // re-entering a shaper that already attempted and failed.
      const shapeFailure = (
        detail: ContextBudgetExhaustedDetail,
        diagnosticReason: string,
        recorderCounters: Partial<ContextBudgetDiagnostic> = {},
      ): PrepareStepResultLike | undefined => {
        state.lastShapeFailure = { stepNumber: options.stepNumber, detail, diagnosticReason };
        return failOpen(diagnosticReason, recorderCounters);
      };

      // Trigger estimate: the last request's input tokens plus a SIGNED char/4 delta of
      // this step's payload (system prompt + projected messages + active tool
      // schemas) against the previous request's measured payload. Measured synchronously from
      // the SDK's own projection — no ledger dependency — so a same-turn
      // `load_tools` schema expansion or a large tool result both count. This
      // position measures BEFORE later shapers (prune) run, so it can
      // over-trigger; that is the recoverable direction, and the verdict owner
      // re-measures the post-shaping payload.
      const measuredMessages = projectedMessages ?? incomingMessages;
      const activeToolsForStep = options.activeTools ?? fallbackActiveTools();
      const payloadChars = midTurnRequestPayloadChars(
        measuredMessages,
        providerTools,
        activeToolsForStep,
        systemPromptChars,
      );
      const forcedEstimate = state.forcedTriggerEstimate;
      state.forcedTriggerEstimate = undefined;
      const estimate =
        forcedEstimate ??
        estimateNextRequestTokens({
          ...(state.lastRequestInputTokens !== undefined
            ? { priorUsageTokens: state.lastRequestInputTokens }
            : {}),
          appendedChars: payloadChars - (state.lastRequestPayloadChars ?? payloadChars),
          charsPerToken,
          coldStartChars: payloadChars,
        });
      if (
        forcedEstimate === undefined &&
        !exceedsHighWater(estimate, state.contextWindow, reserveTokens)
      ) {
        return keepProjection();
      }

      // Fold a safe completed prefix of the durable turn ledger into a
      // replacement projection (validate → persist), shared with the reactive
      // overflow path. This hook maps the outcome to the prepareStep contract:
      // keep the raw projection on skip/fail, apply the fold on success.
      const outcome = await this.computeMidTurnCompactionReplacement({
        turnId,
        state,
        queue,
        minFlushedSteps: options.stepNumber,
        estimatedNextRequestTokens: estimate,
        referencePayloadChars: payloadChars,
        providerTools,
        activeToolsForStep,
        systemPromptChars,
        turnTailPrompt,
      });
      if (outcome.decision === 'skip') return keepProjection();
      if (outcome.decision === 'fail') {
        return shapeFailure(outcome.detail, outcome.diagnosticReason, outcome.recorderCounters);
      }
      acceptedProjection = {
        sourceSignatures: incomingMessages.map(modelMessageSignature),
        sourceSignatureMode: 'exact',
        projectedMessages: outcome.replacementMessages,
      };
      state.replacedStepNumber = options.stepNumber;
      onDiagnosticPatch(
        buildMidTurnReplacedDiagnosticPatch({
          checkpoint: outcome.checkpoint,
          estimatedTokensBefore: outcome.estimatedTokensBefore,
          estimatedTokensAfter: outcome.estimatedTokensAfter,
          reason: 'context_limit',
        }),
      );
      return { messages: outcome.replacementMessages };
    };
  }

  /**
   * Fold a safe completed prefix of the durable turn ledger into a persisted
   * mid_turn checkpoint and its `[block, verbatim anchor, tail]` replacement
   * messages — the compaction core shared by the proactive prepareStep hook
   * (issue #882 PR 1) and the reactive overflow recovery (PR 2). It waits for
   * the seq-ack durability boundary, reads the ledger, plans the fold, then
   * validates (materializable ∧ smaller than the reference request ∧
   * replay-admissible) and persists BEFORE returning the replacement, so a
   * recovery re-projection never re-injects a covered raw span. It only shapes:
   * the pass/terminate verdict and the diagnostic emission are the caller's.
   */
  private async computeMidTurnCompactionReplacement(input: {
    turnId: string;
    state: MidTurnCapacityCompactState;
    queue: AsyncEventQueue<SessionEvent>;
    minFlushedSteps: number;
    estimatedNextRequestTokens: number;
    referencePayloadChars: number;
    providerTools: readonly MakaTool[];
    activeToolsForStep: readonly string[];
    systemPromptChars: number;
    turnTailPrompt: string | undefined;
  }): Promise<MidTurnCompactionOutcome> {
    const {
      turnId,
      state,
      queue,
      providerTools,
      activeToolsForStep,
      systemPromptChars,
      turnTailPrompt,
    } = input;
    const summarizer = this.input.summarizeHistoryCompact!;
    const recorder = this.input.recordHistoryCompactCheckpoint!;
    const loadTurnRuntimeEvents = this.input.loadTurnRuntimeEvents!;
    const policy = this.input.contextBudget!;
    const compactPolicy = policy.historyCompact!;
    const midTurn = compactPolicy.midTurn!;
    const charsPerToken = policy.charsPerToken ?? 4;
    const reserveTokens = midTurn.reserveTokens ?? 16_384;

    // Coverage pool = the durable run ledger, read through the injected
    // seam. Covered events are persisted by construction (no crash window
    // between checkpoint and source), and their bytes are exactly what a
    // recovery re-projection replays.
    //
    // Seq-ack durability boundary. The replacement projection REPLACES the
    // whole message list, so any completed-step content event missing from
    // the durable pool is silently dropped from the next request — a
    // lagging ledger here is content loss (e.g. a step's already-emitted
    // assistant text), not a conservative under-count. No event-kind
    // predicate can close that: the wait counts the event stream itself.
    //  1. The pump has flushed every finish-step boundary the SDK reports
    //     completed (state.flushedSteps), so ALL of the completed steps'
    //     session events — tool pairs AND thinking/text completions — are
    //     enqueued with producer-stamped sequence numbers.
    //  2. The consumer has fully processed everything enqueued
    //     (consumedCount >= pushedCount). The consumer's pull is the ack
    //     (see drain()): it fires after processing, not after persisting,
    //     so deliberately-unpersisted events (non-terminal errors,
    //     partials) can never deadlock the wait.
    // After both, ONE durable read (which itself re-awaits the run's
    // serialized write queue) sees every event the projection may carry.
    // Exits: the boundary, an abort, a detached consumer, or a read failure.
    const abortSignal = this.abortController?.signal;
    for (;;) {
      if (abortSignal?.aborted) {
        return {
          decision: 'fail',
          detail: 'no_safe_completed_span',
          diagnosticReason: 'ledger_wait_aborted',
        };
      }
      if (queue.consumerDetached) {
        return {
          decision: 'fail',
          detail: 'no_safe_completed_span',
          diagnosticReason: 'ledger_wait_aborted',
        };
      }
      if (state.flushedSteps >= input.minFlushedSteps && queue.consumedCount >= queue.pushedCount)
        break;
      await waitForQueueProgressOrAbort(queue, abortSignal);
    }
    let turnLedger: RuntimeEvent[];
    try {
      turnLedger = await loadTurnRuntimeEvents(turnId);
    } catch {
      return {
        decision: 'fail',
        detail: 'no_safe_completed_span',
        diagnosticReason: 'ledger_read_failed',
      };
    }
    const currentTurnEvents = turnLedger
      .filter((event) => event.turnId === turnId)
      .filter(isHistoryCompactContentEvent);
    // The head anchor is persisted before backend.send() is invoked, so
    // its absence is a wiring error, not replication lag — fail open now.
    if (!currentTurnEvents.some((event) => event.id === state.headAnchor.id)) {
      return {
        decision: 'fail',
        detail: 'no_safe_completed_span',
        diagnosticReason: 'head_anchor_not_durable',
      };
    }
    const orderedEvents = [...state.priorContentEvents, ...currentTurnEvents];

    const plan = await planMidTurnCapacityCompaction({
      sessionId: this.sessionId,
      orderedEvents,
      headAnchor: { runtimeEventId: state.headAnchor.id, turnId },
      estimatedNextRequestTokens: input.estimatedNextRequestTokens,
      contextWindow: state.contextWindow,
      reserveTokens,
      reserveTailEvents: midTurn.reserveTailEvents ?? 1,
      charsPerToken,
      now: this.now(),
      ...(compactPolicy.highWaterName !== undefined
        ? { highWaterName: compactPolicy.highWaterName }
        : {}),
      ...(state.previousCheckpoint ? { previousCheckpoint: state.previousCheckpoint } : {}),
      summarize: async ({ coveredRuntimeEvents, newlyFoldedRuntimeEvents, previousCheckpoint }) => {
        return await Promise.resolve(
          summarizer({
            sessionId: this.sessionId,
            turnId,
            source: { foldedRuntimeEvents: [...coveredRuntimeEvents] },
            ...(previousCheckpoint ? { previousCheckpoint } : {}),
            newlyFoldedRuntimeEvents: [...newlyFoldedRuntimeEvents],
            ...(this.abortController?.signal ? { abortSignal: this.abortController.signal } : {}),
          }),
        );
      },
    });

    if (plan.decision === 'skip') return { decision: 'skip' };
    if (plan.decision === 'fail_open') {
      return {
        decision: 'fail',
        detail: plan.reason,
        diagnosticReason: plan.diagnosticReason ?? plan.reason,
      };
    }

    // Lifecycle order is validate → persist → apply, where validate =
    // materializable ∧ smaller ∧ replay-admissible. Replay applies the
    // session's latest checkpoint BEFORE any high-water check, so a
    // checkpoint that fails ANY of the three must never be persisted — it
    // would poison every later projection even though this step correctly
    // refused it.
    const replayPlan = buildRuntimeEventModelReplayPlan(plan.replacementEvents, {
      toolActivityTurnIds: collectToolActivityTurnIds(orderedEvents),
    });
    if (
      replayPlan.items.length === 0 ||
      hasBlockingReplayDiagnostics(replayPlan) ||
      (replayPlan.hasProviderNativeSemantics && !this.canReplayProviderNative(replayPlan))
    ) {
      return {
        decision: 'fail',
        detail: 'no_safe_completed_span',
        diagnosticReason: 'replacement_unmaterializable',
      };
    }
    // The head anchor must render exactly like the raw projection's current
    // user message: the initial request decorates it with the volatile turn
    // tail (cwd, shell context, task state — see send()), which is not part
    // of the durable anchor bytes. Reuse the same decoration owner
    // (appendTurnTailPrompt) on the anchor's replay item so a replacement
    // never silently drops that context — and never counts the drop as
    // shrinkage in the guard below.
    const replayItemsWithAnchorTail = replayPlan.items.map((item) =>
      item.kind === 'text' && item.role === 'user' && item.eventId === state.headAnchor.id
        ? { ...item, content: this.appendTurnTailPrompt(item.content, turnTailPrompt) as string }
        : item,
    );
    const replacementMessages = await this.materializeRuntimeReplayPlan({
      ...replayPlan,
      items: replayItemsWithAnchorTail,
    });
    // Apply the shape only when it actually shrinks the request versus the
    // reference payload (the incoming request for the proactive hook, the
    // request that overflowed for reactive recovery): a materialized
    // replacement that is not smaller proves the summarizer's OUTPUT is
    // unusable, reported as summarizer_failed via replacement_not_smaller.
    const replacedPayloadChars = midTurnRequestPayloadChars(
      replacementMessages,
      providerTools,
      activeToolsForStep,
      systemPromptChars,
    );
    if (replacedPayloadChars >= input.referencePayloadChars) {
      return {
        decision: 'fail',
        detail: 'summarizer_failed',
        diagnosticReason: 'replacement_not_smaller',
      };
    }
    // Replay admissibility uses the same complete-prefix capacity gate as
    // recovery. Actual payload shrinkage was already checked above because
    // only this owner can measure the fully materialized provider request.
    const replayFit = evaluateHistoryCompactCheckpointReplay(
      plan.checkpoint,
      plan.replacementEvents.slice(1),
      policy,
    );
    if (!replayFit.fits) {
      return {
        decision: 'fail',
        detail: 'head_anchor_exceeds_capacity',
        diagnosticReason: `replay_rejected_${replayFit.reason}`,
      };
    }

    // The replacement is valid: durably persist the checkpoint BEFORE
    // applying the projection — the same order as the pre_turn path. A
    // persistence failure keeps raw messages and records write_failed.
    try {
      await Promise.resolve(recorder(plan.checkpoint, turnId));
    } catch {
      return {
        decision: 'fail',
        detail: 'summarizer_failed',
        diagnosticReason: 'write_failed',
        recorderCounters: { historyCompactWritesAttempted: 1, historyCompactWriteFailures: 1 },
      };
    }
    state.previousCheckpoint = plan.checkpoint;
    return {
      decision: 'compacted',
      checkpoint: plan.checkpoint,
      replacementMessages,
      estimatedTokensBefore: plan.estimatedTokensBefore,
      estimatedTokensAfter: plan.estimatedTokensAfter,
    };
  }

  /**
   * Reactive overflow recovery (issue #882 PR 2): the second line of defense.
   * When a provider rejects a request with a context-length error, fold the
   * durable turn ledger once and resend once — a single compact-and-retry
   * latch (pi's `_overflowRecoveryAttempted`). Returns the compacted messages
   * to resend, or undefined when recovery is impossible or already spent, in
   * which case the caller surfaces the real provider error rather than a
   * fabricated success or a synthesized `context_budget_exhausted` (the
   * provider — not the runtime — rejected the request). Non-context-length
   * errors and turns without the mid-turn seam never reach compaction, so the
   * default (no seam) behavior is already better than the old fake end_turn.
   */
  private async recoverFromOverflowError(input: {
    error: unknown;
    retryAlreadyUsed: boolean;
    midTurnState: MidTurnCapacityCompactState | undefined;
    turnId: string;
    currentMessages: readonly ModelMessage[];
    providerTools: readonly MakaTool[];
    activeTools: readonly string[];
    systemPromptChars: number;
    turnTailPrompt: string | undefined;
    queue: AsyncEventQueue<SessionEvent>;
    onDiagnosticPatch: (patch: Partial<ContextBudgetDiagnostic>) => void;
  }): Promise<{ messages: ModelMessage[] } | undefined> {
    const state = input.midTurnState;
    if (input.retryAlreadyUsed || !state) return undefined;
    if (this.modelAdapter.classifyError(input.error) !== 'ContextLength') return undefined;

    // The shrink baseline is the request the provider actually rejected. Its
    // single owner is the verdict owner's per-request payload measure
    // (state.lastRequestPayloadChars), recorded at the end of every
    // prepareStep run — the attempt-INITIAL messages undercount the rejected
    // request by every same-turn tool step, and a baseline anchored there
    // refuses folds that genuinely shrink the real request (review P1-1).
    // The cold-start fallback only covers a send whose verdict owner never
    // ran a prepareStep (defensive; step 0 records the baseline too).
    const referencePayloadChars =
      state.lastRequestPayloadChars ??
      midTurnRequestPayloadChars(
        input.currentMessages,
        input.providerTools,
        input.activeTools,
        input.systemPromptChars,
      );
    const outcome = await this.computeMidTurnCompactionReplacement({
      turnId: input.turnId,
      state,
      queue: input.queue,
      // The stream has ended, so every completed step is already flushed; wait
      // only for the consumer to drain the durable ledger up to date.
      minFlushedSteps: state.flushedSteps,
      // The provider rejected the request outright, so force the fold past the
      // high water regardless of the (evidently under-counting) estimate.
      estimatedNextRequestTokens: state.contextWindow + 1,
      referencePayloadChars,
      providerTools: input.providerTools,
      activeToolsForStep: input.activeTools,
      systemPromptChars: input.systemPromptChars,
      turnTailPrompt: input.turnTailPrompt,
    });
    if (outcome.decision !== 'compacted') {
      // Recovery attempted but could not produce a smaller, admissible
      // request; record the failed overflow attempt and let the caller surface
      // the real provider error.
      input.onDiagnosticPatch({
        historyCompactEnabled: true,
        historyCompactMode: 'read_write',
        ...(outcome.decision === 'fail' && outcome.recorderCounters
          ? outcome.recorderCounters
          : {}),
        ...compactionDecisionDiagnosticPatch({
          stage: 'activeStep',
          sourceKind: 'runtimeEvents',
          decision: 'failedOpen',
          phase: 'mid_turn',
          boundaryKind: 'historyCompact',
          reason: 'overflow',
          ...(outcome.decision === 'fail'
            ? {
                failOpenReason: outcome.diagnosticReason,
                skippedReasonCounts: { [outcome.diagnosticReason]: 1 },
              }
            : {}),
        }),
      });
      return undefined;
    }
    input.onDiagnosticPatch(
      buildMidTurnReplacedDiagnosticPatch({
        checkpoint: outcome.checkpoint,
        estimatedTokensBefore: outcome.estimatedTokensBefore,
        estimatedTokensAfter: outcome.estimatedTokensAfter,
        reason: 'overflow',
      }),
    );
    // A successful recovery restructures the request, so the rejected
    // request's payload measure no longer describes what the retry sends.
    // Reset the baseline: the capacity hook's usage anchor is only coherent
    // paired with the payload chars of the SAME request, and a missing
    // baseline forces the whole-payload cold-start estimate instead of a
    // stale pairing against the dead attempt.
    state.lastRequestPayloadChars = undefined;
    return { messages: outcome.replacementMessages };
  }

  /**
   * The single end-of-pipeline estimate owner for the mid-turn capacity
   * invariant. Every prepareStep hook only shapes; this wrapper measures the
   * FINAL outgoing (messages, tools) payload — the bytes the provider will
   * actually see, after capacity compaction, active tool-result pruning, and
   * semantic/active-full compaction have all run — and issues the one
   * safety-critical verdict:
   *
   *  - estimate = the last request's real INPUT tokens + signed char/4 delta
   *    against the previous request's measured payload (recorded here on
   *    every step, including step 0's baseline); the delta already carries
   *    the step's fresh output, so an output-inclusive baseline would count
   *    it twice, and an unusable usage sample falls back to the whole-payload
   *    cold start rather than a zero baseline;
   *  - over the window with no capacity attempt this step (the approximate
   *    trigger missed, e.g. growth the trigger under-weighted), force ONE
   *    capacity re-entry — the verdict must not terminate a turn a shaper can
   *    still rescue, and one bounded re-entry preserves termination;
   *  - still over the window → context_budget_exhausted, with the terminal
   *    detail taken from this step's capacity outcome: a replacement that
   *    remains too large is head_anchor_exceeds_capacity (the irreducible
   *    remainder exceeds capacity); a recorded shaping failure keeps its own
   *    detail and diagnostic reason.
   *
   * Step 0 is shaped by the pre_turn path and only records the baseline here.
   */
  private buildMidTurnFinalRequestVerdict(input: {
    shaped: PrepareStepFunctionLike;
    reentry: PrepareStepFunctionLike;
    state: MidTurnCapacityCompactState;
    providerTools: readonly MakaTool[];
    fallbackActiveTools: () => readonly string[];
    charsPerToken: number;
    systemPromptChars: number;
    onDiagnosticPatch: (patch: Partial<ContextBudgetDiagnostic>) => void;
  }): PrepareStepFunctionLike {
    const {
      shaped,
      reentry,
      state,
      providerTools,
      fallbackActiveTools,
      charsPerToken,
      systemPromptChars,
      onDiagnosticPatch,
    } = input;
    return async (options) => {
      let result = await Promise.resolve(shaped(options));
      const finalPayloadChars = (): number =>
        midTurnRequestPayloadChars(
          result?.messages ?? options.messages,
          providerTools,
          result?.activeTools ?? options.activeTools ?? fallbackActiveTools(),
          systemPromptChars,
        );
      let payloadChars = finalPayloadChars();
      if (options.stepNumber >= 1 && !state.exhaustedDetail) {
        const estimateFinal = (): number =>
          estimateNextRequestTokens({
            ...(state.lastRequestInputTokens !== undefined
              ? { priorUsageTokens: state.lastRequestInputTokens }
              : {}),
            appendedChars: payloadChars - (state.lastRequestPayloadChars ?? payloadChars),
            charsPerToken,
            coldStartChars: payloadChars,
          });
        let estimate = estimateFinal();
        const capacityAttemptedThisStep =
          state.replacedStepNumber === options.stepNumber ||
          state.lastShapeFailure?.stepNumber === options.stepNumber;
        if (estimate > state.contextWindow && !capacityAttemptedThisStep) {
          // One bounded capacity re-entry: the trigger threshold is
          // approximate on purpose (recoverable), so a miss must become a
          // rescue attempt before it can become a terminal verdict. Re-run
          // only the capacity + prune shapers over the already-shaped
          // projection; a second attempt after a same-step failure is
          // pointless (the failure was not a trigger miss) and would double
          // recorder counters and summarizer calls.
          state.forcedTriggerEstimate = estimate;
          const reshaped = await Promise.resolve(
            reentry({
              ...options,
              messages: result?.messages ?? options.messages,
              ...(result?.activeTools ? { activeTools: result.activeTools } : {}),
            }),
          );
          state.forcedTriggerEstimate = undefined;
          if (reshaped) {
            result = {
              ...(result ?? {}),
              ...reshaped,
              activeTools: reshaped.activeTools ?? result?.activeTools,
            };
          }
          payloadChars = finalPayloadChars();
          estimate = estimateFinal();
        }
        if (estimate > state.contextWindow) {
          const failure =
            state.lastShapeFailure?.stepNumber === options.stepNumber
              ? state.lastShapeFailure
              : undefined;
          const replacedThisStep = state.replacedStepNumber === options.stepNumber;
          const detail: ContextBudgetExhaustedDetail = replacedThisStep
            ? 'head_anchor_exceeds_capacity'
            : (failure?.detail ?? 'no_safe_completed_span');
          const diagnosticReason = replacedThisStep
            ? 'head_anchor_exceeds_capacity'
            : (failure?.diagnosticReason ?? 'no_safe_completed_span');
          state.exhaustedDetail = detail;
          onDiagnosticPatch({
            historyCompactEnabled: true,
            historyCompactMode: 'read_write',
            ...compactionDecisionDiagnosticPatch({
              stage: 'activeStep',
              sourceKind: 'runtimeEvents',
              decision: 'unchanged',
              phase: 'mid_turn',
              boundaryKind: 'historyCompact',
              reason: 'context_budget_exhausted',
              skippedReasonCounts: { [diagnosticReason]: 1 },
            }),
          });
          this.abortController?.abort(new Error(`mid-turn context budget exhausted: ${detail}`));
          return result;
        }
      }
      state.lastRequestPayloadChars = payloadChars;
      return result;
    };
  }

  private recordSemanticCompactSummaryCall(input: {
    callId: string;
    turnId: string;
    modelId: string;
    startedAt: number;
    latencyMs: number;
    usage?: NormalizedAiSdkUsage;
    finishReason?: string;
    status: LlmCallRecord['status'];
    errorClass?: string;
  }): void {
    if (!input.usage) return;
    const costUsd = this.computeTokenUsageCostUsd(input.usage);
    this.input.recordLlmCall?.({
      sessionId: this.sessionId,
      turnId: input.turnId,
      callKind: 'semantic_compact',
      callId: input.callId,
      connectionSlug: this.input.connection.slug,
      providerId: this.input.connection.providerType,
      modelId: input.modelId,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      cacheHitInputTokens: input.usage.cacheHitInputTokens,
      cacheMissInputTokens: input.usage.cacheMissInputTokens,
      ...(input.usage.cacheMissInputSource !== undefined
        ? { cacheMissInputSource: input.usage.cacheMissInputSource }
        : {}),
      cachedInputTokens: input.usage.cachedInputTokens,
      cacheWriteInputTokens: input.usage.cacheWriteInputTokens,
      reasoningTokens: input.usage.reasoningTokens,
      totalTokens: input.usage.totalTokens,
      ...(input.finishReason !== undefined ? { rawFinishReason: input.finishReason } : {}),
      ...(input.usage.raw !== undefined ? { rawUsage: input.usage.raw } : {}),
      latencyMs: input.latencyMs,
      status: input.status,
      ...(input.errorClass ? { errorClass: input.errorClass } : {}),
      startedAt: input.startedAt,
      ...(costUsd !== undefined ? { costUsd } : {}),
    });
  }

  private recordSemanticCompactBlock(block: SemanticCompactBlock): void {
    const recorder = this.input.recordSemanticCompactBlock;
    if (!recorder) return;
    try {
      const result = recorder(block);
      if (result && typeof (result as PromiseLike<void>).then === 'function') {
        void Promise.resolve(result).catch(() => {
          // Semantic compact persistence is diagnostic/storage-only and must
          // never perturb provider request projection or tool-loop progress.
        });
      }
    } catch {
      // Semantic compact persistence is diagnostic/storage-only and must never
      // perturb provider request projection or tool-loop progress.
    }
  }

  private recordActiveFullCompactBlock(block: ActiveFullCompactBlock): void {
    const recorder = this.input.recordActiveFullCompactBlock;
    if (!recorder) return;
    try {
      const result = recorder(block);
      if (result && typeof (result as PromiseLike<void>).then === 'function') {
        void Promise.resolve(result).catch(() => {
          // Active compact persistence is diagnostic/storage-only and must never
          // perturb provider request projection or tool-loop progress.
        });
      }
    } catch {
      // Active compact persistence is diagnostic/storage-only and must never
      // perturb provider request projection or tool-loop progress.
    }
  }

  private async loadHistoryCompactBlocks(
    policy: ContextBudgetPolicy,
  ): Promise<{ policy: ContextBudgetPolicy; diagnosticPatch?: Partial<ContextBudgetDiagnostic> }> {
    const historyCompact = policy.historyCompact;
    if (
      historyCompact?.enabled !== true ||
      (!this.input.loadHistoryCompactCheckpoint && !this.input.loadHistoryCompact)
    ) {
      return { policy };
    }
    if (historyCompact.checkpoint !== undefined || (historyCompact.blocks?.length ?? 0) > 0) {
      return { policy };
    }
    let loadFailures = 0;
    let checkpoint: HistoryCompactCheckpoint | undefined;
    try {
      checkpoint = await Promise.resolve(this.input.loadHistoryCompactCheckpoint?.());
    } catch {
      loadFailures += 1;
    }
    if (checkpoint) {
      return {
        policy: {
          ...policy,
          historyCompact: { ...historyCompact, checkpoint },
        },
        diagnosticPatch: {
          historyCompactEnabled: true,
          historyCompactMode: historyCompact.mode ?? 'deterministic',
          historyCompactBlocksLoaded: 1,
          historyCompactBlocksAvailable: 1,
        },
      };
    }
    if (!this.input.loadHistoryCompact) {
      return loadFailures > 0
        ? {
            policy,
            diagnosticPatch: {
              historyCompactEnabled: true,
              historyCompactMode: historyCompact.mode ?? 'deterministic',
              historyCompactLoadFailures: loadFailures,
            },
          }
        : { policy };
    }
    try {
      // No maxBytes here: the block JSON carries per-event provenance and
      // legitimately outgrows the token budget; the loader caps reads by
      // storage size, and token limits are enforced on the loaded blocks.
      const result = await Promise.resolve(
        this.input.loadHistoryCompact({
          sessionId: this.sessionId,
          maxBlocks: historyCompact.maxBlocks,
          maxEstimatedTokens: historyCompact.maxEstimatedTokens,
        }),
      );
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
          ...(loadFailures > 0 ? { historyCompactLoadFailures: loadFailures } : {}),
          ...(result.skipped && result.skipped > 0
            ? { historyCompactLoadSkipped: result.skipped }
            : {}),
          ...(result.skippedReasonCounts
            ? { historyCompactLoadSkippedReasonCounts: result.skippedReasonCounts }
            : {}),
        },
      };
    } catch {
      loadFailures += 1;
      return {
        policy,
        diagnosticPatch: {
          historyCompactEnabled: true,
          historyCompactMode: historyCompact.mode ?? 'deterministic',
          historyCompactLoadFailures: loadFailures,
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
      const result = await Promise.resolve(
        this.input.loadSynthesisCache({
          sessionId: this.sessionId,
          maxBlocks: synthesisCache.maxBlocks,
          maxEstimatedTokens: synthesisCache.maxEstimatedTokens,
          maxBytes: (synthesisCache.maxEstimatedTokens ?? 2_048) * (policy.charsPerToken ?? 4),
        }),
      );
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
          ...(result.skipped && result.skipped > 0
            ? { synthesisCacheLoadSkipped: result.skipped }
            : {}),
          ...(result.skippedReasonCounts
            ? { synthesisCacheLoadSkippedReasonCounts: result.skippedReasonCounts }
            : {}),
          ...(result.evicted && result.evicted > 0
            ? { synthesisCacheEvicted: result.evicted }
            : {}),
          ...(result.evictionReasonCounts
            ? { synthesisCacheEvictionReasonCounts: result.evictionReasonCounts }
            : {}),
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
    if (
      synthesisCache?.enabled !== true ||
      synthesisCache.mode !== 'read_write' ||
      !this.input.writeSynthesisCache
    ) {
      return {};
    }
    const limits = {
      maxBlocks: synthesisCache.maxBlocks ?? 1,
      maxBlockEstimatedTokens: synthesisCache.maxBlockEstimatedTokens ?? 1_024,
      maxEstimatedTokens: synthesisCache.maxEstimatedTokens ?? 2_048,
      charsPerToken: input.contextBudget.charsPerToken ?? 4,
    };
    try {
      const result = await Promise.resolve(
        this.input.writeSynthesisCache({
          sessionId: this.sessionId,
          turnId: input.turnId,
          source: {
            createdFrom:
              input.archiveRetrievalMode === 'history_search_gated'
                ? 'gated_archive_retrieval'
                : 'eager_archive_retrieval',
            query: input.query,
            hydratedRuntimeEvents: input.hydratedRuntimeEvents,
            retrievedArchiveRefs: input.retrievedArchiveRefs,
            archiveRetrievalMode: input.archiveRetrievalMode,
          },
          limits,
          requestShapeHashBefore: this.priorRequestShape?.requestShapeHash,
        }),
      );
      const blocks = result?.blocks ?? [];
      const estimatedTokens = blocks.reduce(
        (total, block) => total + (block.estimatedTokens ?? 0),
        0,
      );
      return {
        synthesisCacheEnabled: true,
        synthesisCacheMode: 'read_write',
        synthesisCacheWritesAttempted: 1,
        synthesisCacheBlocksWritten: blocks.length,
        ...(blocks.length > 0
          ? {
              synthesisCacheWrittenBlockIds: blocks.map((block) => block.blockId),
              synthesisCacheWriteEstimatedTokens: estimatedTokens,
              highWaterName: blocks[0]!.highWaterName,
              highWaterSeq: blocks[0]!.highWaterSeq,
              highWaterReason: 'synthesis_cache_write',
            }
          : {}),
        ...(result?.skipped && result.skipped > 0
          ? { synthesisCacheWriteSkipped: result.skipped }
          : {}),
        ...(result?.skippedReasonCounts
          ? { synthesisCacheWriteSkippedReasonCounts: result.skippedReasonCounts }
          : {}),
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

  private async writeHistoryCompactCheckpoint(input: {
    turnId: string;
    contextBudget: ContextBudgetPolicy;
    priorRuntimeContext: readonly RuntimeEvent[];
    draftBlock: HistoryCompactBlock;
    abortSignal?: AbortSignal;
  }): Promise<{
    diagnosticPatch: Partial<ContextBudgetDiagnostic>;
    replacementCheckpoint?: HistoryCompactCheckpoint;
    fallbackCheckpoint?: HistoryCompactCheckpoint;
  }> {
    const summarizer = this.input.summarizeHistoryCompact;
    const recorder = this.input.recordHistoryCompactCheckpoint;
    if (!summarizer || !recorder) return { diagnosticPatch: {} };
    const foldedIds = new Set(input.draftBlock.coverage.runtimeEventIds);
    const foldedRuntimeEvents = input.priorRuntimeContext.filter((event) =>
      foldedIds.has(event.id),
    );
    if (foldedRuntimeEvents.length === 0) {
      return {
        diagnosticPatch: {
          historyCompactWritesAttempted: 0,
          historyCompactWriteSkipped: 1,
          historyCompactWriteSkippedReasonCounts: { source_missing: 1 },
        },
      };
    }
    const loadedCheckpoint = input.contextBudget.historyCompact?.checkpoint;
    const checkpointMatch = loadedCheckpoint
      ? matchHistoryCompactCheckpointPrefix(loadedCheckpoint, foldedRuntimeEvents)
      : undefined;
    const previousCheckpoint =
      checkpointMatch && !checkpointMatch.reason ? loadedCheckpoint : undefined;
    const newlyFoldedRuntimeEvents = previousCheckpoint
      ? checkpointMatch!.successorRuntimeEvents
      : foldedRuntimeEvents;
    const retainedRuntimeEvents = input.priorRuntimeContext.filter(
      (event) => !foldedIds.has(event.id) && !event.id.startsWith('history-compact:'),
    );
    const previousCheckpointFitsCurrentLimits =
      previousCheckpoint !== undefined &&
      evaluateHistoryCompactCheckpointReplay(
        previousCheckpoint,
        retainedRuntimeEvents,
        input.contextBudget,
        { sourceReplayEvents: [...foldedRuntimeEvents, ...retainedRuntimeEvents] },
      ).fits;
    if (
      previousCheckpoint &&
      newlyFoldedRuntimeEvents.length === 0 &&
      previousCheckpointFitsCurrentLimits
    ) {
      return {
        fallbackCheckpoint: previousCheckpoint,
        diagnosticPatch: {
          historyCompactEnabled: true,
          historyCompactMode: 'read_write',
          historyCompactWritesAttempted: 0,
          historyCompactWriteSkipped: 1,
          historyCompactWriteSkippedReasonCounts: { already_compacted: 1 },
          historyCompactBlocksAvailable: 1,
          historyCompactBlocksSelected: 1,
          historyCompactBlockIds: [previousCheckpoint.checkpointId],
          historyCompactedTurns: previousCheckpoint.coverage.turnCount,
          historyCompactedEvents: previousCheckpoint.coverage.eventCount,
          historyCompactedEstimatedTokensAfter: previousCheckpoint.estimatedTokens,
          historyCompactCoverageHashes: [previousCheckpoint.coverage.sourceDigest],
          ...compactionDecisionDiagnosticPatch({
            stage: 'priorReplay',
            sourceKind: 'runtimeEvents',
            decision: 'unchanged',
            boundaryKind: 'historyCompact',
            boundaryIds: [previousCheckpoint.checkpointId],
            reason: 'already_compacted',
          }),
        },
      };
    }
    try {
      const summary = await Promise.resolve(
        summarizer({
          sessionId: this.sessionId,
          turnId: input.turnId,
          source: { foldedRuntimeEvents },
          ...(previousCheckpoint ? { previousCheckpoint } : {}),
          newlyFoldedRuntimeEvents,
          requestShapeHashBefore: this.priorRequestShape?.requestShapeHash,
          abortSignal: input.abortSignal,
        }),
      );
      if (!summary?.trim()) {
        return {
          ...(previousCheckpoint ? { fallbackCheckpoint: previousCheckpoint } : {}),
          diagnosticPatch: {
            historyCompactEnabled: true,
            historyCompactMode: 'read_write',
            historyCompactWritesAttempted: 1,
            historyCompactWriteFailures: 1,
            historyCompactWriteSkippedReasonCounts: { empty_summary: 1 },
            ...compactionDecisionDiagnosticPatch({
              stage: 'priorReplay',
              sourceKind: 'runtimeEvents',
              decision: 'failedOpen',
              boundaryKind: 'historyCompact',
              failOpenReason: 'empty_summary',
            }),
          },
        };
      }
      const checkpoint = buildHistoryCompactCheckpoint({
        sessionId: this.sessionId,
        coveredRuntimeEvents: foldedRuntimeEvents,
        summary,
        highWaterName: input.draftBlock.highWaterName,
        highWaterSeq: input.draftBlock.highWaterSeq,
        ...(previousCheckpoint ? { previousCheckpointId: previousCheckpoint.checkpointId } : {}),
        charsPerToken: input.contextBudget.charsPerToken,
        now: this.now(),
      });
      const replayFit = evaluateHistoryCompactCheckpointReplay(
        checkpoint,
        retainedRuntimeEvents,
        input.contextBudget,
        { sourceReplayEvents: [...foldedRuntimeEvents, ...retainedRuntimeEvents] },
      );
      const rejectedReason = !replayFit.fits ? replayFit.reason : undefined;
      if (rejectedReason) {
        return {
          ...(previousCheckpoint ? { fallbackCheckpoint: previousCheckpoint } : {}),
          diagnosticPatch: {
            historyCompactEnabled: true,
            historyCompactMode: 'read_write',
            historyCompactWritesAttempted: 1,
            historyCompactWriteFailures: 1,
            historyCompactWriteSkippedReasonCounts: { [rejectedReason]: 1 },
            ...compactionDecisionDiagnosticPatch({
              stage: 'priorReplay',
              sourceKind: 'runtimeEvents',
              decision: 'failedOpen',
              boundaryKind: 'historyCompact',
              failOpenReason: rejectedReason,
            }),
          },
        };
      }
      await Promise.resolve(recorder(checkpoint, input.turnId));
      return {
        replacementCheckpoint: checkpoint,
        diagnosticPatch: {
          historyCompactEnabled: true,
          historyCompactMode: 'read_write',
          historyCompactWritesAttempted: 1,
          historyCompactBlocksWritten: 1,
          historyCompactWrittenBlockIds: [checkpoint.checkpointId],
          historyCompactWriteEstimatedTokens: checkpoint.estimatedTokens,
          historyCompactBlockIds: [checkpoint.checkpointId],
          historyCompactedEstimatedTokensAfter: checkpoint.estimatedTokens,
          highWaterName: checkpoint.highWaterName,
          highWaterSeq: checkpoint.highWaterSeq,
          highWaterReason: 'history_compact',
        },
      };
    } catch (error) {
      const failureReason =
        error instanceof HistoryCompactSummarizerError ? error.reason : 'write_failed';
      return {
        ...(previousCheckpoint ? { fallbackCheckpoint: previousCheckpoint } : {}),
        diagnosticPatch: {
          historyCompactEnabled: true,
          historyCompactMode: 'read_write',
          historyCompactWritesAttempted: 1,
          historyCompactWriteFailures: 1,
          historyCompactWriteSkippedReasonCounts: { [failureReason]: 1 },
          ...compactionDecisionDiagnosticPatch({
            stage: 'priorReplay',
            sourceKind: 'runtimeEvents',
            decision: 'failedOpen',
            boundaryKind: 'historyCompact',
            failOpenReason: failureReason,
          }),
        },
      };
    }
  }

  private async writeHistoryCompactBlocks(input: {
    turnId: string;
    contextBudget: ContextBudgetPolicy;
    priorRuntimeContext: readonly RuntimeEvent[];
    draftBlocks: HistoryCompactBlock[];
    abortSignal?: AbortSignal;
  }): Promise<{
    diagnosticPatch: Partial<ContextBudgetDiagnostic>;
    replacementBlocks: HistoryCompactBlock[];
  }> {
    const historyCompact = input.contextBudget.historyCompact;
    if (
      historyCompact?.enabled !== true ||
      historyCompact.mode !== 'read_write' ||
      !this.input.writeHistoryCompact
    ) {
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
        const foldedRuntimeEvents = input.priorRuntimeContext.filter((event) =>
          foldedIds.has(event.id),
        );
        if (foldedRuntimeEvents.length === 0) {
          skipped += 1;
          incrementRecord(skippedReasonCounts, 'source_missing');
          continue;
        }
        writesAttempted += 1;
        const result = await Promise.resolve(
          this.input.writeHistoryCompact({
            sessionId: this.sessionId,
            turnId: input.turnId,
            source: {
              draftBlock,
              foldedRuntimeEvents,
            },
            limits,
            requestShapeHashBefore: this.priorRequestShape?.requestShapeHash,
            abortSignal: input.abortSignal,
          }),
        );
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
      const estimatedTokens = replacementBlocks.reduce(
        (total, block) => total + (block.estimatedTokens ?? 0),
        0,
      );
      const replacementRuntimeEventIds = new Set(
        replacementBlocks.flatMap((block) => block.coverage.runtimeEventIds),
      );
      const estimatedTokensBefore = estimateRuntimeEventsTokens(
        input.priorRuntimeContext.filter((event) => replacementRuntimeEventIds.has(event.id)),
        limits.charsPerToken,
      );
      const replacementDecisionPatch =
        replacementBlocks.length > 0
          ? compactionDecisionDiagnosticPatch({
              stage: 'priorReplay',
              sourceKind: 'runtimeEvents',
              decision: 'replaced',
              boundaryKind: 'historyCompact',
              boundaryIds: replacementBlocks.map(
                (block) => historyCompactBlockToCompactionBoundary(block).boundaryId,
              ),
              coverage: {
                turnIds: Array.from(
                  new Set(replacementBlocks.flatMap((block) => block.coverage.turnIds)),
                ),
                runtimeEventIds: Array.from(replacementRuntimeEventIds),
                contentKinds: Array.from(
                  new Set(replacementBlocks.flatMap((block) => block.coverage.contentKinds)),
                ),
                bodySha256: replacementBlocks.flatMap((block) => block.coverage.bodySha256),
              },
              estimatedTokensBefore,
              estimatedTokensAfter: estimatedTokens,
            })
          : compactionDecisionDiagnosticPatch({
              stage: 'priorReplay',
              sourceKind: 'runtimeEvents',
              decision: 'failedOpen',
              boundaryKind: 'historyCompact',
              failOpenReason: Object.keys(skippedReasonCounts)[0] ?? 'write_empty',
              ...(Object.keys(skippedReasonCounts).length > 0 ? { skippedReasonCounts } : {}),
            });
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
          ...replacementDecisionPatch,
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
          ...compactionDecisionDiagnosticPatch({
            stage: 'priorReplay',
            sourceKind: 'runtimeEvents',
            decision: 'failedOpen',
            boundaryKind: 'historyCompact',
            failOpenReason: 'write_failed',
          }),
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

  /**
   * Materialize a replay plan into provider messages, grouping each assistant
   * step's reasoning + text + tool calls into ONE assistant message (Anthropic
   * requires the signed thinking block to lead the tool-use assistant message).
   *
   * The ledger lands a step's parts as: tool_call(s), tool_result(s), thinking,
   * text (the per-step AssistantMessage flushes at `finish-step`, after the
   * step's tool events). Model text carries the step id and closes the step: it
   * emits `[reasoning, text, tool-call…]` then the tool results. Steps with no
   * text closer — a thinking + tool step (its empty text closer is skipped from
   * the plan as `empty_text_skipped`) or a pure-tool step — flush grouped by
   * stepId, claiming any parked reasoning for that step. Legacy per-turn items
   * (no step id) keep the older shape: tool calls form a tool-only assistant,
   * text/thinking become standalone messages.
   */
  private async materializeRuntimeReplayPlan(
    plan: RuntimeEventModelReplayPlan,
  ): Promise<ModelMessage[]> {
    type ToolCallItem = Extract<RuntimeEventModelReplayItem, { kind: 'tool_call' }>;
    type ToolResultItem = Extract<RuntimeEventModelReplayItem, { kind: 'tool_result' }>;
    type ThinkingItem = Extract<RuntimeEventModelReplayItem, { kind: 'thinking' }>;
    const out: ModelMessage[] = [];
    let bufferedCalls: ToolCallItem[] = [];
    const results = new Map<string, ToolResultItem>();
    const reasoningByStep = new Map<string, ThinkingItem>();

    const reasoningPart = (item: ThinkingItem) => ({
      type: 'reasoning' as const,
      text: item.text,
      providerOptions: { anthropic: { signature: item.signature } },
    });
    // Tool results are emitted only when their tool_call claims them here. A
    // result whose call never appears in the plan (sliced-away call, corrupt
    // ledger) is INTENTIONALLY dropped at the end: a standalone tool message
    // with no preceding tool_use in an assistant message is an Anthropic 400.
    // The old item-by-item materializer emitted such orphans; do not "fix" this
    // back — the plan flags them as `unmatched_tool_result` (a non-blocking
    // diagnostic precisely so this drop path is reachable; see
    // hasBlockingReplayDiagnostics).
    const pushToolResults = async (calls: readonly ToolCallItem[]) => {
      for (const call of calls) {
        const result = results.get(call.toolCallId);
        if (!result) continue;
        results.delete(call.toolCallId);
        out.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: result.toolCallId,
              toolName: result.toolName,
              output: await this.materializeToolResultOutput(
                result.output,
                result.isError,
                result.toolCallId,
              ),
            },
          ],
        });
      }
    };
    // Emit one assistant message for a step: reasoning (if any), text (if any),
    // then the step's tool calls, followed by those calls' tool results.
    const emitStep = async (
      reasoning: ThinkingItem | undefined,
      text: string,
      calls: readonly ToolCallItem[],
    ) => {
      const content: unknown[] = [];
      if (reasoning) content.push(reasoningPart(reasoning));
      if (text.length > 0) content.push({ type: 'text', text });
      for (const call of calls) {
        content.push({
          type: 'tool-call',
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.input,
        });
      }
      if (content.length > 0) out.push({ role: 'assistant', content } as ModelMessage);
      await pushToolResults(calls);
    };
    // Emit tool calls no assistant text closed: a thinking + tool step with no
    // text (its empty closer is skipped from the plan), a pure-tool step, or a
    // legacy per-turn tool block. Group consecutive calls by stepId so each step
    // stays one assistant message, and claim the step's parked reasoning by
    // stepId — this is how the common Anthropic interleaved-thinking step shape
    // (reasoning + tool call, no text) gets its reasoning merged ahead of its
    // calls. Calls without a stepId group together (legacy shape, no reasoning).
    const emitGroupedCalls = async (calls: readonly ToolCallItem[]) => {
      let group: ToolCallItem[] = [];
      const emitGroup = async () => {
        if (group.length === 0) return;
        const stepId = group[0]!.stepId;
        const reasoning = stepId !== undefined ? reasoningByStep.get(stepId) : undefined;
        if (stepId !== undefined) reasoningByStep.delete(stepId);
        await emitStep(reasoning, '', group);
        group = [];
      };
      for (const call of calls) {
        if (group.length > 0 && group[0]!.stepId !== call.stepId) await emitGroup();
        group.push(call);
      }
      await emitGroup();
    };
    const flushLooseCalls = async () => {
      if (bufferedCalls.length === 0) return;
      const calls = bufferedCalls;
      bufferedCalls = [];
      await emitGroupedCalls(calls);
    };

    for (const item of plan.items) {
      switch (item.kind) {
        case 'tool_call':
          bufferedCalls.push(item);
          break;
        case 'tool_result':
          results.set(item.toolCallId, item);
          break;
        case 'thinking':
          if (item.stepId !== undefined) {
            reasoningByStep.set(item.stepId, item);
          } else {
            // Legacy standalone reasoning (pure-reasoning turn): emit on its own.
            await flushLooseCalls();
            out.push({ role: 'assistant', content: [reasoningPart(item)] } as ModelMessage);
          }
          break;
        case 'text':
          if (item.role !== 'assistant') {
            await flushLooseCalls();
            out.push(await this.materializeRuntimeReplayItem(item));
            break;
          }
          if (item.stepId !== undefined) {
            const stepId = item.stepId;
            const thisCalls = bufferedCalls.filter((call) => call.stepId === stepId);
            const otherCalls = bufferedCalls.filter((call) => call.stepId !== stepId);
            bufferedCalls = [];
            // Earlier steps' unclosed calls flush first (with their own parked
            // reasoning, if any) so step order is preserved.
            if (otherCalls.length > 0) await emitGroupedCalls(otherCalls);
            await emitStep(reasoningByStep.get(stepId), item.content, thisCalls);
            reasoningByStep.delete(stepId);
          } else {
            // Legacy per-turn assistant text: standalone after any tool block.
            await flushLooseCalls();
            out.push({ role: 'assistant', content: item.content });
          }
          break;
      }
    }
    await flushLooseCalls();
    // Any reasoning whose closing text never arrived (defensive): emit standalone.
    for (const reasoning of reasoningByStep.values()) {
      out.push({ role: 'assistant', content: [reasoningPart(reasoning)] } as ModelMessage);
    }
    return out;
  }

  private async materializeRuntimeReplayItem(
    item: RuntimeEventModelReplayItem,
  ): Promise<ModelMessage> {
    switch (item.kind) {
      case 'text':
        if (item.role === 'user') {
          if (item.steering) {
            // Already envelope-wrapped by the plan; carry the structured
            // identity so injection dedupe recognizes the replayed message.
            return {
              role: 'user',
              content: item.content,
              providerOptions: steeringProviderOptions(item.steering.eventId),
            };
          }
          return {
            role: 'user',
            content: await this.appendImageParts(item.content, item.attachments),
          } as ModelMessage;
        }
        return { role: item.role, content: item.content };
      case 'thinking':
        return {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: item.text,
              providerOptions: {
                anthropic: { signature: item.signature },
              },
            },
          ],
        };
      case 'tool_call':
        return {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: item.toolCallId,
              toolName: item.toolName,
              input: item.input,
            },
          ],
        };
      case 'tool_result':
        return {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: item.toolCallId,
              toolName: item.toolName,
              output: await this.materializeToolResultOutput(
                item.output,
                item.isError,
                item.toolCallId,
              ),
            },
          ],
        };
    }
  }

  private async materializePriorMessages(
    stored: readonly StoredMessage[],
    steeringSidecar?: ReadonlyMap<string, { eventId: string }>,
  ): Promise<ModelMessage[]> {
    const out: ModelMessage[] = [];
    for (const m of stored) {
      if (m.type === 'user') {
        // Degraded projections lose the RuntimeEvent steering marker; the
        // sidecar (keyed by the projection's stable message ids) restores the
        // canonical envelope + structured identity so a fallback-gated turn
        // still presents steering exactly once, in its one provider form.
        const sidecar = steeringSidecar?.get(m.id);
        if (sidecar) {
          out.push(
            steeringModelMessage(
              sidecar.eventId,
              formatTextWithAttachmentRefs(m.text, m.attachments),
            ),
          );
          continue;
        }
        out.push({
          role: 'user',
          content: await this.appendImageParts(
            formatTextWithAttachmentRefs(m.text, m.attachments),
            m.attachments,
          ),
        } as ModelMessage);
      }
      // A thinking/tool-only step projects an assistant row with empty text;
      // replaying it as an empty text block is a hard 400 on Anthropic-protocol
      // providers.
      else if (m.type === 'assistant' && m.text.length > 0)
        out.push({ role: 'assistant', content: m.text });
      // empty assistant / tool_call / tool_result / permission_decision / token_usage / system_note skipped
    }
    return out;
  }

  /** Append provider-visible volatile turn facts after the durable user content. */
  private appendTurnTailPrompt(
    content: ModelMessage['content'],
    turnTailPrompt?: string,
  ): ModelMessage['content'] {
    if (!turnTailPrompt) return content;
    if (typeof content === 'string') return `${content}\n\n${turnTailPrompt}`;
    return [
      ...(content as unknown[]),
      { type: 'text', text: turnTailPrompt },
    ] as ModelMessage['content'];
  }

  /** A decision key deduplicates re-materialization; no key charges each occurrence. */
  private chargeImageBudget(bytes: number, decisionKey?: string): boolean {
    const budget = this.imageRequestBudget;
    if (!budget) return true;
    if (decisionKey !== undefined) {
      const cached = budget.decisions.get(decisionKey);
      if (cached !== undefined) return cached;
    }
    const keep =
      budget.used + bytes <=
      (this.input.maxProviderImageRequestBytes ?? MAX_PROVIDER_IMAGE_REQUEST_BYTES);
    if (keep) budget.used += bytes;
    if (decisionKey !== undefined) budget.decisions.set(decisionKey, keep);
    return keep;
  }

  /**
   * Render provider-visible content for a user message: keep the given
   * (already-formatted) text, and append image attachments as provider image
   * parts only for explicitly vision-capable models. Non-image attachments stay
   * as placeholder refs in the text. Shared by the current turn, RuntimeEvent
   * replay, and the stored-message fallback so all paths present images identically.
   */
  private async appendImageParts(
    textContent: string,
    attachments?: AttachmentRef[],
  ): Promise<ModelMessage['content']> {
    const images = attachments?.filter((a) => a.kind === 'image') ?? [];
    if (images.length === 0) {
      return textContent;
    }
    if (this.input.supportsVision !== true) {
      return appendNonVisionImageFallbackNotice(textContent);
    }
    if (!this.input.readAttachmentBytes) {
      return textContent;
    }
    const parts: Array<
      | { type: 'text'; text: string }
      | { type: 'file'; data: { type: 'data'; data: Uint8Array }; mediaType: string }
    > = [{ type: 'text', text: textContent }];
    let omittedByBudget = 0;
    for (const image of images) {
      const read = await this.input.readAttachmentBytes(image.ref);
      if (!read.ok) {
        parts.push({
          type: 'text',
          text: `Image attachment "${image.name}" could not be loaded: ${read.reason}.`,
        });
        continue;
      }
      if (!this.chargeImageBudget(read.bytes.length)) {
        omittedByBudget += 1;
        continue;
      }
      parts.push({
        type: 'file',
        data: { type: 'data', data: read.bytes },
        mediaType: image.mimeType,
      });
    }
    if (omittedByBudget > 0) {
      parts.push({
        type: 'text',
        text: `[${omittedByBudget} image attachment(s) omitted: the per-request image budget was exceeded. Earlier images were sent; ask the user to send fewer or smaller images.]`,
      });
    }
    return parts as ModelMessage['content'];
  }

  private async materializeToolResultOutput(
    output: unknown,
    isError: boolean,
    decisionKey: string,
  ): Promise<ReturnType<typeof toolResultOutput> | ToolModelOutput> {
    if (isError || !isImageToolResult(output)) return toolResultOutput(output, isError);
    if (this.input.supportsVision !== true) {
      return toolResultText('Image was read, but the selected model does not support image input.');
    }
    if (!this.input.readAttachmentBytes) {
      return toolResultText('Image was read, but its stored bytes are unavailable.');
    }
    const budget = this.imageRequestBudget;
    if (budget && budget.decisions.get(decisionKey) === false) {
      return toolResultText(PROVIDER_IMAGE_BUDGET_EXCEEDED_MESSAGE);
    }
    let read: Awaited<ReturnType<AttachmentByteReader>>;
    try {
      read = await this.input.readAttachmentBytes(output.ref);
    } catch {
      return toolResultText('Image could not be loaded from artifact storage: read_failed.');
    }
    if (!read.ok) {
      return toolResultText(`Image could not be loaded from artifact storage: ${read.reason}.`);
    }
    if (!this.chargeImageBudget(read.bytes.length, decisionKey)) {
      return toolResultText(PROVIDER_IMAGE_BUDGET_EXCEEDED_MESSAGE);
    }
    return {
      type: 'content',
      value: [
        { type: 'text', text: 'Image read successfully.' },
        {
          type: 'file',
          data: { type: 'data', data: Buffer.from(read.bytes).toString('base64') },
          mediaType: output.mimeType,
        },
      ],
    };
  }

  private async buildCurrentUserContent(
    text: string,
    attachments?: AttachmentRef[],
  ): Promise<ModelMessage['content']> {
    return this.appendImageParts(formatTextWithAttachmentRefs(text, attachments), attachments);
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

  private async resolveShellRunContextSummary(): Promise<string | undefined> {
    return await this.input.shellRunContextSummary?.();
  }

  private async *drain(queue: AsyncEventQueue<SessionEvent>): AsyncIterable<SessionEvent> {
    try {
      for await (const ev of queue) {
        yield ev;
        // Generator backpressure IS the consumer's ack: this line runs only
        // when the consumer's loop body finished for `ev` and pulled the next
        // event, so `consumedCount` counts fully PROCESSED events. AgentRun
        // persists each mapped event before continuing, so an acked event is
        // either durable or deliberately skipped (partials, non-terminal
        // errors) — exactly the set a durable read can ever return.
        queue.ackConsumed();
      }
    } finally {
      // The consumer abandoned or finished the stream; wake any seq-ack waiter
      // so it observes `consumerDetached` instead of blocking forever.
      queue.noteConsumerDetached();
    }
  }

  private cleanupAfterTurn(turnId: string): void {
    this.input.permissionEngine.endTurn(turnId, this.aborted ? 'aborted' : 'completed');
    this.abortController = null;
    this.currentQueue = null;
    this.currentTurnId = null;
    this.currentRunId = null;
    this.currentRunTrace = null;
    this.currentUserIntent = undefined;
    this.currentStepMessageId = null;
    this.stopAfterStepRequested = false;
    this.injectedSteeringMessages = [];
    this.toolRuntime.endTurn(turnId, this.aborted ? 'aborted' : 'completed');
    this.aborted = false;
  }

  /**
   * Drain the caller's pending steering at a step boundary. Each message is
   * echoed as a `steering_message` event (so the ledger + transcript render the
   * interjection in place) and accumulated as an envelope-wrapped user message
   * for injection into subsequent provider requests.
   *
   * Persist-before-include invariant: the initial user message is durable
   * before the backend is invoked, and a steered message must hold the same
   * line — the provider must never start executing a directive the ledger does
   * not carry. The seq-ack boundary provides that without a second write path:
   * the consumer's pull is the ack, and AgentRun persists each mapped event
   * before continuing (see drain()), so once everything enqueued up to the
   * steering event is consumed, the event is durable. If the consumer detaches
   * (the persist path failed or the turn is being torn down) before that, the
   * message is nacked and NOT included in any request; an abort after the push
   * waits for that same convergence — durable ⇒ ack (history owns it), detach
   * ⇒ nack — and only then throws so the dying request is never sent.
   */
  private async drainSteeringInto(
    input: BackendSendInput,
    turnId: string,
    queue: AsyncEventQueue<SessionEvent>,
  ): Promise<void> {
    const pull = input.pullSteering;
    if (!pull) return;
    const leases = pull();
    if (leases.length === 0) return;
    const abortSignal = this.abortController?.signal;
    // Binary settlement: every pulled lease settles exactly once, decided
    // ONLY by the persistence fact — durably consumed ⇒ ack + injection set;
    // provably never persisted (never pushed, or the consumer detached
    // without consuming it) ⇒ nack. An abort does NOT settle a pushed lease:
    // it only stops new pushes and the dying request; the wait continues
    // until the teardown converges it (the flow drains after terminal events
    // or detaches on failure), because nacking a durably appended event
    // would put the same directive in the account twice — once via history
    // replay, once via the reclaimed queue.
    const undelivered = [...leases];
    try {
      for (const lease of leases) {
        if (this.aborted || abortSignal?.aborted) {
          // Never pushed: settles as undelivered.
          throw Object.assign(new Error('aborted before steering was pushed'), {
            name: 'AbortError',
          });
        }
        if (queue.consumerDetached) {
          throw new Error('steering message was not durably consumed: event consumer detached');
        }
        const eventId = this.newId();
        queue.push({
          type: 'steering_message',
          id: eventId,
          turnId,
          ts: this.now(),
          messageId: this.newId(),
          text: lease.text,
        } satisfies SessionEvent);
        const pushedThrough = queue.pushedCount;
        for (;;) {
          if (queue.consumedCount >= pushedThrough) break;
          if (queue.consumerDetached) {
            throw new Error('steering message was not durably consumed: event consumer detached');
          }
          await queue.waitForProgress();
        }
        // The mapped RuntimeEvent inherits this session event's id, so the
        // injected message and its future ledger replay share one identity.
        this.injectedSteeringMessages.push(steeringModelMessage(eventId, lease.text));
        input.ackSteering?.([lease.id]);
        undelivered.shift();
        if (this.aborted || abortSignal?.aborted) {
          // Settled (the ledger owns the message; the next turn replays it),
          // but the send is dying: stop before any request is built with it.
          throw Object.assign(new Error('aborted after steering was durable'), {
            name: 'AbortError',
          });
        }
      }
    } catch (error) {
      if (undelivered.length > 0) {
        input.nackSteering?.(undelivered.map((lease) => lease.id));
      }
      throw error;
    }
  }
}

/**
 * Steering identities for degraded StoredMessage projections, keyed by every
 * stable id the projection may have used for the message (event id,
 * providerEventId, storedMessageId), so the sidecar restore is exact.
 */
function buildSteeringSidecar(events: readonly RuntimeEvent[]): Map<string, { eventId: string }> {
  const sidecar = new Map<string, { eventId: string }>();
  for (const event of events) {
    if (event.partial === true) continue;
    if (event.content?.kind !== 'text' || event.content.steering !== true) continue;
    const identity = { eventId: event.id };
    sidecar.set(event.id, identity);
    if (event.refs?.providerEventId) sidecar.set(event.refs.providerEventId, identity);
    if (event.refs?.storedMessageId) sidecar.set(event.refs.storedMessageId, identity);
  }
  return sidecar;
}

function providerToolError(output: unknown): string | undefined {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return undefined;
  const record = output as Record<string, unknown>;
  if (typeof record.error !== 'string' || record.error.length === 0) return undefined;
  if (typeof record.modelText === 'string' && record.modelText.length > 0) {
    return record.modelText;
  }
  if (typeof record.text === 'string' && record.text.length > 0) {
    return record.text;
  }
  return record.error;
}

export function repairMakaToolCall(input: {
  toolCall: RepairableAiSdkToolCall;
  availableToolNames: readonly string[];
  error: unknown;
}): RepairableAiSdkToolCall | null {
  const requestedName = input.toolCall.toolName;
  if (requestedName === INVALID_TOOL_NAME) return null;

  const lowerRequestedName = requestedName.toLowerCase();
  const exactLowercaseMatch = input.availableToolNames.find(
    (name) => name.toLowerCase() === lowerRequestedName,
  );
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
    description:
      'Internal repair target for malformed or unknown tool calls. Do not call directly.',
    parameters: z.object({
      tool: z.string().optional(),
      error: z.string().optional(),
    }),
    permissionRequired: false,
    impl: ({ tool, error }) => {
      const requested = tool ? ` "${tool}"` : '';
      throw new Error(
        `模型请求了不可用或格式错误的工具${requested}：${error || 'tool call could not be parsed'}`,
      );
    },
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function modelMessageSignature(message: ModelMessage): string {
  return sha256(stableStringifyForSignature(message));
}

/**
 * A projection source signature must survive representation-only active
 * pruning. Preserve every message field except a tool-result payload, whose
 * raw body and archive placeholder are normalized to the same stable lineage
 * identity (tool call + original body hash). Any other source mutation still
 * invalidates the accepted projection.
 */
function projectionSourceMessageSignature(message: ModelMessage): string {
  if (message.role !== 'tool' || !Array.isArray(message.content)) {
    return modelMessageSignature(message);
  }
  const normalizedContent = (message.content as unknown[]).map((part) => {
    const lineage = activeToolResultLineageIdentity(part);
    if (!lineage || !part || typeof part !== 'object') return part;
    const { output: _output, result: _result, ...metadata } = part as Record<string, unknown>;
    return {
      ...metadata,
      makaProjectionToolResultLineage: lineage,
    };
  });
  return modelMessageSignature({ ...message, content: normalizedContent } as ModelMessage);
}

function stableStringifyForSignature(value: unknown): string {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? '';
  if (Array.isArray(value)) return `[${value.map(stableStringifyForSignature).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringifyForSignature(object[key])}`)
    .join(',')}}`;
}

function hasBlockingReplayDiagnostics(plan: RuntimeEventModelReplayPlan): boolean {
  // `unmatched_tool_result` is deliberately NOT blocking: the materializer
  // drops an orphan tool result (its call sliced away or the ledger corrupt)
  // on its own — see pushToolResults — so one orphan must not degrade the
  // whole ledger to stored-message projection.
  return plan.diagnostics.some(
    (diagnostic) =>
      diagnostic.code === 'unsupported_role' ||
      diagnostic.code === 'unsupported_content' ||
      diagnostic.code === 'tool_id_mismatch',
  );
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

function mergeNormalizedUsage(
  current: NormalizedAiSdkUsage | undefined,
  next: NormalizedAiSdkUsage,
): NormalizedAiSdkUsage {
  if (!current) return next;
  const cacheMissInputSource =
    current.cacheMissInputSource === 'explicit' || next.cacheMissInputSource === 'explicit'
      ? 'explicit'
      : 'derived';
  const cacheHitInputTokens = current.cacheHitInputTokens + next.cacheHitInputTokens;
  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    cacheHitInputTokens,
    cacheMissInputTokens: current.cacheMissInputTokens + next.cacheMissInputTokens,
    cacheMissInputSource,
    cacheWriteInputTokens: current.cacheWriteInputTokens + next.cacheWriteInputTokens,
    reasoningTokens: current.reasoningTokens + next.reasoningTokens,
    totalTokens: current.totalTokens + next.totalTokens,
    ...(next.rawFinishReason !== undefined ? { rawFinishReason: next.rawFinishReason } : {}),
    cachedInputTokens: cacheHitInputTokens,
  };
}

function sumOptionalCounts<K extends keyof ActiveToolResultPruneDiagnosticPatch>(
  key: K,
  left: ActiveToolResultPruneDiagnosticPatch,
  right: ActiveToolResultPruneDiagnosticPatch,
): Pick<ActiveToolResultPruneDiagnosticPatch, K> | Record<string, never> {
  const total = (left[key] ?? 0) + (right[key] ?? 0);
  return total > 0 ? ({ [key]: total } as Pick<ActiveToolResultPruneDiagnosticPatch, K>) : {};
}

function hasActiveToolResultPruneDiagnosticPatch(
  patch: ActiveToolResultPruneDiagnosticPatch,
): boolean {
  return (
    (patch.activePrunedToolResults ?? 0) > 0 ||
    (patch.activeArchiveFailures ?? 0) > 0 ||
    (patch.activeEstimatedTokensSaved ?? 0) > 0
  );
}

function contextBudgetWithActivePrepareStepDiagnostics(
  base: ContextBudgetDiagnostic | undefined,
  patch: ActiveToolResultPruneDiagnosticPatch,
  activeFullCompactPatch: Partial<ContextBudgetDiagnostic> | undefined,
): ContextBudgetDiagnostic | undefined {
  const prunePatch = hasActiveToolResultPruneDiagnosticPatch(patch) ? patch : undefined;
  const mergedPatch = mergeContextBudgetDiagnosticPatches(prunePatch, activeFullCompactPatch);
  if (!mergedPatch) return base;
  return mergeContextBudgetDiagnostic(base ?? minimalContextBudgetDiagnostic(), mergedPatch);
}

function buildHistoryCompactCheckpointFailOpenContext(
  checkpoint: HistoryCompactCheckpoint,
  priorRuntimeContext: readonly RuntimeEvent[],
  policy: ContextBudgetPolicy,
  retainedCandidates: readonly RuntimeEvent[],
): RuntimeEvent[] {
  const charsPerToken = policy.charsPerToken ?? 4;
  const compactableEvents = priorRuntimeContext.filter(
    (event) => estimateRuntimeEventsTokens([event], charsPerToken) > 0,
  );
  const match = matchHistoryCompactCheckpointPrefix(checkpoint, compactableEvents);
  if (match.reason) return [...retainedCandidates];
  const coveredIds = new Set(match.coveredRuntimeEvents.map((event) => event.id));
  const candidates = retainedCandidates.filter((event) => !coveredIds.has(event.id));
  const turnOrder: string[] = [];
  const byTurn = new Map<string, RuntimeEvent[]>();
  for (const event of candidates) {
    const group = byTurn.get(event.turnId);
    if (group) group.push(event);
    else {
      turnOrder.push(event.turnId);
      byTurn.set(event.turnId, [event]);
    }
  }
  const maxTokens = policy.maxHistoryEstimatedTokens ?? Number.POSITIVE_INFINITY;
  const replayPrefix = projectHistoryCompactCheckpointReplay(
    checkpoint,
    match.coveredRuntimeEvents,
    [],
  );
  let selectedTokens = estimateRuntimeEventsTokens(replayPrefix, charsPerToken);
  const selectedGroups: RuntimeEvent[][] = [];
  for (let index = turnOrder.length - 1; index >= 0; index -= 1) {
    const group = byTurn.get(turnOrder[index]!) ?? [];
    const groupTokens = estimateRuntimeEventsTokens(group, charsPerToken);
    if (selectedTokens + groupTokens > maxTokens) break;
    selectedGroups.unshift(group);
    selectedTokens += groupTokens;
  }
  const replayTail = selectedGroups.flat();
  const replayEvents = projectHistoryCompactCheckpointReplay(
    checkpoint,
    match.coveredRuntimeEvents,
    replayTail,
  );
  return evaluateHistoryCompactCheckpointReplay(checkpoint, replayEvents.slice(1), policy, {
    sourceReplayEvents: [...match.coveredRuntimeEvents, ...replayTail],
  }).fits
    ? replayEvents
    : [...retainedCandidates];
}

function incrementRecord(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function mergeCountsInto(
  target: Record<string, number>,
  source: Record<string, number> | undefined,
): void {
  for (const [key, value] of Object.entries(source ?? {})) {
    target[key] = (target[key] ?? 0) + value;
  }
}
