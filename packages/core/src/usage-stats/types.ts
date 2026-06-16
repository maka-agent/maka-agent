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
