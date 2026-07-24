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
 *     ├─ expose each MakaTool through direct ToolRuntime settlement
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
 *     └─ return settled result + model output back to ai-sdk
 */

import type {
  SessionEvent,
  CompleteEvent,
  AbortEvent,
  ErrorEvent,
  TextCompleteEvent,
  ThinkingCompleteEvent,
  TokenUsageEvent,
  TextDeltaEvent,
  ThinkingDeltaEvent,
  StorageRef,
  AttachmentRef,
  QuoteRef,
} from '@maka/core/events';
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
import {
  resolveEffectiveOrchestration,
  type EffectiveOrchestration,
} from '@maka/core/orchestration';
import type { PlanToolResult } from './plan-tools.js';
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
import type { JSONValue, ModelMessage, ModelToolSet, ToolResultOutput } from './model-protocol.js';
import { z } from 'zod';

import { PermissionEngine } from './permission-engine.js';
import {
  AiSdkAutoApprovalReviewer,
  ApprovalCoordinator,
  type AutoApprovalReviewContext,
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
  type ToolRuntimeInput,
  type ToolSettlement,
} from './tool-runtime.js';
import type { RuntimeCommitSink } from './runtime-commit-sink.js';
import type { SubagentExecutionRef } from './subagent-execution.js';
import {
  ModelAdapter,
  type ModelFactory,
  type ModelFactoryInput,
  type NormalizedAiSdkUsage,
  type ModelStreamResult,
  type PrepareStepFunctionLike,
  type PrepareStepLike,
  type PrepareStepResultLike,
  type RepairableAiSdkToolCall,
} from './model-adapter.js';
import type {
  ActiveToolResultArchiveCandidate,
  ActiveToolResultPruneDiagnosticPatch,
} from './active-tool-result-prune.js';
import { toolResultOutput } from './tool-result-output.js';
import {
  buildActiveCompactionHeadAnchor,
  type ActiveFullCompactBlock,
} from './active-full-compact.js';
import type { SemanticCompactBlock } from './semantic-compact.js';
import { compactionDecisionDiagnosticPatch } from './compaction-boundary.js';
import {
  AiSdkCompaction,
  composeActiveCompactionPrepareStep,
  hasActiveToolResultPruneDiagnosticPatch,
  hasBlockingReplayDiagnostics,
} from './ai-sdk-compaction.js';
import type { ToolArtifactRecorder } from './tool-artifacts.js';
import { RunTrace, type RunTraceRecorder } from './run-trace.js';
import {
  toSandboxRunTraceProjection,
  type SandboxDiagnosticCapability,
  type SandboxDiagnosticsSnapshot,
} from './sandbox/diagnostics.js';
import { renderSandboxTurnTailPrompt } from './system-prompt/sandbox-context-prompt.js';
import { computeCost } from './telemetry/cost.js';
import { getBuiltinPricing } from './telemetry/builtin-pricing.js';
import {
  buildRuntimeEventModelReplayPlan,
  buildSteeringEnvelope,
  collectToolActivityTurnIds,
  formatTextWithInlineRefs,
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
import {
  ProviderRequestTracker,
  type ProviderRequestAttemptRecord,
  type ProviderRequestCaptureRecord,
} from './provider-request-telemetry.js';
import { ToolAvailabilityRuntime, type ToolAvailabilityConfig } from './tool-availability.js';
import { renderSwarmModePrompt } from './swarm-mode.js';
import {
  applyRuntimeEventContextBudget,
  buildContextBudgetDiagnosticShell,
  buildHistoryCompactBlockFromSummary,
  buildHistorySearchSource,
  buildPromptSegmentEstimates,
  estimateRuntimeEventsTokens,
  mergeContextBudgetDiagnostic,
  mergeContextBudgetDiagnosticPatches,
  mergeRuntimeEventsInOriginalOrder,
  minimalContextBudgetDiagnostic,
  rawEvidenceRequestReason,
  retrieveArchivedToolResultsForReplay,
  retrieveReplayHistoryAroundSearchSource,
  retrieveRuntimeEventHistoryAround,
  runtimeEventTurnKey,
  shouldAppendContextCompactedNote,
  shouldAppendContextCompactionFailedOpenNote,
  type ContextBudgetPolicy,
  type HistoryCompactBlock,
  type StaleToolResultArchiveCandidate,
  type SynthesisCacheBlock,
  type SynthesisSourceRef,
  type ArchiveRetrievalMode,
  type ToolResultArchiveReader,
} from './context-budget.js';
import {
  evaluateHistoryCompactCheckpointReplay,
  replaceHistoryCompactReplayBlocks,
} from './history-compact.js';
import { selectSynthesisCacheForReplay } from './synthesis-cache.js';
import {
  historyCompactCheckpointToRuntimeEvent,
  matchHistoryCompactCheckpointPrefix,
  projectHistoryCompactCheckpointReplay,
  type HistoryCompactCheckpoint,
} from './history-compact-checkpoint.js';
import { resolveSelectedModelContextWindow } from './context-budget-policy.js';
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

function joinPromptFragments(fragments: readonly (string | undefined)[]): string | undefined {
  const joined = fragments
    .map((fragment) => fragment?.trim())
    .filter((fragment): fragment is string => Boolean(fragment))
    .join('\n\n');
  return joined.length > 0 ? joined : undefined;
}

function autoApprovalSandboxContext(
  snapshot: SandboxDiagnosticsSnapshot,
): NonNullable<AutoApprovalReviewContext['sandbox']> {
  const { command, filesystem } = snapshot.capabilities;
  return {
    platform: snapshot.platform,
    profileName: snapshot.profile.name,
    fileSystem: snapshot.profile.fileSystem,
    network: snapshot.profile.network,
    commandSandbox: formatSandboxCapability(command),
    filesystemSandbox: formatSandboxCapability(filesystem),
    ...(command.selectionReason ? { commandSandboxSelectionReason: command.selectionReason } : {}),
    ...(filesystem.selectionReason
      ? { filesystemSandboxSelectionReason: filesystem.selectionReason }
      : {}),
    ...(command.failure ? { commandSandboxFailureReason: command.failure.reason } : {}),
    ...(filesystem.failure ? { filesystemSandboxFailureReason: filesystem.failure.reason } : {}),
  };
}

function formatSandboxCapability(capability: SandboxDiagnosticCapability): string {
  return capability.backend === 'none'
    ? capability.status
    : `${capability.status} (${capability.backend})`;
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
  /** Active profile and enforcement capability snapshot for this session backend. */
  sandboxDiagnosticsSnapshot?: SandboxDiagnosticsSnapshot;
  /** Diagnostic-only Plan Mode/execution identity snapshot. */
  planTraceContext?: {
    mode: 'agent' | 'plan';
    storeVersion: number;
    planId?: string;
    proposalId?: string;
    executionId?: string;
  };
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
  /** Optional Phase 2 SQLite T1/T2 boundary for real tool execution. */
  runtimeCommitSink?: RuntimeCommitSink;
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
  spawnChildSession?: ToolRuntimeInput['spawnChildSession'];
  prepareChildAgentResume?: ToolRuntimeInput['prepareChildAgentResume'];
  resumeChildAgent?: ToolRuntimeInput['resumeChildAgent'];
  retryChildAgent?: (input: {
    parentRunId: string;
    sourceRunId: string;
    execution?: SubagentExecutionRef;
    abortSignal: AbortSignal;
    onReady?: (input: {
      childSessionId?: string;
      turnId: string;
      runId?: string;
      agentId: string;
      agentName: string;
    }) => void | Promise<void>;
    onEvent?: (event: SessionEvent) => void;
  }) => Promise<unknown>;
  listChildAgents?: () => Promise<unknown>;
  readChildAgentOutput?: ToolRuntimeInput['readChildAgentOutput'];
  /** Optional diagnostic trace hook for explaining a runtime turn without changing renderer events. */
  recordRunTrace?: RunTraceRecorder;
  /**
   * Durable prepared-request capture boundary. When configured, rejection
   * prevents the corresponding provider request from being dispatched.
   */
  recordProviderRequestCapture?: (
    capture: ProviderRequestCaptureRecord,
  ) => Promise<{ artifactId: string }>;
  /** Best-effort durable row for one physical provider request attempt. */
  recordProviderRequestAttempt?: (attempt: ProviderRequestAttemptRecord) => void | Promise<void>;
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
  /** Diagnostic-only skill catalog trace; never affects prompt construction. */
  emitSkillCatalogTrace?: (message: string, data?: Record<string, unknown>) => void;
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

function toolResultText(text: string): ToolResultOutput {
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
  private currentTurnId: string | null = null;
  private stopAfterStepRequested = false;
  private handoffStopReason: CompleteEvent['stopReason'] | undefined;
  private currentInvocationId: string | null = null;
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
  private currentOrchestration: EffectiveOrchestration | undefined;
  private imageRequestBudget: { used: number; decisions: Map<string, boolean> } | null = null;
  /** Side-channel for tool.execute() callbacks to push events into the iterator. */
  private currentQueue: AsyncEventQueue<SessionEvent> | null = null;
  /** Paused while the backend is waiting on a user permission decision. */
  private currentWatchdog: StreamWatchdog | null = null;
  private currentRunTrace: RunTrace | null = null;
  private currentUserIntent: string | undefined;
  private priorRequestShape: RequestShapeDiagnostic | undefined;
  private readonly compaction: AiSdkCompaction;
  private cumulativeUsageCheckpoint: NormalizedAiSdkUsage | undefined;
  /**
   * Id of the assistant step currently streaming. Passed explicitly into each
   * resolved settlement call so its `tool_start` carries the owning step.
   * Rotated at every step boundary in `send()`; null between turns.
   */
  private currentStepMessageId: string | null = null;

  constructor(input: AiSdkBackendInput) {
    this.input = input;
    this.sessionId = input.sessionId;
    this.newId = input.newId ?? (() => crypto.randomUUID());
    this.now = input.now ?? (() => Date.now());
    this.maxSteps = input.maxSteps;
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
    this.compaction = new AiSdkCompaction({
      input,
      sessionId: this.sessionId,
      now: this.now,
      modelAdapter: this.modelAdapter,
      computeCostUsd: (usage) => this.computeTokenUsageCostUsd(usage),
      materializeRuntimeReplayPlan: (plan) => this.materializeRuntimeReplayPlan(plan),
      canReplayProviderNative: (plan) => this.canReplayProviderNative(plan),
      appendTurnTailPrompt: (content, turnTailPrompt) =>
        this.appendTurnTailPrompt(content, turnTailPrompt),
    });
    this.toolAvailabilityRuntime = new ToolAvailabilityRuntime(
      input.tools,
      input.toolAvailability,
      buildInvalidMakaTool(),
    );
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
      getCurrentInvocationId: () => this.currentInvocationId ?? undefined,
      getCurrentRunId: () => this.currentRunId ?? undefined,
      agentTeam: input.agentTeam,
      materializeDefaultToolResultOutput: ({ toolCallId, output }) =>
        this.materializeToolResultOutput(output, false, toolCallId),
      getCurrentOrchestration: () => this.currentOrchestration,
      permissionRules: input.permissionRules,
      spawnChildAgent: input.spawnChildAgent,
      spawnChildSession: input.spawnChildSession,
      prepareChildAgentResume: input.prepareChildAgentResume,
      resumeChildAgent: input.resumeChildAgent,
      retryChildAgent: input.retryChildAgent,
      listChildAgents: input.listChildAgents,
      readChildAgentOutput: input.readChildAgentOutput,
      getRunTrace: () => this.currentRunTrace,
      permissionTimeoutMs: input.permissionTimeoutMs,
      recordToolInvocation: input.recordToolInvocation,
      runtimeCommitSink: input.runtimeCommitSink,
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
        ...(input.sandboxDiagnosticsSnapshot
          ? { sandbox: autoApprovalSandboxContext(input.sandboxDiagnosticsSnapshot) }
          : {}),
      }),
    });
  }

  // --------------------------------------------------------------------------
  // manual history compaction
  // --------------------------------------------------------------------------

  async compactHistory(input: BackendCompactHistoryInput): Promise<BackendCompactHistoryResult> {
    return this.compaction.compactHistory(input, this.priorRequestShape?.requestShapeHash);
  }

  // --------------------------------------------------------------------------
  // send()
  // --------------------------------------------------------------------------

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.aborted = false;
    const turnId = input.turnId;
    this.currentTurnId = turnId;
    this.currentInvocationId = input.invocationId ?? input.runId ?? null;
    this.currentRunId = input.runId ?? null;
    this.currentOrchestration =
      input.orchestration ??
      resolveEffectiveOrchestration(this.input.header.orchestrationMode, undefined);
    this.currentUserIntent = input.text;
    this.input.permissionEngine.beginTurn(turnId);
    this.toolRuntime.beginTurn(turnId);
    this.abortController = new AbortController();
    this.imageRequestBudget = { used: 0, decisions: new Map() };

    const midTurnState = this.compaction.buildMidTurnCapacityCompactState(input);
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
    trace.turnStarted({
      orchestrationMode: this.currentOrchestration.mode,
      orchestrationSource: this.currentOrchestration.source,
      agentSwarmAuthorization: this.currentOrchestration.agentSwarmAuthorization,
    });
    if (this.input.planTraceContext) {
      trace.emit('plan', 'plan_context_resolved', 'Plan context resolved', {
        ...this.input.planTraceContext,
      });
      if (this.input.planTraceContext.executionId) {
        trace.emit('plan', 'plan_execution_started', 'Plan execution turn started', {
          ...this.input.planTraceContext,
        });
      }
    }
    if (this.input.sandboxDiagnosticsSnapshot) {
      trace.sandboxContextResolved(
        toSandboxRunTraceProjection(this.input.sandboxDiagnosticsSnapshot),
      );
    }
    const recordProviderRequestCapture = this.input.recordProviderRequestCapture;
    const providerRequestTraceId = recordProviderRequestCapture ? this.newId() : undefined;
    const providerRequestTracker = providerRequestTraceId
      ? new ProviderRequestTracker({
          traceId: providerRequestTraceId,
          turnId,
          now: this.now,
          newId: this.newId,
          persistCapture: recordProviderRequestCapture!,
          recordAttempt: this.input.recordProviderRequestAttempt ?? (() => {}),
        })
      : undefined;

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
      this.currentOrchestration.mode === 'swarm' ? new Set(['agent_swarm']) : new Set(),
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

    const modelTools: ModelToolSet = {};
    for (const t of providerTools) {
      modelTools[t.name] = {
        description: t.description,
        inputSchema: t.parameters,
        execute: async (
          args: unknown,
          context: { toolCallId: string; abortSignal: AbortSignal },
        ) => {
          const settlement = await this.toolRuntime.settleToolCall({
            tool: t,
            turnId,
            stepId: this.currentStepMessageId ?? undefined,
            toolCallId: context.toolCallId,
            input: args,
            abortSignal: context.abortSignal,
            eventSink: queue,
          });
          if (isPlanToolResult(settlement.result)) {
            this.handlePlanToolResult(settlement.result, turnId, queue);
          }
          return settlement;
        },
        toModelOutput: ({ output }: { output: unknown }) => (output as ToolSettlement).modelOutput,
      };
    }

    // --- Build messages from RuntimeEvent history and its compatibility projection. ---
    const priorReplay = await this.buildPriorMessages(input);
    if (input.continuation && priorReplay.messages.length === 0) {
      const replay = priorReplayFailureTrace(priorReplay);
      const error = new ContinuationReplayEmptyError(replay.gate, replay.diagnosticCodes);
      trace.modelStreamFailed(error.code, error, replay);
      queue.push(this.makeErrorEvent(turnId, error));
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
            trace.modelStreamFailed(
              'Timeout',
              watchdogTimeoutError,
              priorReplayFailureTrace(priorReplay),
            );
            this.abortController?.abort(watchdogTimeoutError);
          },
        });
        this.currentWatchdog = watchdog;
        watchdog.start();
        const activeTools = plan.activeTools;
        const systemPrompt = joinPromptFragments([
          await this.resolveSystemPrompt(),
          this.currentOrchestration?.mode === 'swarm' ? renderSwarmModePrompt() : undefined,
        ]);
        const turnTailPrompt = input.continuation
          ? undefined
          : joinPromptFragments([
              await this.resolveTurnTailPrompt(),
              await this.resolveShellRunContextSummary(),
              this.input.sandboxDiagnosticsSnapshot
                ? renderSandboxTurnTailPrompt(this.input.sandboxDiagnosticsSnapshot)
                : undefined,
            ]);
        const currentUserContent = input.continuation
          ? undefined
          : await this.buildCurrentUserContent(input.text, input.attachments, input.quotes);
        const messages =
          currentUserContent === undefined
            ? [...priorReplay.messages]
            : [
                ...priorReplay.messages,
                {
                  role: 'user' as const,
                  content: this.appendTurnTailPrompt(currentUserContent, turnTailPrompt),
                } as ModelMessage,
              ];
        const activeCompactionHeadAnchor =
          messages[messages.length - 1]?.role === 'user'
            ? buildActiveCompactionHeadAnchor(
                messages,
                messages.length - 1,
                this.input.contextBudget?.charsPerToken,
              )
            : undefined;
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
              currentUserContent: input.continuation
                ? ''
                : formatTextWithInlineRefs(input.text, {
                    ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
                    ...(input.quotes !== undefined ? { quotes: input.quotes } : {}),
                  }),
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
          this.compaction.buildSemanticCompactPrepareStep(
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
            this.abortController?.signal,
          ),
          this.compaction.buildActiveFullCompactPrepareStep(
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
        const midTurnCapacityHook = this.compaction.buildMidTurnCapacityCompactPrepareStep(
          turnId,
          midTurnState,
          queue,
          providerTools,
          () => currentRepairToolNames(),
          turnTailPrompt,
          midTurnSystemPromptChars,
          onMidTurnDiagnosticPatch,
          this.abortController?.signal,
        );
        // When mid-turn capacity compaction is active, the prune must also cover
        // the newest completed step; see collectPrunablePrepareStepToolCallIds.
        const activeToolResultPruneIncludesNewestStep = midTurnState !== undefined;
        const activeToolResultPruneHook = this.compaction.buildActiveToolResultPrunePrepareStep(
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
            ? this.compaction.buildMidTurnFinalRequestVerdict({
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
                abortController: this.abortController,
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
          providerRequestTracker?.setStep(attemptStepBase + options.stepNumber);
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
        let result: ModelStreamResult;
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
            tools: modelTools,
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
            ...(providerRequestTracker ? { providerRequestTracker } : {}),
            ...(remainingStepBudget !== undefined ? { maxSteps: remainingStepBudget } : {}),
          });

          let streamFailure: unknown;
          let sawStreamError = false;
          try {
            for await (const event of result.events) {
              if (this.aborted) break;
              watchdog.markActivity();
              if (event.kind === 'error') {
                // A request-level error ends this stream; capture it and stop
                // consuming (the synthesized trailer carries no real step) so
                // the recovery decision runs on the outcome, not the trailer.
                streamFailure = event.failure;
                sawStreamError = true;
                break;
              }
              if (event.kind === 'step-finish') {
                // Step boundary: AI SDK 7 delimits steps with `finish-step`
                // (and `step-finish` for legacy replay fixtures); the adapter
                // reduces both to this event. A duplicate boundary is harmless:
                // the second flush no-ops (accumulators already cleared) and one
                // extra id rotation just discards an unused id.
                runtimeSteps += 1;
                const stepUsage = event.usage;
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
              if (event.kind === 'finish' || event.kind === 'step-finish') {
                rawFinishReason = event.finishReason ?? rawFinishReason;
              }
              if (event.kind === 'text') {
                stepText += event.text;
                queue.push({
                  type: 'text_delta',
                  id: this.newId(),
                  turnId,
                  ts: this.now(),
                  messageId: this.currentStepMessageId!,
                  text: event.text,
                } satisfies TextDeltaEvent);
              } else if (event.kind === 'thinking') {
                stepThinking += event.text;
                queue.push({
                  type: 'thinking_delta',
                  id: this.newId(),
                  turnId,
                  ts: this.now(),
                  messageId: this.currentStepMessageId!,
                  text: event.text,
                } satisfies ThinkingDeltaEvent);
              } else if (event.kind === 'thinking-signature') {
                stepSignature = event.signature;
              } else if (event.kind === 'step-finish') {
                // The step's text/thinking deltas are all in (the stream is
                // drained in order), so flush this step's AssistantMessage and
                // rotate to a fresh id for the next step. The step's tool calls
                // (appended mid-step via execute()) already carry the pre-rotation
                // id from the resolved settlement call, so replay can regroup
                // them with this step's reasoning even though they land before
                // this row.
                await flushStep();
                this.currentStepMessageId = this.newId();
                if (midTurnState) {
                  // Durability clock: step N's thinking/text completion events
                  // are enqueued by flushStep just above, so only after this
                  // boundary can a seq-ack wait for step N mean anything. Wake
                  // waiters AFTER the increment or they would re-check a stale
                  // count and sleep.
                  midTurnState.flushedSteps += 1;
                  queue.wake();
                }
              }
            }
          } catch (error) {
            streamFailure = error;
            sawStreamError = true;
          }

          if (sawStreamError && !this.aborted) {
            if (this.stopAfterStepRequested) throw streamFailure;
            // A retry is a fresh provider request that would run at least one
            // more step; with the send-level budget already spent there is
            // nothing left to grant it, so the error is terminal.
            const stepBudgetRemains = this.maxSteps === undefined || runtimeSteps < this.maxSteps;
            const recovered = stepBudgetRemains
              ? await this.compaction.recoverFromOverflowError({
                  error: streamFailure,
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
                  abortSignal: this.abortController?.signal,
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
            const errorClass = this.modelAdapter.classifyError(streamFailure);
            if (
              errorClass === 'Network' &&
              !transportRetryUsed &&
              stepBudgetRemains &&
              !this.toolRuntime.hasStepAdmission(this.currentStepMessageId) &&
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
            throw streamFailure;
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
        const finishReason = (await result.finishReason.catch(() => 'stop')) ?? 'stop';
        const stepLimit = this.maxSteps;
        const stepLimitReached = stepLimit !== undefined && finishReason === 'tool-calls';
        rawFinishReason = rawFinishReason ?? finishReason;
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
          const attemptTotalUsage = await result.usage;
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
              ...(providerRequestTraceId ? { providerRequestTraceId } : {}),
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
              ...(providerRequestTraceId ? { providerRequestTraceId } : {}),
            } satisfies TokenUsageEvent);
          }
        } catch {
          // best-effort; ai-sdk usage promise may reject on abort
        }

        // Nothing may await between this check and terminal emission: Stop must
        // win even when it arrives during post-stream usage persistence.
        if (this.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        const stopReason =
          this.handoffStopReason ??
          (this.maxSteps !== undefined && finishReason === 'tool-calls'
            ? 'step_limit'
            : this.mapFinishReason(finishReason));
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
            trace.modelStreamFailed(streamErrorClass, err, priorReplayFailureTrace(priorReplay));
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

  private handlePlanToolResult(
    result: PlanToolResult,
    turnId: string,
    queue: AsyncEventQueue<SessionEvent>,
  ): void {
    if (result.kind === 'plan_submitted') {
      const proposal = result.proposal;
      queue.push({
        type: 'plan_submitted',
        id: this.newId(),
        turnId,
        ts: this.now(),
        planId: proposal.planId,
        proposalId: proposal.proposalId,
        revision: proposal.revision,
        title: proposal.title,
        ...(proposal.overview ? { overview: proposal.overview } : {}),
        ...(proposal.risks ? { risks: proposal.risks } : {}),
        steps: proposal.steps.map((step) => ({ ...step, status: 'pending' })),
      });
      this.currentRunTrace?.emit('plan', 'plan_submitted', 'Plan submitted', {
        planId: proposal.planId,
        proposalId: proposal.proposalId,
        revision: proposal.revision,
        storeVersion: result.storeVersion,
      });
      this.handoffStopReason = 'plan_handoff';
      this.stopAfterStepRequested = true;
      return;
    }

    const traceType = result.kind;
    this.currentRunTrace?.emit('plan', traceType, 'Plan execution state changed', {
      planId: result.execution.planId,
      proposalId: result.execution.proposalId,
      executionId: result.execution.executionId,
      storeVersion: result.storeVersion,
    });
    if (result.kind === 'plan_execution_completed' || result.kind === 'plan_execution_cancelled') {
      this.stopAfterStepRequested = true;
    }
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
    this.compaction.abortHistoryCompact();
    if (this.currentTurnId !== null) {
      this.input.permissionEngine.endTurn(this.currentTurnId, 'aborted');
      this.toolRuntime.endTurn(this.currentTurnId, 'aborted');
    }
    this.currentRunTrace?.abortRequested(_reason);
  }

  async respondToPermission(decision: PermissionDecision): Promise<void> {
    if (this.currentTurnId === null) return;
    this.input.permissionEngine.recordResponse(this.currentTurnId, decision);
    // PermissionDecisionMessage + ack event are written inside ToolRuntime settlement
    // after parked.resolve() returns, so no further work here.
  }

  async respondToUserQuestion(response: UserQuestionResponse): Promise<void> {
    if (this.currentTurnId === null) return;
    this.toolRuntime.respondToUserQuestion(this.currentTurnId, response);
  }

  async dispose(): Promise<void> {
    if (!this.aborted) await this.stop('user_stop');
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
    const preparedContextBudget =
      await this.compaction.prepareContextBudgetPolicy(priorRuntimeContext);
    const contextBudget = preparedContextBudget.policy;
    const budgeted = applyRuntimeEventContextBudget(priorRuntimeContext, contextBudget, {
      historyCompactProtocol:
        contextBudget?.historyCompact?.checkpoint ||
        this.compaction.hasHistoryCompactCheckpointWriter()
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
      this.compaction.hasHistoryCompactWriter()
    ) {
      const loadedBlockIds = new Set(
        (contextBudget.historyCompact.blocks ?? []).map((block) => block.blockId),
      );
      const draftBlocks = budgeted.historyCompactBlocks.filter(
        (block) => !loadedBlockIds.has(block.blockId),
      );
      if (draftBlocks.length > 0) {
        if (this.input.summarizeHistoryCompact && this.input.recordHistoryCompactCheckpoint) {
          const writePatch = await this.compaction.writeHistoryCompactCheckpoint({
            turnId: input.turnId,
            contextBudget,
            priorRuntimeContext,
            draftBlock: draftBlocks[0]!,
            abortSignal: this.abortController?.signal,
            requestShapeHashBefore: this.priorRequestShape?.requestShapeHash,
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
          const writePatch = await this.compaction.writeHistoryCompactBlocks({
            turnId: input.turnId,
            contextBudget,
            priorRuntimeContext,
            draftBlocks,
            abortSignal: this.abortController?.signal,
            requestShapeHashBefore: this.priorRequestShape?.requestShapeHash,
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
          const writePatch = await this.compaction.writeSynthesisCacheBlocks({
            turnId: input.turnId,
            query: input.text,
            hydratedRuntimeEvents: runtimeContext,
            retrievedArchiveRefs: retrieval.retrievedSourceRefs ?? [],
            archiveRetrievalMode: contextBudget.archiveRetrieval?.mode ?? 'eager',
            contextBudget,
            requestShapeHashBefore: this.priorRequestShape?.requestShapeHash,
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
        messages: input.continuation
          ? await this.materializeRuntimeReplayTextOnly(plan)
          : projectedMessages,
        gate: input.continuation ? 'runtime_replay_text_only' : 'stored_message_projection',
        diagnostics: plan.diagnostics,
        runtimeEventCount: runtimeContext.length,
        ...(contextBudgetDiagnostic ? { contextBudget: contextBudgetDiagnostic } : {}),
        ...(latestHistoryCompactCheckpoint ? { latestHistoryCompactCheckpoint } : {}),
      };
    }

    if (hasBlockingReplayDiagnostics(plan)) {
      return {
        messages: input.continuation
          ? await this.materializeRuntimeReplayTextOnly(plan)
          : projectedMessages,
        gate: input.continuation
          ? 'runtime_replay_text_only'
          : 'runtime_replay_unsupported_semantics',
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
        messages: input.continuation
          ? await this.materializeRuntimeReplayTextOnly(plan)
          : projectedMessages,
        gate: input.continuation
          ? 'runtime_replay_text_only'
          : 'runtime_replay_unsupported_semantics',
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

  private async materializeRuntimeReplayTextOnly(
    plan: RuntimeEventModelReplayPlan,
  ): Promise<ModelMessage[]> {
    const messages: ModelMessage[] = [];
    for (const item of plan.items) {
      if (item.kind === 'text') messages.push(await this.materializeRuntimeReplayItem(item));
    }
    return messages;
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
          out.push(steeringModelMessage(sidecar.eventId, formatTextWithInlineRefs(m.text, m)));
          continue;
        }
        out.push({
          role: 'user',
          content: await this.appendImageParts(formatTextWithInlineRefs(m.text, m), m.attachments),
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
  ): Promise<ToolResultOutput> {
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
    quotes?: QuoteRef[],
  ): Promise<ModelMessage['content']> {
    return this.appendImageParts(
      formatTextWithInlineRefs(text, {
        ...(attachments !== undefined ? { attachments } : {}),
        ...(quotes !== undefined ? { quotes } : {}),
      }),
      attachments,
    );
  }

  private async resolveSystemPrompt(): Promise<string | undefined> {
    if (typeof this.input.systemPrompt === 'function') {
      return await this.input.systemPrompt({
        sessionId: this.sessionId,
        cwd: this.input.header.cwd,
        workspaceRoot: this.input.header.workspaceRoot,
        emitSkillCatalogTrace: (message, data) =>
          this.currentRunTrace?.emit('skill', 'skill_catalog_built', message, data),
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
    this.currentInvocationId = null;
    this.currentRunId = null;
    this.currentOrchestration = undefined;
    this.currentRunTrace = null;
    this.currentUserIntent = undefined;
    this.currentStepMessageId = null;
    this.stopAfterStepRequested = false;
    this.handoffStopReason = undefined;
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

function isPlanToolResult(output: unknown): output is PlanToolResult {
  if (!output || typeof output !== 'object') return false;
  return [
    'plan_submitted',
    'plan_progress_updated',
    'plan_execution_completed',
    'plan_execution_cancelled',
  ].includes(String((output as { kind?: unknown }).kind));
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

function priorReplayFailureTrace(replay: {
  gate: string;
  diagnostics: readonly { code: string }[];
}): { gate: string; diagnosticCodes: string[] } {
  return {
    gate: replay.gate,
    diagnosticCodes: [...new Set(replay.diagnostics.map((diagnostic) => diagnostic.code))],
  };
}

class ContinuationReplayEmptyError extends Error {
  readonly code = 'continuation_replay_empty';

  constructor(
    readonly replayGate: string,
    readonly diagnosticCodes: readonly string[],
  ) {
    super(`Continuation replay is empty after ${replayGate}`);
    this.name = 'ContinuationReplayEmptyError';
  }
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
  return evaluateHistoryCompactCheckpointReplay(
    checkpoint,
    replayEvents.slice(1),
    policy?.charsPerToken,
    policy?.maxHistoryEstimatedTokens,
    {
      sourceReplayEvents: [...match.coveredRuntimeEvents, ...replayTail],
    },
  ).fits
    ? replayEvents
    : [...retainedCandidates];
}
