import { createHash } from 'node:crypto';
import type { ModelMessage } from 'ai';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { ContextBudgetDiagnostic } from '@maka/core/usage-stats/types';
import {
  activeFullCompactCoverageFromEntries,
  buildActiveFullCompactBlockFromSummary,
  buildActiveFullCompactSourceIndex,
  buildDeterministicActiveFullCompactSummary,
  selectActiveFullCompactCoveredSpan,
  validateActiveFullCompactBlockForSourceIndex,
  type ActiveFullCompactArchiveRef,
  type ActiveFullCompactCoverage,
  type ActiveFullCompactPolicy,
  type ActiveFullCompactFailOpenReason,
  type ActiveFullCompactSelection,
  type ActiveFullCompactSourceEntry,
  type ActiveFullCompactSourceIndex,
  type ActiveFullCompactSourceRef,
  type ActiveFullCompactValidationResult,
} from './active-full-compact.js';
import { compactionDecisionDiagnosticPatch } from './compaction-boundary.js';
import { estimateTokens } from './context-budget.js';
import type { CompactSummaryResult, NormalizedAiSdkUsage } from './model-adapter.js';

const DEFAULT_CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_SUMMARY_TOKENS = 768;
const DEFAULT_MAX_COMPACT_CALL_TOKENS = 4096;
const DEFAULT_MIN_SAVINGS_TOKENS = 256;
const DEFAULT_MIN_SAVINGS_RATIO = 0.05;
const DEFAULT_COMPACT_CALL_TOKEN_COST_WEIGHT = 1;
const DEFAULT_MAX_CONSECUTIVE_INVALID_SUMMARIES = 2;
const DEFAULT_INVALID_SUMMARY_COOLDOWN_STEPS = 8;
const PRIVATE_VERIFIER_PATTERN = /\b(hidden|private|official)\s+(verifier|evaluation|eval|test|assertion|oracle)\b/i;
const SUMMARY_FIELD_LABELS = {
  objective: ['current_objective', 'current objective'],
  nextAction: ['next_action', 'next action'],
} as const;

export interface SemanticCompactPolicy {
  enabled: boolean;
  mode?: 'off' | 'validate_only' | 'prepare_step_dry_run' | 'replace';
  minStepNumber?: number;
  highWaterRatio?: number;
  forceRatio?: number;
  targetRatio?: number;
  maxActiveEstimatedTokens?: number;
  minRecentMessages?: number;
  minRecentToolPairs?: number;
  maxSummaryEstimatedTokens?: number;
  minSavingsTokens?: number;
  minSavingsRatio?: number;
  minNetSavingsTokens?: number;
  compactCallTokenCostWeight?: number;
  maxCompactCallTokens?: number;
  maxConsecutiveInvalidSummaries?: number;
  invalidSummaryCooldownSteps?: number;
  summarizerModel?: string;
  timeoutMs?: number;
  archiveRequired?: boolean;
  benchmarkStateCards?: boolean;
  promptVersion?: string;
  highWaterName?: string;
}

export interface SemanticCompactSummaryRequest {
  system: string;
  messages: readonly ModelMessage[];
  maxOutputTokens: number;
  abortSignal?: AbortSignal;
}

export type SemanticCompactSummarizer = (
  request: SemanticCompactSummaryRequest,
) => Promise<CompactSummaryResult> | CompactSummaryResult;

export interface SemanticCompactControllerState {
  consecutiveInvalidSummaries: number;
  totalInvalidSummaries: number;
  compactCallCount: number;
  compactCallTotalTokens: number;
  acceptedEstimatedTokensSaved: number;
  suppressedUntilStep?: number;
  lastInvalidReason?: string;
}

export interface SemanticCompactStateCard {
  kind: 'process' | 'vm' | 'artifact' | 'command' | 'constraint' | 'verifier' | 'next_action' | 'generic';
  text: string;
  sourceIds: string[];
}

export interface SemanticCompactStructuredSummary {
  currentObjective: string;
  userConstraints: string[];
  importantFilesAndArtifacts: string[];
  commandsAndResults: string[];
  errorsAndFixes: string[];
  failedHypotheses: string[];
  operationalState: string[];
  publicVerificationState: string;
  remainingWork: string[];
  nextAction: string;
  archiveRefsToRereadIfNeeded: string[];
}

export interface SemanticCompactBlock {
  kind: 'maka.semantic_compact_block';
  version: 1;
  blockId: string;
  sessionId: string;
  turnId: string;
  runId?: string;
  invocationId?: string;
  createdAt: number;
  highWaterName: string;
  highWaterSeq: number;
  trigger: {
    reason: 'high_water' | 'force_ratio' | 'predictive_growth' | 'reactive_prompt_too_long' | 'manual_test';
    stepNumber?: number;
    estimatedTokensBefore?: number;
    thresholdTokens?: number;
  };
  coverage: ActiveFullCompactCoverage;
  sourceRefs: ActiveFullCompactSourceRef[];
  archiveRefs?: ActiveFullCompactArchiveRef[];
  preservedTail: {
    messageIndexes: number[];
    toolCallIds: string[];
    sourceIds: string[];
  };
  summary: {
    promptVersion: string;
    text: string;
    limitations?: string[];
    nextAction?: string;
  };
  stateCards?: SemanticCompactStateCard[];
  requestShapeHashBefore?: string;
  requestShapeHashAfter?: string;
  preActiveContextEstimatedTokens: number;
  postReplacementEstimatedTokens: number;
  estimatedTokensSavedSigned: number;
  estimatedNetTokensSavedSigned?: number;
  compactCallUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheWriteInputTokens?: number;
    totalTokens?: number;
  };
  finishReason?: string;
  providerRequestId?: string;
  acceptance: {
    decision: 'accepted' | 'rejected' | 'dry_run';
    reason?: string;
    validationReasons?: string[];
  };
}

export type SemanticCompactDecision = 'unchanged' | 'replaced' | 'failedOpen';

export type SemanticCompactFailureStage =
  | 'summarizer'
  | 'summary'
  | 'source_validation'
  | 'provider_shape'
  | 'economics';

export type SemanticCompactFailureReason =
  | ActiveFullCompactFailOpenReason
  | 'summarizer_failed'
  | 'summarizer_timeout'
  | 'summary_invalid_json'
  | 'summary_schema_invalid'
  | 'summary_missing_current_objective'
  | 'summary_missing_next_action'
  | 'private_verifier_surface'
  | 'source_refs_missing'
  | 'source_ref_mismatch'
  | 'current_user_not_preserved'
  | 'provider_message_structure_invalid'
  | 'thinking_pair_split'
  | 'non_positive_savings'
  | 'below_min_savings_tokens'
  | 'below_min_savings_ratio'
  | 'non_positive_net_savings'
  | 'below_min_net_savings_tokens';

export interface SemanticCompactFailure {
  kind: 'maka.semantic_compact_failure';
  stage: SemanticCompactFailureStage;
  reason: SemanticCompactFailureReason;
  reasons: SemanticCompactFailureReason[];
  retryable: boolean;
}

export interface SemanticCompactValidationResult {
  valid: boolean;
  reasons: SemanticCompactFailureReason[];
  reasonCounts: Readonly<Record<string, number>>;
}

export interface SemanticCompactRewriteInput {
  sessionId: string;
  turnId: string;
  runId?: string;
  invocationId?: string;
  messages: readonly ModelMessage[];
  policy: SemanticCompactPolicy | undefined;
  runtimeEvents?: readonly RuntimeEvent[];
  stepNumber: number;
  controllerState?: SemanticCompactControllerState;
  now?: number;
  charsPerToken?: number;
  requestShapeHashBefore?: string;
  requestShapeHashForMessages?: (messages: readonly ModelMessage[]) => string;
  summarizer: SemanticCompactSummarizer;
  abortSignal?: AbortSignal;
}

export interface SemanticCompactRewriteResult {
  messages: ModelMessage[];
  decision: SemanticCompactDecision;
  reason?: string;
  diagnosticPatch: Partial<ContextBudgetDiagnostic>;
  block?: SemanticCompactBlock;
  validation?: ActiveFullCompactValidationResult;
  failure?: SemanticCompactFailure;
}

