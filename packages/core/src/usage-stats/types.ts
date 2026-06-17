export type TimeRange =
  | '24h'
  | '7d'
  | '30d'
  | 'all'
  | { from: number; to: number };

export type UsageGroupBy = 'provider' | 'model' | 'tool' | 'day' | 'hour';

export interface UsageQuery {
  range: TimeRange;
  connectionSlug?: string;
  providerId?: string;
  modelId?: string;
  toolName?: string;
  status?: 'success' | 'error' | 'aborted' | 'all';
}

export interface UsageSummaryV2 {
  range: { from: number; to: number };
  totalRequests: number;
  totalCostUsd: number;
  totalTokens: {
    input: number;
    output: number;
    cacheMiss: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    total: number;
  };
  cacheHitRequests: number;
  cacheCreateRequests: number;
  errorRequests: number;
}

export interface UsageBucket {
  key: string;
  label: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheMissTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheMissInputSource?: CacheMissInputSource;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
  avgLatencyMs: number;
  errorRate: number;
}

export interface UsageLogRow {
  id: string;
  ts: number;
  connectionSlug?: string;
  providerId: string;
  modelId: string;
  toolName?: string;
  inputTokens: number;
  outputTokens: number;
  cacheMissTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
  latencyMs: number;
  status: 'success' | 'error' | 'aborted';
  errorClass?: string;
  sessionId?: string;
  turnId?: string;
  prefixHash?: string;
  prefixChangeReason?: PrefixChangeReason;
  requestShapeHash?: string;
  requestShapeChangeReason?: PrefixChangeReason;
  toolSchemaChangeReason?: ToolSchemaChangeReason;
  toolSourceEconomy?: ToolSourceEconomyDiagnostic;
  promptSegments?: PromptSegmentEstimate[];
  contextBudget?: ContextBudgetDiagnostic;
}

export interface PricingConfig {
  modelKey: string;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cacheReadUsdPer1M?: number;
  cacheWriteUsdPer1M?: number;
}

export interface LlmCallRecord {
  sessionId?: string;
  turnId?: string;
  connectionSlug?: string;
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheHitInputTokens?: number;
  cacheMissInputTokens?: number;
  /** Backward-compatible alias for cacheHitInputTokens. */
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  rawFinishReason?: string;
  rawUsage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
  latencyMs: number;
  status: 'success' | 'error' | 'aborted';
  errorClass?: string;
  startedAt: number;
  prefixHash?: string;
  prefixChangeReason?: PrefixChangeReason;
  requestShapeHash?: string;
  requestShapeChangeReason?: PrefixChangeReason;
  toolSchemaChangeReason?: ToolSchemaChangeReason;
  toolSourceEconomy?: ToolSourceEconomyDiagnostic;
  cacheMissInputSource?: CacheMissInputSource;
  promptSegments?: PromptSegmentEstimate[];
  contextBudget?: ContextBudgetDiagnostic;
}

export type ToolSourceId = string;

export type PrefixChangeReason =
  | 'first_turn'
  | 'system_prompt_changed'
  | 'tool_schema_changed'
  | 'provider_options_changed'
  | 'model_or_provider_changed'
  | 'history_projection_changed'
  | 'stable'
  | 'unknown';

export type ToolSchemaChangeReason =
  | 'tool_schema_changed'
  | 'tool_source_enabled'
  | 'tool_source_state_changed';

export interface ToolSourceEconomyDiagnostic {
  mode: 'full' | 'source_economy';
  enabledSourceIds: ToolSourceId[];
  availableSourceIds?: ToolSourceId[];
  connectorToolName?: string;
  coreToolNames?: string[];
  visibleToolNamesBySource?: Record<ToolSourceId, string[]>;
  visibleToolCount?: number;
  fullToolCount?: number;
  hiddenToolCount?: number;
  visibleToolSchemaChars?: number;
  fullToolSchemaChars?: number;
  toolSchemaCharReduction?: number;
  estimatedToolSchemaTokenReduction?: number;
}

