import type { LlmConnection } from '@maka/core/llm-connections';
import type { ContextBudgetPolicy } from '@maka/runtime';

export function buildContextBudgetPolicy(connection: LlmConnection): ContextBudgetPolicy | undefined {
  if (process.env.MAKA_CONTEXT_BUDGET === 'off') return undefined;
  const maxHistoryEstimatedTokens =
    parseOptionalPositiveInt(process.env.MAKA_CONTEXT_HISTORY_BUDGET_TOKENS) ??
    defaultHistoryBudgetTokens(connection);
  const maxHistoryTurns = parseOptionalPositiveInt(process.env.MAKA_CONTEXT_HISTORY_BUDGET_TURNS);
  const minRecentTurns = parsePositiveInt(process.env.MAKA_CONTEXT_MIN_RECENT_TURNS, 2);
  const staleToolResultPrune = buildStaleToolResultPrunePolicy();
  const archiveRetrieval = buildArchiveRetrievalPolicy();
  const historySearch = buildHistorySearchPolicy();
  const synthesisCache = buildSynthesisCachePolicy();
  const historyCompact = buildHistoryCompactPolicy();
  const historyRewrite = buildHistoryRewriteGatePolicy();
  const semanticCompact = buildSemanticCompactPolicy();
  const activeToolResultPrune = buildActiveToolResultPrunePolicy();
  if (
    maxHistoryEstimatedTokens === undefined &&
    maxHistoryTurns === undefined &&
    staleToolResultPrune === undefined &&
    archiveRetrieval === undefined &&
    historySearch === undefined &&
    synthesisCache === undefined &&
    historyCompact === undefined &&
    semanticCompact === undefined &&
    historyRewrite === undefined &&
    activeToolResultPrune === undefined
  ) {
    return undefined;
  }
  return {
    name: 'desktop-default-history-budget',
    ...(maxHistoryTurns !== undefined ? { maxHistoryTurns } : {}),
    ...(maxHistoryEstimatedTokens !== undefined ? { maxHistoryEstimatedTokens } : {}),
    ...(staleToolResultPrune !== undefined ? { staleToolResultPrune } : {}),
    ...(archiveRetrieval !== undefined ? { archiveRetrieval } : {}),
    ...(historySearch !== undefined ? { historySearch } : {}),
    ...(synthesisCache !== undefined ? { synthesisCache } : {}),
    ...(historyCompact !== undefined ? { historyCompact } : {}),
    ...(semanticCompact !== undefined ? { semanticCompact } : {}),
    ...(activeToolResultPrune !== undefined ? { activeToolResultPrune } : {}),
    ...(historyRewrite !== undefined ? { historyRewrite } : {}),
    minRecentTurns,
  };
}

function buildStaleToolResultPrunePolicy(): NonNullable<ContextBudgetPolicy['staleToolResultPrune']> | undefined {
  if (process.env.MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE !== 'on') return undefined;
  return {
    enabled: true,
    maxResultEstimatedTokens: parsePositiveInt(
      process.env.MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_TOKENS,
      2048,
    ),
    minRecentTurnsFull: parsePositiveInt(
      process.env.MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS,
      parsePositiveInt(process.env.MAKA_CONTEXT_MIN_RECENT_TURNS, 2),
    ),
  };
}

function buildActiveToolResultPrunePolicy(): NonNullable<ContextBudgetPolicy['activeToolResultPrune']> | undefined {
  const enabled = parseOptionalBoolean(
    process.env.MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE,
    'MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE',
  );
  if (enabled === false) return undefined;
  return {
    enabled: true,
    maxCurrentResultEstimatedTokens: parsePositiveInt(
      process.env.MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MAX_ESTIMATED_TOKENS,
      2048,
    ),
    minStepNumber: parseOptionalNonNegativeInt(process.env.MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MIN_STEP_NUMBER) ?? 1,
  };
}