export async function rewriteSemanticCompactInMessages(
  input: SemanticCompactRewriteInput,
): Promise<SemanticCompactRewriteResult> {
  const messages = [...input.messages];
  const policy = input.policy;
  const charsPerToken = input.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  if (policy?.enabled !== true || policy.mode === 'off') {
    return unchanged(messages, 'disabled');
  }
  const brakeReason = semanticCompactBrakeReason(policy, input.controllerState, input.stepNumber);
  if (brakeReason) {
    return unchanged(messages, brakeReason);
  }

  const index = buildActiveFullCompactSourceIndex({
    sessionId: input.sessionId,
    turnId: input.turnId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    messages,
    runtimeEvents: input.runtimeEvents,
    stepNumber: input.stepNumber,
    charsPerToken,
  });
  const selectionPolicy = policyForSemanticSelection(policy, messages);
  const baseSelection = selectActiveFullCompactCoveredSpan(index, selectionPolicy);
  const selection = preserveCurrentUserInSemanticSelection(baseSelection, index, messages);
  if (selection.decision !== 'selected') {
    const decision = selection.decision === 'failedOpen' ? 'failedOpen' : 'unchanged';
    return {
      messages,
      decision,
      reason: selection.reason,
      diagnosticPatch: semanticCompactDecisionDiagnosticPatch({
        decision,
        reason: selection.reason,
        estimatedTokensBefore: index.estimatedTokens,
        estimatedTokensAfter: index.estimatedTokens,
        skippedReasonCounts: selection.skippedReasonCounts,
      }),
    };
  }

  const validationBlock = buildActiveFullCompactBlockFromSummary({
    sessionId: input.sessionId,
    turnId: input.turnId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    entries: selection.entries,
    summary: {
      schemaVersion: 1,
      text: 'Semantic compact source validation block.',
      nextActions: ['Continue from semantic compact summary and preserved recent tail.'],
    },
    highWaterName: policy.highWaterName ?? 'semantic-compact-high-water',
    highWaterSeq: input.stepNumber,
    trigger: {
      reason: 'high_water',
      stepNumber: input.stepNumber,
      estimatedTokensBefore: index.estimatedTokens,
      ...(policy.maxActiveEstimatedTokens !== undefined
        ? { thresholdTokens: Math.floor(policy.maxActiveEstimatedTokens * finiteRatio(policy.highWaterRatio, 0.8)) }
        : {}),
    },
    now: input.now,
    charsPerToken,
    requestShapeHashBefore: input.requestShapeHashBefore ?? input.requestShapeHashForMessages?.(messages),
    preActiveContextEstimatedTokens: index.estimatedTokens,
  });
  const validation = validateActiveFullCompactBlockForSourceIndex(validationBlock, index, {
    sessionId: input.sessionId,
    turnId: input.turnId,
    archiveRequired: policy.archiveRequired,
    charsPerToken,
  });
  if (!validation.valid) {
    const reasons = validation.reasons.length > 0 ? validation.reasons : ['source_ref_mismatch'] as const;
    const reason = reasons[0]!;
    recordInvalidSummary(input.controllerState, policy, reason, input.stepNumber);
    return failClosed(messages, index, {
      stage: 'source_validation',
      reason,
      reasons: [...reasons],
      validation,
    });
  }

  const stateCards = buildSemanticStateCards({
    selection,
    messages,
    runtimeEvents: input.runtimeEvents,
    policy,
    charsPerToken,
  });
  let summary: CompactSummaryResult;
  try {
    summary = await callSummarizerWithTimeout(input.summarizer, {
      system: semanticCompactSystemPrompt(policy),
      messages: buildSummarizerMessages({
        selection,
        messages,
        index,
        stateCards,
        policy,
        charsPerToken,
      }),
      maxOutputTokens: Math.floor(policy.maxCompactCallTokens ?? DEFAULT_MAX_COMPACT_CALL_TOKENS),
      abortSignal: input.abortSignal,
    }, policy.timeoutMs);
  } catch (error) {
    const reason: SemanticCompactFailureReason = error instanceof SemanticCompactSummarizerTimeoutError
      ? 'summarizer_timeout'
      : 'summarizer_failed';
    recordInvalidSummary(input.controllerState, policy, reason, input.stepNumber);
    return failClosed(messages, index, {
      stage: 'summarizer',
      reason,
      reasons: [reason],
      retryable: true,
    });
  }

  const compactCallUsage = summary.usage ? compactUsage(summary.usage) : undefined;
  recordCompactCall(input.controllerState, compactCallUsage);
  const parsedSummary = parseSemanticCompactSummary(summary.text);
  if (!parsedSummary.ok) {
    recordInvalidSummary(input.controllerState, policy, parsedSummary.reason, input.stepNumber);
    return failClosed(messages, index, {
      stage: 'summary',
      reason: parsedSummary.reason,
      reasons: [parsedSummary.reason],
      compactCallUsage,
    });
  }
  const structuredSummary = parsedSummary.summary;
  const summaryText = renderStructuredSemanticSummary(structuredSummary);
  const surfacedPrivateVerifier = newPrivateVerifierSurface(
    `${summary.text}\n${summaryText}`,
    selectedSourceText(selection, messages),
  );

  const requestShapeHashBefore = input.requestShapeHashBefore ?? input.requestShapeHashForMessages?.(messages);
  const block = buildSemanticCompactBlock({
    input,
    index,
    selection,
    structuredSummary,
    summaryText,
    stateCards,
    usage: summary.usage,
    finishReason: summary.finishReason,
    providerRequestId: summary.providerRequestId,
    requestShapeHashBefore,
    charsPerToken,
  });
  const replacementMessage = semanticCompactBlockToModelMessage(block);
  const replacementMessages = [
    ...messages.slice(0, selection.startMessageIndex),
    replacementMessage,
    ...messages.slice(selection.endMessageIndex + 1),
  ];
  const requestShapeHashAfter = input.requestShapeHashForMessages?.(replacementMessages);
  if (requestShapeHashAfter) block.requestShapeHashAfter = requestShapeHashAfter;
  block.postReplacementEstimatedTokens = estimatePostReplacementTokens(index, selection.estimatedTokens, renderSemanticCompactBlock(block), charsPerToken);
  block.estimatedTokensSavedSigned = index.estimatedTokens - block.postReplacementEstimatedTokens;
  block.estimatedNetTokensSavedSigned = estimateSemanticNetTokensSaved(block, policy);

  const sourceValidation = validateSemanticCompactBlockForSourceIndex(block, index, {
    requiredSourceIds: selection.entries.map((entry) => entry.sourceId),
    archiveRequired: policy.archiveRequired,
    charsPerToken,
  });
  const replacementValidation = validateSemanticCompactReplacementShape({
    originalMessages: messages,
    replacementMessages,
    block,
  });
  const rejectionReasons: SemanticCompactFailureReason[] = [
    ...sourceValidation.reasons,
    ...replacementValidation.reasons,
    ...(surfacedPrivateVerifier ? ['private_verifier_surface' as const] : []),
  ];
  const economicsReason = semanticSavingsRejectionReason(block, policy);
  if (economicsReason) rejectionReasons.push(economicsReason);
  const uniqueRejectionReasons = uniqueStrings(rejectionReasons) as SemanticCompactFailureReason[];
  const primaryRejectionReason = uniqueRejectionReasons[0];

  if (primaryRejectionReason) {
    const stage = semanticFailureStage(primaryRejectionReason);
    block.acceptance = {
      decision: 'rejected',
      reason: primaryRejectionReason,
      validationReasons: uniqueRejectionReasons,
    };
    recordInvalidSummary(input.controllerState, policy, primaryRejectionReason, input.stepNumber);
    return failClosed(messages, index, {
      stage,
      reason: primaryRejectionReason,
      reasons: uniqueRejectionReasons,
      block,
      validation,
      compactCallUsage,
    });
  }

  recordValidSummary(input.controllerState);

  if (policy.mode === 'validate_only' || policy.mode === 'prepare_step_dry_run') {
    block.acceptance = { decision: 'dry_run', reason: policy.mode };
    return {
      messages,
      decision: 'unchanged',
      reason: policy.mode,
      block,
      validation,
      diagnosticPatch: semanticCompactDecisionDiagnosticPatch({
        decision: 'unchanged',
        boundaryIds: [block.blockId],
        coverage: block.coverage,
        estimatedTokensBefore: index.estimatedTokens,
        estimatedTokensAfter: block.postReplacementEstimatedTokens,
        estimatedTokensSaved: block.estimatedTokensSavedSigned,
        compactCallUsage: block.compactCallUsage,
        reason: policy.mode,
        validationReasonCounts: validation.reasonCounts,
      }),
    };
  }

  block.acceptance = { decision: 'accepted' };
  recordAcceptedSemanticCompact(input.controllerState, block);
  return {
    messages: replacementMessages,
    decision: 'replaced',
    block,
    validation,
    diagnosticPatch: {
      ...semanticCompactDecisionDiagnosticPatch({
        decision: 'replaced',
        boundaryIds: [block.blockId],
        coverage: block.coverage,
        estimatedTokensBefore: index.estimatedTokens,
        estimatedTokensAfter: block.postReplacementEstimatedTokens,
        estimatedTokensSaved: block.estimatedTokensSavedSigned,
        compactCallUsage: block.compactCallUsage,
        validationReasonCounts: validation.reasonCounts,
      }),
      ...(requestShapeHashBefore && requestShapeHashAfter
        ? {
            highWaterRequestShapeHashBefore: requestShapeHashBefore,
            highWaterRequestShapeHashAfter: requestShapeHashAfter,
          }
        : {}),
    },
  };
}

