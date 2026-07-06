import type { LlmConnection } from '@maka/core/llm-connections';
import type { ContextBudgetPolicy } from './context-budget.js';

export interface BuildDefaultContextBudgetPolicyOptions {
  name?: string;
  env?: Record<string, string | undefined>;
}

export function buildDefaultContextBudgetPolicy(
  connection: LlmConnection,
  options: BuildDefaultContextBudgetPolicyOptions = {},
): ContextBudgetPolicy | undefined {
  const env = options.env ?? process.env;
  if (env.MAKA_CONTEXT_BUDGET === 'off') return undefined;
  const maxHistoryEstimatedTokens =
    parseOptionalPositiveInt(env.MAKA_CONTEXT_HISTORY_BUDGET_TOKENS) ??
    defaultHistoryBudgetTokens(connection);
  const maxHistoryTurns = parseOptionalPositiveInt(env.MAKA_CONTEXT_HISTORY_BUDGET_TURNS);
  const minRecentTurns = parsePositiveInt(env.MAKA_CONTEXT_MIN_RECENT_TURNS, 2);
  const surfaceName = (options.name ?? 'default-history-budget').replace(/-default-history-budget$/, '');
  const staleToolResultPrune = buildStaleToolResultPrunePolicy(env);
  const archiveRetrieval = buildArchiveRetrievalPolicy(env);
  const historySearch = buildHistorySearchPolicy(env);
  const synthesisCache = buildSynthesisCachePolicy(env);
  const historyCompact = buildHistoryCompactPolicy(env, `${surfaceName}-history-compact`);
  const historyRewrite = buildHistoryRewriteGatePolicy(env, `${surfaceName}-history-rewrite`);
  const semanticCompact = buildSemanticCompactPolicy(env, `${surfaceName}-semantic-compact`);
  const activeToolResultPrune = buildActiveToolResultPrunePolicy(env);
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
    name: options.name ?? 'default-history-budget',
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

export interface BuildManualCompactLookupPolicyOptions {
  highWaterName?: string;
}

// Overlay a bounded lookup-only historyCompact policy for manual compaction:
// replay loaded compact blocks but never synthesize fallback blocks, and cap
// the replayed history so a manual /compact cannot balloon the context. Keeps
// every compact default in one place so the CLI and desktop do not diverge.
export function buildManualCompactLookupPolicy(
  base: ContextBudgetPolicy | undefined,
  options: BuildManualCompactLookupPolicyOptions = {},
): ContextBudgetPolicy | undefined {
  if (!base) return undefined;
  const budgetedPolicy = base.maxHistoryEstimatedTokens === undefined
    ? { ...base, maxHistoryEstimatedTokens: 32_000 }
    : base;
  const current = budgetedPolicy.historyCompact;
  return {
    ...budgetedPolicy,
    historyCompact: {
      ...current,
      enabled: true,
      mode: 'lookup',
      highWaterRatio: 0.000001,
      tailEstimatedTokens: 1,
      minRecentTurns: current?.minRecentTurns ?? budgetedPolicy.minRecentTurns ?? 1,
      maxBlocks: current?.maxBlocks ?? 1,
      maxEstimatedTokens: current?.maxEstimatedTokens ?? 2_048,
      maxBlockEstimatedTokens: current?.maxBlockEstimatedTokens ?? 1_024,
      highWaterName: current?.highWaterName ?? options.highWaterName ?? 'manual-history-compact',
    },
  };
}

function buildStaleToolResultPrunePolicy(
  env: Record<string, string | undefined>,
): NonNullable<ContextBudgetPolicy['staleToolResultPrune']> | undefined {
  if (env.MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE !== 'on') return undefined;
  return {
    enabled: true,
    maxResultEstimatedTokens: parsePositiveInt(
      env.MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_TOKENS,
      2048,
    ),
    minRecentTurnsFull: parsePositiveInt(
      env.MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS,
      parsePositiveInt(env.MAKA_CONTEXT_MIN_RECENT_TURNS, 2),
    ),
  };
}

function buildActiveToolResultPrunePolicy(
  env: Record<string, string | undefined>,
): NonNullable<ContextBudgetPolicy['activeToolResultPrune']> | undefined {
  const enabled = parseOptionalBoolean(
    env.MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE,
    'MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE',
  );
  if (enabled === false) return undefined;
  return {
    enabled: true,
    maxCurrentResultEstimatedTokens: parsePositiveInt(
      env.MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MAX_ESTIMATED_TOKENS,
      2048,
    ),
    minStepNumber: parseOptionalNonNegativeInt(env.MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MIN_STEP_NUMBER) ?? 1,
  };
}

function buildArchiveRetrievalPolicy(
  env: Record<string, string | undefined>,
): NonNullable<ContextBudgetPolicy['archiveRetrieval']> | undefined {
  if (env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL !== 'on') return undefined;
  const mode = parseArchiveRetrievalMode(env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MODE);
  return {
    enabled: true,
    ...(mode ? { mode } : {}),
    maxResults: parsePositiveInt(env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_RESULTS, 3),
    maxEstimatedTokens: parsePositiveInt(env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_TOKENS, 8192),
    maxBytes: parsePositiveInt(env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_BYTES, 1024 * 1024),
    order: 'newest_first',
  };
}

function buildHistorySearchPolicy(
  env: Record<string, string | undefined>,
): NonNullable<ContextBudgetPolicy['historySearch']> | undefined {
  if (env.MAKA_CONTEXT_HISTORY_SEARCH !== 'on') return undefined;
  return {
    enabled: true,
    maxResults: parsePositiveInt(env.MAKA_CONTEXT_HISTORY_SEARCH_MAX_RESULTS, 5),
    around: parsePositiveInt(env.MAKA_CONTEXT_HISTORY_SEARCH_AROUND, 1),
    maxEstimatedTokens: parsePositiveInt(env.MAKA_CONTEXT_HISTORY_SEARCH_MAX_TOKENS, 4096),
  };
}

function buildSynthesisCachePolicy(
  env: Record<string, string | undefined>,
): NonNullable<ContextBudgetPolicy['synthesisCache']> | undefined {
  if (env.MAKA_CONTEXT_SYNTHESIS_CACHE !== 'on') return undefined;
  return {
    enabled: true,
    mode: parseSynthesisCacheMode(env.MAKA_CONTEXT_SYNTHESIS_CACHE_MODE),
    maxBlocks: parsePositiveInt(env.MAKA_CONTEXT_SYNTHESIS_CACHE_MAX_BLOCKS, 1),
    maxEstimatedTokens: parsePositiveInt(env.MAKA_CONTEXT_SYNTHESIS_CACHE_MAX_TOKENS, 2048),
    maxBlockEstimatedTokens: parsePositiveInt(env.MAKA_CONTEXT_SYNTHESIS_CACHE_MAX_BLOCK_TOKENS, 1024),
    invalidateOnNewToolResult: true,
    schemaVersion: 1,
  };
}

function buildHistoryCompactPolicy(
  env: Record<string, string | undefined>,
  defaultHighWaterName: string,
): NonNullable<ContextBudgetPolicy['historyCompact']> | undefined {
  if (env.MAKA_CONTEXT_HISTORY_COMPACT !== 'on') return undefined;
  const highWaterRatio = parseOptionalRatio(env.MAKA_CONTEXT_HISTORY_COMPACT_HIGH_WATER_RATIO);
  const forceRatio = parseOptionalRatio(env.MAKA_CONTEXT_HISTORY_COMPACT_FORCE_RATIO);
  const targetRatio = parseOptionalRatio(env.MAKA_CONTEXT_HISTORY_COMPACT_TARGET_RATIO);
  const tailEstimatedTokens = parseOptionalPositiveInt(env.MAKA_CONTEXT_HISTORY_COMPACT_TAIL_TOKENS);
  const minRecentTurns = parseOptionalPositiveInt(env.MAKA_CONTEXT_HISTORY_COMPACT_MIN_RECENT_TURNS);
  const maxSummaryEstimatedTokens = parseOptionalPositiveInt(env.MAKA_CONTEXT_HISTORY_COMPACT_MAX_SUMMARY_TOKENS);
  return {
    enabled: true,
    mode: parseHistoryCompactMode(env.MAKA_CONTEXT_HISTORY_COMPACT_MODE),
    ...(highWaterRatio !== undefined ? { highWaterRatio } : {}),
    ...(forceRatio !== undefined ? { forceRatio } : {}),
    ...(targetRatio !== undefined ? { targetRatio } : {}),
    ...(tailEstimatedTokens !== undefined ? { tailEstimatedTokens } : {}),
    ...(minRecentTurns !== undefined ? { minRecentTurns } : {}),
    ...(maxSummaryEstimatedTokens !== undefined ? { maxSummaryEstimatedTokens } : {}),
    maxBlocks: parsePositiveInt(env.MAKA_CONTEXT_HISTORY_COMPACT_MAX_BLOCKS, 1),
    maxEstimatedTokens: parsePositiveInt(env.MAKA_CONTEXT_HISTORY_COMPACT_MAX_TOKENS, 2048),
    maxBlockEstimatedTokens: parsePositiveInt(env.MAKA_CONTEXT_HISTORY_COMPACT_MAX_BLOCK_TOKENS, 1024),
    highWaterName: env.MAKA_CONTEXT_HISTORY_COMPACT_HIGH_WATER_NAME ?? defaultHighWaterName,
  };
}

function buildHistoryRewriteGatePolicy(
  env: Record<string, string | undefined>,
  defaultName: string,
): NonNullable<ContextBudgetPolicy['historyRewrite']> | undefined {
  if (env.MAKA_CONTEXT_HISTORY_REWRITE !== 'on') return undefined;
  return {
    enabled: true,
    name: env.MAKA_CONTEXT_HISTORY_REWRITE_NAME ?? defaultName,
    historyRewriteVersion: env.MAKA_CONTEXT_HISTORY_REWRITE_VERSION ?? 'phase6-v1',
    resetReason: env.MAKA_CONTEXT_HISTORY_REWRITE_RESET_REASON ?? 'operator_enabled_history_rewrite_gate',
  };
}

function buildSemanticCompactPolicy(
  env: Record<string, string | undefined>,
  defaultHighWaterName: string,
): NonNullable<ContextBudgetPolicy['semanticCompact']> | undefined {
  const enabled = parseOptionalBoolean(env.MAKA_CONTEXT_SEMANTIC_COMPACT, 'MAKA_CONTEXT_SEMANTIC_COMPACT');
  if (enabled === false) return undefined;
  const mode = parseSemanticCompactMode(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MODE);
  if (mode === 'off') return undefined;
  const rejectInvalidSummaries = parseOptionalBoolean(
    env.MAKA_CONTEXT_SEMANTIC_COMPACT_REJECT_INVALID_SUMMARIES,
    'MAKA_CONTEXT_SEMANTIC_COMPACT_REJECT_INVALID_SUMMARIES',
  );
  const archiveRequired = parseOptionalBoolean(
    env.MAKA_CONTEXT_SEMANTIC_COMPACT_ARCHIVE_REQUIRED,
    'MAKA_CONTEXT_SEMANTIC_COMPACT_ARCHIVE_REQUIRED',
  );
  const benchmarkStateCards = parseOptionalBoolean(
    env.MAKA_CONTEXT_SEMANTIC_COMPACT_BENCHMARK_STATE_CARDS,
    'MAKA_CONTEXT_SEMANTIC_COMPACT_BENCHMARK_STATE_CARDS',
  );
  return {
    enabled: true,
    mode: mode ?? 'replace',
    minStepNumber: parseOptionalNonNegativeInt(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_STEP_NUMBER) ?? 2,
    highWaterRatio: parseOptionalRatio(env.MAKA_CONTEXT_SEMANTIC_COMPACT_HIGH_WATER_RATIO) ?? 0.5,
    forceRatio: parseOptionalRatio(env.MAKA_CONTEXT_SEMANTIC_COMPACT_FORCE_RATIO),
    targetRatio: parseOptionalRatio(env.MAKA_CONTEXT_SEMANTIC_COMPACT_TARGET_RATIO),
    maxActiveEstimatedTokens:
      parseOptionalPositiveInt(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_ACTIVE_ESTIMATED_TOKENS) ??
      parseOptionalPositiveInt(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_ESTIMATED_TOKENS) ??
      16_384,
    minRecentMessages: parseOptionalNonNegativeInt(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_RECENT_MESSAGES) ?? 4,
    minRecentToolPairs: parseOptionalNonNegativeInt(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_RECENT_TOOL_PAIRS) ?? 1,
    maxSummaryEstimatedTokens:
      parseOptionalPositiveInt(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_SUMMARY_ESTIMATED_TOKENS) ??
      parseOptionalPositiveInt(env.MAKA_CONTEXT_SEMANTIC_COMPACT_SUMMARY_MAX_ESTIMATED_TOKENS) ??
      768,
    minSavingsTokens: parseOptionalNonNegativeInt(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_SAVINGS_TOKENS) ?? 256,
    minSavingsRatio: parseOptionalRatio(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_SAVINGS_RATIO),
    minNetSavingsTokens: parseOptionalNonNegativeInt(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_NET_SAVINGS_TOKENS) ?? 256,
    compactCallTokenCostWeight: parseOptionalNonNegativeNumber(
      env.MAKA_CONTEXT_SEMANTIC_COMPACT_CALL_TOKEN_COST_WEIGHT,
    ),
    maxCompactCallTokens: parseOptionalPositiveInt(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_CALL_TOKENS) ?? 4096,
    maxConsecutiveInvalidSummaries:
      parseOptionalNonNegativeInt(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_CONSECUTIVE_INVALID_SUMMARIES) ?? 2,
    invalidSummaryCooldownSteps:
      parseOptionalNonNegativeInt(env.MAKA_CONTEXT_SEMANTIC_COMPACT_INVALID_SUMMARY_COOLDOWN_STEPS) ?? 8,
    ...(rejectInvalidSummaries !== undefined ? { rejectInvalidSummaries } : {}),
    timeoutMs: parseOptionalPositiveInt(env.MAKA_CONTEXT_SEMANTIC_COMPACT_TIMEOUT_MS),
    ...(archiveRequired !== undefined ? { archiveRequired } : {}),
    ...(benchmarkStateCards !== undefined ? { benchmarkStateCards } : {}),
    ...(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MODEL
      ? { summarizerModel: env.MAKA_CONTEXT_SEMANTIC_COMPACT_MODEL }
      : {}),
    ...(env.MAKA_CONTEXT_SEMANTIC_COMPACT_PROMPT_VERSION
      ? { promptVersion: env.MAKA_CONTEXT_SEMANTIC_COMPACT_PROMPT_VERSION }
      : {}),
    highWaterName: env.MAKA_CONTEXT_SEMANTIC_COMPACT_HIGH_WATER_NAME ?? defaultHighWaterName,
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
