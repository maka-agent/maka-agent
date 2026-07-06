import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { ModelMessage } from 'ai';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type {
  ContextBudgetDiagnostic,
  PromptSegmentEstimate,
} from '@maka/core/usage-stats/types';
import {
  compactionDecisionDiagnosticPatch,
  historyCompactBlockToCompactionBoundary,
} from './compaction-boundary.js';
import type { ActiveFullCompactPolicy } from './active-full-compact.js';
import type { SemanticCompactPolicy } from './semantic-compact.js';
import type { CompactionDecisionKind } from './compaction-boundary.js';

export interface ContextBudgetPolicy {
  name?: string;
  /**
   * Approximate max model-visible prior-history tokens. This is an estimate
   * used for shaping, not provider billing.
   */
  maxHistoryEstimatedTokens?: number;
  /** Hard cap on prior turns retained for model replay. */
  maxHistoryTurns?: number;
  /** Keep at least this many recent turns even if the token estimate exceeds the cap. */
  minRecentTurns?: number;
  /** Estimate conversion. Defaults to 4 chars/token, intentionally conservative for mixed text. */
  charsPerToken?: number;
  /** Optional replay-only pruning for stale oversized tool results before whole-turn compaction. */
  staleToolResultPrune?: StaleToolResultPrunePolicy;
  /**
   * Optional current-turn, provider-visible tool-result pruning before the next
   * AI SDK step. Defaults off and does not mutate persisted session messages.
   */
  activeToolResultPrune?: ActiveToolResultPrunePolicy;
  /**
   * Optional active-loop full compact replacement. When enabled, prepareStep can
   * replace a validated older provider-message span with a source-bearing block.
   */
  activeFullCompact?: ActiveFullCompactPolicy;
  /**
   * Optional current-turn LLM semantic compact replacement. Runs after active
   * tool-result pruning and before the next provider step.
   */
  semanticCompact?: SemanticCompactPolicy;
  /** Optional replay-only archive hydration after pruning. Defaults off. */
  archiveRetrieval?: ArchiveRetrievalPolicy;
  /** Optional deterministic prior-history search used to re-add bounded around-context. Defaults off. */
  historySearch?: RuntimeEventHistorySearchPolicy;
  /** Optional replay-only source-bearing synthesis cache over older RuntimeEvent history. Defaults off. */
  synthesisCache?: SynthesisCachePolicy;
  /** Optional replay-only high-water compaction of older RuntimeEvent history into a source-bearing block. */
  historyCompact?: HistoryCompactPolicy;
  /** Named rewrite/compaction gate for diagnostics and explicit cache-shape resets. */
  historyRewrite?: HistoryRewriteGatePolicy;
}

export interface StaleToolResultPrunePolicy {
  enabled: boolean;
  /** Tool result payloads above this estimate are replaced with archive placeholders. Defaults to 2048. */
  maxResultEstimatedTokens?: number;
  /** Keep this many newest turns' tool results full. Defaults to ContextBudgetPolicy.minRecentTurns, then 1. */
  minRecentTurnsFull?: number;
  /**
   * Archive refs keyed by RuntimeEvent id. Rewrites only happen when a
   * matching ref exists, so archive-write failure keeps original content.
   */
  archiveRefs?: readonly ToolResultArchiveRef[] | Readonly<Record<string, ToolResultArchiveRef>>;
}

export interface ActiveToolResultPrunePolicy {
  enabled: boolean;
  /** Tool result payloads above this estimate are archived and replaced. Defaults to 2048. */
  maxCurrentResultEstimatedTokens?: number;
  /** Do not rewrite before this SDK step. Defaults to 1, so step 0 is untouched. */
  minStepNumber?: number;
}

export interface ArchiveRetrievalPolicy {
  enabled: boolean;
  /**
   * Defaults to `eager` for Phase 6 compatibility. `history_search_gated`
   * only hydrates placeholders whose turn was selected by history search.
   */
  mode?: ArchiveRetrievalMode;
  maxResults?: number;
  maxEstimatedTokens?: number;
  maxBytes?: number;
  order?: 'newest_first';
}

export type ArchiveRetrievalMode = 'eager' | 'history_search_gated';

export interface RuntimeEventHistorySearchPolicy {
  enabled: boolean;
  query?: string;
  maxResults?: number;
  around?: number;
  maxEstimatedTokens?: number;
}

export interface SynthesisCachePolicy {
  enabled: boolean;
  /** Source-bearing blocks available for the current replay projection. */
  blocks?: readonly SynthesisCacheBlock[];
  /** Defaults to `lookup`; `read_write` enables host-owned lifecycle callbacks. */
  mode?: 'lookup' | 'read_write';
  /** Defaults to 1 to keep replay bounded and deterministic. */
  maxBlocks?: number;
  /** Defaults to 2048 to keep replay bounded and deterministic. */
  maxEstimatedTokens?: number;
  /** Defaults to 1024 to reject any single over-large synthesis block. */
  maxBlockEstimatedTokens?: number;
  /**
   * When true (default), a newer matching tool result invalidates older synthesis
   * for the same tool/query key.
   */
  invalidateOnNewToolResult?: boolean;
  /** Current schema version accepted by the loader/selector. */
  schemaVersion?: 1;
}

export interface SynthesisCacheBlock {
  kind: 'maka.synthesis_cache_block';
  version: 1;
  blockId: string;
  sessionId: string;
  createdAt: number;
  highWaterName: string;
  highWaterSeq: number;
  sourceRef?: {
    sourceRef?: string;
    repoRoot?: string;
    gitCommit?: string;
    harnessRunId?: string;
  };
  coverage: SynthesisCacheCoverage;
  summary: string;
  limitations: string[];
  sourceRefs: readonly SynthesisSourceRef[];
  estimatedTokens?: number;
  requestShape?: {
    before?: string;
    after?: string;
  };
  invalidation?: {
    schemaVersion: 1;
    sourceBodyHashes: string[];
    invalidateOnNewToolResult: boolean;
  };
  createdFrom:
    | 'gated_archive_retrieval'
    | 'eager_archive_retrieval'
    | 'full_context'
    | 'live_tool_result'
    | 'host_deterministic';
  requestShapeHashBefore?: string;
  requestShapeHashAfter?: string;
}

export interface SynthesisCacheCoverage {
  queryKeys: string[];
  turnIds: string[];
  runtimeEventIds: string[];
  toolNames: string[];
  toolCallIds: string[];
  artifactIds: string[];
  bodySha256: string[];
}

export type SynthesisSourceRef =
  | {
      kind: 'archived_tool_result';
      sessionId: string;
      turnId: string;
      runtimeEventId: string;
      toolCallId: string;
      toolName: string;
      artifactId: string;
      bodySha256: string;
      originalEstimatedTokens: number;
      originalBytes: number;
      placeholderReason: ArchivedToolResultReason;
    }
  | {
      kind: 'runtime_event';
      sessionId: string;
      turnId: string;
      runtimeEventId: string;
      role: 'user' | 'model' | 'tool' | 'system';
      contentKind: string;
    }
  | {
      kind: 'history_search_hit';
      sessionId: string;
      turnId: string;
      runtimeEventId: string;
      score: number;
      matchedTerms: string[];
    }
  | {
      kind: 'live_tool_result';
      sessionId: string;
      turnId: string;
      runtimeEventId: string;
      toolCallId: string;
      toolName: string;
      argsSha256: string;
      resultSha256: string;
      artifactId?: string;
    };

export interface SynthesisCacheReplayResult {
  events: RuntimeEvent[];
  selectedBlocks: SynthesisCacheBlock[];
  diagnosticPatch: Partial<ContextBudgetDiagnostic>;
}

export interface HistoryCompactPolicy {
  enabled: boolean;
  /** `lookup` only replays supplied blocks; `read_write` may persist a host replacement for a deterministic draft. */
  mode?: 'deterministic' | 'lookup' | 'read_write';
  /** Source-bearing compact blocks available for the current replay projection. */
  blocks?: readonly HistoryCompactBlock[];
  /** Defaults to 1 to keep replay bounded and deterministic. */
  maxBlocks?: number;
  /** Defaults to 2048 to keep replay bounded and deterministic. */
  maxEstimatedTokens?: number;
  /** Defaults to maxSummaryEstimatedTokens, then 1024, to reject a single over-large compact block. */
  maxBlockEstimatedTokens?: number;
  /** Compact once prior history exceeds this ratio of maxHistoryEstimatedTokens. Defaults to 0.8. */
  highWaterRatio?: number;
  /** Diagnostic high-water ratio reserved for future forced compaction. Defaults to 0.9. */
  forceRatio?: number;
  /** Try to keep the retained tail under this ratio of maxHistoryEstimatedTokens. Defaults to 0.5. */
  targetRatio?: number;
  /** Explicit retained-tail token budget. Overrides targetRatio when provided. */
  tailEstimatedTokens?: number;
  /** Keep at least this many newest turns after compaction. Defaults to ContextBudgetPolicy.minRecentTurns, then 1. */
  minRecentTurns?: number;
  /** Maximum deterministic summary estimate. Defaults to 768. */
  maxSummaryEstimatedTokens?: number;
  /** Current block schema version. Defaults to 1. */
  summarySchemaVersion?: 1;
  /**
   * If true, every compacted RuntimeEvent must have a matching sourceArchiveRef.
   * The default false mode remains source-bearing through RuntimeEvent refs only.
   */
  archiveRequired?: boolean;
  /** Optional archive refs keyed by RuntimeEvent id for archive-before-project validation. */
  sourceArchiveRefs?: readonly HistoryCompactSourceArchiveRef[] | Readonly<Record<string, HistoryCompactSourceArchiveRef>>;
  highWaterName?: string;
}

export interface HistoryCompactSourceArchiveRef {
  runtimeEventId: string;
  artifactId: string;
  bodySha256: string;
  originalEstimatedTokens: number;
  originalBytes: number;
}

export interface HistoryCompactBlock {
  kind: 'maka.history_compact_block';
  version: 1;
  blockId: string;
  sessionId: string;
  createdAt: number;
  highWaterName: string;
  highWaterSeq: number;
  coverage: HistoryCompactCoverage;
  summary: string;
  limitations: string[];
  sourceRefs: readonly SynthesisSourceRef[];
  sourceArchiveRefs?: readonly HistoryCompactSourceArchiveRef[];
  estimatedTokens?: number;
  requestShapeHashBefore?: string;
  requestShapeHashAfter?: string;
}

export interface HistoryCompactCoverage {
  turnIds: string[];
  runtimeEventIds: string[];
  contentKinds: string[];
  bodySha256: string[];
}

export interface HistoryCompactReplayResult {
  events: RuntimeEvent[];
  blocks: HistoryCompactBlock[];
  diagnosticPatch: Partial<ContextBudgetDiagnostic>;
}

export interface HistoryRewriteGatePolicy {
  enabled: boolean;
  name?: string;
  historyRewriteVersion: string;
  resetReason: string;
}

export const ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND = 'maka.archived_tool_result';
export const ACTIVE_ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND = 'maka.active_archived_tool_result';
export const ARCHIVED_TOOL_RESULT_REWRITE_VERSION = 1;
const DEFAULT_MAX_TOOL_RESULT_ESTIMATED_TOKENS = 2048;
export type ArchivedToolResultReason = 'stale_tool_result_pruned_before_compact';
export type ActiveArchivedToolResultReason = 'active_current_turn_tool_result_pruned_before_next_step';

export interface ArchivedToolResultPlaceholder {
  kind: typeof ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND;
  rewriteVersion: typeof ARCHIVED_TOOL_RESULT_REWRITE_VERSION;
  artifactId: string;
  runtimeEventId: string;
  toolCallId: string;
  toolName: string;
  bodySha256: string;
  originalEstimatedTokens: number;
  originalBytes: number;
  reason: ArchivedToolResultReason;
}

export interface StaleToolResultArchiveCandidate {
  runtimeEventId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  result: unknown;
  serializedResult: string;
  originalEstimatedTokens: number;
  originalBytes: number;
  rewriteVersion: typeof ARCHIVED_TOOL_RESULT_REWRITE_VERSION;
  reason: ArchivedToolResultReason;
}

