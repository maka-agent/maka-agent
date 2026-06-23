import type { RuntimeEvent } from '@maka/core';
import type { InvocationResult } from '@maka/runtime';

export const HARBOR_CELL_OUTPUT_SCHEMA_VERSION = 1;

export interface HarborCellTokenSummary {
  input: number;
  output: number;
  cachedInput: number;
  cacheHitInput: number;
  cacheMissInput: number;
  cacheWriteInput: number;
  cacheMissInputSource?: 'explicit' | 'derived';
  reasoning: number;
  total: number;
  costUsd: number;
  pricingSource: 'runtime';
}

export interface HarborCellRuntimeRefs {
  invocationId: string;
  sessionId: string;
  runId: string;
  turnId: string;
}

export interface HarborCellToolSummary {
  providerVisibleToolCount: number;
  actualToolCalls: number;
  actualToolNames: string[];
  actualToolCallCounts: Record<string, number>;
}

export interface HarborCellOutput {
  schemaVersion: typeof HARBOR_CELL_OUTPUT_SCHEMA_VERSION;
  status: InvocationResult['status'];
  errorClass?: string;
  runtimeEventsPath: string;
  promptHash?: string;
  tokenSummary: HarborCellTokenSummary;
  toolSummary: HarborCellToolSummary;
  steps: number;
  durationMs: number;
  startedAt: number;
  finishedAt: number;
  runtimeRefs: HarborCellRuntimeRefs;
}

export function buildHarborCellOutput(input: {
  invocation: InvocationResult;
  runtimeEventsPath: string;
}): HarborCellOutput {
  const { invocation } = input;
  return {
    schemaVersion: HARBOR_CELL_OUTPUT_SCHEMA_VERSION,
    status: invocation.status,
    ...(invocation.failure?.class ? { errorClass: invocation.failure.class } : {}),
    runtimeEventsPath: input.runtimeEventsPath,
    ...promptHashField(invocation.events),
    tokenSummary: summarizeCellTokens(invocation.events),
    toolSummary: summarizeCellTools(invocation.events),
    steps: invocation.events.length,
    durationMs: invocation.finishedAt - invocation.startedAt,
    startedAt: invocation.startedAt,
    finishedAt: invocation.finishedAt,
    runtimeRefs: {
      invocationId: invocation.invocationId,
      sessionId: invocation.sessionId,
      runId: invocation.runId,
      turnId: invocation.turnId,
    },
  };
}

export function validateHarborCellOutput(value: unknown): HarborCellOutput {
  if (!isRecord(value)) {
    throw new Error('Harbor cell output must be a JSON object');
  }
  const schemaVersion = requireNumber(value.schemaVersion, 'schemaVersion');
  if (value.schemaVersion !== HARBOR_CELL_OUTPUT_SCHEMA_VERSION) {
    throw new Error(`unsupported Harbor cell output schemaVersion: ${value.schemaVersion}`);
  }
  const status = requireStringUnion(value.status, 'status', ['completed', 'failed'] as const);
  const errorClass = 'errorClass' in value ? requireOptionalString(value.errorClass, 'errorClass') : undefined;
  const runtimeEventsPath = requireString(value.runtimeEventsPath, 'runtimeEventsPath');
  const promptHash = 'promptHash' in value ? requireOptionalString(value.promptHash, 'promptHash') : undefined;
  const tokenSummary = validateTokenSummary(value.tokenSummary);
  const toolSummary = validateToolSummary(value.toolSummary);
  const steps = requireNumber(value.steps, 'steps');
  const durationMs = requireNumber(value.durationMs, 'durationMs');
  const startedAt = requireNumber(value.startedAt, 'startedAt');
  const finishedAt = requireNumber(value.finishedAt, 'finishedAt');
  const runtimeRefs = validateRuntimeRefs(value.runtimeRefs);
  const output: HarborCellOutput = {
    schemaVersion: schemaVersion as typeof HARBOR_CELL_OUTPUT_SCHEMA_VERSION,
    status,
    ...(errorClass !== undefined ? { errorClass } : {}),
    runtimeEventsPath,
    ...(promptHash !== undefined ? { promptHash } : {}),
    tokenSummary,
    toolSummary,
    steps,
    durationMs,
    startedAt,
    finishedAt,
    runtimeRefs,
  };
  return output;
}

export function summarizeCellTokens(events: readonly RuntimeEvent[]): HarborCellTokenSummary {
  const summary: HarborCellTokenSummary = {
    input: 0,
    output: 0,
    cachedInput: 0,
    cacheHitInput: 0,
    cacheMissInput: 0,
    cacheWriteInput: 0,
    reasoning: 0,
    total: 0,
    costUsd: 0,
    pricingSource: 'runtime',
  };
  let sawExplicitCacheMiss = false;
  let sawDerivedCacheMiss = false;
  for (const event of events) {
    const usage = event.actions?.tokenUsage;
    if (!usage) continue;
    summary.input += usage.input ?? 0;
    summary.output += usage.output ?? 0;
    const cacheHitInput = usage.cacheHitInput ?? usage.cacheRead ?? 0;
    const cacheWriteInput = usage.cacheWriteInput ?? usage.cacheCreation ?? 0;
    const derivedCacheMiss = Math.max(0, (usage.input ?? 0) - cacheHitInput - cacheWriteInput);
    summary.cacheHitInput += cacheHitInput;
    summary.cachedInput += cacheHitInput;
    summary.cacheMissInput += usage.cacheMissInput ?? derivedCacheMiss;
    summary.cacheWriteInput += cacheWriteInput;
    if (usage.cacheMissInputSource === 'explicit' || usage.cacheMissInput !== undefined) {
      sawExplicitCacheMiss = true;
    } else if (
      usage.input !== undefined
      || usage.cacheHitInput !== undefined
      || usage.cacheRead !== undefined
      || cacheWriteInput > 0
    ) {
      sawDerivedCacheMiss = true;
    }
    summary.reasoning += usage.reasoning ?? 0;
    summary.total += usage.total ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.reasoning ?? 0);
    summary.costUsd += usage.costUsd ?? 0;
  }
  if (sawExplicitCacheMiss) {
    summary.cacheMissInputSource = 'explicit';
  } else if (sawDerivedCacheMiss) {
    summary.cacheMissInputSource = 'derived';
  }
  return summary;
}

