import {
  isContextBudgetDiagnostic,
  isPromptSegmentEstimate,
  type LlmCallRecord,
  type ToolInvocationRecord,
} from '@maka/core';

export type PersistedLlmCallRecord = LlmCallRecord & {
  id: string;
  cacheHitInputTokens: number;
  cacheMissInputTokens: number;
  cacheWriteInputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
  date: string;
  ts: number;
};

export type PersistedToolInvocationRecord = ToolInvocationRecord & {
  id: string;
  argsSummary?: string;
  bytesIn: number;
  bytesOut: number;
  date: string;
  ts: number;
};

export interface TelemetryFile {
  version: 1;
  usageRecords: PersistedLlmCallRecord[];
  toolInvocations: PersistedToolInvocationRecord[];
}

const LLM_KEYS = new Set([
  'sessionId',
  'turnId',
  'callKind',
  'callId',
  'connectionSlug',
  'providerId',
  'modelId',
  'inputTokens',
  'outputTokens',
  'cacheHitInputTokens',
  'cacheMissInputTokens',
  'cacheWriteInputTokens',
  'reasoningTokens',
  'totalTokens',
  'rawFinishReason',
  'rawUsage',
  'latencyMs',
  'status',
  'errorClass',
  'costUsd',
  'startedAt',
  'systemPromptHash',
  'prefixHash',
  'prefixChangeReason',
  'requestShapeHash',
  'requestShapeChangeReason',
  'toolSchemaChangeReason',
  'toolAvailability',
  'cacheMissInputSource',
  'promptSegments',
  'contextBudget',
  'id',
  'date',
  'ts',
]);

const TOOL_KEYS = new Set([
  'sessionId',
  'turnId',
  'toolCallId',
  'toolName',
  'providerId',
  'modelId',
  'durationMs',
  'status',
  'errorClass',
  'argsSummary',
  'resultSummary',
  'bytesIn',
  'bytesOut',
  'startedAt',
  'id',
  'date',
  'ts',
]);

const PREFIX_CHANGE_REASONS = new Set([
  'first_turn',
  'system_prompt_changed',
  'tool_schema_changed',
  'provider_options_changed',
  'model_or_provider_changed',
  'history_projection_changed',
  'stable',
  'unknown',
]);
const CALL_KINDS = new Set(['main', 'semantic_compact']);
const CACHE_MISS_INPUT_SOURCES = new Set(['explicit', 'derived']);

export function emptyTelemetryFile(): TelemetryFile {
  return { version: 1, usageRecords: [], toolInvocations: [] };
}

export function decodeTelemetryFile(input: unknown): TelemetryFile {
  if (!isRecord(input)) throw invalid('expected an object');
  if (!hasOnlyKeys(input, new Set(['version', 'usageRecords', 'toolInvocations']))) {
    throw invalid('expected exactly version, usageRecords, toolInvocations');
  }
  if (input.version !== 1) throw invalid('expected version 1');
  if (!Array.isArray(input.usageRecords)) throw invalid('usageRecords must be an array');
  if (!Array.isArray(input.toolInvocations)) throw invalid('toolInvocations must be an array');
  return {
    version: 1,
    usageRecords: input.usageRecords.map(decodePersistedLlmCallRecord),
    toolInvocations: input.toolInvocations.map(decodePersistedToolInvocationRecord),
  };
}

export function decodePersistedLlmCallRecord(input: unknown): PersistedLlmCallRecord {
  if (!isRecord(input) || !hasOnlyKeys(input, LLM_KEYS)) throw invalid('invalid LLM row keys');
  if (!strings(input, ['id', 'providerId', 'modelId', 'date'])) {
    throw invalid('invalid required LLM string');
  }
  if (
    !nonNegativeNumbers(input, [
      'inputTokens',
      'outputTokens',
      'cacheHitInputTokens',
      'cacheMissInputTokens',
      'cacheWriteInputTokens',
      'reasoningTokens',
      'totalTokens',
      'latencyMs',
      'costUsd',
      'startedAt',
      'ts',
    ])
  ) {
    throw invalid('invalid required LLM number');
  }
  if (!['success', 'error', 'aborted'].includes(input.status as string)) {
    throw invalid('invalid LLM status');
  }
  if (!optionalStrings(input, LLM_OPTIONAL_STRINGS)) throw invalid('invalid LLM string');
  if (!optionalEnum(input.callKind, CALL_KINDS)) throw invalid('invalid callKind');
  if (!optionalEnum(input.prefixChangeReason, PREFIX_CHANGE_REASONS)) {
    throw invalid('invalid prefixChangeReason');
  }
  if (!optionalEnum(input.requestShapeChangeReason, PREFIX_CHANGE_REASONS)) {
    throw invalid('invalid requestShapeChangeReason');
  }
  if (!optionalEnum(input.toolSchemaChangeReason, TOOL_SCHEMA_CHANGE_REASONS)) {
    throw invalid('invalid toolSchemaChangeReason');
  }
  if (!optionalEnum(input.cacheMissInputSource, CACHE_MISS_INPUT_SOURCES)) {
    throw invalid('invalid cacheMissInputSource');
  }
  if (input.rawUsage !== undefined && !isRawUsage(input.rawUsage))
    throw invalid('invalid rawUsage');
  if (input.toolAvailability !== undefined && !isToolAvailability(input.toolAvailability)) {
    throw invalid('invalid toolAvailability');
  }
  if (
    input.promptSegments !== undefined &&
    (!Array.isArray(input.promptSegments) || !input.promptSegments.every(isPromptSegmentEstimate))
  ) {
    throw invalid('invalid promptSegments');
  }
  if (input.contextBudget !== undefined && !isContextBudgetDiagnostic(input.contextBudget)) {
    throw invalid('invalid contextBudget');
  }
  return input as unknown as PersistedLlmCallRecord;
}