export interface ActiveToolResultArchiveCandidate {
  turnId: string;
  toolCallId: string;
  toolName: string;
  result: unknown;
  serializedResult: string;
  originalEstimatedTokens: number;
  originalBytes: number;
  rewriteVersion: typeof ARCHIVED_TOOL_RESULT_REWRITE_VERSION;
  reason: ActiveArchivedToolResultReason;
  runtimeEventId?: string;
}

export interface ActiveArchivedToolResultPlaceholder {
  kind: typeof ACTIVE_ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND;
  rewriteVersion: typeof ARCHIVED_TOOL_RESULT_REWRITE_VERSION;
  artifactId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  bodySha256: string;
  originalEstimatedTokens: number;
  originalBytes: number;
  reason: ActiveArchivedToolResultReason;
}

export interface ToolResultArchiveRef {
  runtimeEventId: string;
  toolCallId: string;
  toolName: string;
  artifactId: string;
  bodySha256: string;
  originalEstimatedTokens: number;
  originalBytes: number;
  rewriteVersion: typeof ARCHIVED_TOOL_RESULT_REWRITE_VERSION;
  reason: ArchivedToolResultReason;
}

export type ToolResultArchiveReadFailureReason =
  | 'not_found'
  | 'deleted'
  | 'too_large'
  | 'not_allowed'
  | 'read_failed'
  | 'source_mismatch'
  | 'session_mismatch'
  | 'size_mismatch'
  | 'corrupt';

export interface ToolResultArchiveReaderInput extends ArchivedToolResultPlaceholder {
  sessionId: string;
  maxBytes?: number;
}

export type ToolResultArchiveReadResult =
  | { ok: true; serializedResult: string }
  | { ok: false; reason: ToolResultArchiveReadFailureReason };

export type ToolResultArchiveReader = (
  input: ToolResultArchiveReaderInput,
) => Promise<ToolResultArchiveReadResult> | ToolResultArchiveReadResult;

export interface ArchiveRetrievalResult {
  events: RuntimeEvent[];
  diagnosticPatch: Partial<ContextBudgetDiagnostic>;
  retrievedSourceRefs?: SynthesisSourceRef[];
}

export interface BuildSynthesisCacheBlocksInput {
  sessionId: string;
  query: string;
  hydratedRuntimeEvents: readonly RuntimeEvent[];
  retrievedArchiveRefs: readonly SynthesisSourceRef[];
  archiveRetrievalMode: ArchiveRetrievalMode;
  limits: {
    maxBlocks: number;
    maxBlockEstimatedTokens: number;
    maxEstimatedTokens: number;
    charsPerToken: number;
  };
  requestShapeHashBefore?: string;
  requestShapeHashAfter?: string;
  now?: number;
}

export interface BuildSynthesisCacheBlocksResult {
  blocks: SynthesisCacheBlock[];
  skipped: number;
  skippedReasonCounts?: Record<string, number>;
}

export interface RuntimeEventHistorySearchHit {
  eventId: string;
  turnId: string;
  ts: number;
  score: number;
  matchedTerms: string[];
}

export interface RuntimeEventHistoryAroundResult {
  events: RuntimeEvent[];
  hits: RuntimeEventHistorySearchHit[];
  diagnosticPatch: Partial<ContextBudgetDiagnostic>;
}

export interface BudgetedRuntimeContext {
  events: RuntimeEvent[];
  diagnostic: ContextBudgetDiagnostic;
  historyCompactBlocks?: HistoryCompactBlock[];
}

export interface PromptSegmentInput {
  systemPrompt?: string;
  toolSchemaChars: number;
  toolCount: number;
  priorMessages: readonly ModelMessage[];
  priorRuntimeEventCount?: number;
  currentUserContent: string;
  turnTailPrompt?: string;
  charsPerToken?: number;
}

export function applyRuntimeEventContextBudget(
  events: readonly RuntimeEvent[],
  policy: ContextBudgetPolicy | undefined,
): BudgetedRuntimeContext | undefined {
  const prunePolicy = policy?.staleToolResultPrune;
  const pruneEnabled = prunePolicy?.enabled === true;
  const archiveRetrievalEnabled = policy?.archiveRetrieval?.enabled === true;
  const historySearchEnabled = policy?.historySearch?.enabled === true;
  const synthesisCacheEnabled = policy?.synthesisCache?.enabled === true;
  const historyCompactEnabled = policy?.historyCompact?.enabled === true;
  const historyRewriteEnabled = policy?.historyRewrite?.enabled === true;
  const enabled = Boolean(
    policy?.maxHistoryEstimatedTokens ||
    policy?.maxHistoryTurns ||
    pruneEnabled ||
    archiveRetrievalEnabled ||
    historySearchEnabled ||
    synthesisCacheEnabled ||
    historyCompactEnabled ||
    historyRewriteEnabled
  );
  if (!enabled) return undefined;
  if (!policy) return undefined;
  const charsPerToken = policy?.charsPerToken ?? 4;
  const maxTokens = finitePositive(policy?.maxHistoryEstimatedTokens);
  const maxTurns = finitePositive(policy?.maxHistoryTurns);
  const minRecentTurns = Math.max(0, Math.floor(policy?.minRecentTurns ?? 1));
  const estimatedTokensBefore = estimateRuntimeEventsTokens(events, charsPerToken);
  const pruned = pruneStaleToolResultsBeforeCompact(events, policy, charsPerToken);
  const compacted = applyRuntimeEventHistoryCompact(
    pruned.events,
    policy,
    { charsPerToken, maxHistoryEstimatedTokens: maxTokens },
  );
  const budgetEvents = compacted.blocks.length > 0 ? compacted.events : pruned.events;
  const turnGroups = groupEventsByTurn(budgetEvents.filter(isHistoryCompactContentEvent), charsPerToken);

  const keptTurnIds = new Set<string>();
  let keptEvents: RuntimeEvent[];
  if (compacted.blocks.length > 0) {
    keptEvents = budgetEvents;
    for (const event of keptEvents) keptTurnIds.add(turnKey(event));
  } else {
    let keptTokens = 0;
    for (let index = turnGroups.length - 1; index >= 0; index -= 1) {
      const group = turnGroups[index]!;
      const nextTurnCount = keptTurnIds.size + 1;
      const mustKeep = nextTurnCount <= minRecentTurns;
      const wouldExceedTurns = maxTurns !== undefined && nextTurnCount > maxTurns;
      const wouldExceedTokens =
        maxTokens !== undefined &&
        keptTokens > 0 &&
        keptTokens + group.estimatedTokens > maxTokens;
      if (!mustKeep && (wouldExceedTurns || wouldExceedTokens)) break;
      keptTurnIds.add(group.turnId);
      keptTokens += group.estimatedTokens;
    }
    keptEvents = budgetEvents.filter((event) => keptTurnIds.has(turnKey(event)));
  }

  const diagnostic: ContextBudgetDiagnostic = {
    enabled: true,
    ...(policy?.name ? { policyName: policy.name } : {}),
    ...(maxTokens !== undefined ? { maxHistoryEstimatedTokens: maxTokens } : {}),
    ...(maxTurns !== undefined ? { maxHistoryTurns: maxTurns } : {}),
    estimatedTokensBefore,
    estimatedTokensAfter: estimateRuntimeEventsTokens(keptEvents, charsPerToken),
    keptTurns: keptTurnIds.size,
    droppedTurns: compacted.blocks.length > 0
      ? compacted.blocks.reduce((total, block) => total + block.coverage.turnIds.length, 0)
      : Math.max(0, turnGroups.length - keptTurnIds.size),
    keptEvents: keptEvents.length,
    droppedEvents: Math.max(
      0,
      (compacted.blocks.length > 0 ? pruned.events.length : budgetEvents.length) - keptEvents.length,
    ),
    ...(policy.historyRewrite?.enabled === true
      ? {
          historyRewriteVersion: policy.historyRewrite.historyRewriteVersion,
          historyRewriteResetReason: policy.historyRewrite.resetReason,
          historyRewriteGate: policy.historyRewrite.name ?? 'history-rewrite',
        }
      : {}),
    ...compacted.diagnosticPatch,
    ...(pruned.prunedToolResults > 0
      ? {
          prunedToolResults: pruned.prunedToolResults,
          prunedToolResultEstimatedTokensBefore: pruned.estimatedTokensBefore,
          prunedToolResultEstimatedTokensAfter: pruned.estimatedTokensAfter,
          archivePlaceholders: pruned.prunedToolResults,
          archivePlaceholderReasonCounts: {
            stale_tool_result_pruned_before_compact: pruned.prunedToolResults,
          },
        }
      : {}),
    ...(pruned.archiveWriteFailures > 0
      ? {
          archiveWriteFailures: pruned.archiveWriteFailures,
          unarchivedToolResults: pruned.archiveWriteFailures,
        }
      : {}),
  };
  return {
    events: keptEvents,
    diagnostic,
    ...(compacted.blocks.length > 0 ? { historyCompactBlocks: compacted.blocks } : {}),
  };
}