export function semanticCompactBlockToModelMessage(block: SemanticCompactBlock): ModelMessage {
  return {
    role: 'user',
    content: renderSemanticCompactBlock(block),
  } as ModelMessage;
}

export function renderSemanticCompactBlock(block: SemanticCompactBlock): string {
  const stateLines = (block.stateCards ?? []).map((card) =>
    `- ${card.kind}: ${singleLine(card.text)}`
  );
  const archiveCount = block.archiveRefs?.length ?? 0;
  return [
    `<maka_semantic_compact_block id="${escapeAttribute(block.blockId)}" high_water="${escapeAttribute(block.highWaterName)}" seq="${block.highWaterSeq}" version="${block.version}">`,
    'summary:',
    block.summary.text,
    stateLines.length > 0 ? 'restoration_state_cards:' : '',
    ...stateLines,
    archiveCount > 0 ? `durable_archives_available: ${archiveCount} raw evidence refs retained outside provider-visible context.` : '',
    `durable_coverage: ${block.coverage.providerMessageSourceIds.length} provider source entries and ${block.coverage.toolCallIds.length} tool calls retained in the compact audit side-channel.`,
    `preserved_tail: messages=${block.preservedTail.messageIndexes.join(',') || 'none'} toolCalls=${block.preservedTail.toolCallIds.join(',') || 'none'}`,
    'instructions: Continue from this semantic summary plus the exact preserved recent messages that follow it. Use archive refs for raw evidence recovery when needed.',
    '</maka_semantic_compact_block>',
  ].filter((line) => line !== '').join('\n');
}

