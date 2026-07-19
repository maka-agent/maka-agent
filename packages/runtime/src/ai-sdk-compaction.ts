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
import type { ContextBudgetDiagnostic } from '@maka/core/usage-stats/types';

import type { AiSdkBackendInput } from './ai-sdk-backend.js';
import {
  compactionDecisionDiagnosticPatch,
  historyCompactBlockToCompactionBoundary,
} from './compaction-boundary.js';
import {
  estimateRuntimeEventsTokens,
  type ArchiveRetrievalMode,
  type ContextBudgetPolicy,
  type HistoryCompactBlock,
  type SynthesisSourceRef,
} from './context-budget.js';
import { evaluateHistoryCompactCheckpointReplay } from './history-compact.js';
import { HistoryCompactSummarizerError } from './history-compact-error.js';
import {
  buildHistoryCompactCheckpoint,
  matchHistoryCompactCheckpointPrefix,
  type HistoryCompactCheckpoint,
} from './history-compact-checkpoint.js';

/** Constructor dependencies for AiSdkCompaction. Grows as more families move in. */
export interface AiSdkCompactionDeps {
  input: AiSdkBackendInput;
  sessionId: string;
  now: () => number;
}

export class AiSdkCompaction {
  private readonly input: AiSdkBackendInput;
  private readonly sessionId: string;
  private readonly now: () => number;

  constructor(deps: AiSdkCompactionDeps) {
    this.input = deps.input;
    this.sessionId = deps.sessionId;
    this.now = deps.now;
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