export function applyRuntimeEventHistoryCompact(
  events: readonly RuntimeEvent[],
  policy: ContextBudgetPolicy | undefined,
  options: {
    charsPerToken?: number;
    maxHistoryEstimatedTokens?: number;
  } = {},
): HistoryCompactReplayResult {
  const compactPolicy = policy?.historyCompact;
  if (compactPolicy?.enabled !== true) {
    return { events: [...events], blocks: [], diagnosticPatch: {} };
  }

  const charsPerToken = options.charsPerToken ?? policy?.charsPerToken ?? 4;
  const maxTokens = finitePositive(options.maxHistoryEstimatedTokens ?? policy?.maxHistoryEstimatedTokens);
  const skippedReasonCounts: Record<string, number> = {};
  const basePatch: Partial<ContextBudgetDiagnostic> = {
    historyCompactEnabled: true,
    historyCompactMode: compactPolicy.mode ?? 'deterministic',
  };
  if (maxTokens === undefined) {
    increment(skippedReasonCounts, 'max_history_tokens_missing');
    return {
      events: [...events],
      blocks: [],
      diagnosticPatch: {
        ...basePatch,
        historyCompactSkipped: 1,
        historyCompactSkippedReasonCounts: skippedReasonCounts,
        ...historyCompactSkippedDecisionPatch(skippedReasonCounts),
      },
    };
  }

  const compactableEvents = events.filter(isHistoryCompactContentEvent);
  const estimatedTokensBefore = estimateRuntimeEventsTokens(compactableEvents, charsPerToken);
  const highWaterRatio = finiteRatio(compactPolicy.highWaterRatio, 0.8);
  const highWaterThreshold = Math.max(1, Math.floor(maxTokens * highWaterRatio));
  if (estimatedTokensBefore <= highWaterThreshold) {
    increment(skippedReasonCounts, 'below_high_water');
    return {
      events: [...events],
      blocks: [],
      diagnosticPatch: {
        ...basePatch,
        historyCompactSkipped: 1,
        historyCompactSkippedReasonCounts: skippedReasonCounts,
        ...historyCompactSkippedDecisionPatch(skippedReasonCounts),
      },
    };
  }

  const turnGroups = groupEventsByTurn(compactableEvents, charsPerToken);
  if (turnGroups.length <= 1) {
    increment(skippedReasonCounts, 'insufficient_turns');
    return {
      events: [...events],
      blocks: [],
      diagnosticPatch: {
        ...basePatch,
        historyCompactSkipped: 1,
        historyCompactSkippedReasonCounts: skippedReasonCounts,
        ...historyCompactSkippedDecisionPatch(skippedReasonCounts),
      },
    };
  }

  const minRecentTurns = Math.max(
    1,
    Math.floor(compactPolicy.minRecentTurns ?? policy?.minRecentTurns ?? 1),
  );
  const targetRatio = finiteRatio(compactPolicy.targetRatio, 0.5);
  const tailBudget =
    finitePositive(compactPolicy.tailEstimatedTokens)
    ?? Math.max(1, Math.floor(maxTokens * targetRatio));
  const tailTurnIds = selectHistoryCompactTailTurnIds(turnGroups, {
    minRecentTurns,
    tailBudget,
  });
  const foldedTurnIds = turnGroups
    .map((group) => group.turnId)
    .filter((turnId) => !tailTurnIds.has(turnId));
  if (foldedTurnIds.length === 0) {
    increment(skippedReasonCounts, 'no_foldable_turns');
    return {
      events: [...events],
      blocks: [],
      diagnosticPatch: {
        ...basePatch,
        historyCompactSkipped: 1,
        historyCompactSkippedReasonCounts: skippedReasonCounts,
        ...historyCompactSkippedDecisionPatch(skippedReasonCounts),
      },
    };
  }

  const foldedTurnIdSet = new Set(foldedTurnIds);
  const foldedEvents = compactableEvents.filter((event) => foldedTurnIdSet.has(turnKey(event)));
  const retainedEvents = compactableEvents.filter((event) => !foldedTurnIdSet.has(turnKey(event)));
  if (foldedEvents.length === 0) {
    increment(skippedReasonCounts, 'no_foldable_events');
    return {
      events: [...events],
      blocks: [],
      diagnosticPatch: {
        ...basePatch,
        historyCompactSkipped: 1,
        historyCompactSkippedReasonCounts: skippedReasonCounts,
        ...historyCompactSkippedDecisionPatch(skippedReasonCounts),
      },
    };
  }

  const loaded = selectLoadedHistoryCompactBlock(
    foldedEvents,
    compactPolicy,
    { sessionId: foldedEvents[0]?.sessionId ?? '', charsPerToken },
    skippedReasonCounts,
  );
  if (loaded) {
    const { block: loadedBlock, coveredEvents } = loaded;
    const coveredEventIds = new Set(coveredEvents.map((event) => event.id));
    const uncoveredFoldedEvents = foldedEvents.filter((event) => !coveredEventIds.has(event.id));
    const estimatedTokensBeforeFold = estimateRuntimeEventsTokens(coveredEvents, charsPerToken);
    const loadedBlockText = renderHistoryCompactBlock(loadedBlock);
    const estimatedTokensAfterFold =
      loadedBlock.estimatedTokens ?? estimateTokens(loadedBlockText.length, charsPerToken);
    const boundary = historyCompactBlockToCompactionBoundary(loadedBlock, {
      renderedText: loadedBlockText,
      preservedAnchor: { tailTurnIds: [...tailTurnIds] },
      validationStatus: 'valid',
    });
    const outputEvents = [historyCompactBlockToRuntimeEvent(loadedBlock), ...uncoveredFoldedEvents, ...retainedEvents];
    if (maxTokens === undefined || estimateRuntimeEventsTokens(outputEvents, charsPerToken) <= maxTokens) {
      return {
        events: outputEvents,
        blocks: [loadedBlock],
        diagnosticPatch: {
          ...basePatch,
          historyCompactBlocksAvailable: compactPolicy.blocks?.length ?? 0,
          historyCompactBlocksSelected: 1,
          historyCompactBlockIds: [loadedBlock.blockId],
          historyCompactedTurns: loadedBlock.coverage.turnIds.length,
          historyCompactedEvents: loadedBlock.coverage.runtimeEventIds.length,
          historyCompactedEstimatedTokensBefore: estimatedTokensBeforeFold,
          historyCompactedEstimatedTokensAfter: estimatedTokensAfterFold,
          historyCompactCoverageHashes: loadedBlock.coverage.bodySha256,
          highWaterName: loadedBlock.highWaterName,
          highWaterSeq: loadedBlock.highWaterSeq,
          highWaterReason: 'history_compact',
          ...compactionDecisionDiagnosticPatch({
            stage: 'priorReplay',
            sourceKind: 'runtimeEvents',
            decision: 'replaced',
            boundaryKind: boundary.kind,
            boundaryIds: [boundary.boundaryId],
            coverage: boundary.coverage,
            estimatedTokensBefore: estimatedTokensBeforeFold,
            estimatedTokensAfter: estimatedTokensAfterFold,
          }),
        },
      };
    }
    increment(skippedReasonCounts, 'prefix_over_budget');
  }

  const archiveRefs = normalizeHistoryCompactSourceArchiveRefs(compactPolicy.sourceArchiveRefs);
  if (compactPolicy.archiveRequired === true) {
    const archiveValidationReason = validateHistoryCompactArchiveCoverage(
      foldedEvents,
      archiveRefs,
      charsPerToken,
    );
    if (archiveValidationReason) {
      increment(skippedReasonCounts, archiveValidationReason);
      return {
        events: [...events],
        blocks: [],
        diagnosticPatch: {
          ...basePatch,
          historyCompactSkipped: 1,
          historyCompactSkippedReasonCounts: skippedReasonCounts,
          ...historyCompactSkippedDecisionPatch(skippedReasonCounts),
        },
      };
    }
  }

  if (compactPolicy.mode === 'lookup') {
    if (!skippedReasonCounts.prefix_over_budget) {
      increment(skippedReasonCounts, 'lookup_miss');
    }
    return {
      events: [...events],
      blocks: [],
      diagnosticPatch: {
        ...basePatch,
        historyCompactSkipped: 1,
        historyCompactSkippedReasonCounts: skippedReasonCounts,
        ...historyCompactSkippedDecisionPatch(skippedReasonCounts),
      },
    };
  }

  const block = buildHistoryCompactBlock(foldedEvents, compactPolicy, {
    charsPerToken,
    archiveRefs,
  });
  const estimatedTokensBeforeFold = estimateRuntimeEventsTokens(foldedEvents, charsPerToken);
  const blockText = renderHistoryCompactBlock(block);
  const estimatedTokensAfterFold = block.estimatedTokens ?? estimateTokens(blockText.length, charsPerToken);
  const boundary = historyCompactBlockToCompactionBoundary(block, {
    renderedText: blockText,
    preservedAnchor: { tailTurnIds: [...tailTurnIds] },
    validationStatus: 'valid',
  });
  const synthetic = historyCompactBlockToRuntimeEvent(block);
  const outputEvents = [synthetic, ...retainedEvents];
  return {
    events: outputEvents,
    blocks: [block],
    diagnosticPatch: {
      ...basePatch,
      historyCompactBlockIds: [block.blockId],
      historyCompactBlocksSelected: 1,
      historyCompactedTurns: block.coverage.turnIds.length,
      historyCompactedEvents: block.coverage.runtimeEventIds.length,
      historyCompactedEstimatedTokensBefore: estimatedTokensBeforeFold,
      historyCompactedEstimatedTokensAfter: estimatedTokensAfterFold,
      historyCompactCoverageHashes: block.coverage.bodySha256,
      highWaterName: block.highWaterName,
      highWaterSeq: block.highWaterSeq,
      highWaterReason: 'history_compact',
      ...compactionDecisionDiagnosticPatch({
        stage: 'priorReplay',
        sourceKind: 'runtimeEvents',
        decision: 'replaced',
        boundaryKind: boundary.kind,
        boundaryIds: [boundary.boundaryId],
        coverage: boundary.coverage,
        estimatedTokensBefore: estimatedTokensBeforeFold,
        estimatedTokensAfter: estimatedTokensAfterFold,
      }),
    },
  };
}

export async function retrieveArchivedToolResultsForReplay(
  events: readonly RuntimeEvent[],
  policy: ArchiveRetrievalPolicy | undefined,
  reader: ToolResultArchiveReader | undefined,
  options: {
    sessionId: string;
    charsPerToken?: number;
    allowedTurnIds?: ReadonlySet<string> | readonly string[];
  },
): Promise<ArchiveRetrievalResult> {
  if (policy?.enabled !== true || !reader) {
    return { events: [...events], diagnosticPatch: {} };
  }

  const charsPerToken = options.charsPerToken ?? 4;
  const mode = policy.mode ?? 'eager';
  const allowedTurnIds = normalizeAllowedTurnIds(options.allowedTurnIds);
  const maxResults = finitePositive(policy.maxResults) ?? 3;
  const maxEstimatedTokens = finitePositive(policy.maxEstimatedTokens) ?? 8_192;
  const maxBytes = finitePositive(policy.maxBytes) ?? 1024 * 1024;
  const candidates = collectArchiveRetrievalCandidates(events, policy.order ?? 'newest_first');

  let retrieved = 0;
  let retrievedTokens = 0;
  let skipped = 0;
  let failures = 0;
  const skippedReasonCounts: Record<string, number> = {};
  const failureReasonCounts: Record<string, number> = {};
  const replacements = new Map<string, unknown>();
  const retrievedSourceRefs: SynthesisSourceRef[] = [];

  for (const candidate of candidates) {
    if (retrieved >= maxResults) break;
    if (mode === 'history_search_gated' && !allowedTurnIds.has(turnKey(candidate.event))) {
      skipped += 1;
      increment(skippedReasonCounts, 'history_search_gate');
      continue;
    }
    if (candidate.placeholder.originalBytes > maxBytes) {
      skipped += 1;
      increment(skippedReasonCounts, 'max_bytes');
      continue;
    }
    if (candidate.placeholder.originalEstimatedTokens > maxEstimatedTokens) {
      skipped += 1;
      increment(skippedReasonCounts, 'max_candidate_tokens');
      continue;
    }
    if (retrievedTokens + candidate.placeholder.originalEstimatedTokens > maxEstimatedTokens) {
      skipped += 1;
      increment(skippedReasonCounts, 'max_total_tokens');
      continue;
    }

    const readResult = await Promise.resolve(reader({
      ...candidate.placeholder,
      sessionId: options.sessionId,
      maxBytes,
    })).catch((): ToolResultArchiveReadResult => ({ ok: false, reason: 'read_failed' }));
    if (!readResult.ok) {
      failures += 1;
      increment(failureReasonCounts, readResult.reason);
      continue;
    }
    const actualHash = sha256(readResult.serializedResult);
    if (actualHash !== candidate.placeholder.bodySha256) {
      failures += 1;
      increment(failureReasonCounts, 'corrupt');
      continue;
    }

    replacements.set(candidate.event.id, deserializeToolResultArchive(readResult.serializedResult));
    retrievedSourceRefs.push({
      kind: 'archived_tool_result',
      sessionId: options.sessionId,
      turnId: turnKey(candidate.event),
      runtimeEventId: candidate.event.id,
      toolCallId: candidate.placeholder.toolCallId,
      toolName: candidate.placeholder.toolName,
      artifactId: candidate.placeholder.artifactId,
      bodySha256: candidate.placeholder.bodySha256,
      originalEstimatedTokens: candidate.placeholder.originalEstimatedTokens,
      originalBytes: candidate.placeholder.originalBytes,
      placeholderReason: candidate.placeholder.reason,
    });
    retrieved += 1;
    retrievedTokens += candidate.placeholder.originalEstimatedTokens;
  }

  const hydratedEvents = events.map((event) => {
    const replacement = replacements.get(event.id);
    if (!replacements.has(event.id) || event.content?.kind !== 'function_response') return event;
    return {
      ...event,
      content: {
        ...event.content,
        result: replacement,
      },
    };
  });

  return {
    events: hydratedEvents,
    ...(retrievedSourceRefs.length > 0 ? { retrievedSourceRefs } : {}),
    diagnosticPatch: {
      archiveRetrievalMode: mode,
      ...(mode === 'history_search_gated'
        ? { archiveRetrievalEligibleTurns: allowedTurnIds.size }
        : {}),
      retrievedArchiveToolResults: retrieved,
      retrievedArchiveEstimatedTokens: retrievedTokens,
      archiveRetrievalSkipped: skipped,
      archiveRetrievalFailures: failures,
      ...(Object.keys(skippedReasonCounts).length > 0
        ? { archiveRetrievalSkippedReasonCounts: skippedReasonCounts }
        : {}),
      ...(Object.keys(failureReasonCounts).length > 0
        ? { archiveRetrievalFailureReasonCounts: failureReasonCounts }
        : {}),
    },
  };
}