export function validateSemanticCompactBlockForSourceIndex(
  block: SemanticCompactBlock,
  index: ActiveFullCompactSourceIndex,
  options: {
    requiredSourceIds?: readonly string[];
    archiveRequired?: boolean;
    charsPerToken?: number;
  } = {},
): SemanticCompactValidationResult {
  const reasons: SemanticCompactFailureReason[] = [];
  const add = (reason: SemanticCompactFailureReason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  if (block.sourceRefs.length === 0) add('source_refs_missing');
  const coveredSourceIds = uniqueSorted(block.coverage.providerMessageSourceIds);
  const referencedSourceIds = uniqueSorted(block.sourceRefs.map((ref) => ref.sourceId));
  const requiredSourceIds = uniqueSorted(options.requiredSourceIds ?? coveredSourceIds);
  if (
    block.coverage.providerMessageSourceIds.length !== coveredSourceIds.length
    || block.sourceRefs.length !== referencedSourceIds.length
    || !sameStrings(coveredSourceIds, referencedSourceIds)
    || !sameStrings(requiredSourceIds, referencedSourceIds)
  ) {
    add('source_ref_mismatch');
  }

  const activeValidation = validateActiveFullCompactBlockForSourceIndex({
    kind: 'maka.active_full_compact_block',
    version: block.version,
    blockId: block.blockId,
    sessionId: block.sessionId,
    turnId: block.turnId,
    ...(block.runId ? { runId: block.runId } : {}),
    ...(block.invocationId ? { invocationId: block.invocationId } : {}),
    createdAt: block.createdAt,
    highWaterName: block.highWaterName,
    highWaterSeq: block.highWaterSeq,
    trigger: block.trigger,
    coverage: block.coverage,
    summary: {
      schemaVersion: 1,
      text: block.summary.text,
      ...(block.summary.nextAction ? { nextActions: [block.summary.nextAction] } : {}),
    },
    limitations: block.summary.limitations ?? [],
    sourceRefs: block.sourceRefs,
    ...(block.archiveRefs ? { archiveRefs: block.archiveRefs } : {}),
  }, index, {
    sessionId: block.sessionId,
    turnId: block.turnId,
    archiveRequired: options.archiveRequired,
    charsPerToken: options.charsPerToken,
  });
  for (const reason of activeValidation.reasons) add(reason);

  const entriesBySourceId = new Map(index.entries.map((entry) => [entry.sourceId, entry]));
  const requiredEntries = requiredSourceIds
    .map((sourceId) => entriesBySourceId.get(sourceId))
    .filter((entry): entry is ActiveFullCompactSourceEntry => entry !== undefined);
  if (
    requiredEntries.length !== requiredSourceIds.length
    || stableStringify(activeFullCompactCoverageFromEntries(requiredEntries)) !== stableStringify(block.coverage)
  ) {
    add('coverage_miss');
  }

  for (const ref of block.sourceRefs) {
    const entry = entriesBySourceId.get(ref.sourceId);
    if (
      !entry
      || ref.kind !== sourceRefKindForEntry(entry)
      || ref.messageIndex !== entry.messageIndex
      || ref.partIndex !== entry.partIndex
      || ref.sessionId !== block.sessionId
      || ref.turnId !== entry.turnId
      || ref.runtimeEventId !== entry.runtimeEventId
      || ref.toolCallId !== entry.toolCallId
      || ref.toolName !== entry.toolName
      || ref.contentKind !== entry.contentKind
      || ref.bodySha256 !== entry.bodySha256
      || !sameOptionalArchiveRef(ref.archiveRef, entry.archiveRef)
    ) {
      add('source_ref_mismatch');
    }
  }

  return {
    valid: reasons.length === 0,
    reasons,
    reasonCounts: countStringReasons(reasons),
  };
}

export function validateSemanticCompactReplacementShape(input: {
  originalMessages: readonly ModelMessage[];
  replacementMessages: readonly ModelMessage[];
  block: SemanticCompactBlock;
}): SemanticCompactValidationResult {
  const reasons: SemanticCompactFailureReason[] = [];
  const add = (reason: SemanticCompactFailureReason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  const coveredMessageIndexes = uniqueNumbers(input.block.sourceRefs.map((ref) => ref.messageIndex));
  const startMessageIndex = coveredMessageIndexes[0];
  const endMessageIndex = coveredMessageIndexes.at(-1);
  if (startMessageIndex === undefined || endMessageIndex === undefined) {
    add('source_refs_missing');
    add('provider_message_structure_invalid');
    return { valid: false, reasons, reasonCounts: countStringReasons(reasons) };
  }

  const expectedMessages = [
    ...input.originalMessages.slice(0, startMessageIndex),
    semanticCompactBlockToModelMessage(input.block),
    ...input.originalMessages.slice(endMessageIndex + 1),
  ];
  if (
    input.replacementMessages.some((message) => !isBasicProviderMessageShape(message))
    || !sameModelMessages(expectedMessages, input.replacementMessages)
  ) {
    add('provider_message_structure_invalid');
  }

  const currentUserIndex = findLastMessageIndex(input.originalMessages, 'user');
  if (currentUserIndex >= startMessageIndex && currentUserIndex <= endMessageIndex) {
    add('current_user_not_preserved');
  } else if (currentUserIndex >= 0) {
    const mappedIndex = mapPreservedMessageIndex(currentUserIndex, startMessageIndex, endMessageIndex);
    if (!sameModelMessage(input.originalMessages[currentUserIndex], input.replacementMessages[mappedIndex])) {
      add('current_user_not_preserved');
    }
  }

  validatePreservedToolPairs(
    input.originalMessages,
    input.replacementMessages,
    startMessageIndex,
    endMessageIndex,
    add,
  );
  validatePreservedThinking(
    input.originalMessages,
    input.replacementMessages,
    startMessageIndex,
    endMessageIndex,
    add,
  );

  return {
    valid: reasons.length === 0,
    reasons,
    reasonCounts: countStringReasons(reasons),
  };
}

function policyForSemanticSelection(
  policy: SemanticCompactPolicy,
  messages: readonly ModelMessage[],
): ActiveFullCompactPolicy {
  const minRecentMessages = Math.max(
    Math.floor(policy.minRecentMessages ?? 1),
    recentMessageCountForToolPairs(messages, Math.floor(policy.minRecentToolPairs ?? 0)),
  );
  return {
    enabled: true,
    minStepNumber: policy.minStepNumber,
    highWaterRatio: policy.highWaterRatio,
    forceRatio: policy.forceRatio,
    targetRatio: policy.targetRatio,
    maxActiveEstimatedTokens: policy.maxActiveEstimatedTokens,
    minRecentMessages,
    minRecentToolPairs: policy.minRecentToolPairs,
    maxSummaryEstimatedTokens: policy.maxSummaryEstimatedTokens,
    archiveRequired: policy.archiveRequired,
    highWaterName: policy.highWaterName,
  };
}

function preserveCurrentUserInSemanticSelection(
  selection: ActiveFullCompactSelection,
  index: ActiveFullCompactSourceIndex,
  messages: readonly ModelMessage[],
): ActiveFullCompactSelection {
  if (selection.decision !== 'selected') return selection;
  const currentUserIndex = findLastMessageIndex(messages, 'user');
  if (currentUserIndex < selection.startMessageIndex || currentUserIndex > selection.endMessageIndex) {
    return selection;
  }

  const before = selection.entries.filter((entry) => entry.messageIndex < currentUserIndex);
  const after = selection.entries.filter((entry) => entry.messageIndex > currentUserIndex);
  const candidates = [before, after]
    .filter((entries) => entries.length > 0)
    .sort((left, right) => selectedEntryTokens(right) - selectedEntryTokens(left));
  for (const entries of candidates) {
    const validationBlock = buildActiveFullCompactBlockFromSummary({
      sessionId: index.sessionId,
      turnId: index.turnId,
      ...(index.runId ? { runId: index.runId } : {}),
      ...(index.invocationId ? { invocationId: index.invocationId } : {}),
      entries,
      summary: { schemaVersion: 1, text: 'Semantic compact current-user preservation preflight.' },
      highWaterSeq: index.stepNumber,
    });
    const validation = validateActiveFullCompactBlockForSourceIndex(validationBlock, index, {
      sessionId: index.sessionId,
      turnId: index.turnId,
    });
    if (!validation.valid) continue;
    return {
      decision: 'selected',
      startMessageIndex: Math.min(...entries.map((entry) => entry.messageIndex)),
      endMessageIndex: Math.max(...entries.map((entry) => entry.messageIndex)),
      entries,
      coverage: activeFullCompactCoverageFromEntries(entries),
      estimatedTokens: selectedEntryTokens(entries),
    };
  }
  return {
    decision: 'unchanged',
    reason: 'no_candidate',
    skippedReasonCounts: { current_user_preserved: 1 },
  };
}

function selectedEntryTokens(entries: readonly ActiveFullCompactSourceEntry[]): number {
  return entries.reduce((total, entry) => total + entry.estimatedTokens, 0);
}

function recentMessageCountForToolPairs(messages: readonly ModelMessage[], minPairs: number): number {
  if (minPairs <= 0) return 0;
  const retained = new Set<number>();
  const callsById = new Map<string, number>();
  const resultsById = new Map<string, number>();
  messages.forEach((message, index) => {
    for (const id of messageToolCallIds(message)) callsById.set(id, index);
    for (const id of messageToolResultIds(message)) resultsById.set(id, index);
  });
  let pairs = 0;
  for (let index = messages.length - 1; index >= 0 && pairs < minPairs; index -= 1) {
    for (const id of messageToolResultIds(messages[index]!)) {
      const callIndex = callsById.get(id);
      const resultIndex = resultsById.get(id);
      if (callIndex === undefined || resultIndex === undefined) continue;
      retained.add(callIndex);
      retained.add(resultIndex);
      pairs += 1;
      if (pairs >= minPairs) break;
    }
  }
  if (retained.size === 0) return 0;
  return messages.length - Math.min(...retained);
}

function messageToolCallIds(message: ModelMessage): string[] {
  const content = (message as { content?: unknown }).content;
  const parts = Array.isArray(content) ? content : [];
  return parts
    .map((part) => isRecord(part) && part.type === 'tool-call' ? part.toolCallId ?? part.tool_call_id : undefined)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function messageToolResultIds(message: ModelMessage): string[] {
  if ((message as { role?: string }).role !== 'tool') return [];
  const content = (message as { content?: unknown }).content;
  const parts = Array.isArray(content) ? content : [];
  return parts
    .map((part) => isRecord(part) && part.type === 'tool-result' ? part.toolCallId ?? part.tool_call_id : undefined)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function buildSummarizerMessages(input: {
  selection: Extract<ReturnType<typeof selectActiveFullCompactCoveredSpan>, { decision: 'selected' }>;
  messages: readonly ModelMessage[];
  index: ActiveFullCompactSourceIndex;
  stateCards: readonly SemanticCompactStateCard[];
  policy: SemanticCompactPolicy;
  charsPerToken: number;
}): ModelMessage[] {
  const contextBoundary = {
    coveredProviderSourceEntries: input.selection.coverage.providerMessageSourceIds.length,
    coveredToolCalls: input.selection.coverage.toolCallIds.length,
    contentKinds: input.selection.coverage.contentKinds,
    durableArchiveRefCount: input.selection.entries.filter((entry) => entry.archiveRef).length,
  };
  const restorationCards = input.stateCards.map((card) => ({
    kind: card.kind,
    text: card.text,
  }));
  const schema = {
    current_objective: 'string, required, one sentence',
    user_constraints: ['strings, public constraints only'],
    important_files_and_artifacts: ['strings, paths/artifacts that matter'],
    commands_and_results: ['strings, only commands/results needed for continuity'],
    errors_and_fixes: ['strings'],
    failed_hypotheses: ['strings'],
    operational_state: ['strings, process/build/vm/service state'],
    public_verification_state: 'string, public verifier/test state only',
    remaining_work: ['strings'],
    next_action: 'string, required, exact next action',
    archive_refs_to_reread_if_needed: ['strings, names/descriptions only'],
  };
  const request = [
    'Create a concise semantic compact summary for the Maka agent to continue this same task.',
    'Return ONLY a valid JSON object. Do not wrap it in markdown. Do not add prose before or after JSON.',
    `JSON schema: ${JSON.stringify(schema)}`,
    'The current_objective and next_action string fields are required and must be non-empty.',
    'Use arrays for list fields. Keep each list to at most 6 short items.',
    'Use only the public provider-visible messages above and the bounded restoration cards below.',
    'Do not invent command results, file contents, process state, credentials, verifier results, or hidden/private evaluation facts.',
    'Summarize continuity only. Durable source refs, hashes, and archive audit metadata are stored outside this provider-visible summary.',
    'Preserve objective, constraints, decisions, failed attempts, commands/results that matter, files/artifacts, active process/build state, public verification state, and exact next action.',
    `Prefer concise JSON around ${input.policy.maxSummaryEstimatedTokens ?? DEFAULT_MAX_SUMMARY_TOKENS} estimated tokens when possible; complete valid JSON is more important than brevity.`,
    `context_boundary: ${JSON.stringify(contextBoundary)}`,
    `restoration_cards: ${JSON.stringify(restorationCards)}`,
  ].join('\n');
  return [
    ...input.messages.slice(input.selection.startMessageIndex, input.selection.endMessageIndex + 1),
    { role: 'user', content: request } as ModelMessage,
  ];
}

function semanticCompactSystemPrompt(policy: SemanticCompactPolicy): string {
  return [
    'You compress a Maka agent session for current-turn context compaction.',
    'No tools are available. Return only valid JSON matching the requested schema.',
    'Do not include hidden/private verifier material unless it was explicitly present in public provider-visible input.',
    `Prompt version: ${policy.promptVersion ?? 'maka-semantic-compact-json-v2'}.`,
  ].join('\n');
}

function buildSemanticStateCards(input: {
  selection: Extract<ReturnType<typeof selectActiveFullCompactCoveredSpan>, { decision: 'selected' }>;
  messages: readonly ModelMessage[];
  runtimeEvents?: readonly RuntimeEvent[];
  policy: SemanticCompactPolicy;
  charsPerToken: number;
}): SemanticCompactStateCard[] {
  if (input.policy.benchmarkStateCards === false) return [];
  const deterministic = buildDeterministicActiveFullCompactSummary({
    selection: input.selection,
    messages: input.messages,
    runtimeEvents: input.runtimeEvents,
    maxSummaryEstimatedTokens: Math.min(input.policy.maxSummaryEstimatedTokens ?? DEFAULT_MAX_SUMMARY_TOKENS, 384),
    charsPerToken: input.charsPerToken,
  });
  const allSourceIds = input.selection.entries.map((entry) => entry.sourceId);
  const cards: SemanticCompactStateCard[] = [];
  for (const text of deterministic.processState ?? []) cards.push({ kind: 'process', text, sourceIds: allSourceIds });
  for (const text of deterministic.vmState ?? []) cards.push({ kind: 'vm', text, sourceIds: allSourceIds });
  for (const text of deterministic.artifactPaths ?? []) cards.push({ kind: 'artifact', text, sourceIds: allSourceIds });
  for (const command of deterministic.commandsTried ?? []) {
    cards.push({ kind: 'command', text: `${command.command}: ${command.outcome}`, sourceIds: command.sourceIds ?? allSourceIds });
  }
  for (const text of deterministic.constraints ?? []) cards.push({ kind: 'constraint', text, sourceIds: allSourceIds });
  if (deterministic.latestVerifierFailure) {
    cards.push({ kind: 'verifier', text: deterministic.latestVerifierFailure, sourceIds: allSourceIds });
  }
  for (const text of deterministic.nextActions ?? []) cards.push({ kind: 'next_action', text, sourceIds: allSourceIds });
  return cards.slice(0, 16);
}

function buildSemanticCompactBlock(input: {
  input: SemanticCompactRewriteInput;
  index: ActiveFullCompactSourceIndex;
  selection: Extract<ReturnType<typeof selectActiveFullCompactCoveredSpan>, { decision: 'selected' }>;
  structuredSummary: SemanticCompactStructuredSummary;
  summaryText: string;
  stateCards: readonly SemanticCompactStateCard[];
  usage?: NormalizedAiSdkUsage;
  finishReason?: string;
  providerRequestId?: string;
  requestShapeHashBefore?: string;
  charsPerToken: number;
}): SemanticCompactBlock {
  const policy = input.input.policy!;
  const archiveRefs = uniqueArchiveRefs(input.selection.entries.map((entry) => entry.archiveRef).filter(isArchiveRef));
  const sourceRefs = input.selection.entries.map((entry): ActiveFullCompactSourceRef => ({
    kind: entry.archiveRef ? 'active_archive_placeholder' : entry.runtimeEventId ? 'runtime_event' : 'provider_message',
    sourceId: entry.sourceId,
    messageIndex: entry.messageIndex,
    ...(entry.partIndex !== undefined ? { partIndex: entry.partIndex } : {}),
    sessionId: input.input.sessionId,
    turnId: entry.turnId,
    ...(entry.runtimeEventId ? { runtimeEventId: entry.runtimeEventId } : {}),
    ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
    ...(entry.toolName ? { toolName: entry.toolName } : {}),
    contentKind: entry.contentKind,
    bodySha256: entry.bodySha256,
    ...(entry.archiveRef ? { archiveRef: entry.archiveRef } : {}),
  }));
  const preservedTailIndexes = preservedTailMessageIndexes(input.index, input.selection);
  const preservedTailEntries = input.index.entries.filter((entry) => preservedTailIndexes.includes(entry.messageIndex));
  const draft = {
    sessionId: input.input.sessionId,
    turnId: input.input.turnId,
    coverage: activeFullCompactCoverageFromEntries(input.selection.entries),
    summaryText: input.structuredSummary.currentObjective,
    nextAction: input.structuredSummary.nextAction,
    highWaterSeq: input.input.stepNumber,
  };
  const block: SemanticCompactBlock = {
    kind: 'maka.semantic_compact_block',
    version: 1,
    blockId: `semcompact-${sha256(stableStringify(draft)).slice(0, 32)}`,
    sessionId: input.input.sessionId,
    turnId: input.input.turnId,
    ...(input.input.runId ? { runId: input.input.runId } : {}),
    ...(input.input.invocationId ? { invocationId: input.input.invocationId } : {}),
    createdAt: input.input.now ?? Date.now(),
    highWaterName: policy.highWaterName ?? 'semantic-compact-high-water',
    highWaterSeq: input.input.stepNumber,
    trigger: {
      reason: 'high_water',
      stepNumber: input.input.stepNumber,
      estimatedTokensBefore: input.index.estimatedTokens,
      ...(policy.maxActiveEstimatedTokens !== undefined
        ? { thresholdTokens: Math.floor(policy.maxActiveEstimatedTokens * finiteRatio(policy.highWaterRatio, 0.8)) }
        : {}),
    },
    coverage: activeFullCompactCoverageFromEntries(input.selection.entries),
    sourceRefs,
    ...(archiveRefs.length > 0 ? { archiveRefs } : {}),
    preservedTail: {
      messageIndexes: preservedTailIndexes,
      toolCallIds: uniqueSorted(preservedTailEntries.map((entry) => entry.toolCallId).filter(nonEmpty)),
      sourceIds: uniqueSorted(preservedTailEntries.map((entry) => entry.sourceId)),
    },
    summary: {
      promptVersion: policy.promptVersion ?? 'maka-semantic-compact-json-v2',
      text: input.summaryText,
      limitations: ['LLM semantic compact summary is bounded by public provider-visible context and deterministic restoration cards.'],
      nextAction: input.structuredSummary.nextAction,
    },
    ...(input.stateCards.length > 0 ? { stateCards: [...input.stateCards] } : {}),
    ...(input.requestShapeHashBefore ? { requestShapeHashBefore: input.requestShapeHashBefore } : {}),
    preActiveContextEstimatedTokens: input.index.estimatedTokens,
    postReplacementEstimatedTokens: input.index.estimatedTokens,
    estimatedTokensSavedSigned: 0,
    ...(input.usage ? { compactCallUsage: compactUsage(input.usage) } : {}),
    ...(input.finishReason ? { finishReason: input.finishReason } : {}),
    ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
    acceptance: { decision: 'rejected', reason: 'pending_acceptance' },
  };
  block.postReplacementEstimatedTokens = estimatePostReplacementTokens(
    input.index,
    input.selection.estimatedTokens,
    renderSemanticCompactBlock(block),
    input.charsPerToken,
  );
  block.estimatedTokensSavedSigned = input.index.estimatedTokens - block.postReplacementEstimatedTokens;
  return block;
}

function semanticSavingsRejectionReason(
  block: SemanticCompactBlock,
  policy: SemanticCompactPolicy,
): SemanticCompactFailureReason | undefined {
  if (block.estimatedTokensSavedSigned <= 0) return 'non_positive_savings';
  const minSavingsTokens = Math.max(0, Math.floor(policy.minSavingsTokens ?? DEFAULT_MIN_SAVINGS_TOKENS));
  if (block.estimatedTokensSavedSigned < minSavingsTokens) return 'below_min_savings_tokens';
  const minSavingsRatio = Math.max(0, policy.minSavingsRatio ?? DEFAULT_MIN_SAVINGS_RATIO);
  const savingsRatio = block.preActiveContextEstimatedTokens > 0
    ? block.estimatedTokensSavedSigned / block.preActiveContextEstimatedTokens
    : 0;
  if (savingsRatio < minSavingsRatio) return 'below_min_savings_ratio';
  const minNetSavingsTokens = Math.max(0, Math.floor(policy.minNetSavingsTokens ?? minSavingsTokens));
  const netSavings = block.estimatedNetTokensSavedSigned ?? block.estimatedTokensSavedSigned;
  if (netSavings <= 0) return 'non_positive_net_savings';
  if (netSavings < minNetSavingsTokens) {
    return 'below_min_net_savings_tokens';
  }
  return undefined;
}

function estimateSemanticNetTokensSaved(block: SemanticCompactBlock, policy: SemanticCompactPolicy): number {
  const compactCallTokens = block.compactCallUsage?.totalTokens ?? 0;
  const weight = finiteNonNegativeNumber(policy.compactCallTokenCostWeight, DEFAULT_COMPACT_CALL_TOKEN_COST_WEIGHT);
  return block.estimatedTokensSavedSigned - Math.ceil(compactCallTokens * weight);
}

function semanticCompactBrakeReason(
  policy: SemanticCompactPolicy,
  state: SemanticCompactControllerState | undefined,
  stepNumber: number,
): string | undefined {
  if (!state) return undefined;
  if (state.suppressedUntilStep !== undefined) {
    if (stepNumber <= state.suppressedUntilStep) return 'semantic_compact_cooldown';
    delete state.suppressedUntilStep;
    state.consecutiveInvalidSummaries = 0;
    delete state.lastInvalidReason;
  }
  const maxConsecutiveInvalid = Math.floor(policy.maxConsecutiveInvalidSummaries ?? DEFAULT_MAX_CONSECUTIVE_INVALID_SUMMARIES);
  if (maxConsecutiveInvalid > 0 && state.consecutiveInvalidSummaries >= maxConsecutiveInvalid) {
    const cooldownSteps = Math.floor(policy.invalidSummaryCooldownSteps ?? DEFAULT_INVALID_SUMMARY_COOLDOWN_STEPS);
    if (cooldownSteps > 0) {
      state.suppressedUntilStep = Math.max(state.suppressedUntilStep ?? 0, stepNumber + cooldownSteps);
      return 'semantic_compact_cooldown';
    }
  }
  return undefined;
}

function recordCompactCall(
  state: SemanticCompactControllerState | undefined,
  usage: SemanticCompactBlock['compactCallUsage'] | undefined,
): void {
  if (!state) return;
  state.compactCallCount += 1;
  state.compactCallTotalTokens += usage?.totalTokens ?? 0;
}

function recordInvalidSummary(
  state: SemanticCompactControllerState | undefined,
  policy: SemanticCompactPolicy,
  reason: string,
  stepNumber: number,
): void {
  if (!state) return;
  state.consecutiveInvalidSummaries += 1;
  state.totalInvalidSummaries += 1;
  state.lastInvalidReason = reason;
  const maxConsecutiveInvalid = Math.floor(policy.maxConsecutiveInvalidSummaries ?? DEFAULT_MAX_CONSECUTIVE_INVALID_SUMMARIES);
  const cooldownSteps = Math.floor(policy.invalidSummaryCooldownSteps ?? DEFAULT_INVALID_SUMMARY_COOLDOWN_STEPS);
  if (maxConsecutiveInvalid > 0 && cooldownSteps > 0 && state.consecutiveInvalidSummaries >= maxConsecutiveInvalid) {
    state.suppressedUntilStep = Math.max(state.suppressedUntilStep ?? 0, stepNumber + cooldownSteps);
  }
}

function recordValidSummary(state: SemanticCompactControllerState | undefined): void {
  if (!state) return;
  state.consecutiveInvalidSummaries = 0;
  delete state.lastInvalidReason;
}

function recordAcceptedSemanticCompact(
  state: SemanticCompactControllerState | undefined,
  block: SemanticCompactBlock,
): void {
  if (!state) return;
  state.acceptedEstimatedTokensSaved += block.estimatedTokensSavedSigned;
}

function semanticCompactDecisionDiagnosticPatch(input: {
  decision: 'unchanged' | 'replaced' | 'failedOpen';
  boundaryIds?: readonly string[];
  coverage?: ActiveFullCompactCoverage;
  estimatedTokensBefore?: number;
  estimatedTokensAfter?: number;
  estimatedTokensSaved?: number;
  compactCallUsage?: SemanticCompactBlock['compactCallUsage'];
  reason?: string;
  failOpenReason?: string;
  skippedReasonCounts?: Readonly<Record<string, number>>;
  validationReasonCounts?: Readonly<Record<string, number>>;
}): Partial<ContextBudgetDiagnostic> {
  return {
    semanticCompactEnabled: true,
    ...compactionDecisionDiagnosticPatch({
      stage: 'activeStep',
      sourceKind: 'providerMessages',
      boundaryKind: 'semanticCompact',
      decision: input.decision,
      ...(input.boundaryIds ? { boundaryIds: input.boundaryIds } : {}),
      ...(input.coverage ? {
        coverage: {
          turnIds: input.coverage.turnIds,
          runtimeEventIds: input.coverage.runtimeEventIds,
          toolCallIds: input.coverage.toolCallIds,
          contentKinds: input.coverage.contentKinds,
          bodySha256: input.coverage.bodySha256,
        },
      } : {}),
      ...(input.estimatedTokensBefore !== undefined ? { estimatedTokensBefore: input.estimatedTokensBefore } : {}),
      ...(input.estimatedTokensAfter !== undefined ? { estimatedTokensAfter: input.estimatedTokensAfter } : {}),
      ...(input.estimatedTokensSaved !== undefined ? { estimatedTokensSaved: input.estimatedTokensSaved } : {}),
      ...(input.compactCallUsage ? { compactCallUsage: input.compactCallUsage } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.failOpenReason ? { failOpenReason: input.failOpenReason } : {}),
      ...(input.skippedReasonCounts ? { skippedReasonCounts: input.skippedReasonCounts } : {}),
      ...(input.validationReasonCounts ? { validationReasonCounts: input.validationReasonCounts } : {}),
    }),
  };
}

async function callSummarizerWithTimeout(
  summarizer: SemanticCompactSummarizer,
  request: SemanticCompactSummaryRequest,
  timeoutMs: number | undefined,
): Promise<CompactSummaryResult> {
  if (!timeoutMs || timeoutMs <= 0) return Promise.resolve(summarizer(request));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new SemanticCompactSummarizerTimeoutError();
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  const parentAbort = () => controller.abort(request.abortSignal?.reason);
  request.abortSignal?.addEventListener('abort', parentAbort, { once: true });
  try {
    return await Promise.race([
      Promise.resolve(summarizer({ ...request, abortSignal: controller.signal })),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    request.abortSignal?.removeEventListener('abort', parentAbort);
  }
}

class SemanticCompactSummarizerTimeoutError extends Error {
  constructor() {
    super('semantic compact summarizer timeout');
    this.name = 'SemanticCompactSummarizerTimeoutError';
  }
}

function estimatePostReplacementTokens(
  index: ActiveFullCompactSourceIndex,
  selectedTokens: number,
  renderedReplacement: string,
  charsPerToken: number,
): number {
  return Math.max(0, index.estimatedTokens - selectedTokens + estimateTokens(renderedReplacement.length, charsPerToken));
}

function preservedTailMessageIndexes(
  index: ActiveFullCompactSourceIndex,
  selection: { endMessageIndex: number },
): number[] {
  const indexes = new Set<number>();
  for (let cursor = selection.endMessageIndex + 1; cursor < index.providerMessageCount; cursor += 1) {
    indexes.add(cursor);
  }
  return [...indexes].sort((a, b) => a - b);
}

function selectedSourceText(
  selection: { startMessageIndex: number; endMessageIndex: number },
  messages: readonly ModelMessage[],
): string {
  return stableStringify(messages.slice(selection.startMessageIndex, selection.endMessageIndex + 1));
}

type SemanticCompactSummaryParseReason =
  | 'summary_missing'
  | 'summary_invalid_json'
  | 'summary_schema_invalid'
  | 'summary_missing_current_objective'
  | 'summary_missing_next_action';

function parseSemanticCompactSummary(text: string): {
  ok: true;
  summary: SemanticCompactStructuredSummary;
} | {
  ok: false;
  reason: SemanticCompactSummaryParseReason;
} {
  const raw = text.trim();
  if (!raw) return { ok: false, reason: 'summary_missing' };
  const jsonText = extractJsonObjectText(raw);
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText);
      const normalized = normalizeStructuredSummary(parsed);
      if (normalized.ok) return normalized;
      return { ok: false, reason: normalized.reason };
    } catch {
      return { ok: false, reason: 'summary_invalid_json' };
    }
  }
  const legacy = parseLegacyLabeledSummary(raw);
  if (legacy.ok) return legacy;
  return { ok: false, reason: 'summary_invalid_json' };
}

function renderStructuredSemanticSummary(summary: SemanticCompactStructuredSummary): string {
  return [
    `current_objective: ${summary.currentObjective}`,
    ...renderSummaryList('user_constraints', summary.userConstraints),
    ...renderSummaryList('important_files_and_artifacts', summary.importantFilesAndArtifacts),
    ...renderSummaryList('commands_and_results', summary.commandsAndResults),
    ...renderSummaryList('errors_and_fixes', summary.errorsAndFixes),
    ...renderSummaryList('failed_hypotheses', summary.failedHypotheses),
    ...renderSummaryList('operational_state', summary.operationalState),
    `public_verification_state: ${summary.publicVerificationState || 'No public verification state claimed.'}`,
    ...renderSummaryList('remaining_work', summary.remainingWork),
    `next_action: ${summary.nextAction}`,
    ...renderSummaryList('archive_refs_to_reread_if_needed', summary.archiveRefsToRereadIfNeeded),
  ].join('\n').trim();
}

function renderSummaryList(label: string, values: readonly string[]): string[] {
  const clean = values.map(singleLine).filter(nonEmpty).slice(0, 8);
  if (clean.length === 0) return [`${label}: none`];
  if (clean.length === 1) return [`${label}: ${clean[0]}`];
  return [`${label}:`, ...clean.map((value) => `- ${value}`)];
}

function extractJsonObjectText(raw: string): string | undefined {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fence?.[1]?.trim() ?? raw;
  if (candidate.startsWith('{') && candidate.endsWith('}')) return candidate;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) return candidate.slice(start, end + 1);
  return undefined;
}

function normalizeStructuredSummary(value: unknown): {
  ok: true;
  summary: SemanticCompactStructuredSummary;
} | {
  ok: false;
  reason: SemanticCompactSummaryParseReason;
} {
  if (!isRecord(value)) return { ok: false, reason: 'summary_schema_invalid' };
  const currentObjective = stringField(value, 'current_objective');
  if (!currentObjective) return { ok: false, reason: 'summary_missing_current_objective' };
  const nextAction = stringField(value, 'next_action');
  if (!nextAction) return { ok: false, reason: 'summary_missing_next_action' };
  return {
    ok: true,
    summary: {
      currentObjective,
      userConstraints: stringListField(value, 'user_constraints'),
      importantFilesAndArtifacts: stringListField(value, 'important_files_and_artifacts'),
      commandsAndResults: stringListField(value, 'commands_and_results'),
      errorsAndFixes: stringListField(value, 'errors_and_fixes'),
      failedHypotheses: stringListField(value, 'failed_hypotheses'),
      operationalState: stringListField(value, 'operational_state'),
      publicVerificationState: stringField(value, 'public_verification_state') ?? '',
      remainingWork: stringListField(value, 'remaining_work'),
      nextAction,
      archiveRefsToRereadIfNeeded: stringListField(value, 'archive_refs_to_reread_if_needed'),
    },
  };
}

function parseLegacyLabeledSummary(raw: string): {
  ok: true;
  summary: SemanticCompactStructuredSummary;
} | {
  ok: false;
  reason: SemanticCompactSummaryParseReason;
} {
  const currentObjective = extractSummaryField(raw, SUMMARY_FIELD_LABELS.objective);
  if (!currentObjective) return { ok: false, reason: 'summary_missing_current_objective' };
  const nextAction = extractSummaryField(raw, SUMMARY_FIELD_LABELS.nextAction);
  if (!nextAction) return { ok: false, reason: 'summary_missing_next_action' };
  return {
    ok: true,
    summary: {
      currentObjective,
      userConstraints: fieldListFromLegacy(raw, ['user_constraints', 'user constraints']),
      importantFilesAndArtifacts: fieldListFromLegacy(raw, ['important_files_and_artifacts', 'important files and artifacts']),
      commandsAndResults: fieldListFromLegacy(raw, ['commands_and_results', 'commands and results']),
      errorsAndFixes: fieldListFromLegacy(raw, ['errors_and_fixes', 'errors and fixes']),
      failedHypotheses: fieldListFromLegacy(raw, ['failed_hypotheses', 'failed hypotheses']),
      operationalState: fieldListFromLegacy(raw, ['operational_state', 'operational state']),
      publicVerificationState: extractSummaryField(raw, ['public_verification_state', 'public verification state']) ?? '',
      remainingWork: fieldListFromLegacy(raw, ['remaining_work', 'remaining work']),
      nextAction,
      archiveRefsToRereadIfNeeded: fieldListFromLegacy(raw, ['archive_refs_to_reread_if_needed', 'archive refs to reread if needed']),
    },
  };
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  if (typeof field !== 'string') return undefined;
  const trimmed = singleLine(field);
  return trimmed.length > 0 ? trimmed : undefined;
}

function stringListField(value: Record<string, unknown>, key: string): string[] {
  const field = value[key];
  if (Array.isArray(field)) return field.map((item) => typeof item === 'string' ? singleLine(item) : '').filter(nonEmpty).slice(0, 8);
  if (typeof field === 'string') {
    const trimmed = singleLine(field);
    return trimmed.length > 0 && trimmed.toLowerCase() !== 'none' ? [trimmed] : [];
  }
  return [];
}

function fieldListFromLegacy(raw: string, labels: readonly string[]): string[] {
  const field = extractSummaryField(raw, labels);
  if (!field || field.toLowerCase() === 'none') return [];
  return field.split(/\n|;|\u2022/g).map((part) => singleLine(part.replace(/^-+\s*/, ''))).filter(nonEmpty).slice(0, 8);
}

function extractSummaryField(summaryText: string, labels: readonly string[]): string | undefined {
  const lines = summaryText.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_ ]{0,64})\s*:\s*(.*)$/);
    if (!match) continue;
    const label = match[1]!.trim().toLowerCase().replace(/\s+/g, ' ');
    const wanted = labels.map((value) => value.toLowerCase().replace(/_/g, ' '));
    if (!wanted.includes(label.replace(/_/g, ' '))) continue;
    const inlineValue = match[2]!.trim();
    if (inlineValue.length > 0) return inlineValue;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^\s*[A-Za-z_][A-Za-z0-9_ ]{0,64}\s*:/.test(lines[cursor]!)) break;
      const continuation = lines[cursor]!.trim();
      if (continuation.length > 0) return continuation;
    }
  }
  return undefined;
}

