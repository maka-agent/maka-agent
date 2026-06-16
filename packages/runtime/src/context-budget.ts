import type { ModelMessage } from 'ai';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type {
  ContextBudgetDiagnostic,
  PromptSegmentEstimate,
} from '@maka/core/usage-stats/types';

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

export const ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND = 'maka.archived_tool_result';
export const ARCHIVED_TOOL_RESULT_REWRITE_VERSION = 1;
const DEFAULT_MAX_TOOL_RESULT_ESTIMATED_TOKENS = 2048;
export type ArchivedToolResultReason = 'stale_tool_result_pruned_before_compact';

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

export interface BudgetedRuntimeContext {
  events: RuntimeEvent[];
  diagnostic: ContextBudgetDiagnostic;
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
  const enabled = Boolean(policy?.maxHistoryEstimatedTokens || policy?.maxHistoryTurns || pruneEnabled);
  if (!enabled) return undefined;
  if (!policy) return undefined;
  const charsPerToken = policy?.charsPerToken ?? 4;
  const maxTokens = finitePositive(policy?.maxHistoryEstimatedTokens);
  const maxTurns = finitePositive(policy?.maxHistoryTurns);
  const minRecentTurns = Math.max(0, Math.floor(policy?.minRecentTurns ?? 1));
  const estimatedTokensBefore = estimateRuntimeEventsTokens(events, charsPerToken);
  const pruned = pruneStaleToolResultsBeforeCompact(events, policy, charsPerToken);
  const budgetEvents = pruned.events;
  const turnGroups = groupEventsByTurn(budgetEvents, charsPerToken);

  const keptTurnIds = new Set<string>();
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

  const keptEvents = budgetEvents.filter((event) => keptTurnIds.has(turnKey(event)));
  const diagnostic: ContextBudgetDiagnostic = {
    enabled: true,
    ...(policy?.name ? { policyName: policy.name } : {}),
    ...(maxTokens !== undefined ? { maxHistoryEstimatedTokens: maxTokens } : {}),
    ...(maxTurns !== undefined ? { maxHistoryTurns: maxTurns } : {}),
    estimatedTokensBefore,
    estimatedTokensAfter: estimateRuntimeEventsTokens(keptEvents, charsPerToken),
    keptTurns: keptTurnIds.size,
    droppedTurns: Math.max(0, turnGroups.length - keptTurnIds.size),
    keptEvents: keptEvents.length,
    droppedEvents: Math.max(0, budgetEvents.length - keptEvents.length),
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
  return { events: keptEvents, diagnostic };
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
    const resultBytes = serializedResult.length;
    const resultEstimatedTokens = estimateTokens(resultBytes, charsPerToken);
    if (resultEstimatedTokens <= maxResultEstimatedTokens) return event;

    const archiveRef = archiveRefs.get(event.id);
    if (!archiveRef || !archiveRefMatches(archiveRef, {
      runtimeEventId: event.id,
      toolCallId: content.id,
      toolName: content.name,
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
    const originalBytes = serializedResult.length;
    const originalEstimatedTokens = estimateTokens(originalBytes, charsPerToken);
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

function finitePositive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}