export function deserializeToolResultArchive(serialized: string): unknown {
  if (serialized === 'undefined') return undefined;
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    return serialized;
  }
}

export function searchRuntimeEventHistory(
  events: readonly RuntimeEvent[],
  query: string,
  policy: RuntimeEventHistorySearchPolicy | undefined,
): RuntimeEventHistorySearchHit[] {
  if (policy?.enabled !== true) return [];
  const terms = tokenizeSearchQuery(query);
  if (terms.length === 0) return [];
  const maxResults = finitePositive(policy.maxResults) ?? 5;
  return events
    .map((event) => scoreRuntimeEventSearchHit(event, terms))
    .filter((hit): hit is RuntimeEventHistorySearchHit => hit !== undefined)
    .sort((a, b) => b.score - a.score || b.ts - a.ts || b.eventId.localeCompare(a.eventId))
    .slice(0, maxResults);
}

export function retrieveRuntimeEventHistoryAround(
  events: readonly RuntimeEvent[],
  query: string,
  policy: RuntimeEventHistorySearchPolicy | undefined,
  options: { charsPerToken?: number } = {},
): RuntimeEventHistoryAroundResult {
  if (policy?.enabled !== true) {
    return { events: [], hits: [], diagnosticPatch: {} };
  }
  const charsPerToken = options.charsPerToken ?? 4;
  const around = Math.max(0, Math.floor(policy.around ?? 1));
  const maxEstimatedTokens = finitePositive(policy.maxEstimatedTokens) ?? 4_096;
  const hits = searchRuntimeEventHistory(events, policy.query ?? query, policy);
  const selectedIndexes = new Set<number>();
  const indexesByEventId = new Map(events.map((event, index) => [event.id, index]));
  for (const hit of hits) {
    const index = indexesByEventId.get(hit.eventId);
    if (index === undefined) continue;
    for (let cursor = Math.max(0, index - around); cursor <= Math.min(events.length - 1, index + around); cursor += 1) {
      selectedIndexes.add(cursor);
    }
  }

  const selectedEvents: RuntimeEvent[] = [];
  let selectedTokens = 0;
  let skipped = 0;
  for (const index of [...selectedIndexes].sort((a, b) => a - b)) {
    const event = events[index]!;
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

export function selectSynthesisCacheForReplay(
  events: readonly RuntimeEvent[],
  query: string,
  policy: SynthesisCachePolicy | undefined,
  options: { sessionId: string; charsPerToken?: number } = { sessionId: '' },
): SynthesisCacheReplayResult {
  if (policy?.enabled !== true) {
    return { events: [...events], selectedBlocks: [], diagnosticPatch: {} };
  }

  const charsPerToken = options.charsPerToken ?? 4;
  const blocks = policy.blocks ?? [];
  const maxBlocks = finitePositive(policy.maxBlocks) ?? 1;
  const maxEstimatedTokens = finitePositive(policy.maxEstimatedTokens) ?? 2_048;
  const maxBlockEstimatedTokens = finitePositive(policy.maxBlockEstimatedTokens) ?? 1_024;
  const selectedBlocks: SynthesisCacheBlock[] = [];
  let selectedTokenEstimate = 0;
  const skippedReasonCounts: Record<string, number> = {};
  const invalidationReasonCounts: Record<string, number> = {};
  const rawEvidenceReason = rawEvidenceRequestReason(query);
  const sourceIndex = buildSynthesisSourceIndex(events);

  for (const block of blocks) {
    if (selectedBlocks.length >= maxBlocks) {
      increment(skippedReasonCounts, 'max_blocks');
      continue;
    }
    const validationReason = validateSynthesisCacheBlock(block, sourceIndex, options.sessionId);
    if (validationReason) {
      increment(invalidationReasonCounts, validationReason);
      continue;
    }
    const blockTokenEstimate = block.estimatedTokens
      ?? estimateTokens(renderSynthesisCacheBlock(block).length, charsPerToken);
    if (blockTokenEstimate > maxBlockEstimatedTokens) {
      increment(skippedReasonCounts, 'max_block_tokens');
      continue;
    }
    if (selectedTokenEstimate + blockTokenEstimate > maxEstimatedTokens) {
      increment(skippedReasonCounts, 'max_total_tokens');
      continue;
    }
    if (!synthesisBlockCoversQuery(block, query)) {
      increment(skippedReasonCounts, 'coverage_miss');
      continue;
    }
    if (rawEvidenceReason) {
      increment(skippedReasonCounts, rawEvidenceReason);
      continue;
    }
    const newerReason = policy.invalidateOnNewToolResult === false
      ? undefined
      : newerRelevantToolResultReason(block, events, query);
    if (newerReason) {
      increment(invalidationReasonCounts, newerReason);
      continue;
    }
    selectedBlocks.push(block);
    selectedTokenEstimate += blockTokenEstimate;
  }

  const skipped = Object.values(skippedReasonCounts).reduce((total, count) => total + count, 0);
  const invalidated = Object.values(invalidationReasonCounts).reduce((total, count) => total + count, 0);
  const diagnosticPatch: Partial<ContextBudgetDiagnostic> = {
    synthesisCacheEnabled: true,
    synthesisCacheMode: selectedBlocks.length > 0 ? policy.mode ?? 'lookup' : 'fallback_archive_retrieval',
    synthesisCacheBlocksAvailable: blocks.length,
    synthesisCacheBlocksSelected: selectedBlocks.length,
    ...(selectedBlocks.length > 0
      ? {
          synthesisCacheBlockIds: selectedBlocks.map((block) => block.blockId),
          synthesisCacheEstimatedTokens: selectedTokenEstimate,
          highWaterName: selectedBlocks[0]!.highWaterName,
          highWaterSeq: selectedBlocks[0]!.highWaterSeq,
          highWaterReason: 'synthesis_cache_select',
        }
      : {}),
    ...(skipped > 0
      ? {
          synthesisCacheSkipped: skipped,
          synthesisCacheSkippedReasonCounts: skippedReasonCounts,
        }
      : {}),
    ...(invalidated > 0
      ? {
          synthesisCacheInvalidated: invalidated,
          synthesisCacheInvalidationReasonCounts: invalidationReasonCounts,
        }
      : {}),
  };

  if (selectedBlocks.length === 0) {
    return { events: [...events], selectedBlocks, diagnosticPatch };
  }

  const coveredEventIds = new Set<string>();
  const coveredToolCallIds = new Set<string>();
  const insertions = new Map<number, RuntimeEvent[]>();
  for (const block of selectedBlocks) {
    const blockEventIds = new Set(block.coverage.runtimeEventIds);
    const blockToolCallIds = new Set(block.coverage.toolCallIds);
    for (const eventId of block.coverage.runtimeEventIds) coveredEventIds.add(eventId);
    for (const toolCallId of block.coverage.toolCallIds) coveredToolCallIds.add(toolCallId);
    for (const ref of block.sourceRefs) {
      if ('runtimeEventId' in ref) {
        coveredEventIds.add(ref.runtimeEventId);
        blockEventIds.add(ref.runtimeEventId);
      }
      if ('toolCallId' in ref) {
        coveredToolCallIds.add(ref.toolCallId);
        blockToolCallIds.add(ref.toolCallId);
      }
    }
    const insertionIndex = events.findIndex((event) =>
      blockEventIds.has(event.id) ||
      (event.content?.kind === 'function_call' && blockToolCallIds.has(event.content.id))
    );
    if (insertionIndex < 0) {
      throw new Error('validated synthesis cache block has no covered replay event');
    }
    const synthetic = synthesisBlockRuntimeEvent(block, options.sessionId);
    const existing = insertions.get(insertionIndex);
    if (existing) existing.push(synthetic);
    else insertions.set(insertionIndex, [synthetic]);
  }
  const replayEvents: RuntimeEvent[] = [];
  for (const [index, event] of events.entries()) {
    const synthetic = insertions.get(index);
    if (synthetic) replayEvents.push(...synthetic);
    if (
      coveredEventIds.has(event.id) ||
      (event.content?.kind === 'function_call' && coveredToolCallIds.has(event.content.id))
    ) {
      continue;
    }
    replayEvents.push(event);
  }
  return {
    events: replayEvents,
    selectedBlocks,
    diagnosticPatch,
  };
}

export function renderSynthesisCacheBlock(block: SynthesisCacheBlock): string {
  const sourceText = block.sourceRefs.map((ref) => renderSynthesisSourceRef(ref)).join('; ');
  return [
    `<maka_synthesis_cache_block id="${escapeAttribute(block.blockId)}" high_water="${escapeAttribute(block.highWaterName)}" seq="${block.highWaterSeq}">`,
    `summary: ${block.summary}`,
    `coverage: queryKeys=[${block.coverage.queryKeys.join(', ')}], turnIds=[${block.coverage.turnIds.join(', ')}], runtimeEventIds=[${block.coverage.runtimeEventIds.join(', ')}], artifactIds=[${block.coverage.artifactIds.join(', ')}]`,
    `limitations: ${block.limitations.join('; ')}`,
    `sources: ${sourceText}`,
    '</maka_synthesis_cache_block>',
  ].join('\n');
}

export function renderHistoryCompactBlock(block: HistoryCompactBlock): string {
  const sourceText = block.sourceRefs.map((ref) => renderSynthesisSourceRef(ref)).join('; ');
  const archiveText = (block.sourceArchiveRefs ?? [])
    .map((ref) =>
      `archive(runtimeEventId=${ref.runtimeEventId}, artifactId=${ref.artifactId}, bodySha256=${ref.bodySha256})`
    )
    .join('; ');
  return [
    `<maka_history_compact_block id="${escapeAttribute(block.blockId)}" high_water="${escapeAttribute(block.highWaterName)}" seq="${block.highWaterSeq}" version="${block.version}">`,
    `summary: ${block.summary}`,
    `coverage: turnIds=[${block.coverage.turnIds.join(', ')}], runtimeEventIds=[${block.coverage.runtimeEventIds.join(', ')}], contentKinds=[${block.coverage.contentKinds.join(', ')}], bodySha256=[${block.coverage.bodySha256.join(', ')}]`,
    `limitations: ${block.limitations.join('; ')}`,
    `sources: ${sourceText}`,
    ...(archiveText.length > 0 ? [`archives: ${archiveText}`] : []),
    '</maka_history_compact_block>',
  ].join('\n');
}

export function validateHistoryCompactBlockShape(value: unknown, sessionId?: string): value is HistoryCompactBlock {
  if (!value || typeof value !== 'object') return false;
  const block = value as Partial<HistoryCompactBlock>;
  return block.kind === 'maka.history_compact_block'
    && block.version === 1
    && nonEmpty(block.blockId)
    && nonEmpty(block.sessionId)
    && (sessionId === undefined || block.sessionId === sessionId)
    && Number.isFinite(block.createdAt)
    && nonEmpty(block.highWaterName)
    && Number.isFinite(block.highWaterSeq)
    && !!block.coverage
    && Array.isArray(block.coverage.turnIds)
    && Array.isArray(block.coverage.runtimeEventIds)
    && Array.isArray(block.coverage.contentKinds)
    && Array.isArray(block.coverage.bodySha256)
    && allNonEmpty(block.coverage.turnIds)
    && allNonEmpty(block.coverage.runtimeEventIds)
    && allNonEmpty(block.coverage.contentKinds)
    && allNonEmpty(block.coverage.bodySha256)
    && typeof block.summary === 'string'
    && block.summary.length > 0
    && Array.isArray(block.limitations)
    && Array.isArray(block.sourceRefs)
    && block.sourceRefs.length > 0
    && block.sourceRefs.every(isValidSynthesisSourceRef)
    && optionalNonNegativeFiniteNumber(block.estimatedTokens)
    && (
      block.sourceArchiveRefs === undefined ||
      (Array.isArray(block.sourceArchiveRefs) && block.sourceArchiveRefs.every(isValidHistoryCompactSourceArchiveRef))
    );
}

export function historyCompactBlockToRuntimeEvent(block: HistoryCompactBlock): RuntimeEvent {
  return {
    id: `history-compact:${block.blockId}`,
    sessionId: block.sessionId,
    runId: `history-compact:${block.blockId}`,
    turnId: `history-compact:${block.highWaterSeq}`,
    invocationId: `history-compact:${block.blockId}`,
    ts: block.createdAt,
    partial: false,
    role: 'user',
    author: 'system',
    content: {
      kind: 'text',
      text: renderHistoryCompactBlock(block),
    },
    ...(block.sourceArchiveRefs?.[0]
      ? { refs: { artifactId: block.sourceArchiveRefs[0].artifactId } }
      : {}),
  };
}

export function buildHistoryCompactBlockFromSummary(input: {
  sessionId: string;
  foldedRuntimeEvents: readonly RuntimeEvent[];
  summary: string;
  highWaterName?: string;
  highWaterSeq?: number;
  maxSummaryEstimatedTokens?: number;
  sourceArchiveRefs?: readonly HistoryCompactSourceArchiveRef[];
  requestShapeHashBefore?: string;
  requestShapeHashAfter?: string;
  now?: number;
  charsPerToken?: number;
}): HistoryCompactBlock {
  const charsPerToken = input.charsPerToken ?? 4;
  const highWaterName = input.highWaterName ?? 'history-compact-high-water';
  const createdAt = Math.max(
    input.now ?? 1,
    ...input.foldedRuntimeEvents.map((event) => event.ts),
  );
  const highWaterSeq = input.highWaterSeq ?? createdAt;
  const coverage = deriveHistoryCompactCoverage(input.foldedRuntimeEvents);
  const sourceRefs: SynthesisSourceRef[] = input.foldedRuntimeEvents.map((event) => ({
    kind: 'runtime_event',
    sessionId: event.sessionId,
    turnId: turnKey(event),
    runtimeEventId: event.id,
    role: event.role,
    contentKind: event.content?.kind ?? 'none',
  }));
  const maxSummaryTokens = finitePositive(input.maxSummaryEstimatedTokens) ?? 768;
  const summary = boundText(input.summary, Math.max(80, maxSummaryTokens * Math.max(1, charsPerToken)));
  const blockDraft = {
    version: 1,
    sessionId: input.sessionId,
    highWaterName,
    highWaterSeq,
    coverage,
    summary,
  };
  const sourceArchiveRefs = input.sourceArchiveRefs?.filter(isValidHistoryCompactSourceArchiveRef) ?? [];
  const block: HistoryCompactBlock = {
    kind: 'maka.history_compact_block',
    version: 1,
    blockId: stableHistoryCompactBlockId(blockDraft),
    sessionId: input.sessionId,
    createdAt,
    highWaterName,
    highWaterSeq,
    coverage,
    summary,
    limitations: [
      'Host-owned replay-time summary of older RuntimeEvents.',
      'Original RuntimeEvents are not mutated; request raw evidence or history search when exact wording matters.',
      ...(sourceArchiveRefs.length === 0
        ? ['No archive refs are attached; source coverage is by RuntimeEvent ids and content hashes.']
        : []),
    ],
    sourceRefs,
    ...(sourceArchiveRefs.length > 0 ? { sourceArchiveRefs } : {}),
    ...(input.requestShapeHashBefore ? { requestShapeHashBefore: input.requestShapeHashBefore } : {}),
    ...(input.requestShapeHashAfter ? { requestShapeHashAfter: input.requestShapeHashAfter } : {}),
  };
  block.estimatedTokens = estimateTokens(renderHistoryCompactBlock(block).length, charsPerToken);
  return block;
}

export function buildSynthesisCacheBlocksFromHydratedArchives(
  input: BuildSynthesisCacheBlocksInput,
): BuildSynthesisCacheBlocksResult {
  const skippedReasonCounts: Record<string, number> = {};
  const archiveRefs = input.retrievedArchiveRefs.filter(
    (ref): ref is Extract<SynthesisSourceRef, { kind: 'archived_tool_result' }> =>
      ref.kind === 'archived_tool_result',
  );
  if (archiveRefs.length === 0) {
    increment(skippedReasonCounts, 'source_missing');
    return { blocks: [], skipped: 1, skippedReasonCounts };
  }

  const maxBlocks = finitePositive(input.limits.maxBlocks) ?? 1;
  const maxBlockEstimatedTokens = finitePositive(input.limits.maxBlockEstimatedTokens) ?? 1_024;
  const maxEstimatedTokens = finitePositive(input.limits.maxEstimatedTokens) ?? 2_048;
  const charsPerToken = input.limits.charsPerToken ?? 4;
  const coverage = deriveSynthesisCoverageFromSourceRefs(archiveRefs);
  const excerpts = buildSynthesisArchiveExcerpts(input.hydratedRuntimeEvents, archiveRefs);
  if (excerpts.length === 0) {
    increment(skippedReasonCounts, 'source_missing');
    return { blocks: [], skipped: 1, skippedReasonCounts };
  }

  const queryKeys = deriveSynthesisQueryKeys(input.query, archiveRefs, excerpts);
  if (queryKeys.length === 0) {
    increment(skippedReasonCounts, 'coverage_miss');
    return { blocks: [], skipped: 1, skippedReasonCounts };
  }

  const blockDraft = {
    sessionId: input.sessionId,
    coverage: { ...coverage, queryKeys },
    sourceRefs: archiveRefs,
    excerpts,
    mode: input.archiveRetrievalMode,
  };
  const createdAt = Math.max(
    input.now ?? 0,
    ...input.hydratedRuntimeEvents
      .filter((event) => coverage.runtimeEventIds.includes(event.id))
      .map((event) => event.ts),
  );
  const highWaterSeq = Math.max(
    1,
    ...input.hydratedRuntimeEvents
      .filter((event) => coverage.runtimeEventIds.includes(event.id))
      .map((event) => event.ts),
  );
  const block: SynthesisCacheBlock = {
    kind: 'maka.synthesis_cache_block',
    version: 1,
    blockId: stableSynthesisBlockId(blockDraft),
    sessionId: input.sessionId,
    createdAt,
    highWaterName: 'synthesis-cache-after-archive-retrieval',
    highWaterSeq,
    coverage: { ...coverage, queryKeys },
    summary: buildBoundedSynthesisSummary(excerpts),
    limitations: [
      'Deterministic synthesis from archived tool-result excerpts only.',
      'Raw output is not included; request raw evidence to retrieve the archive.',
    ],
    sourceRefs: archiveRefs,
    createdFrom: input.archiveRetrievalMode === 'history_search_gated'
      ? 'gated_archive_retrieval'
      : 'eager_archive_retrieval',
    ...(input.requestShapeHashBefore ? { requestShapeHashBefore: input.requestShapeHashBefore } : {}),
    ...(input.requestShapeHashAfter ? { requestShapeHashAfter: input.requestShapeHashAfter } : {}),
    ...(input.requestShapeHashBefore || input.requestShapeHashAfter
      ? {
          requestShape: {
            ...(input.requestShapeHashBefore ? { before: input.requestShapeHashBefore } : {}),
            ...(input.requestShapeHashAfter ? { after: input.requestShapeHashAfter } : {}),
          },
        }
      : {}),
    invalidation: {
      schemaVersion: 1,
      sourceBodyHashes: coverage.bodySha256,
      invalidateOnNewToolResult: true,
    },
  };
  block.estimatedTokens = estimateTokens(renderSynthesisCacheBlock(block).length, charsPerToken);
  if (block.estimatedTokens > maxBlockEstimatedTokens || block.estimatedTokens > maxEstimatedTokens) {
    increment(skippedReasonCounts, 'max_block_tokens');
    return { blocks: [], skipped: 1, skippedReasonCounts };
  }
  return { blocks: [block].slice(0, maxBlocks), skipped: 0 };
}

export function deriveSynthesisCoverageFromSourceRefs(
  refs: readonly SynthesisSourceRef[],
): SynthesisCacheCoverage {
  const archiveRefs = refs.filter(
    (ref): ref is Extract<SynthesisSourceRef, { kind: 'archived_tool_result' }> =>
      ref.kind === 'archived_tool_result',
  );
  return {
    queryKeys: [],
    turnIds: uniqueSorted(archiveRefs.map((ref) => ref.turnId)),
    runtimeEventIds: uniqueSorted(archiveRefs.map((ref) => ref.runtimeEventId)),
    toolNames: uniqueSorted(archiveRefs.map((ref) => ref.toolName)),
    toolCallIds: uniqueSorted(archiveRefs.map((ref) => ref.toolCallId)),
    artifactIds: uniqueSorted(archiveRefs.map((ref) => ref.artifactId)),
    bodySha256: uniqueSorted(archiveRefs.map((ref) => ref.bodySha256)),
  };
}

export function stableSynthesisBlockId(value: unknown): string {
  return `synth-${sha256(stableStringify(value)).slice(0, 32)}`;
}

export function validateSynthesisCacheBlockShape(value: unknown, sessionId?: string): value is SynthesisCacheBlock {
  if (!value || typeof value !== 'object') return false;
  const block = value as Partial<SynthesisCacheBlock>;
  return block.kind === 'maka.synthesis_cache_block'
    && block.version === 1
    && nonEmpty(block.blockId)
    && nonEmpty(block.sessionId)
    && (sessionId === undefined || block.sessionId === sessionId)
    && Number.isFinite(block.createdAt)
    && nonEmpty(block.highWaterName)
    && Number.isFinite(block.highWaterSeq)
    && !!block.coverage
    && Array.isArray(block.coverage.queryKeys)
    && Array.isArray(block.coverage.turnIds)
    && Array.isArray(block.coverage.runtimeEventIds)
    && Array.isArray(block.coverage.toolNames)
    && Array.isArray(block.coverage.toolCallIds)
    && Array.isArray(block.coverage.artifactIds)
    && Array.isArray(block.coverage.bodySha256)
    && typeof block.summary === 'string'
    && block.summary.length > 0
    && Array.isArray(block.limitations)
    && Array.isArray(block.sourceRefs)
    && block.sourceRefs.length > 0
    && block.sourceRefs.every(isValidSynthesisSourceRef)
    && optionalNonNegativeFiniteNumber(block.estimatedTokens);
}

function optionalNonNegativeFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

export function buildPromptSegmentEstimates(input: PromptSegmentInput): PromptSegmentEstimate[] {
  const charsPerToken = input.charsPerToken ?? 4;
  return [
    segment('system_prompt', input.systemPrompt?.length ?? 0, charsPerToken),
    {
      ...segment('tool_schema', input.toolSchemaChars, charsPerToken),
      toolCount: input.toolCount,
    },
    {
      ...segment('prior_history', estimateModelMessagesChars(input.priorMessages), charsPerToken),
      messageCount: input.priorMessages.length,
      ...(input.priorRuntimeEventCount !== undefined ? { eventCount: input.priorRuntimeEventCount } : {}),
    },
    segment('current_user', input.currentUserContent.length, charsPerToken),
    segment('turn_tail', input.turnTailPrompt?.length ?? 0, charsPerToken),
  ];
}

export function estimateModelMessagesChars(messages: readonly ModelMessage[]): number {
  return messages.reduce((total, message) => total + estimateModelMessageChars(message), 0);
}

export function estimateRuntimeEventsTokens(
  events: readonly RuntimeEvent[],
  charsPerToken = 4,
): number {
  const chars = events.reduce((total, event) => total + estimateRuntimeEventChars(event), 0);
  return estimateTokens(chars, charsPerToken);
}

export function estimateTokens(chars: number, charsPerToken = 4): number {
  if (chars <= 0) return 0;
  return Math.ceil(chars / Math.max(1, charsPerToken));
}

function groupEventsByTurn(events: readonly RuntimeEvent[], charsPerToken: number): Array<{
  turnId: string;
  estimatedTokens: number;
}> {
  const order: string[] = [];
  const byTurn = new Map<string, RuntimeEvent[]>();
  for (const event of events) {
    const key = turnKey(event);
    const group = byTurn.get(key);
    if (group) group.push(event);
    else {
      order.push(key);
      byTurn.set(key, [event]);
    }
  }
  return order.map((turnId) => ({
    turnId,
    estimatedTokens: estimateRuntimeEventsTokens(byTurn.get(turnId) ?? [], charsPerToken),
  }));
}

function selectHistoryCompactTailTurnIds(
  turnGroups: ReadonlyArray<{ turnId: string; estimatedTokens: number }>,
  options: { minRecentTurns: number; tailBudget: number },
): Set<string> {
  const selected = new Set<string>();
  let selectedTokens = 0;
  for (let index = turnGroups.length - 1; index >= 0; index -= 1) {
    const group = turnGroups[index]!;
    const nextCount = selected.size + 1;
    const mustKeep = nextCount <= options.minRecentTurns;
    const wouldExceedBudget = selectedTokens > 0 && selectedTokens + group.estimatedTokens > options.tailBudget;
    if (!mustKeep && wouldExceedBudget) break;
    selected.add(group.turnId);
    selectedTokens += group.estimatedTokens;
  }
  return selected;
}

function selectLoadedHistoryCompactBlock(
  foldedEvents: readonly RuntimeEvent[],
  policy: HistoryCompactPolicy,
  options: {
    sessionId: string;
    charsPerToken: number;
  },
  skippedReasonCounts: Record<string, number>,
): { block: HistoryCompactBlock; coveredEvents: RuntimeEvent[] } | undefined {
  const blocks = policy.blocks ?? [];
  if (blocks.length === 0) return undefined;
  const maxBlocks = finitePositive(policy.maxBlocks) ?? 1;
  const maxEstimatedTokens = finitePositive(policy.maxEstimatedTokens) ?? 2_048;
  const maxBlockEstimatedTokens =
    finitePositive(policy.maxBlockEstimatedTokens)
    ?? finitePositive(policy.maxSummaryEstimatedTokens)
    ?? 1_024;
  let selectedTokens = 0;
  let selected = 0;
  for (const block of blocks) {
    if (selected >= maxBlocks) {
      increment(skippedReasonCounts, 'max_blocks');
      continue;
    }
    const validation = validateHistoryCompactBlockForEvents(block, foldedEvents, options.sessionId);
    if (validation.reason) {
      increment(skippedReasonCounts, validation.reason);
      continue;
    }
    const blockTokens =
      block.estimatedTokens ?? estimateTokens(renderHistoryCompactBlock(block).length, options.charsPerToken);
    if (blockTokens > maxBlockEstimatedTokens) {
      increment(skippedReasonCounts, 'max_block_tokens');
      continue;
    }
    if (selectedTokens + blockTokens > maxEstimatedTokens) {
      increment(skippedReasonCounts, 'max_total_tokens');
      continue;
    }
    selected += 1;
    selectedTokens += blockTokens;
    return { block: { ...block, estimatedTokens: blockTokens }, coveredEvents: validation.coveredEvents };
  }
  return undefined;
}

function validateHistoryCompactBlockForEvents(
  block: HistoryCompactBlock,
  foldedEvents: readonly RuntimeEvent[],
  sessionId: string,
): {
  reason?: 'invalid_schema_version' | 'session_mismatch' | 'coverage_miss' | 'source_hash_mismatch';
  coveredEvents: RuntimeEvent[];
} {
  if (!validateHistoryCompactBlockShape(block, sessionId || undefined)) return { reason: 'invalid_schema_version', coveredEvents: [] };
  if (sessionId.length > 0 && block.sessionId !== sessionId) return { reason: 'session_mismatch', coveredEvents: [] };
  const coverageIds = new Set(block.coverage.runtimeEventIds);
  const coveredEvents: RuntimeEvent[] = [];
  for (const event of foldedEvents) {
    if (!coverageIds.has(event.id)) break;
    if (!block.coverage.turnIds.includes(turnKey(event))) return { reason: 'coverage_miss', coveredEvents: [] };
    if (!block.coverage.contentKinds.includes(event.content?.kind ?? 'none')) return { reason: 'coverage_miss', coveredEvents: [] };
    if (!block.coverage.bodySha256.includes(runtimeEventBodySha256(event))) return { reason: 'source_hash_mismatch', coveredEvents: [] };
    coveredEvents.push(event);
  }
  if (coveredEvents.length === 0 || coveredEvents.length !== coverageIds.size) {
    return { reason: 'coverage_miss', coveredEvents: [] };
  }
  return { coveredEvents };
}

function buildHistoryCompactBlock(
  foldedEvents: readonly RuntimeEvent[],
  policy: HistoryCompactPolicy,
  options: {
    charsPerToken: number;
    archiveRefs: ReadonlyMap<string, HistoryCompactSourceArchiveRef>;
  },
): HistoryCompactBlock {
  const sourceArchiveRefs: HistoryCompactSourceArchiveRef[] = [];
  for (const event of foldedEvents) {
    const ref = options.archiveRefs.get(event.id);
    if (ref && historyCompactArchiveRefMatches(event, ref, options.charsPerToken)) {
      sourceArchiveRefs.push(ref);
    }
  }
  return buildHistoryCompactBlockFromSummary({
    sessionId: foldedEvents[0]?.sessionId ?? 'unknown-session',
    foldedRuntimeEvents: foldedEvents,
    summary: buildDeterministicHistoryCompactSummary(foldedEvents, policy, options.charsPerToken),
    highWaterName: policy.highWaterName,
    maxSummaryEstimatedTokens: policy.maxSummaryEstimatedTokens,
    sourceArchiveRefs,
    charsPerToken: options.charsPerToken,
  });
}

function deriveHistoryCompactCoverage(events: readonly RuntimeEvent[]): HistoryCompactCoverage {
  return {
    turnIds: uniqueSorted(events.map((event) => turnKey(event))),
    runtimeEventIds: uniqueSorted(events.map((event) => event.id)),
    contentKinds: uniqueSorted(events.map((event) => event.content?.kind ?? 'none')),
    bodySha256: uniqueSorted(events.map(runtimeEventBodySha256)),
  };
}

function buildDeterministicHistoryCompactSummary(
  events: readonly RuntimeEvent[],
  policy: HistoryCompactPolicy,
  charsPerToken: number,
): string {
  const maxSummaryTokens = finitePositive(policy.maxSummaryEstimatedTokens) ?? 768;
  const maxChars = Math.max(80, maxSummaryTokens * Math.max(1, charsPerToken));
  const coverage = deriveHistoryCompactCoverage(events);
  const lines = [
    `Compacted ${coverage.turnIds.length} older turns and ${coverage.runtimeEventIds.length} RuntimeEvents.`,
    `Content kinds: ${coverage.contentKinds.join(', ')}.`,
    'Ordered excerpts:',
  ];
  for (const event of events) {
    const excerpt = historyCompactEventExcerpt(event);
    if (!excerpt) continue;
    lines.push(`- ${turnKey(event)}/${event.id}/${event.role}/${event.content?.kind ?? 'none'}: ${excerpt}`);
  }
  return boundText(lines.join('\n'), maxChars);
}

function historyCompactEventExcerpt(event: RuntimeEvent): string | undefined {
  const content = event.content;
  if (!content) return undefined;
  switch (content.kind) {
    case 'text':
    case 'thinking':
      return normalizeWhitespace(content.text).slice(0, 220);
    case 'function_call':
      return normalizeWhitespace(`${content.name} ${stableStringify(content.args)}`).slice(0, 220);
    case 'function_response':
      return normalizeWhitespace(`${content.name} ${stableStringify(content.result)}`).slice(0, 220);
    case 'error':
      return normalizeWhitespace(`${content.code ?? ''} ${content.reason ?? ''} ${content.message}`).slice(0, 220);
  }
}

function stableHistoryCompactBlockId(value: unknown): string {
  return `hcompact-${sha256(stableStringify(value)).slice(0, 32)}`;
}

function normalizeHistoryCompactSourceArchiveRefs(
  refs: HistoryCompactPolicy['sourceArchiveRefs'],
): Map<string, HistoryCompactSourceArchiveRef> {
  const map = new Map<string, HistoryCompactSourceArchiveRef>();
  if (!refs) return map;
  if (Array.isArray(refs)) {
    for (const ref of refs) map.set(ref.runtimeEventId, ref);
    return map;
  }
  for (const [runtimeEventId, ref] of Object.entries(refs)) map.set(runtimeEventId, ref);
  return map;
}

function validateHistoryCompactArchiveCoverage(
  events: readonly RuntimeEvent[],
  refs: ReadonlyMap<string, HistoryCompactSourceArchiveRef>,
  charsPerToken: number,
): 'archive_missing' | 'archive_mismatch' | undefined {
  for (const event of events) {
    const ref = refs.get(event.id);
    if (!ref) return 'archive_missing';
    if (!historyCompactArchiveRefMatches(event, ref, charsPerToken)) return 'archive_mismatch';
  }
  return undefined;
}

function historyCompactSkippedDecisionPatch(
  skippedReasonCounts: Readonly<Record<string, number>>,
): Partial<ContextBudgetDiagnostic> {
  const reason = Object.keys(skippedReasonCounts)[0];
  const decision: CompactionDecisionKind = reason === 'archive_missing' || reason === 'archive_mismatch'
    ? 'failedOpen'
    : 'unchanged';
  return compactionDecisionDiagnosticPatch({
    stage: 'priorReplay',
    sourceKind: 'runtimeEvents',
    decision,
    boundaryKind: 'historyCompact',
    ...(reason ? { reason } : {}),
    ...(decision === 'failedOpen' && reason ? { failOpenReason: reason } : {}),
    skippedReasonCounts,
  });
}

function historyCompactArchiveRefMatches(
  event: RuntimeEvent,
  ref: HistoryCompactSourceArchiveRef,
  charsPerToken: number,
): boolean {
  const body = runtimeEventArchiveBody(event);
  return ref.runtimeEventId === event.id
    && nonEmpty(ref.artifactId)
    && ref.bodySha256 === sha256(body)
    && ref.originalEstimatedTokens === estimateTokens(body.length, charsPerToken)
    && ref.originalBytes === utf8ByteLength(body);
}

function runtimeEventArchiveBody(event: RuntimeEvent): string {
  return stableStringify(event.content ?? {});
}

function runtimeEventBodySha256(event: RuntimeEvent): string {
  return sha256(runtimeEventArchiveBody(event));
}

function isValidHistoryCompactSourceArchiveRef(value: unknown): value is HistoryCompactSourceArchiveRef {
  if (!value || typeof value !== 'object') return false;
  const ref = value as Partial<HistoryCompactSourceArchiveRef>;
  return nonEmpty(ref.runtimeEventId)
    && nonEmpty(ref.artifactId)
    && nonEmpty(ref.bodySha256)
    && Number.isFinite(ref.originalEstimatedTokens)
    && Number.isFinite(ref.originalBytes)
    && (ref.originalEstimatedTokens ?? 0) > 0
    && (ref.originalBytes ?? 0) > 0;
}

function pruneStaleToolResultsBeforeCompact(
  events: readonly RuntimeEvent[],
  policy: ContextBudgetPolicy,
  charsPerToken: number,
): {
  events: RuntimeEvent[];
  prunedToolResults: number;
  archiveWriteFailures: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
} {
  const prunePolicy = policy.staleToolResultPrune;
  if (prunePolicy?.enabled !== true) {
    return {
      events: [...events],
      prunedToolResults: 0,
      archiveWriteFailures: 0,
      estimatedTokensBefore: 0,
      estimatedTokensAfter: 0,
    };
  }

  const maxResultEstimatedTokens =
    finitePositive(prunePolicy.maxResultEstimatedTokens)
    ?? DEFAULT_MAX_TOOL_RESULT_ESTIMATED_TOKENS;
  const minRecentTurnsFull = Math.max(
    0,
    Math.floor(prunePolicy.minRecentTurnsFull ?? policy.minRecentTurns ?? 1),
  );
  const protectedTurnIds = recentTurnIds(events, minRecentTurnsFull);
  const archiveRefs = normalizeArchiveRefs(prunePolicy.archiveRefs);

  let prunedToolResults = 0;
  let archiveWriteFailures = 0;
  let estimatedTokensBefore = 0;
  let estimatedTokensAfter = 0;
  const prunedEvents = events.map((event) => {
    const content = event.content;
    if (
      event.partial ||
      content?.kind !== 'function_response' ||
      protectedTurnIds.has(turnKey(event))
    ) {
      return event;
    }

    if (isArchivedToolResultPlaceholder(content.result)) return event;

    const serializedResult = serializeToolResultForArchive(content.result);
    const resultBytes = utf8ByteLength(serializedResult);
    const resultEstimatedTokens = estimateTokens(serializedResult.length, charsPerToken);
    if (resultEstimatedTokens <= maxResultEstimatedTokens) return event;

    const archiveRef = archiveRefs.get(event.id);
    if (!archiveRef || !archiveRefMatches(archiveRef, {
      runtimeEventId: event.id,
      toolCallId: content.id,
      toolName: content.name,
      bodySha256: sha256(serializedResult),
      originalBytes: resultBytes,
      originalEstimatedTokens: resultEstimatedTokens,
    })) {
      archiveWriteFailures += 1;
      return event;
    }

    const placeholder: ArchivedToolResultPlaceholder = {
      kind: ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND,
      rewriteVersion: ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
      artifactId: archiveRef.artifactId,
      runtimeEventId: event.id,
      toolCallId: content.id,
      toolName: content.name,
      bodySha256: archiveRef.bodySha256,
      originalEstimatedTokens: resultEstimatedTokens,
      originalBytes: resultBytes,
      reason: 'stale_tool_result_pruned_before_compact',
    };
    const placeholderEstimatedTokens = estimateTokens(stableJsonLength(placeholder), charsPerToken);
    prunedToolResults += 1;
    estimatedTokensBefore += resultEstimatedTokens;
    estimatedTokensAfter += placeholderEstimatedTokens;
    return {
      ...event,
      content: {
        ...content,
        result: placeholder,
      },
    };
  });

  return {
    events: prunedEvents,
    prunedToolResults,
    archiveWriteFailures,
    estimatedTokensBefore,
    estimatedTokensAfter,
  };
}

export function collectStaleToolResultArchiveCandidates(
  events: readonly RuntimeEvent[],
  policy: ContextBudgetPolicy | undefined,
): StaleToolResultArchiveCandidate[] {
  const prunePolicy = policy?.staleToolResultPrune;
  if (prunePolicy?.enabled !== true) return [];
  const charsPerToken = policy?.charsPerToken ?? 4;
  const maxResultEstimatedTokens =
    finitePositive(prunePolicy.maxResultEstimatedTokens)
    ?? DEFAULT_MAX_TOOL_RESULT_ESTIMATED_TOKENS;
  const minRecentTurnsFull = Math.max(
    0,
    Math.floor(prunePolicy.minRecentTurnsFull ?? policy?.minRecentTurns ?? 1),
  );
  const protectedTurnIds = recentTurnIds(events, minRecentTurnsFull);
  const candidates: StaleToolResultArchiveCandidate[] = [];
  for (const event of events) {
    const content = event.content;
    if (
      event.partial ||
      content?.kind !== 'function_response' ||
      protectedTurnIds.has(turnKey(event)) ||
      isArchivedToolResultPlaceholder(content.result)
    ) {
      continue;
    }
    const serializedResult = serializeToolResultForArchive(content.result);
    const originalBytes = utf8ByteLength(serializedResult);
    const originalEstimatedTokens = estimateTokens(serializedResult.length, charsPerToken);
    if (originalEstimatedTokens <= maxResultEstimatedTokens) continue;
    candidates.push({
      runtimeEventId: event.id,
      turnId: event.turnId,
      toolCallId: content.id,
      toolName: content.name,
      result: content.result,
      serializedResult,
      originalEstimatedTokens,
      originalBytes,
      rewriteVersion: ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
      reason: 'stale_tool_result_pruned_before_compact',
    });
  }
  return candidates;
}

export function serializeToolResultForArchive(result: unknown): string {
  if (result === undefined) return 'undefined';
  try {
    return JSON.stringify(result) ?? 'null';
  } catch {
    return String(result);
  }
}

export function isArchivedToolResultPlaceholder(value: unknown): value is ArchivedToolResultPlaceholder {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ArchivedToolResultPlaceholder>;
  return candidate.kind === ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND
    && candidate.rewriteVersion === ARCHIVED_TOOL_RESULT_REWRITE_VERSION
    && typeof candidate.artifactId === 'string'
    && candidate.artifactId.length > 0
    && typeof candidate.runtimeEventId === 'string'
    && candidate.runtimeEventId.length > 0
    && typeof candidate.toolCallId === 'string'
    && candidate.toolCallId.length > 0
    && typeof candidate.toolName === 'string'
    && candidate.toolName.length > 0
    && typeof candidate.bodySha256 === 'string'
    && candidate.bodySha256.length > 0
    && typeof candidate.originalEstimatedTokens === 'number'
    && Number.isFinite(candidate.originalEstimatedTokens)
    && candidate.originalEstimatedTokens > 0
    && typeof candidate.originalBytes === 'number'
    && Number.isFinite(candidate.originalBytes)
    && candidate.originalBytes > 0
    && candidate.reason === 'stale_tool_result_pruned_before_compact';
}

function normalizeArchiveRefs(
  refs: StaleToolResultPrunePolicy['archiveRefs'],
): Map<string, ToolResultArchiveRef> {
  const map = new Map<string, ToolResultArchiveRef>();
  if (!refs) return map;
  if (Array.isArray(refs)) {
    for (const ref of refs) map.set(ref.runtimeEventId, ref);
    return map;
  }
  for (const [runtimeEventId, ref] of Object.entries(refs)) {
    map.set(runtimeEventId, ref);
  }
  return map;
}

function archiveRefMatches(
  ref: ToolResultArchiveRef,
  candidate: {
    runtimeEventId: string;
    toolCallId: string;
    toolName: string;
    bodySha256: string;
    originalEstimatedTokens: number;
    originalBytes: number;
  },
): boolean {
  return ref.runtimeEventId === candidate.runtimeEventId
    && ref.toolCallId === candidate.toolCallId
    && ref.toolName === candidate.toolName
    && ref.rewriteVersion === ARCHIVED_TOOL_RESULT_REWRITE_VERSION
    && ref.reason === 'stale_tool_result_pruned_before_compact'
    && typeof ref.artifactId === 'string'
    && ref.artifactId.length > 0
    && typeof ref.bodySha256 === 'string'
    && ref.bodySha256.length > 0
    && ref.bodySha256 === candidate.bodySha256
    && ref.originalEstimatedTokens === candidate.originalEstimatedTokens
    && ref.originalBytes === candidate.originalBytes;
}

function recentTurnIds(events: readonly RuntimeEvent[], count: number): Set<string> {
  if (count <= 0) return new Set();
  const order: string[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const key = turnKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    order.push(key);
  }
  return new Set(order.slice(Math.max(0, order.length - count)));
}

function turnKey(event: RuntimeEvent): string {
  return event.turnId || '<unknown-turn>';
}

function isHistoryCompactContentEvent(event: RuntimeEvent): boolean {
  return estimateRuntimeEventChars(event) > 0;
}

function estimateRuntimeEventChars(event: RuntimeEvent): number {
  let total = 0;
  const content = event.content;
  if (content?.kind === 'text' || content?.kind === 'thinking') total += content.text.length;
  else if (content?.kind === 'function_call') total += content.name.length + stableJsonLength(content.args);
  else if (content?.kind === 'function_response') total += content.name.length + stableJsonLength(content.result);
  else if (content?.kind === 'error') total += content.message.length;
  return total;
}

function estimateModelMessageChars(message: ModelMessage): number {
  const raw = message as unknown as { content?: unknown };
  return estimateContentChars(raw.content);
}

function estimateContentChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((total, part) => total + estimatePartChars(part), 0);
  }
  return stableJsonLength(content);
}