function buildArchiveRetrievalPolicy(): NonNullable<ContextBudgetPolicy['archiveRetrieval']> | undefined {
  if (process.env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL !== 'on') return undefined;
  const mode = parseArchiveRetrievalMode(process.env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MODE);
  return {
    enabled: true,
    ...(mode ? { mode } : {}),
    maxResults: parsePositiveInt(process.env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_RESULTS, 3),
    maxEstimatedTokens: parsePositiveInt(process.env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_TOKENS, 8192),
    maxBytes: parsePositiveInt(process.env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_BYTES, 1024 * 1024),
    order: 'newest_first',
  };
}

function buildHistorySearchPolicy(): NonNullable<ContextBudgetPolicy['historySearch']> | undefined {
  if (process.env.MAKA_CONTEXT_HISTORY_SEARCH !== 'on') return undefined;
  return {
    enabled: true,
    maxResults: parsePositiveInt(process.env.MAKA_CONTEXT_HISTORY_SEARCH_MAX_RESULTS, 5),
    around: parsePositiveInt(process.env.MAKA_CONTEXT_HISTORY_SEARCH_AROUND, 1),
    maxEstimatedTokens: parsePositiveInt(process.env.MAKA_CONTEXT_HISTORY_SEARCH_MAX_TOKENS, 4096),
  };
}

function buildSynthesisCachePolicy(): NonNullable<ContextBudgetPolicy['synthesisCache']> | undefined {
  if (process.env.MAKA_CONTEXT_SYNTHESIS_CACHE !== 'on') return undefined;
  return {
    enabled: true,
    mode: parseSynthesisCacheMode(process.env.MAKA_CONTEXT_SYNTHESIS_CACHE_MODE),
    maxBlocks: parsePositiveInt(process.env.MAKA_CONTEXT_SYNTHESIS_CACHE_MAX_BLOCKS, 1),
    maxEstimatedTokens: parsePositiveInt(process.env.MAKA_CONTEXT_SYNTHESIS_CACHE_MAX_TOKENS, 2048),
    maxBlockEstimatedTokens: parsePositiveInt(process.env.MAKA_CONTEXT_SYNTHESIS_CACHE_MAX_BLOCK_TOKENS, 1024),
    invalidateOnNewToolResult: true,
    schemaVersion: 1,
  };
}

function buildHistoryCompactPolicy(): NonNullable<ContextBudgetPolicy['historyCompact']> | undefined {
  if (process.env.MAKA_CONTEXT_HISTORY_COMPACT !== 'on') return undefined;
  const highWaterRatio = parseOptionalRatio(process.env.MAKA_CONTEXT_HISTORY_COMPACT_HIGH_WATER_RATIO);
  const forceRatio = parseOptionalRatio(process.env.MAKA_CONTEXT_HISTORY_COMPACT_FORCE_RATIO);
  const targetRatio = parseOptionalRatio(process.env.MAKA_CONTEXT_HISTORY_COMPACT_TARGET_RATIO);
  const tailEstimatedTokens = parseOptionalPositiveInt(process.env.MAKA_CONTEXT_HISTORY_COMPACT_TAIL_TOKENS);
  const minRecentTurns = parseOptionalPositiveInt(process.env.MAKA_CONTEXT_HISTORY_COMPACT_MIN_RECENT_TURNS);
  const maxSummaryEstimatedTokens = parseOptionalPositiveInt(process.env.MAKA_CONTEXT_HISTORY_COMPACT_MAX_SUMMARY_TOKENS);
  return {
    enabled: true,
    mode: parseHistoryCompactMode(process.env.MAKA_CONTEXT_HISTORY_COMPACT_MODE),
    ...(highWaterRatio !== undefined ? { highWaterRatio } : {}),
    ...(forceRatio !== undefined ? { forceRatio } : {}),
    ...(targetRatio !== undefined ? { targetRatio } : {}),
    ...(tailEstimatedTokens !== undefined ? { tailEstimatedTokens } : {}),
    ...(minRecentTurns !== undefined ? { minRecentTurns } : {}),
    ...(maxSummaryEstimatedTokens !== undefined ? { maxSummaryEstimatedTokens } : {}),
    maxBlocks: parsePositiveInt(process.env.MAKA_CONTEXT_HISTORY_COMPACT_MAX_BLOCKS, 1),
    maxEstimatedTokens: parsePositiveInt(process.env.MAKA_CONTEXT_HISTORY_COMPACT_MAX_TOKENS, 2048),
    maxBlockEstimatedTokens: parsePositiveInt(process.env.MAKA_CONTEXT_HISTORY_COMPACT_MAX_BLOCK_TOKENS, 1024),
    highWaterName: process.env.MAKA_CONTEXT_HISTORY_COMPACT_HIGH_WATER_NAME ?? 'desktop-history-compact',
  };
}