export type CacheMissInputSource = 'explicit' | 'derived';

export type PromptSegmentKind =
  | 'system_prompt'
  | 'tool_schema'
  | 'prior_history'
  | 'current_user'
  | 'turn_tail';

export interface PromptSegmentEstimate {
  kind: PromptSegmentKind;
  chars: number;
  estimatedTokens: number;
  messageCount?: number;
  eventCount?: number;
  toolCount?: number;
}

export interface ContextBudgetDiagnostic {
  enabled: boolean;
  policyName?: string;
  maxHistoryEstimatedTokens?: number;
  maxHistoryTurns?: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  keptTurns: number;
  droppedTurns: number;
  keptEvents: number;
  droppedEvents: number;
  prunedToolResults?: number;
  prunedToolResultEstimatedTokensBefore?: number;
  prunedToolResultEstimatedTokensAfter?: number;
  archivePlaceholders?: number;
  archiveWriteFailures?: number;
  unarchivedToolResults?: number;
  archivePlaceholderReasonCounts?: Record<string, number>;
  archiveRetrievalMode?: 'eager' | 'history_search_gated';
  archiveRetrievalEligibleTurns?: number;
  retrievedArchiveToolResults?: number;
  retrievedArchiveEstimatedTokens?: number;
  archiveRetrievalSkipped?: number;
  archiveRetrievalFailures?: number;
  archiveRetrievalSkippedReasonCounts?: Record<string, number>;
  archiveRetrievalFailureReasonCounts?: Record<string, number>;
  historySearchMatches?: number;
  historyAroundRetrievedEvents?: number;
  historyAroundEstimatedTokens?: number;
  historyAroundSkippedEvents?: number;
  synthesisCacheEnabled?: boolean;
  synthesisCacheMode?: 'off' | 'lookup' | 'read_write' | 'write_only' | 'fallback_archive_retrieval';
  synthesisCacheBlocksLoaded?: number;
  synthesisCacheLoadSkipped?: number;
  synthesisCacheLoadSkippedReasonCounts?: Record<string, number>;
  synthesisCacheLoadFailures?: number;
  synthesisCacheBlocksAvailable?: number;
  synthesisCacheBlocksSelected?: number;
  synthesisCacheBlockIds?: string[];
  synthesisCacheEstimatedTokens?: number;
  synthesisCacheSkipped?: number;
  synthesisCacheSkippedReasonCounts?: Record<string, number>;
  synthesisCacheInvalidated?: number;
  synthesisCacheInvalidationReasonCounts?: Record<string, number>;
  synthesisCacheWritesAttempted?: number;
  synthesisCacheBlocksWritten?: number;
  synthesisCacheWrittenBlockIds?: string[];
  synthesisCacheWriteEstimatedTokens?: number;
  synthesisCacheWriteSkipped?: number;
  synthesisCacheWriteSkippedReasonCounts?: Record<string, number>;
  synthesisCacheWriteFailures?: number;
  synthesisCacheEvicted?: number;
  synthesisCacheEvictionReasonCounts?: Record<string, number>;
  highWaterName?: string;
  highWaterSeq?: number;
  highWaterReason?:
    | 'archive_prune'
    | 'history_search_gated_retrieval'
    | 'synthesis_cache_write'
    | 'synthesis_cache_select'
    | 'manual_reset'
    | 'system_change'
    | 'tools_change'
    | 'log_rewrite';
  highWaterRequestShapeHashBefore?: string;
  highWaterRequestShapeHashAfter?: string;
  historyRewriteVersion?: string;
  historyRewriteResetReason?: string;
  historyRewriteGate?: string;
}

export interface ToolInvocationRecord {
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  toolName: string;
  providerId?: string;
  modelId?: string;
  durationMs: number;
  status: 'success' | 'error' | 'aborted';
  errorClass?: string;
  argsSummary?: string;
  bytesIn?: number;
  bytesOut?: number;
  startedAt: number;
}