function estimatePartChars(part: unknown): number {
  if (!part || typeof part !== 'object') return stableJsonLength(part);
  const value = part as Record<string, unknown>;
  let total = 0;
  for (const key of ['text', 'toolName', 'toolCallId'] as const) {
    if (typeof value[key] === 'string') total += value[key].length;
  }
  for (const key of ['input', 'output'] as const) {
    if (value[key] !== undefined) total += stableJsonLength(value[key]);
  }
  return total;
}

function segment(
  kind: PromptSegmentEstimate['kind'],
  chars: number,
  charsPerToken: number,
): PromptSegmentEstimate {
  return {
    kind,
    chars,
    estimatedTokens: estimateTokens(chars, charsPerToken),
  };
}

function stableJsonLength(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}

function buildSynthesisArchiveExcerpts(
  events: readonly RuntimeEvent[],
  refs: ReadonlyArray<Extract<SynthesisSourceRef, { kind: 'archived_tool_result' }>>,
): Array<{ runtimeEventId: string; toolName: string; text: string }> {
  const eventsById = new Map(events.map((event) => [event.id, event]));
  return [...refs]
    .sort((a, b) => a.turnId.localeCompare(b.turnId) || a.runtimeEventId.localeCompare(b.runtimeEventId))
    .map((ref) => {
      const event = eventsById.get(ref.runtimeEventId);
      if (event?.content?.kind !== 'function_response') return undefined;
      if (isArchivedToolResultPlaceholder(event.content.result)) return undefined;
      const serialized = serializeToolResultForArchive(event.content.result);
      return {
        runtimeEventId: ref.runtimeEventId,
        toolName: ref.toolName,
        text: serialized.slice(0, 1_200),
      };
    })
    .filter((item): item is { runtimeEventId: string; toolName: string; text: string } => item !== undefined);
}