function buildHistoryRewriteGatePolicy(): NonNullable<ContextBudgetPolicy['historyRewrite']> | undefined {
  if (process.env.MAKA_CONTEXT_HISTORY_REWRITE !== 'on') return undefined;
  return {
    enabled: true,
    name: process.env.MAKA_CONTEXT_HISTORY_REWRITE_NAME ?? 'desktop-history-rewrite',
    historyRewriteVersion: process.env.MAKA_CONTEXT_HISTORY_REWRITE_VERSION ?? 'phase6-v1',
    resetReason: process.env.MAKA_CONTEXT_HISTORY_REWRITE_RESET_REASON ?? 'operator_enabled_history_rewrite_gate',
  };
}

function buildSemanticCompactPolicy(): NonNullable<ContextBudgetPolicy['semanticCompact']> | undefined {
  const enabled = parseOptionalBoolean(process.env.MAKA_CONTEXT_SEMANTIC_COMPACT, 'MAKA_CONTEXT_SEMANTIC_COMPACT');
  if (enabled === false) return undefined;
  const mode = parseSemanticCompactMode(process.env.MAKA_CONTEXT_SEMANTIC_COMPACT_MODE);
  if (mode === 'off') return undefined;
  const rejectInvalidSummaries = parseOptionalBoolean(
    process.env.MAKA_CONTEXT_SEMANTIC_COMPACT_REJECT_INVALID_SUMMARIES,
    'MAKA_CONTEXT_SEMANTIC_COMPACT_REJECT_INVALID_SUMMARIES',
  );
  const archiveRequired = parseOptionalBoolean(
    process.env.MAKA_CONTEXT_SEMANTIC_COMPACT_ARCHIVE_REQUIRED,
    'MAKA_CONTEXT_SEMANTIC_COMPACT_ARCHIVE_REQUIRED',
  );
  const benchmarkStateCards = parseOptionalBoolean(
    process.env.MAKA_CONTEXT_SEMANTIC_COMPACT_BENCHMARK_STATE_CARDS,
    'MAKA_CONTEXT_SEMANTIC_COMPACT_BENCHMARK_STATE_CARDS',
  );
  return {
    enabled: true,
    mode: mode ?? 'replace',
    minStepNumber: parseOptionalNonNegativeInt(process.env.MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_STEP_NUMBER) ?? 2,
    highWaterRatio: parseOptionalRatio(process.env.MAKA_CONTEXT_SEMANTIC_COMPACT_HIGH_WATER_RATIO) ?? 0.5,
    forceRatio: parseOptionalRatio(process.env.MAKA_CONTEXT_SEMANTIC_COMPACT_FORCE_RATIO),
    targetRatio: parseOptionalRatio(process.env.MAKA_CONTEXT_SEMANTIC_COMPACT_TARGET_RATIO),
    maxActiveEstimatedTokens:
      parseOptionalPositiveInt(process.env.MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_ACTIVE_ESTIMATED_TOKENS) ??
      parseOptionalPositiveInt(process.env.MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_ESTIMATED_TOKENS) ??
      16_384,
    minRecentMessages: parseOptionalNonNegativeInt(process.env.MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_RECENT_MESSAGES) ?? 4,
    minRecentToolPairs: parseOptionalNonNegativeInt(process.env.MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_RECENT_TOOL_PAIRS) ?? 1,
    maxSummaryEstimatedTokens:
      parseOptionalPositiveInt(process.env.MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_SUMMARY_ESTIMATED_TOKENS) ??
      parseOptionalPositiveInt(process.env.MAKA_CONTEXT_SEMANTIC_COMPACT_SUMMARY_MAX_ESTIMATED_TOKENS) ??
      768,
    minSavingsTokens: parseOptionalNonNegativeInt(process.env.MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_SAVINGS_TOKENS) ?? 256,
    minSavingsRatio: parseOptionalRatio(process.env.MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_SAVINGS_RATIO),
    minNetSavingsTokens: parseOptionalNonNegativeInt(process.env.MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_NET_SAVINGS_TOKENS) ?? 256,
    compactCallTokenCostWeight: parseOptionalNonNegativeNumber(
      process.env.MAKA_CONTEXT_SEMANTIC_COMPACT_CALL_TOKEN_COST_WEIGHT,
    ),
    maxCompactCallTokens: parseOptionalPositiveInt(process.env.MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_CALL_TOKENS) ?? 4096,
    maxConsecutiveInvalidSummaries:
      parseOptionalNonNegativeInt(process.env.MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_CONSECUTIVE_INVALID_SUMMARIES) ?? 2,
    invalidSummaryCooldownSteps:
      parseOptionalNonNegativeInt(process.env.MAKA_CONTEXT_SEMANTIC_COMPACT_INVALID_SUMMARY_COOLDOWN_STEPS) ?? 8,
    ...(rejectInvalidSummaries !== undefined ? { rejectInvalidSummaries } : {}),
    timeoutMs: parseOptionalPositiveInt(process.env.MAKA_CONTEXT_SEMANTIC_COMPACT_TIMEOUT_MS),
    ...(archiveRequired !== undefined ? { archiveRequired } : {}),
    ...(benchmarkStateCards !== undefined ? { benchmarkStateCards } : {}),
    ...(process.env.MAKA_CONTEXT_SEMANTIC_COMPACT_MODEL
      ? { summarizerModel: process.env.MAKA_CONTEXT_SEMANTIC_COMPACT_MODEL }
      : {}),
    ...(process.env.MAKA_CONTEXT_SEMANTIC_COMPACT_PROMPT_VERSION
      ? { promptVersion: process.env.MAKA_CONTEXT_SEMANTIC_COMPACT_PROMPT_VERSION }
      : {}),
    highWaterName: process.env.MAKA_CONTEXT_SEMANTIC_COMPACT_HIGH_WATER_NAME ?? 'desktop-semantic-compact',
  };
}