function newPrivateVerifierSurface(summaryText: string, publicSourceText: string): boolean {
  return PRIVATE_VERIFIER_PATTERN.test(summaryText) && !PRIVATE_VERIFIER_PATTERN.test(publicSourceText);
}

function failClosed(
  messages: ModelMessage[],
  index: ActiveFullCompactSourceIndex,
  input: {
    stage: SemanticCompactFailureStage;
    reason: SemanticCompactFailureReason;
    reasons: readonly SemanticCompactFailureReason[];
    retryable?: boolean;
    block?: SemanticCompactBlock;
    validation?: ActiveFullCompactValidationResult;
    compactCallUsage?: SemanticCompactBlock['compactCallUsage'];
  },
): SemanticCompactRewriteResult {
  const reasons = uniqueStrings(input.reasons) as SemanticCompactFailureReason[];
  return {
    messages,
    decision: 'failedOpen',
    reason: input.reason,
    ...(input.block ? { block: input.block } : {}),
    ...(input.validation ? { validation: input.validation } : {}),
    failure: {
      kind: 'maka.semantic_compact_failure',
      stage: input.stage,
      reason: input.reason,
      reasons,
      retryable: input.retryable ?? false,
    },
    diagnosticPatch: semanticCompactDecisionDiagnosticPatch({
      decision: 'failedOpen',
      reason: input.reason,
      failOpenReason: input.reason,
      estimatedTokensBefore: index.estimatedTokens,
      estimatedTokensAfter: index.estimatedTokens,
      estimatedTokensSaved: 0,
      ...(input.compactCallUsage ? { compactCallUsage: input.compactCallUsage } : {}),
      skippedReasonCounts: countStringReasons(reasons),
      ...(input.validation ? { validationReasonCounts: input.validation.reasonCounts } : {}),
    }),
  };
}

