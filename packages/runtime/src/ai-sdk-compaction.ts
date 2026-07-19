/**
 * AiSdkCompaction — history-compaction / context-budget orchestrator extracted
 * from AiSdkBackend (issue #1084, runtime/compaction lane, slice 2).
 *
 * Owns the compact/synthesis-cache load and write paths that AiSdkBackend's
 * streamText adaptation drives. Behavior-neutral collaborator: methods move
 * verbatim, turn-scoped state (abortSignal, requestShapeHashBefore) is passed
 * per call, and replay/telemetry capabilities that stay on AiSdkBackend are
 * injected as host callbacks (added as later families move in).
 */

import type { RuntimeEvent } from '@maka/core/runtime-event';
import type {
  BackendCompactHistoryInput,
  BackendCompactHistoryResult,
} from '@maka/core/backend-types';
import type { ContextBudgetDiagnostic, LlmCallRecord } from '@maka/core/usage-stats/types';

import type { AiSdkBackendInput } from './ai-sdk-backend.js';
import {
  compactionDecisionDiagnosticPatch,
  historyCompactBlockToCompactionBoundary,
} from './compaction-boundary.js';
import {
  ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
  applyRuntimeEventContextBudget,
  buildContextBudgetDiagnosticShell,
  estimateRuntimeEventsTokens,
  mergeContextBudgetDiagnostic,
  mergeContextBudgetDiagnosticPatches,
  type ActiveArchivedToolResultPlaceholder,
  type ArchiveRetrievalMode,
  type ContextBudgetPolicy,
  type HistoryCompactBlock,
  type SynthesisSourceRef,
  type ToolResultArchiveRef,
} from './context-budget.js';
import { evaluateHistoryCompactCheckpointReplay } from './history-compact.js';
import { HistoryCompactSummarizerError } from './history-compact-error.js';
import {
  buildHistoryCompactCheckpoint,
  matchHistoryCompactCheckpointPrefix,
  type HistoryCompactCheckpoint,
} from './history-compact-checkpoint.js';

import { createHash } from 'node:crypto';
import type { ModelMessage } from 'ai';
import type {
  ModelAdapter,
  NormalizedAiSdkUsage,
  PrepareStepFunctionLike,
  PrepareStepLike,
  PrepareStepResultLike,
} from './model-adapter.js';
import {
  activeToolResultLineageIdentity,
  rewriteActiveToolResultsInMessages,
  type ActiveToolResultArchiveCandidate,
  type ActiveToolResultPruneDiagnosticPatch,
} from './active-tool-result-prune.js';
import {
  rewriteActiveFullCompactInMessages,
  type ActiveCompactionHeadAnchor,
  type ActiveFullCompactBlock,
} from './active-full-compact.js';
import {
  rewriteSemanticCompactInMessages,
  type SemanticCompactBlock,
  type SemanticCompactControllerState,
} from './semantic-compact.js';
import { collectStaleToolResultArchiveCandidates } from './tool-result-archive.js';

/** Constructor dependencies for AiSdkCompaction. Grows as more families move in. */
export interface AiSdkCompactionDeps {
  input: AiSdkBackendInput;
  sessionId: string;
  now: () => number;
  modelAdapter: ModelAdapter;
  computeCostUsd: (usage: NormalizedAiSdkUsage) => number | undefined;
}

export class AiSdkCompaction {
  private readonly input: AiSdkBackendInput;
  private readonly sessionId: string;
  private readonly now: () => number;
  private readonly modelAdapter: ModelAdapter;
  private readonly computeCostUsd: (usage: NormalizedAiSdkUsage) => number | undefined;
  private historyCompactAbortController: AbortController | null = null;

  constructor(deps: AiSdkCompactionDeps) {
    this.input = deps.input;
    this.sessionId = deps.sessionId;
    this.now = deps.now;
    this.modelAdapter = deps.modelAdapter;
    this.computeCostUsd = deps.computeCostUsd;
  }

  /** Abort an in-flight manual history compaction (called by AiSdkBackend.stop). */
  public abortHistoryCompact(): void {
    this.historyCompactAbortController?.abort();
  }