export function decodePersistedToolInvocationRecord(input: unknown): PersistedToolInvocationRecord {
  if (!isRecord(input) || !hasOnlyKeys(input, TOOL_KEYS)) throw invalid('invalid tool row keys');
  if (!strings(input, ['id', 'toolName', 'date'])) throw invalid('invalid required tool string');
  if (!nonNegativeNumbers(input, ['durationMs', 'bytesIn', 'bytesOut', 'startedAt', 'ts'])) {
    throw invalid('invalid required tool number');
  }
  if (!['success', 'error', 'aborted'].includes(input.status as string)) {
    throw invalid('invalid tool status');
  }
  if (!optionalStrings(input, TOOL_OPTIONAL_STRINGS)) throw invalid('invalid tool string');
  if (input.resultSummary !== undefined && !isToolResultSummary(input.resultSummary)) {
    throw invalid('invalid tool resultSummary');
  }
  return input as unknown as PersistedToolInvocationRecord;
}

const LLM_OPTIONAL_STRINGS = [
  'sessionId',
  'turnId',
  'callId',
  'connectionSlug',
  'rawFinishReason',
  'errorClass',
  'systemPromptHash',
  'prefixHash',
  'requestShapeHash',
] as const;

const TOOL_OPTIONAL_STRINGS = [
  'sessionId',
  'turnId',
  'toolCallId',
  'providerId',
  'modelId',
  'errorClass',
  'argsSummary',
] as const;

const TOOL_SCHEMA_CHANGE_REASONS = new Set([
  'tool_schema_changed',
  'tool_source_enabled',
  'tool_source_state_changed',
]);

function isRawUsage(input: unknown): boolean {
  if (!isRecord(input) || !hasOnlyKeys(input, RAW_USAGE_KEYS)) return false;
  if (!optionalNonNegativeNumbers(input, RAW_USAGE_NUMBERS)) return false;
  return (
    isTokenDetails(input.prompt_tokens_details, 'cached_tokens') &&
    isTokenDetails(input.completion_tokens_details, 'reasoning_tokens')
  );
}

const RAW_USAGE_KEYS = new Set([
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'prompt_cache_hit_tokens',
  'prompt_cache_miss_tokens',
  'prompt_tokens_details',
  'completion_tokens_details',
]);

const RAW_USAGE_NUMBERS = [
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'prompt_cache_hit_tokens',
  'prompt_cache_miss_tokens',
] as const;

function isTokenDetails(input: unknown, key: string): boolean {
  return (
    input === undefined ||
    (isRecord(input) && hasOnlyKeys(input, new Set([key])) && optionalNonNegative(input[key]))
  );
}

function isToolAvailability(input: unknown): boolean {
  if (!isRecord(input) || !hasOnlyKeys(input, TOOL_AVAILABILITY_KEYS)) return false;
  if (input.mode !== 'economy' || !isStringArray(input.enabledSourceIds)) return false;
  if (input.availableSourceIds !== undefined && !isStringArray(input.availableSourceIds)) {
    return false;
  }
  if (input.connectorToolName !== undefined && typeof input.connectorToolName !== 'string') {
    return false;
  }
  if (
    input.visibleToolNamesBySource !== undefined &&
    (!isRecord(input.visibleToolNamesBySource) ||
      !Object.values(input.visibleToolNamesBySource).every(isStringArray))
  ) {
    return false;
  }
  return optionalNonNegativeNumbers(input, TOOL_AVAILABILITY_NUMBERS);
}

const TOOL_AVAILABILITY_KEYS = new Set([
  'mode',
  'enabledSourceIds',
  'availableSourceIds',
  'connectorToolName',
  'visibleToolNamesBySource',
  'visibleToolCount',
  'fullToolCount',
  'hiddenToolCount',
  'visibleToolSchemaChars',
  'fullToolSchemaChars',
  'toolSchemaCharReduction',
  'estimatedToolSchemaTokenReduction',
]);

const TOOL_AVAILABILITY_NUMBERS = [
  'visibleToolCount',
  'fullToolCount',
  'hiddenToolCount',
  'visibleToolSchemaChars',
  'fullToolSchemaChars',
  'toolSchemaCharReduction',
  'estimatedToolSchemaTokenReduction',
] as const;

function isToolResultSummary(input: unknown): boolean {
  return (
    isRecord(input) &&
    hasOnlyKeys(input, TOOL_RESULT_KEYS) &&
    typeof input.kind === 'string' &&
    (input.status === undefined || typeof input.status === 'string') &&
    optionalNonNegativeNumbers(input, TOOL_RESULT_NUMBERS)
  );
}

const TOOL_RESULT_KEYS = new Set([
  'kind',
  'status',
  'itemCount',
  'startedItemCount',
  'completedItemCount',
  'failedItemCount',
  'cancelledItemCount',
  'artifactCount',
]);

const TOOL_RESULT_NUMBERS = [
  'itemCount',
  'startedItemCount',
  'completedItemCount',
  'failedItemCount',
  'cancelledItemCount',
  'artifactCount',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function strings(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === 'string');
}

function optionalStrings(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => value[key] === undefined || typeof value[key] === 'string');
}

function nonNegativeNumbers(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => isNonNegativeFinite(value[key]));
}

function optionalNonNegativeNumbers(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => optionalNonNegative(value[key]));
}

function optionalNonNegative(value: unknown): boolean {
  return value === undefined || isNonNegativeFinite(value);
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function optionalEnum(value: unknown, allowed: ReadonlySet<string>): boolean {
  return value === undefined || (typeof value === 'string' && allowed.has(value));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function invalid(message: string): Error {
  return new Error(`Invalid telemetry file: ${message}`);
}