function unchanged(messages: ModelMessage[], reason: string): SemanticCompactRewriteResult {
  return {
    messages,
    decision: 'unchanged',
    reason,
    diagnosticPatch: semanticCompactDecisionDiagnosticPatch({
      decision: 'unchanged',
      reason,
    }),
  };
}

function compactUsage(usage: NormalizedAiSdkUsage): NonNullable<SemanticCompactBlock['compactCallUsage']> {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheHitInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
    totalTokens: usage.totalTokens,
  };
}

function semanticFailureStage(reason: SemanticCompactFailureReason): SemanticCompactFailureStage {
  if (reason === 'summarizer_failed' || reason === 'summarizer_timeout') return 'summarizer';
  if (
    reason === 'summary_missing'
    || reason === 'summary_invalid_json'
    || reason === 'summary_schema_invalid'
    || reason === 'summary_missing_current_objective'
    || reason === 'summary_missing_next_action'
    || reason === 'private_verifier_surface'
  ) {
    return 'summary';
  }
  if (
    reason === 'current_user_not_preserved'
    || reason === 'provider_message_structure_invalid'
    || reason === 'tool_pair_split'
    || reason === 'thinking_pair_split'
  ) {
    return 'provider_shape';
  }
  if (
    reason === 'non_positive_savings'
    || reason === 'below_min_savings_tokens'
    || reason === 'below_min_savings_ratio'
    || reason === 'non_positive_net_savings'
    || reason === 'below_min_net_savings_tokens'
  ) {
    return 'economics';
  }
  return 'source_validation';
}