  public async loadHistoryCompactBlocks(
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

  public async loadSynthesisCacheBlocks(
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

  public async writeSynthesisCacheBlocks(input: {
    requestShapeHashBefore?: string;
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
          requestShapeHashBefore: input.requestShapeHashBefore,
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

  public async writeHistoryCompactCheckpoint(input: {
    requestShapeHashBefore?: string;
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
        input.contextBudget?.charsPerToken,
        input.contextBudget?.maxHistoryEstimatedTokens,
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
          requestShapeHashBefore: input.requestShapeHashBefore,
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
        input.contextBudget?.charsPerToken,
        input.contextBudget?.maxHistoryEstimatedTokens,
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

  public async writeHistoryCompactBlocks(input: {
    requestShapeHashBefore?: string;
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
            requestShapeHashBefore: input.requestShapeHashBefore,
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

  public async compactHistory(
    input: BackendCompactHistoryInput,
    requestShapeHashBefore?: string,
  ): Promise<BackendCompactHistoryResult> {
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
              requestShapeHashBefore,
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
              requestShapeHashBefore,
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

  public hasHistoryCompactWriter(): boolean {
    return Boolean(
      this.input.writeHistoryCompact ||
        (this.input.summarizeHistoryCompact && this.input.recordHistoryCompactCheckpoint),
    );
  }

  public hasHistoryCompactCheckpointWriter(): boolean {
    return Boolean(this.input.summarizeHistoryCompact && this.input.recordHistoryCompactCheckpoint);
  }

  public async prepareContextBudgetPolicy(runtimeContext: readonly RuntimeEvent[]): Promise<{
    policy: ContextBudgetPolicy | undefined;
    diagnosticPatch?: Partial<ContextBudgetDiagnostic>;
  }> {
    const policy = this.input.contextBudget;
    if (!policy) return { policy };
    let nextPolicy = policy;

    if (policy.staleToolResultPrune?.enabled === true) {
      const candidates = collectStaleToolResultArchiveCandidates(
        runtimeContext,
        policy?.staleToolResultPrune,
        policy?.charsPerToken ?? 4,
        policy?.minRecentTurns,
      );
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

  public buildActiveToolResultPrunePrepareStep(
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

  public buildSemanticCompactPrepareStep(
    turnId: string,
    model: unknown,
    runtimeEvents: readonly RuntimeEvent[] | undefined,
    headAnchor: ActiveCompactionHeadAnchor | undefined,
    requestShapeHashForMessages: (
      messages: readonly ModelMessage[],
      activeToolsForStep: readonly string[] | undefined,
    ) => string,
    onDiagnosticPatch?: (patch: Partial<ContextBudgetDiagnostic>) => void,
    abortSignal?: AbortSignal,
  ): PrepareStepFunctionLike | undefined {
    const policy = this.input.contextBudget?.semanticCompact;
    if (policy?.enabled !== true || policy.mode === 'off' || !headAnchor) return undefined;

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
        abortSignal: abortSignal,
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

  public buildActiveFullCompactPrepareStep(
    turnId: string,
    runtimeEvents: readonly RuntimeEvent[] | undefined,
    headAnchor: ActiveCompactionHeadAnchor | undefined,
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
        ...(headAnchor ? { headAnchor } : {}),
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
    const costUsd = this.computeCostUsd(input.usage);
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
}

// -- moved helpers (defined in ai-sdk-backend, used only by cache write) -------

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

// -- moved helpers (prepare-step / signature / prune) ------------------------

type ActiveCompactionPrepareStepResult = PrepareStepResultLike & {
  makaSemanticCompactStatus?: 'replaced' | 'projected';
};

export function composeActiveCompactionPrepareStep(
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

export interface ActiveFullCompactPrepareStepProjection {
  sourceSignatures: readonly string[];
  sourceSignatureMode: 'exact' | 'active_prune_lineage';
  projectedMessages: readonly ModelMessage[];
  semanticBlock?: SemanticCompactBlock;
}

export function projectAcceptedActiveFullCompactMessages(
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

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function modelMessageSignature(message: ModelMessage): string {
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

export function hasActiveToolResultPruneDiagnosticPatch(
  patch: ActiveToolResultPruneDiagnosticPatch,
): boolean {
  return (
    (patch.activePrunedToolResults ?? 0) > 0 ||
    (patch.activeArchiveFailures ?? 0) > 0 ||
    (patch.activeEstimatedTokensSaved ?? 0) > 0
  );
}