export function summarizeCellTools(events: readonly RuntimeEvent[]): HarborCellToolSummary {
  const counts = new Map<string, number>();
  let providerVisibleToolCount = 0;
  for (const event of events) {
    const content = event.content;
    if (content?.kind === 'function_call') {
      counts.set(content.name, (counts.get(content.name) ?? 0) + 1);
    }
    const promptSegments = event.actions?.tokenUsage?.promptSegments;
    if (promptSegments) {
      for (const segment of promptSegments) {
        if (segment.kind === 'tool_schema' && typeof segment.toolCount === 'number') {
          providerVisibleToolCount = Math.max(providerVisibleToolCount, segment.toolCount);
        }
      }
    }
  }
  const sorted = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  return {
    providerVisibleToolCount,
    actualToolCalls: sorted.reduce((sum, [, count]) => sum + count, 0),
    actualToolNames: sorted.map(([name]) => name),
    actualToolCallCounts: Object.fromEntries(sorted),
  };
}

function promptHashField(events: readonly RuntimeEvent[]): Pick<HarborCellOutput, 'promptHash'> {
  for (const event of events) {
    const hash = event.actions?.tokenUsage?.systemPromptHash;
    if (hash) return { promptHash: hash };
  }
  return {};
}

function validateTokenSummary(value: unknown): HarborCellTokenSummary {
  if (!isRecord(value)) throw new Error('tokenSummary must be a JSON object');
  return {
    input: requireNumber(value.input, 'tokenSummary.input'),
    output: requireNumber(value.output, 'tokenSummary.output'),
    cachedInput: optionalNumber(value.cachedInput, 'tokenSummary.cachedInput') ?? 0,
    cacheHitInput:
      optionalNumber(value.cacheHitInput, 'tokenSummary.cacheHitInput')
      ?? optionalNumber(value.cachedInput, 'tokenSummary.cachedInput')
      ?? 0,
    cacheMissInput: optionalNumber(value.cacheMissInput, 'tokenSummary.cacheMissInput') ?? 0,
    cacheWriteInput: optionalNumber(value.cacheWriteInput, 'tokenSummary.cacheWriteInput') ?? 0,
    ...cacheMissInputSourceField(value.cacheMissInputSource),
    reasoning: requireNumber(value.reasoning, 'tokenSummary.reasoning'),
    total: requireNumber(value.total, 'tokenSummary.total'),
    costUsd: requireNumber(value.costUsd, 'tokenSummary.costUsd'),
    pricingSource:
      requireOptionalStringUnion(value.pricingSource, 'tokenSummary.pricingSource', ['runtime'] as const)
      ?? 'runtime',
  };
}

function validateToolSummary(value: unknown): HarborCellToolSummary {
  if (!isRecord(value)) throw new Error('toolSummary must be a JSON object');
  const actualToolCallCounts = validateToolCallCounts(value.actualToolCallCounts);
  return {
    providerVisibleToolCount: requireNumber(value.providerVisibleToolCount, 'toolSummary.providerVisibleToolCount'),
    actualToolCalls: requireNumber(value.actualToolCalls, 'toolSummary.actualToolCalls'),
    actualToolNames: validateStringArray(value.actualToolNames, 'toolSummary.actualToolNames'),
    actualToolCallCounts,
  };
}

function validateToolCallCounts(value: unknown): Record<string, number> {
  if (!isRecord(value)) throw new Error('toolSummary.actualToolCallCounts must be a JSON object');
  const counts: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    counts[key] = requireNumber(raw, `toolSummary.actualToolCallCounts.${key}`);
  }
  return counts;
}

function validateStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${field} must be an array of strings`);
  }
  return [...value];
}

function validateRuntimeRefs(value: unknown): HarborCellRuntimeRefs {
  if (!isRecord(value)) throw new Error('runtimeRefs must be a JSON object');
  return {
    invocationId: requireString(value.invocationId, 'runtimeRefs.invocationId'),
    sessionId: requireString(value.sessionId, 'runtimeRefs.sessionId'),
    runId: requireString(value.runId, 'runtimeRefs.runId'),
    turnId: requireString(value.turnId, 'runtimeRefs.turnId'),
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireOptionalString(value: unknown, field: string): string | undefined {
  if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
    throw new Error(`${field} must be a non-empty string when present`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  return requireNumber(value, field);
}

function requireStringUnion<T extends readonly string[]>(value: unknown, field: string, allowed: T): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function requireOptionalStringUnion<T extends readonly string[]>(
  value: unknown,
  field: string,
  allowed: T,
): T[number] | undefined {
  if (value === undefined) return undefined;
  return requireStringUnion(value, field, allowed);
}

function cacheMissInputSourceField(value: unknown): Pick<HarborCellTokenSummary, 'cacheMissInputSource'> {
  const cacheMissInputSource = requireOptionalStringUnion(
    value,
    'tokenSummary.cacheMissInputSource',
    ['explicit', 'derived'] as const,
  );
  return cacheMissInputSource ? { cacheMissInputSource } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