function validatePreservedToolPairs(
  originalMessages: readonly ModelMessage[],
  replacementMessages: readonly ModelMessage[],
  startMessageIndex: number,
  endMessageIndex: number,
  add: (reason: SemanticCompactFailureReason) => void,
): void {
  const original = collectToolMessagePositions(originalMessages);
  const replacement = collectToolMessagePositions(replacementMessages);
  const toolCallIds = new Set([...original.calls.keys(), ...original.results.keys()]);
  for (const toolCallId of toolCallIds) {
    const callIndexes = original.calls.get(toolCallId) ?? [];
    const resultIndexes = original.results.get(toolCallId) ?? [];
    const allIndexes = [...callIndexes, ...resultIndexes];
    const coveredCount = allIndexes.filter((index) => index >= startMessageIndex && index <= endMessageIndex).length;
    if (coveredCount > 0 && coveredCount < allIndexes.length) {
      add('tool_pair_split');
      continue;
    }
    if (coveredCount === allIndexes.length || callIndexes.length === 0 || resultIndexes.length === 0) continue;

    const replacementCalls = replacement.calls.get(toolCallId) ?? [];
    const replacementResults = replacement.results.get(toolCallId) ?? [];
    if (replacementCalls.length !== callIndexes.length || replacementResults.length !== resultIndexes.length) {
      add('tool_pair_split');
      continue;
    }
    const expectedCalls = callIndexes.map((index) => mapPreservedMessageIndex(index, startMessageIndex, endMessageIndex));
    const expectedResults = resultIndexes.map((index) => mapPreservedMessageIndex(index, startMessageIndex, endMessageIndex));
    if (!sameNumbers(expectedCalls, replacementCalls) || !sameNumbers(expectedResults, replacementResults)) {
      add('tool_pair_split');
      continue;
    }
    if (Math.max(...replacementCalls) >= Math.min(...replacementResults)) add('tool_pair_split');
  }
}