function deriveSynthesisQueryKeys(
  query: string,
  refs: ReadonlyArray<Extract<SynthesisSourceRef, { kind: 'archived_tool_result' }>>,
  excerpts: ReadonlyArray<{ text: string }>,
): string[] {
  const candidates = new Set<string>();
  for (const token of tokenizeSearchQuery(query)) {
    const key = normalizeSynthesisQueryKey(token);
    if (isUsefulSynthesisQueryKey(key)) candidates.add(key);
  }
  for (const ref of refs) {
    const toolCallId = normalizeSynthesisQueryKey(ref.toolCallId);
    if (isUsefulSynthesisQueryKey(toolCallId)) candidates.add(toolCallId);
  }
  const excerptText = excerpts.map((excerpt) => excerpt.text.toLowerCase()).join('\n');
  for (const match of excerptText.matchAll(/\b[a-z][a-z0-9_-]{2,64}\b/g)) {
    if (candidates.size >= 12) break;
    const key = normalizeSynthesisQueryKey(match[0]);
    if (isUsefulSynthesisQueryKey(key)) candidates.add(key);
  }
  return [...candidates].sort().slice(0, 12);
}

function buildBoundedSynthesisSummary(
  excerpts: ReadonlyArray<{ runtimeEventId: string; toolName: string; text: string }>,
): string {
  const lines: string[] = [];
  for (const excerpt of excerpts) {
    const normalized = excerpt.text.replace(/\s+/g, ' ').trim();
    if (!normalized) continue;
    lines.push(`${excerpt.toolName}/${excerpt.runtimeEventId}: ${normalized.slice(0, 700)}`);
  }
  return lines.join('\n').slice(0, 2_000);
}

