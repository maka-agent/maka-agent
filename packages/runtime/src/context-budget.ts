import { Buffer } from 'node:buffer';
import {
  estimateTokens,
  estimateRuntimeEventChars,
  estimateRuntimeEventsTokens,
  stableJsonLength,
  turnKey,
  groupEventsByTurn,
  uniqueSorted,
  sha256,
  stableStringify,
  finitePositive,
  nonEmpty,
  allNonEmpty,
  increment,
  escapeAttribute,
  tokenizeSearchQuery,
} from './context-budget-helpers.js';

export { estimateTokens, estimateRuntimeEventsTokens };

export * from './synthesis-cache.js';
import {
  ActiveToolResultPrunePolicy,
  ArchiveRetrievalPolicy,
  HistoryCompactSourceArchiveRef,
  isValidHistoryCompactSourceArchiveRef,
  isValidSynthesisSourceRef,
  optionalNonNegativeFiniteNumber,
  pruneStaleToolResultsBeforeCompact,
  runtimeEventArchiveBody,
  runtimeEventBodySha256,
  RuntimeEventHistoryAroundResult,
  RuntimeEventHistorySearchPolicy,
  searchRuntimeEventHistory,
  StaleToolResultPrunePolicy,
  SynthesisCachePolicy,
  SynthesisSourceRef,
  utf8ByteLength,
} from './synthesis-cache.js';
import type { ModelMessage } from 'ai';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type {
  CompactionDecisionDiagnostic,
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
import {
  historyCompactCheckpointToRuntimeEvent,
  matchHistoryCompactCheckpointPrefix,
  midTurnHeadAnchorEvent,
  renderHistoryCompactCheckpoint,
  type HistoryCompactCheckpoint,
} from './history-compact-checkpoint.js';

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

export type HistoryCompactCheckpointReplayFit =
  | { fits: true; checkpointTokens: number; replayTokens: number }
  | {
      fits: false;
      checkpointTokens: number;
      replayTokens: number;
      reason: 'prefix_over_budget' | 'replacement_not_smaller';
    };

export interface HistoryCompactReplayOptions {
  charsPerToken?: number;
  maxHistoryEstimatedTokens?: number;
  sourceReplayEvents?: readonly RuntimeEvent[];
  /** Selects the continuation seam without changing the shared compaction implementation. */
  historyCompactProtocol?: 'legacy_v1' | 'checkpoint_v2';
}

/** The single current-policy gate for every checkpoint entering model replay. */
export function evaluateHistoryCompactCheckpointReplay(
  checkpoint: HistoryCompactCheckpoint,
  replayTail: readonly RuntimeEvent[],
  policy: ContextBudgetPolicy,
  options: HistoryCompactReplayOptions = {},
): HistoryCompactCheckpointReplayFit {
  const charsPerToken = options.charsPerToken ?? policy.charsPerToken ?? 4;
  const checkpointEvent = historyCompactCheckpointToRuntimeEvent(checkpoint);
  const checkpointTokens = estimateRuntimeEventsTokens([checkpointEvent], charsPerToken);
  const replayTokens = estimateRuntimeEventsTokens([checkpointEvent, ...replayTail], charsPerToken);
  const maxHistoryTokens = finitePositive(
    options.maxHistoryEstimatedTokens ?? policy.maxHistoryEstimatedTokens,
  );
  if (maxHistoryTokens !== undefined && replayTokens > maxHistoryTokens) {
    return { fits: false, checkpointTokens, replayTokens, reason: 'prefix_over_budget' };
  }
  if (options.sourceReplayEvents) {
    const sourceReplayTokens = estimateRuntimeEventsTokens(
      options.sourceReplayEvents,
      charsPerToken,
    );
    if (replayTokens >= sourceReplayTokens) {
      return { fits: false, checkpointTokens, replayTokens, reason: 'replacement_not_smaller' };
    }
  }
  return { fits: true, checkpointTokens, replayTokens };
}

export interface HistoryCompactPolicy {
  enabled: boolean;
  /** `lookup` only replays supplied blocks; `read_write` may persist a host replacement for a deterministic draft. */
  mode?: 'deterministic' | 'lookup' | 'read_write';
  /** Source-bearing compact blocks available for the current replay projection. */
  blocks?: readonly HistoryCompactBlock[];
  /** V2 checkpoint loaded from the run ledger. Preferred over legacy V1 blocks. */
  checkpoint?: HistoryCompactCheckpoint;
  /** Legacy V1 deterministic-block limit. V2 LLM checkpoints are validated as a complete replay. */
  maxBlocks?: number;
  /** Legacy V1 deterministic-block token limit. V2 LLM checkpoints use the history capacity. */
  maxEstimatedTokens?: number;
  /** Legacy V1 per-block token limit. V2 LLM checkpoints are not truncated to this size. */
  maxBlockEstimatedTokens?: number;
  /** Compact once prior history exceeds this ratio of maxHistoryEstimatedTokens. Defaults to 0.8. */
  highWaterRatio?: number;
  /** Diagnostic high-water ratio reserved for future forced compaction. Defaults to 0.9. */
  forceRatio?: number;
  /** Legacy V1 tail target. Ignored by the V2 checkpoint protocol. */
  targetRatio?: number;
  /** Legacy V1 explicit tail budget. Ignored by the V2 checkpoint protocol. */
  tailEstimatedTokens?: number;
  /** Legacy V1 recent-turn request. V2 keeps exactly the latest complete turn at turn boundaries. */
  minRecentTurns?: number;
  /** Legacy V1 deterministic-summary estimate. Defaults to 768. */
  maxSummaryEstimatedTokens?: number;
  /** Current block schema version. Defaults to 1. */
  summarySchemaVersion?: 1;
  /**
   * If true, every compacted RuntimeEvent must have a matching sourceArchiveRef.
   * The default false mode remains source-bearing through RuntimeEvent refs only.
   */
  archiveRequired?: boolean;
  /** Optional archive refs keyed by RuntimeEvent id for archive-before-project validation. */
  sourceArchiveRefs?:
    | readonly HistoryCompactSourceArchiveRef[]
    | Readonly<Record<string, HistoryCompactSourceArchiveRef>>;
  highWaterName?: string;
  /**
   * Optional mid-turn capacity compaction, layered on the same V2 checkpoint
   * protocol. Omitting the field in a handwritten policy leaves it off; the
   * shared runtime default (buildDefaultContextBudgetPolicy) enables it
   * whenever history compaction is on, unless MAKA_CONTEXT_HISTORY_COMPACT_MID_TURN
   * opts out. When enabled the backend measures the next provider request
   * between steps and folds a safe completed prefix before crossing the model
   * context window.
   */
  midTurn?: HistoryCompactMidTurnPolicy;
}

export interface HistoryCompactMidTurnPolicy {
  enabled: boolean;
  /**
   * Tokens kept free below the selected model context window. The proactive
   * high-water threshold is `contextWindow - reserveTokens`. Defaults to 16384
   * when omitted in a handwritten policy; the shared runtime default always
   * supplies a window-bounded value.
   */
  reserveTokens?: number;
  /** Trailing events kept verbatim as the continuation tail. Defaults to 1. */
  reserveTailEvents?: number;
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
  checkpoint?: HistoryCompactCheckpoint;
  diagnosticPatch: Partial<ContextBudgetDiagnostic>;
}

export interface HistoryRewriteGatePolicy {
  enabled: boolean;
  name?: string;
  historyRewriteVersion: string;
  resetReason: string;
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
  options: Pick<HistoryCompactReplayOptions, 'historyCompactProtocol'> = {},
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
      historyRewriteEnabled,
  );
  if (!enabled) return undefined;
  if (!policy) return undefined;
  const charsPerToken = policy?.charsPerToken ?? 4;
  const maxTokens = finitePositive(policy?.maxHistoryEstimatedTokens);
  const maxTurns = finitePositive(policy?.maxHistoryTurns);
  const minRecentTurns = Math.max(0, Math.floor(policy?.minRecentTurns ?? 1));
  const estimatedTokensBefore = estimateRuntimeEventsTokens(events, charsPerToken);
  const pruned = pruneStaleToolResultsBeforeCompact(
    events,
    policy?.staleToolResultPrune,
    charsPerToken,
    policy?.minRecentTurns,
  );
  const compacted = applyRuntimeEventHistoryCompact(pruned.events, policy, {
    charsPerToken,
    maxHistoryEstimatedTokens: maxTokens,
    ...(options.historyCompactProtocol
      ? { historyCompactProtocol: options.historyCompactProtocol }
      : {}),
  });
  const hasCompactedReplay = compacted.blocks.length > 0 || compacted.checkpoint !== undefined;
  const budgetEvents = hasCompactedReplay ? compacted.events : pruned.events;
  const turnGroups = groupEventsByTurn(
    budgetEvents.filter(isHistoryCompactContentEvent),
    charsPerToken,
  );

  const keptTurnIds = new Set<string>();
  let keptEvents: RuntimeEvent[];
  if (hasCompactedReplay) {
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
        maxTokens !== undefined && keptTokens > 0 && keptTokens + group.estimatedTokens > maxTokens;
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
    droppedTurns: hasCompactedReplay
      ? compacted.blocks.reduce((total, block) => total + block.coverage.turnIds.length, 0) +
        (compacted.checkpoint?.coverage.turnCount ?? 0)
      : Math.max(0, turnGroups.length - keptTurnIds.size),
    keptEvents: keptEvents.length,
    droppedEvents: Math.max(
      0,
      (hasCompactedReplay ? pruned.events.length : budgetEvents.length) - keptEvents.length,
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
  options: HistoryCompactReplayOptions = {},
): HistoryCompactReplayResult {
  const compactPolicy = policy?.historyCompact;
  if (compactPolicy?.enabled !== true) {
    return { events: [...events], blocks: [], diagnosticPatch: {} };
  }

  const charsPerToken = options.charsPerToken ?? policy?.charsPerToken ?? 4;
  const maxTokens = finitePositive(
    options.maxHistoryEstimatedTokens ?? policy?.maxHistoryEstimatedTokens,
  );
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

  // A mid_turn checkpoint's coverage reaches into the compacted turn's own
  // completed steps, so it can extend past what tail selection would retain
  // and must not require multiple prior turns. Match it against the full
  // content projection BEFORE every size-based guard — including the
  // below-high-water skip: replaying an accepted mid_turn checkpoint is a
  // correctness invariant (the covered raw span must never be re-injected),
  // not a capacity optimization, so a small raw projection does not bypass
  // it. Replay is the deterministic [block, verbatim head anchor, tail].
  const midTurnCheckpoint =
    compactPolicy.checkpoint?.phase === 'mid_turn' ? compactPolicy.checkpoint : undefined;
  if (midTurnCheckpoint) {
    const match = matchHistoryCompactCheckpointPrefix(midTurnCheckpoint, compactableEvents);
    if (match.reason) {
      increment(skippedReasonCounts, match.reason);
    } else {
      const headAnchor = midTurnHeadAnchorEvent(midTurnCheckpoint, match.coveredRuntimeEvents);
      const replayTail = headAnchor
        ? [headAnchor, ...match.successorRuntimeEvents]
        : [...match.successorRuntimeEvents];
      const fit = evaluateHistoryCompactCheckpointReplay(midTurnCheckpoint, replayTail, policy!, {
        charsPerToken,
        maxHistoryEstimatedTokens: maxTokens,
        sourceReplayEvents: [...match.coveredRuntimeEvents, ...match.successorRuntimeEvents],
      });
      if (!fit.fits) {
        increment(skippedReasonCounts, fit.reason);
      } else {
        return {
          events: [historyCompactCheckpointToRuntimeEvent(midTurnCheckpoint), ...replayTail],
          blocks: [],
          checkpoint: midTurnCheckpoint,
          diagnosticPatch: {
            ...basePatch,
            historyCompactBlocksAvailable: 1,
            historyCompactBlocksSelected: 1,
            historyCompactBlockIds: [midTurnCheckpoint.checkpointId],
            historyCompactedTurns: midTurnCheckpoint.coverage.turnCount,
            historyCompactedEvents: midTurnCheckpoint.coverage.eventCount,
            historyCompactedEstimatedTokensBefore: estimateRuntimeEventsTokens(
              match.coveredRuntimeEvents,
              charsPerToken,
            ),
            historyCompactedEstimatedTokensAfter: fit.checkpointTokens,
            historyCompactCoverageHashes: [midTurnCheckpoint.coverage.sourceDigest],
            highWaterName: midTurnCheckpoint.highWaterName,
            highWaterSeq: midTurnCheckpoint.highWaterSeq,
            highWaterReason: 'history_compact',
            ...compactionDecisionDiagnosticPatch({
              stage: 'priorReplay',
              sourceKind: 'runtimeEvents',
              decision: 'replaced',
              phase: 'mid_turn',
              boundaryKind: 'historyCompact',
              boundaryIds: [midTurnCheckpoint.checkpointId],
              coverage: { bodySha256: [midTurnCheckpoint.coverage.sourceDigest] },
              estimatedTokensBefore: estimateRuntimeEventsTokens(
                match.coveredRuntimeEvents,
                charsPerToken,
              ),
              estimatedTokensAfter: fit.checkpointTokens,
            }),
          },
        };
      }
    }
  }

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

  const usesCheckpointV2Seam =
    options.historyCompactProtocol === 'checkpoint_v2' || compactPolicy.checkpoint !== undefined;
  const tailSelection = usesCheckpointV2Seam
    ? selectLatestCompleteTurnEvents(turnGroups)
    : selectLegacyHistoryCompactTailEvents(turnGroups, {
        tailBudget:
          finitePositive(compactPolicy.tailEstimatedTokens) ??
          Math.max(1, Math.floor(maxTokens * finiteRatio(compactPolicy.targetRatio, 0.5))),
      });
  const retainedEventIds = tailSelection.eventIds;
  const tailTurnIds = tailSelection.turnIds;
  const foldedEvents = compactableEvents.filter((event) => !retainedEventIds.has(event.id));
  const retainedEvents = compactableEvents.filter((event) => retainedEventIds.has(event.id));
  if (foldedEvents.length === 0) {
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

  // mid_turn checkpoints were handled above against the full content projection.
  const checkpoint =
    compactPolicy.checkpoint?.phase === 'mid_turn' ? undefined : compactPolicy.checkpoint;
  if (checkpoint) {
    const match = matchHistoryCompactCheckpointPrefix(checkpoint, foldedEvents);
    if (match.reason) {
      increment(skippedReasonCounts, match.reason);
    } else {
      const replayTail = [...match.successorRuntimeEvents, ...retainedEvents];
      const fit = evaluateHistoryCompactCheckpointReplay(checkpoint, replayTail, policy!, {
        charsPerToken,
        maxHistoryEstimatedTokens: maxTokens,
        sourceReplayEvents: [...match.coveredRuntimeEvents, ...replayTail],
      });
      if (!fit.fits) {
        increment(skippedReasonCounts, fit.reason);
      } else {
        const outputEvents = [historyCompactCheckpointToRuntimeEvent(checkpoint), ...replayTail];
        const checkpointTokens = fit.checkpointTokens;
        return {
          events: outputEvents,
          blocks: [],
          checkpoint,
          diagnosticPatch: {
            ...basePatch,
            historyCompactBlocksAvailable: 1,
            historyCompactBlocksSelected: 1,
            historyCompactBlockIds: [checkpoint.checkpointId],
            historyCompactedTurns: checkpoint.coverage.turnCount,
            historyCompactedEvents: checkpoint.coverage.eventCount,
            historyCompactedEstimatedTokensBefore: estimateRuntimeEventsTokens(
              match.coveredRuntimeEvents,
              charsPerToken,
            ),
            historyCompactedEstimatedTokensAfter: checkpointTokens,
            historyCompactCoverageHashes: [checkpoint.coverage.sourceDigest],
            highWaterName: checkpoint.highWaterName,
            highWaterSeq: checkpoint.highWaterSeq,
            highWaterReason: 'history_compact',
            ...compactionDecisionDiagnosticPatch({
              stage: 'priorReplay',
              sourceKind: 'runtimeEvents',
              decision: 'replaced',
              boundaryKind: 'historyCompact',
              boundaryIds: [checkpoint.checkpointId],
              coverage: {
                bodySha256: [checkpoint.coverage.sourceDigest],
              },
              estimatedTokensBefore: estimateRuntimeEventsTokens(
                match.coveredRuntimeEvents,
                charsPerToken,
              ),
              estimatedTokensAfter: checkpointTokens,
            }),
          },
        };
      }
    }
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
    const outputEvents = [
      historyCompactBlockToRuntimeEvent(loadedBlock),
      ...uncoveredFoldedEvents,
      ...retainedEvents,
    ];
    if (fitsHistoryBudget(outputEvents, maxTokens, charsPerToken)) {
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
  const estimatedTokensAfterFold =
    block.estimatedTokens ?? estimateTokens(blockText.length, charsPerToken);
  const boundary = historyCompactBlockToCompactionBoundary(block, {
    renderedText: blockText,
    preservedAnchor: { tailTurnIds: [...tailTurnIds] },
    validationStatus: 'valid',
  });
  const synthetic = historyCompactBlockToRuntimeEvent(block);
  const outputEvents = [synthetic, ...retainedEvents];
  if (!fitsHistoryBudget(outputEvents, maxTokens, charsPerToken)) {
    increment(skippedReasonCounts, 'replay_over_budget');
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

// Model-visible rendering stays bounded regardless of how many events the
// block folds: per-event ids, hashes, and archive refs live only in the
// persisted block JSON, where coverage validation and replay read them.
export function renderHistoryCompactBlock(block: HistoryCompactBlock): string {
  const archiveCount = block.sourceArchiveRefs?.length ?? 0;
  return [
    `<maka_history_compact_block id="${escapeAttribute(block.blockId)}" high_water="${escapeAttribute(block.highWaterName)}" seq="${block.highWaterSeq}" version="${block.version}">`,
    `summary: ${block.summary}`,
    `coverage: ${block.coverage.runtimeEventIds.length} runtime events across ${block.coverage.turnIds.length} turns, contentKinds=[${block.coverage.contentKinds.join(', ')}]${archiveCount > 0 ? `, archivedSources=${archiveCount}` : ''}`,
    `limitations: ${block.limitations.join('; ')}`,
    '</maka_history_compact_block>',
  ].join('\n');
}

export function validateHistoryCompactBlockShape(
  value: unknown,
  sessionId?: string,
): value is HistoryCompactBlock {
  if (!value || typeof value !== 'object') return false;
  const block = value as Partial<HistoryCompactBlock>;
  return (
    block.kind === 'maka.history_compact_block' &&
    block.version === 1 &&
    nonEmpty(block.blockId) &&
    nonEmpty(block.sessionId) &&
    (sessionId === undefined || block.sessionId === sessionId) &&
    Number.isFinite(block.createdAt) &&
    nonEmpty(block.highWaterName) &&
    Number.isFinite(block.highWaterSeq) &&
    !!block.coverage &&
    Array.isArray(block.coverage.turnIds) &&
    Array.isArray(block.coverage.runtimeEventIds) &&
    Array.isArray(block.coverage.contentKinds) &&
    Array.isArray(block.coverage.bodySha256) &&
    allNonEmpty(block.coverage.turnIds) &&
    allNonEmpty(block.coverage.runtimeEventIds) &&
    allNonEmpty(block.coverage.contentKinds) &&
    allNonEmpty(block.coverage.bodySha256) &&
    typeof block.summary === 'string' &&
    block.summary.length > 0 &&
    Array.isArray(block.limitations) &&
    Array.isArray(block.sourceRefs) &&
    block.sourceRefs.length > 0 &&
    block.sourceRefs.every(isValidSynthesisSourceRef) &&
    optionalNonNegativeFiniteNumber(block.estimatedTokens) &&
    (block.sourceArchiveRefs === undefined ||
      (Array.isArray(block.sourceArchiveRefs) &&
        block.sourceArchiveRefs.every(isValidHistoryCompactSourceArchiveRef)))
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
  const createdAt = Math.max(input.now ?? 1, ...input.foldedRuntimeEvents.map((event) => event.ts));
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
  const summary = boundText(
    input.summary,
    Math.max(80, maxSummaryTokens * Math.max(1, charsPerToken)),
  );
  const blockDraft = {
    version: 1,
    sessionId: input.sessionId,
    highWaterName,
    highWaterSeq,
    coverage,
    summary,
  };
  const sourceArchiveRefs =
    input.sourceArchiveRefs?.filter(isValidHistoryCompactSourceArchiveRef) ?? [];
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
        ? [
            'No archive refs are attached; source coverage is by RuntimeEvent ids and content hashes.',
          ]
        : []),
    ],
    sourceRefs,
    ...(sourceArchiveRefs.length > 0 ? { sourceArchiveRefs } : {}),
    ...(input.requestShapeHashBefore
      ? { requestShapeHashBefore: input.requestShapeHashBefore }
      : {}),
    ...(input.requestShapeHashAfter ? { requestShapeHashAfter: input.requestShapeHashAfter } : {}),
  };
  block.estimatedTokens = estimateTokens(renderHistoryCompactBlock(block).length, charsPerToken);
  return block;
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
      ...(input.priorRuntimeEventCount !== undefined
        ? { eventCount: input.priorRuntimeEventCount }
        : {}),
    },
    segment('current_user', input.currentUserContent.length, charsPerToken),
    segment('turn_tail', input.turnTailPrompt?.length ?? 0, charsPerToken),
  ];
}

export function estimateModelMessagesChars(messages: readonly ModelMessage[]): number {
  return messages.reduce((total, message) => total + estimateModelMessageChars(message), 0);
}

function fitsHistoryBudget(
  events: readonly RuntimeEvent[],
  maxTokens: number | undefined,
  charsPerToken: number,
): boolean {
  return maxTokens === undefined || estimateRuntimeEventsTokens(events, charsPerToken) <= maxTokens;
}

function selectLatestCompleteTurnEvents(
  turnGroups: ReadonlyArray<{
    turnId: string;
    estimatedTokens: number;
    events: readonly RuntimeEvent[];
  }>,
): { eventIds: Set<string>; turnIds: Set<string> } {
  const eventIds = new Set<string>();
  const turnIds = new Set<string>();
  const latest = turnGroups.at(-1);
  if (!latest) return { eventIds, turnIds };
  turnIds.add(latest.turnId);
  for (const event of latest.events) eventIds.add(event.id);
  return { eventIds, turnIds };
}

function selectLegacyHistoryCompactTailEvents(
  turnGroups: ReadonlyArray<{
    turnId: string;
    estimatedTokens: number;
    events: readonly RuntimeEvent[];
  }>,
  options: { tailBudget: number },
): { eventIds: Set<string>; turnIds: Set<string> } {
  const eventIds = new Set<string>();
  const turnIds = new Set<string>();
  let selectedTokens = 0;
  for (let index = turnGroups.length - 1; index >= 0; index -= 1) {
    const group = turnGroups[index]!;
    if (selectedTokens + group.estimatedTokens > options.tailBudget) {
      if (eventIds.size === 0) {
        const fallbackIds = latestCompleteStepEventIds(group.events);
        for (const id of fallbackIds) eventIds.add(id);
        if (fallbackIds.length > 0) turnIds.add(group.turnId);
      }
      break;
    }
    turnIds.add(group.turnId);
    for (const event of group.events) eventIds.add(event.id);
    selectedTokens += group.estimatedTokens;
  }
  return { eventIds, turnIds };
}

function latestCompleteStepEventIds(events: readonly RuntimeEvent[]): string[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.content?.kind !== 'function_response') continue;
    for (let callIndex = index - 1; callIndex >= 0; callIndex -= 1) {
      const call = events[callIndex]!;
      if (call.content?.kind === 'function_call' && call.content.id === event.content.id) {
        return [call.id, event.id];
      }
    }
  }
  const latest = events.at(-1);
  return latest ? [latest.id] : [];
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
    finitePositive(policy.maxBlockEstimatedTokens) ??
    finitePositive(policy.maxSummaryEstimatedTokens) ??
    1_024;
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
      block.estimatedTokens ??
      estimateTokens(renderHistoryCompactBlock(block).length, options.charsPerToken);
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
    return {
      block: { ...block, estimatedTokens: blockTokens },
      coveredEvents: validation.coveredEvents,
    };
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
  if (!validateHistoryCompactBlockShape(block, sessionId || undefined))
    return { reason: 'invalid_schema_version', coveredEvents: [] };
  if (sessionId.length > 0 && block.sessionId !== sessionId)
    return { reason: 'session_mismatch', coveredEvents: [] };
  const coverageIds = new Set(block.coverage.runtimeEventIds);
  const coveredEvents: RuntimeEvent[] = [];
  for (const event of foldedEvents) {
    if (!coverageIds.has(event.id)) break;
    if (!block.coverage.turnIds.includes(turnKey(event)))
      return { reason: 'coverage_miss', coveredEvents: [] };
    if (!block.coverage.contentKinds.includes(event.content?.kind ?? 'none'))
      return { reason: 'coverage_miss', coveredEvents: [] };
    if (!block.coverage.bodySha256.includes(runtimeEventBodySha256(event)))
      return { reason: 'source_hash_mismatch', coveredEvents: [] };
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
    lines.push(
      `- ${turnKey(event)}/${event.id}/${event.role}/${event.content?.kind ?? 'none'}: ${excerpt}`,
    );
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
      return normalizeWhitespace(`${content.name} ${stableStringify(content.result)}`).slice(
        0,
        220,
      );
    case 'error':
      return normalizeWhitespace(
        `${content.code ?? ''} ${content.reason ?? ''} ${content.message}`,
      ).slice(0, 220);
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
  const decision: CompactionDecisionKind =
    reason === 'archive_missing' || reason === 'archive_mismatch' ? 'failedOpen' : 'unchanged';
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
  return (
    ref.runtimeEventId === event.id &&
    nonEmpty(ref.artifactId) &&
    ref.bodySha256 === sha256(body) &&
    ref.originalEstimatedTokens === estimateTokens(body.length, charsPerToken) &&
    ref.originalBytes === utf8ByteLength(body)
  );
}

/** True when the event carries model-visible content the compact projection counts. */
export function isHistoryCompactContentEvent(event: RuntimeEvent): boolean {
  return estimateRuntimeEventChars(event) > 0;
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

// ============================================================================
// Replay ordering + context-budget diagnostic merge helpers.
// Relocated from ai-sdk-backend.ts: these are pure functions over
// RuntimeEvent / ContextBudgetDiagnostic and belong to this budgeting domain.
// ============================================================================

export function mergeRuntimeEventsInOriginalOrder(
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

export function buildContextBudgetDiagnosticShell(
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

export function runtimeEventTurnKey(event: RuntimeEvent): string {
  return event.turnId || '<unknown-turn>';
}

export function retrieveReplayHistoryAroundSearchSource(
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
  const maxEstimatedTokens =
    typeof policy.maxEstimatedTokens === 'number' &&
    Number.isFinite(policy.maxEstimatedTokens) &&
    policy.maxEstimatedTokens > 0
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
    for (
      let cursor = Math.max(0, index - around);
      cursor <= Math.min(replayEvents.length - 1, index + around);
      cursor += 1
    ) {
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

export function buildHistorySearchSource(
  events: readonly RuntimeEvent[],
  policy: ContextBudgetPolicy | undefined,
): readonly RuntimeEvent[] {
  if (policy?.staleToolResultPrune?.enabled !== true) return events;
  return (
    applyRuntimeEventContextBudget(events, {
      ...policy,
      maxHistoryEstimatedTokens: undefined,
      maxHistoryTurns: undefined,
      archiveRetrieval: undefined,
      historySearch: undefined,
      historyRewrite: undefined,
    })?.events ?? events
  );
}

export function mergeContextBudgetDiagnostic(
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
    ...mergeCompactionDecisionDiagnostics(base.compactionDecisions, patch.compactionDecisions),
  };
}

export function mergeContextBudgetDiagnosticPatches(
  left: Partial<ContextBudgetDiagnostic> | undefined,
  right: Partial<ContextBudgetDiagnostic> | undefined,
): Partial<ContextBudgetDiagnostic> | undefined {
  if (!left && !right) return undefined;
  if (!left) return right;
  if (!right) return left;
  return mergeContextBudgetDiagnostic(left as ContextBudgetDiagnostic, right);
}

export function shouldAppendContextCompactedNote(
  contextBudget: ContextBudgetDiagnostic | undefined,
): boolean {
  if ((contextBudget?.historyCompactBlocksWritten ?? 0) <= 0) return false;
  return (
    contextBudget?.compactionDecisions?.some(
      (decision) =>
        decision.stage === 'priorReplay' &&
        decision.boundaryKind === 'historyCompact' &&
        decision.decision === 'replaced',
    ) === true
  );
}

export function shouldAppendContextCompactionFailedOpenNote(
  contextBudget: ContextBudgetDiagnostic | undefined,
): boolean {
  return (
    (contextBudget?.historyCompactWriteFailures ?? 0) > 0 &&
    contextBudget?.compactionDecisions?.some(
      (decision) =>
        decision.stage === 'priorReplay' &&
        decision.boundaryKind === 'historyCompact' &&
        decision.decision === 'failedOpen',
    ) === true
  );
}

export function minimalContextBudgetDiagnostic(): ContextBudgetDiagnostic {
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

function mergeCompactionDecisionDiagnostics(
  left: readonly CompactionDecisionDiagnostic[] | undefined,
  right: readonly CompactionDecisionDiagnostic[] | undefined,
): { compactionDecisions: CompactionDecisionDiagnostic[] } | Record<string, never> {
  if (!left && !right) return {};
  if (!right || right.length === 0) return { compactionDecisions: [...(left ?? [])] };
  const replacesHistoryCompact = right.some(
    (decision) => decision.stage === 'priorReplay' && decision.boundaryKind === 'historyCompact',
  );
  const retainedLeft = replacesHistoryCompact
    ? (left ?? []).filter(
        (decision) =>
          !(decision.stage === 'priorReplay' && decision.boundaryKind === 'historyCompact'),
      )
    : (left ?? []);
  return { compactionDecisions: [...retainedLeft, ...right] };
}

export function replaceHistoryCompactReplayBlocks(
  events: readonly RuntimeEvent[],
  blocks: readonly HistoryCompactBlock[],
): RuntimeEvent[] {
  if (blocks.length === 0) return [...events];
  return [
    ...blocks.map((block) => historyCompactBlockToRuntimeEvent(block)),
    ...events.filter((event) => !event.id.startsWith('history-compact:')),
  ];
}