function defaultHistoryBudgetTokens(connection: LlmConnection): number | undefined {
  if (connection.providerType === 'deepseek') return undefined;
  return 32_000;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = parseOptionalPositiveInt(value);
  return parsed ?? fallback;
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseOptionalNonNegativeInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseOptionalNonNegativeNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseOptionalRatio(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(1, parsed) : undefined;
}

function parseSynthesisCacheMode(value: string | undefined): 'lookup' | 'read_write' {
  return value === 'read_write' ? 'read_write' : 'lookup';
}

function parseHistoryCompactMode(value: string | undefined): NonNullable<ContextBudgetPolicy['historyCompact']>['mode'] {
  if (value === 'lookup' || value === 'read_write' || value === 'deterministic') return value;
  return 'lookup';
}

function parseSemanticCompactMode(value: string | undefined): NonNullable<ContextBudgetPolicy['semanticCompact']>['mode'] | undefined {
  if (!value) return undefined;
  if (value === 'off' || value === 'validate_only' || value === 'prepare_step_dry_run' || value === 'replace') return value;
  return undefined;
}

function parseOptionalBoolean(value: string | undefined, name: string): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  switch (normalized) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
    case 'enabled':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'off':
    case 'disabled':
      return false;
    default:
      throw new Error(`${name} must be a boolean, got ${JSON.stringify(value)}`);
  }
}

function parseArchiveRetrievalMode(value: string | undefined): NonNullable<ContextBudgetPolicy['archiveRetrieval']>['mode'] | undefined {
  return value === 'history_search_gated' || value === 'eager' ? value : undefined;
}