const SYNTHESIS_QUERY_KEY_STOPWORDS = new Set([
  'acknowledge',
  'and',
  'answer',
  'archive',
  'archived',
  'available',
  'call',
  'context',
  'current',
  'debug',
  'do',
  'evidence',
  'exactly',
  'false',
  'for',
  'from',
  'index',
  'is',
  'json',
  'key',
  'kind',
  'lookup',
  'noise',
  'not',
  'only',
  'output',
  'payload',
  'phase',
  'phase7',
  'phase8',
  'phase9',
  'prior',
  'raw',
  'recover',
  'recovery',
  'repeat',
  'result',
  'row',
  'rows',
  'sentinel',
  'show',
  'stable',
  'stale',
  'store',
  'target',
  'text',
  'the',
  'this',
  'tool',
  'tools',
  'true',
  'value',
  'was',
  'were',
]);

function normalizeSynthesisQueryKey(term: string): string {
  return term.toLowerCase().replace(/^[._/:-]+|[._/:-]+$/g, '');
}

function isUsefulSynthesisQueryKey(term: string): boolean {
  return term.length >= 3
    && !SYNTHESIS_QUERY_KEY_STOPWORDS.has(term)
    && !/^\d+$/.test(term);
}

function isValidSynthesisSourceRef(value: unknown): value is SynthesisSourceRef {
  if (!value || typeof value !== 'object') return false;
  const ref = value as Partial<SynthesisSourceRef>;
  if (ref.kind === 'archived_tool_result') {
    const archived = ref as Partial<Extract<SynthesisSourceRef, { kind: 'archived_tool_result' }>>;
    return nonEmpty(archived.sessionId)
      && nonEmpty(archived.turnId)
      && nonEmpty(archived.runtimeEventId)
      && nonEmpty(archived.toolCallId)
      && nonEmpty(archived.toolName)
      && nonEmpty(archived.artifactId)
      && nonEmpty(archived.bodySha256)
      && Number.isFinite(archived.originalEstimatedTokens)
      && Number.isFinite(archived.originalBytes)
      && archived.placeholderReason === 'stale_tool_result_pruned_before_compact';
  }
  if (ref.kind === 'runtime_event' || ref.kind === 'history_search_hit' || ref.kind === 'live_tool_result') {
    return nonEmpty((ref as { sessionId?: string }).sessionId)
      && nonEmpty((ref as { turnId?: string }).turnId)
      && nonEmpty((ref as { runtimeEventId?: string }).runtimeEventId);
  }
  return false;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}