function validatePreservedThinking(
  originalMessages: readonly ModelMessage[],
  replacementMessages: readonly ModelMessage[],
  startMessageIndex: number,
  endMessageIndex: number,
  add: (reason: SemanticCompactFailureReason) => void,
): void {
  originalMessages.forEach((message, index) => {
    if (index >= startMessageIndex && index <= endMessageIndex) return;
    if (!messageHasThinking(message)) return;
    const mappedIndex = mapPreservedMessageIndex(index, startMessageIndex, endMessageIndex);
    if (!sameModelMessage(message, replacementMessages[mappedIndex])) add('thinking_pair_split');
  });
  for (const message of replacementMessages) {
    if ((message as { role?: string }).role !== 'assistant') continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    const thinkingIndex = content.findIndex((part) => isThinkingPart(part));
    const toolCallIndex = content.findIndex((part) => isRecord(part) && part.type === 'tool-call');
    if (thinkingIndex >= 0 && toolCallIndex >= 0 && thinkingIndex > toolCallIndex) add('thinking_pair_split');
  }
}

function collectToolMessagePositions(messages: readonly ModelMessage[]): {
  calls: Map<string, number[]>;
  results: Map<string, number[]>;
} {
  const calls = new Map<string, number[]>();
  const results = new Map<string, number[]>();
  messages.forEach((message, index) => {
    for (const id of messageToolCallIds(message)) pushNumber(calls, id, index);
    for (const id of messageToolResultIds(message)) pushNumber(results, id, index);
  });
  return { calls, results };
}

function pushNumber(map: Map<string, number[]>, key: string, value: number): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

function messageHasThinking(message: ModelMessage): boolean {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) && content.some(isThinkingPart);
}

function isThinkingPart(value: unknown): boolean {
  return isRecord(value) && (value.type === 'reasoning' || value.type === 'thinking');
}

function findLastMessageIndex(messages: readonly ModelMessage[], role: string): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if ((messages[index] as { role?: string } | undefined)?.role === role) return index;
  }
  return -1;
}

function mapPreservedMessageIndex(index: number, startMessageIndex: number, endMessageIndex: number): number {
  if (index < startMessageIndex) return index;
  return index - (endMessageIndex - startMessageIndex);
}

function sameModelMessages(left: readonly ModelMessage[], right: readonly ModelMessage[]): boolean {
  return left.length === right.length && left.every((message, index) => sameModelMessage(message, right[index]));
}

function sameModelMessage(left: ModelMessage | undefined, right: ModelMessage | undefined): boolean {
  return left !== undefined && right !== undefined && stableStringify(left) === stableStringify(right);
}

function sameOptionalArchiveRef(
  left: ActiveFullCompactArchiveRef | undefined,
  right: ActiveFullCompactArchiveRef | undefined,
): boolean {
  if (!left || !right) return left === right;
  return stableStringify(left) === stableStringify(right);
}

function sourceRefKindForEntry(entry: ActiveFullCompactSourceEntry): ActiveFullCompactSourceRef['kind'] {
  if (entry.archiveRef) return 'active_archive_placeholder';
  if (entry.runtimeEventId) return 'runtime_event';
  return 'provider_message';
}

function isBasicProviderMessageShape(message: ModelMessage): boolean {
  const candidate = message as { role?: unknown; content?: unknown };
  if (
    candidate.role !== 'system'
    && candidate.role !== 'user'
    && candidate.role !== 'assistant'
    && candidate.role !== 'tool'
  ) {
    return false;
  }
  if (typeof candidate.content === 'string') return candidate.role !== 'tool';
  if (!Array.isArray(candidate.content) || !candidate.content.every((part) => isRecord(part) && nonEmpty(part.type))) {
    return false;
  }
  return candidate.role !== 'tool' || candidate.content.every((part) => part.type === 'tool-result');
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function uniqueArchiveRefs(refs: readonly ActiveFullCompactArchiveRef[]): ActiveFullCompactArchiveRef[] {
  const seen = new Set<string>();
  const out: ActiveFullCompactArchiveRef[] = [];
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.artifactId}:${ref.bodySha256}:${ref.toolCallId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function isArchiveRef(value: unknown): value is ActiveFullCompactArchiveRef {
  return isRecord(value)
    && (value.kind === 'toolResult' || value.kind === 'compactSource')
    && typeof value.artifactId === 'string'
    && typeof value.bodySha256 === 'string';
}

function finiteRatio(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(0, Math.min(1, value));
}

function finiteNonNegativeNumber(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key])]),
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function countStringReasons(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
