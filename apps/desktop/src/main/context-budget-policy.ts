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
  if (
    maxHistoryEstimatedTokens === undefined &&
    maxHistoryTurns === undefined &&
    staleToolResultPrune === undefined &&
    archiveRetrieval === undefined &&
    historySearch === undefined &&
    synthesisCache === undefined &&
    historyCompact === undefined &&
    historyRewrite === undefined
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

function parseArchiveRetrievalMode(value: string | undefined): NonNullable<ContextBudgetPolicy['archiveRetrieval']>['mode'] | undefined {
  return value === 'history_search_gated' || value === 'eager' ? value : undefined;
}