function collectArchiveRetrievalCandidates(
  events: readonly RuntimeEvent[],
  order: NonNullable<ArchiveRetrievalPolicy['order']>,
): Array<{
  event: RuntimeEvent;
  placeholder: ArchivedToolResultPlaceholder;
}> {
  const candidates: Array<{ event: RuntimeEvent; placeholder: ArchivedToolResultPlaceholder }> = [];
  for (const event of events) {
    if (event.content?.kind !== 'function_response') continue;
    if (!isArchivedToolResultPlaceholder(event.content.result)) continue;
    candidates.push({ event, placeholder: event.content.result });
  }
  return order === 'newest_first' ? candidates.reverse() : candidates;
}

function normalizeAllowedTurnIds(
  turnIds: ReadonlySet<string> | readonly string[] | undefined,
): ReadonlySet<string> {
  if (!turnIds) return new Set();
  if (turnIds instanceof Set) return turnIds;
  return new Set(turnIds);
}

function scoreRuntimeEventSearchHit(
  event: RuntimeEvent,
  terms: readonly string[],
): RuntimeEventHistorySearchHit | undefined {
  const haystack = runtimeEventSearchText(event).toLowerCase();
  if (!haystack) return undefined;
  let score = 0;
  const matchedTerms: string[] = [];
  for (const term of terms) {
    if (!haystack.includes(term)) continue;
    matchedTerms.push(term);
    score += term.length;
  }
  if (score <= 0) return undefined;
  return {
    eventId: event.id,
    turnId: turnKey(event),
    ts: event.ts,
    score,
    matchedTerms,
  };
}

function runtimeEventSearchText(event: RuntimeEvent): string {
  const content = event.content;
  if (!content) return '';
  switch (content.kind) {
    case 'text':
    case 'thinking':
      return content.text;
    case 'function_call':
      return `${content.name} ${stableStringify(content.args)}`;
    case 'function_response':
      if (isArchivedToolResultPlaceholder(content.result)) {
        return [
          content.name,
          content.result.toolName,
          content.result.toolCallId,
          content.result.artifactId,
          content.result.bodySha256,
          content.result.reason,
        ].join(' ');
      }
      return `${content.name} ${stableStringify(content.result)}`;
    case 'error':
      return `${content.message} ${content.reason ?? ''} ${content.code ?? ''}`;
  }
}

function buildSynthesisSourceIndex(events: readonly RuntimeEvent[]): Map<string, RuntimeEvent> {
  return new Map(events.map((event) => [event.id, event]));
}

function validateSynthesisCacheBlock(
  block: SynthesisCacheBlock,
  sourceIndex: ReadonlyMap<string, RuntimeEvent>,
  sessionId: string,
): string | undefined {
  if (block.kind !== 'maka.synthesis_cache_block' || block.version !== 1) {
    return 'invalid_schema_version';
  }
  if (sessionId.length > 0 && block.sessionId !== sessionId) {
    return 'session_mismatch';
  }
  if (
    !nonEmpty(block.blockId) ||
    !nonEmpty(block.sessionId) ||
    !Number.isFinite(block.createdAt) ||
    !nonEmpty(block.highWaterName) ||
    !Number.isFinite(block.highWaterSeq) ||
    !nonEmpty(block.summary) ||
    !Array.isArray(block.limitations) ||
    block.sourceRefs.length === 0
  ) {
    return 'source_missing';
  }
  if (
    block.coverage.queryKeys.length === 0 ||
    block.coverage.turnIds.length === 0 ||
    block.coverage.runtimeEventIds.length === 0 ||
    block.coverage.artifactIds.length === 0 ||
    block.coverage.bodySha256.length === 0 ||
    !allNonEmpty(block.coverage.queryKeys) ||
    !allNonEmpty(block.coverage.turnIds) ||
    !allNonEmpty(block.coverage.runtimeEventIds) ||
    !allNonEmpty(block.coverage.toolNames) ||
    !allNonEmpty(block.coverage.toolCallIds) ||
    !allNonEmpty(block.coverage.artifactIds) ||
    !allNonEmpty(block.coverage.bodySha256)
  ) {
    return 'source_missing';
  }

  for (const ref of block.sourceRefs) {
    const event = sourceIndex.get(ref.runtimeEventId);
    if (!event) return ref.kind === 'archived_tool_result' ? 'source_missing' : 'coverage_miss';
    if (ref.sessionId !== block.sessionId || (sessionId.length > 0 && ref.sessionId !== sessionId)) {
      return 'session_mismatch';
    }
    if (event.turnId !== ref.turnId) return 'source_hash_mismatch';
    if (ref.kind === 'archived_tool_result') {
      if (
        !nonEmpty(ref.artifactId) ||
        !nonEmpty(ref.bodySha256) ||
        !nonEmpty(ref.toolCallId) ||
        !nonEmpty(ref.toolName) ||
        ref.originalEstimatedTokens <= 0 ||
        ref.originalBytes <= 0 ||
        ref.placeholderReason !== 'stale_tool_result_pruned_before_compact'
      ) {
        return 'source_missing';
      }
      if (event.content?.kind !== 'function_response') return 'source_hash_mismatch';
      if (!isArchivedToolResultPlaceholder(event.content.result)) return 'source_hash_mismatch';
      const placeholder = event.content.result;
      if (
        placeholder.artifactId !== ref.artifactId ||
        placeholder.bodySha256 !== ref.bodySha256 ||
        placeholder.toolCallId !== ref.toolCallId ||
        placeholder.toolName !== ref.toolName ||
        placeholder.originalEstimatedTokens !== ref.originalEstimatedTokens ||
        placeholder.originalBytes !== ref.originalBytes ||
        placeholder.reason !== ref.placeholderReason
      ) {
        return 'source_hash_mismatch';
      }
    }
  }
  return undefined;
}

function synthesisBlockCoversQuery(block: SynthesisCacheBlock, query: string): boolean {
  return block.coverage.queryKeys.some((key) => queryContainsCoveredKey(query, key));
}

function queryContainsCoveredKey(query: string, key: string): boolean {
  const normalizedQuery = query.toLowerCase();
  const normalizedKey = key.toLowerCase().trim();
  if (normalizedKey.length === 0) return false;
  let index = normalizedQuery.indexOf(normalizedKey);
  while (index >= 0) {
    const before = index === 0 ? '' : normalizedQuery[index - 1]!;
    const after = normalizedQuery[index + normalizedKey.length] ?? '';
    if (!isQueryKeyContinuation(before) && !isQueryKeyContinuation(after)) {
      return true;
    }
    index = normalizedQuery.indexOf(normalizedKey, index + normalizedKey.length);
  }
  return false;
}

function isQueryKeyContinuation(char: string): boolean {
  return /^[a-z0-9_-]$/.test(char);
}

export function rawEvidenceRequestReason(query: string): 'raw_evidence_requested' | 'exact_output_requested' | undefined {
  const normalized = query.toLowerCase();
  if (/\b(exact|verbatim|original wording|word-for-word|full output)\b/.test(normalized)) {
    return 'exact_output_requested';
  }
  if (/\b(raw|evidence|proof|show how|debug|source|archive|tool output|original tool)\b/.test(normalized)) {
    return 'raw_evidence_requested';
  }
  return undefined;
}

function newerRelevantToolResultReason(
  block: SynthesisCacheBlock,
  events: readonly RuntimeEvent[],
  query: string,
): 'new_relevant_tool_result' | undefined {
  const sourceEventIds = new Set(block.coverage.runtimeEventIds);
  const toolNames = new Set(block.coverage.toolNames);
  const sourceTimes = events
    .filter((event) => sourceEventIds.has(event.id))
    .map((event) => event.ts);
  const newestSourceTs = sourceTimes.length > 0 ? Math.max(...sourceTimes) : block.createdAt;
  const keys = block.coverage.queryKeys.map((key) => key.toLowerCase());
  const queryText = query.toLowerCase();
  for (const event of events) {
    if (event.ts <= newestSourceTs || event.content?.kind !== 'function_response') continue;
    if (sourceEventIds.has(event.id) || !toolNames.has(event.content.name)) continue;
    const eventText = runtimeEventSearchText(event).toLowerCase();
    if (keys.some((key) => eventText.includes(key) || queryText.includes(key))) {
      return 'new_relevant_tool_result';
    }
  }
  return undefined;
}

function synthesisBlockRuntimeEvent(block: SynthesisCacheBlock, sessionId: string): RuntimeEvent {
  return {
    id: `synthesis-cache:${block.blockId}`,
    sessionId,
    runId: `synthesis-cache:${block.blockId}`,
    turnId: `synthesis-cache:${block.highWaterSeq}`,
    invocationId: `synthesis-cache:${block.blockId}`,
    ts: block.createdAt,
    partial: false,
    role: 'model',
    author: 'system',
    content: {
      kind: 'text',
      text: renderSynthesisCacheBlock(block),
    },
    refs: {
      artifactId: block.coverage.artifactIds[0],
    },
  };
}

function renderSynthesisSourceRef(ref: SynthesisSourceRef): string {
  switch (ref.kind) {
    case 'archived_tool_result':
      return `archived_tool_result(runtimeEventId=${ref.runtimeEventId}, turnId=${ref.turnId}, artifactId=${ref.artifactId}, bodySha256=${ref.bodySha256}, toolName=${ref.toolName})`;
    case 'runtime_event':
      return `runtime_event(runtimeEventId=${ref.runtimeEventId}, turnId=${ref.turnId}, role=${ref.role}, contentKind=${ref.contentKind})`;
    case 'history_search_hit':
      return `history_search_hit(runtimeEventId=${ref.runtimeEventId}, turnId=${ref.turnId}, score=${ref.score}, matchedTerms=${ref.matchedTerms.join('|')})`;
    case 'live_tool_result':
      return `live_tool_result(runtimeEventId=${ref.runtimeEventId}, turnId=${ref.turnId}, toolName=${ref.toolName}, resultSha256=${ref.resultSha256})`;
  }
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function allNonEmpty(values: readonly unknown[]): boolean {
  return values.every(nonEmpty);
}

function tokenizeSearchQuery(query: string): string[] {
  return [...new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9_./:-]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2),
  )].slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function finitePositive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function finiteRatio(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(1, value);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function boundText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 14)).trimEnd()}\n[truncated]`;
}
