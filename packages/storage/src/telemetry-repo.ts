import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  UsageBucket,
  UsageGroupBy,
  UsageLogRow,
  UsageQuery,
  UsageSummaryV2,
} from '@maka/core/usage-stats/types';
import {
  decodePersistedLlmCallRecord,
  decodePersistedToolInvocationRecord,
  decodeTelemetryFile,
  emptyTelemetryFile,
  type PersistedLlmCallRecord,
  type PersistedToolInvocationRecord,
  type TelemetryFile,
} from './telemetry-file-schema.js';

export type {
  PersistedLlmCallRecord,
  PersistedToolInvocationRecord,
} from './telemetry-file-schema.js';

export interface TelemetryRepo {
  insertLlmCall(record: PersistedLlmCallRecord): Promise<void>;
  insertToolInvocation(record: PersistedToolInvocationRecord): Promise<void>;
  summary(query: UsageQuery): UsageSummaryV2;
  buckets(query: UsageQuery, groupBy: UsageGroupBy): UsageBucket[];
  logs(query: UsageQuery, offset?: number, limit?: number): { rows: UsageLogRow[]; total: number };
  latestLlmRuntimeProbe(connectionSlug: string, modelId?: string): UsageLogRow | undefined;
  load(): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface CreateTelemetryRepoOptions {
  readonly createIfMissing?: boolean;
}

export class TelemetryRepoClosedError extends Error {
  constructor() {
    super('Telemetry repository is closed');
    this.name = 'TelemetryRepoClosedError';
  }
}

export class TelemetryRepoNotLoadedError extends Error {
  constructor() {
    super('Telemetry repository has not been loaded');
    this.name = 'TelemetryRepoNotLoadedError';
  }
}

export class TelemetryRepoPublicationError extends Error {
  readonly domain = 'telemetry_derived_index';

  constructor(options: { cause: unknown }) {
    super('Unable to publish telemetry derived index', options);
    this.name = 'TelemetryRepoPublicationError';
  }
}

export function createTelemetryRepo(
  workspaceRoot: string,
  options: CreateTelemetryRepoOptions = {},
): TelemetryRepo {
  return new FileTelemetryRepo(workspaceRoot, options.createIfMissing ?? true);
}

class FileTelemetryRepo implements TelemetryRepo {
  private readonly path: string;
  private readonly createIfMissing: boolean;
  private file: TelemetryFile = emptyTelemetryFile();
  private loaded = false;
  private queue: Promise<void> = Promise.resolve();
  private writeFailure: TelemetryRepoPublicationError | undefined;
  private state: 'open' | 'closing' | 'closed' = 'open';
  private closePromise: Promise<void> | undefined;

  constructor(workspaceRoot: string, createIfMissing: boolean) {
    this.path = join(workspaceRoot, 'telemetry.json');
    this.createIfMissing = createIfMissing;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.assertOpen();
    try {
      const text = await readFile(this.path, 'utf8');
      this.file = decodeTelemetryFile(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.file = emptyTelemetryFile();
      if (this.createIfMissing) await this.write(this.file);
    }
    this.loaded = true;
  }

  insertLlmCall(record: PersistedLlmCallRecord): Promise<void> {
    this.assertReady();
    return this.enqueueMutation((file) => ({
      ...file,
      usageRecords: upsertById(file.usageRecords, decodePersistedLlmCallRecord(record)),
    }));
  }

  insertToolInvocation(record: PersistedToolInvocationRecord): Promise<void> {
    this.assertReady();
    return this.enqueueMutation((file) => ({
      ...file,
      toolInvocations: upsertById(
        file.toolInvocations,
        decodePersistedToolInvocationRecord(record),
      ),
    }));
  }

  summary(query: UsageQuery): UsageSummaryV2 {
    this.assertReady();
    const { from, to } = resolveRange(query.range);
    const rows = this.filteredUsageRows(query, from, to);
    const input = sum(rows.map((row) => row.inputTokens));
    const output = sum(rows.map((row) => row.outputTokens));
    const cacheMiss = sum(rows.map((row) => row.cacheMissInputTokens));
    const cacheRead = sum(rows.map((row) => row.cacheHitInputTokens));
    const cacheWrite = sum(rows.map((row) => row.cacheWriteInputTokens));
    const reasoning = sum(rows.map((row) => row.reasoningTokens));
    return {
      range: { from, to },
      totalRequests: rows.length,
      totalCostUsd: sum(rows.map((row) => row.costUsd)),
      totalTokens: {
        input,
        output,
        cacheMiss,
        cacheRead,
        cacheWrite,
        reasoning,
        total: sum(rows.map((row) => row.totalTokens)),
      },
      cacheHitRequests: rows.filter((row) => row.cacheHitInputTokens > 0).length,
      cacheCreateRequests: rows.filter((row) => row.cacheWriteInputTokens > 0).length,
      errorRequests: rows.filter((row) => row.status === 'error').length,
    };
  }

  buckets(query: UsageQuery, groupBy: UsageGroupBy): UsageBucket[] {
    this.assertReady();
    const { from, to } = resolveRange(query.range);
    if (groupBy === 'tool') return toolBuckets(this.filteredToolRows(query, from, to));
    const rows = this.filteredUsageRows(query, from, to);
    const groups = new Map<string, PersistedLlmCallRecord[]>();
    for (const row of rows) {
      const key = bucketKey(row, groupBy);
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }
    return [...groups.entries()]
      .map(([key, groupRows]) => usageBucket(key, groupRows))
      .sort((a, b) => b.requests - a.requests);
  }

  logs(query: UsageQuery, offset = 0, limit = 100): { rows: UsageLogRow[]; total: number } {
    this.assertReady();
    const { from, to } = resolveRange(query.range);
    const rows = this.filteredUsageRows(query, from, to)
      .sort((a, b) => b.ts - a.ts)
      .map(
        (row) =>
          ({
            id: row.id,
            ts: row.ts,
            ...(row.callKind ? { callKind: row.callKind } : {}),
            ...(row.callId ? { callId: row.callId } : {}),
            ...(row.connectionSlug ? { connectionSlug: row.connectionSlug } : {}),
            providerId: row.providerId,
            modelId: row.modelId,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            cacheMissTokens: row.cacheMissInputTokens,
            cacheReadTokens: row.cacheHitInputTokens,
            cacheWriteTokens: row.cacheWriteInputTokens,
            ...(row.cacheMissInputSource ? { cacheMissInputSource: row.cacheMissInputSource } : {}),
            reasoningTokens: row.reasoningTokens,
            totalTokens: row.totalTokens,
            costUsd: row.costUsd,
            latencyMs: row.latencyMs,
            status: row.status,
            ...(row.errorClass ? { errorClass: row.errorClass } : {}),
            ...(row.sessionId ? { sessionId: row.sessionId } : {}),
            ...(row.turnId ? { turnId: row.turnId } : {}),
            ...(row.systemPromptHash ? { systemPromptHash: row.systemPromptHash } : {}),
            ...(row.prefixHash ? { prefixHash: row.prefixHash } : {}),
            ...(row.prefixChangeReason ? { prefixChangeReason: row.prefixChangeReason } : {}),
            ...(row.requestShapeHash ? { requestShapeHash: row.requestShapeHash } : {}),
            ...(row.requestShapeChangeReason
              ? { requestShapeChangeReason: row.requestShapeChangeReason }
              : {}),
            ...(row.toolSchemaChangeReason
              ? { toolSchemaChangeReason: row.toolSchemaChangeReason }
              : {}),
            ...(row.toolAvailability ? { toolAvailability: row.toolAvailability } : {}),
            ...(row.promptSegments ? { promptSegments: row.promptSegments } : {}),
            ...(row.contextBudget ? { contextBudget: row.contextBudget } : {}),
          }) satisfies UsageLogRow,
      );
    return { rows: rows.slice(offset, offset + limit), total: rows.length };
  }

  latestLlmRuntimeProbe(connectionSlug: string, modelId?: string): UsageLogRow | undefined {
    return this.logs(
      {
        range: 'all',
        connectionSlug,
        ...(modelId ? { modelId } : {}),
      },
      0,
      1,
    ).rows[0];
  }

  async flush(): Promise<void> {
    await this.queue;
    if (this.writeFailure !== undefined) throw this.writeFailure;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.state = 'closing';
    this.closePromise = this.flush().finally(() => {
      this.state = 'closed';
    });
    return this.closePromise;
  }

  private filteredUsageRows(query: UsageQuery, from: number, to: number): PersistedLlmCallRecord[] {
    return this.file.usageRecords.filter((row) => {
      if (row.ts < from || row.ts > to) return false;
      if (query.connectionSlug && row.connectionSlug !== query.connectionSlug) return false;
      if (query.providerId && row.providerId !== query.providerId) return false;
      if (query.modelId && row.modelId !== query.modelId) return false;
      if (query.status && query.status !== 'all' && row.status !== query.status) return false;
      return true;
    });
  }

  private filteredToolRows(
    query: UsageQuery,
    from: number,
    to: number,
  ): PersistedToolInvocationRecord[] {
    return this.file.toolInvocations.filter((row) => {
      if (row.ts < from || row.ts > to) return false;
      if (query.toolName && row.toolName !== query.toolName) return false;
      if (query.status && query.status !== 'all' && row.status !== query.status) return false;
      return true;
    });
  }

  private enqueueMutation(mutate: (file: TelemetryFile) => TelemetryFile): Promise<void> {
    this.assertOpen();
    if (this.writeFailure) return Promise.reject(this.writeFailure);
    const next = this.queue.then(async () => {
      if (this.writeFailure) throw this.writeFailure;
      try {
        const candidate = mutate(this.file);
        await this.write(candidate);
        this.file = candidate;
      } catch (error) {
        throw new TelemetryRepoPublicationError({ cause: error });
      }
    });
    this.queue = next.catch((error: TelemetryRepoPublicationError) => {
      if (this.writeFailure === undefined) this.writeFailure = error;
    });
    return next;
  }

  private async write(file: TelemetryFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, JSON.stringify(file, null, 2) + '\n', 'utf8');
    await rename(tempPath, this.path);
  }

  private assertOpen(): void {
    if (this.state !== 'open') throw new TelemetryRepoClosedError();
  }

  private assertReady(): void {
    this.assertOpen();
    if (!this.loaded) throw new TelemetryRepoNotLoadedError();
  }
}

function upsertById<T extends { id: string }>(rows: T[], row: T): T[] {
  return [...rows.filter((current) => current.id !== row.id), row];
}

export function resolveRange(range: UsageQuery['range']): { from: number; to: number } {
  if (typeof range === 'object') return range;
  const now = Date.now();
  switch (range) {
    case '24h':
      return { from: now - 24 * 60 * 60 * 1000, to: now };
    case '7d':
      return { from: now - 7 * 24 * 60 * 60 * 1000, to: now };
    case '30d':
      return { from: now - 30 * 24 * 60 * 60 * 1000, to: now };
    case 'all':
      return { from: 0, to: now };
  }
}

function bucketKey(row: PersistedLlmCallRecord, groupBy: UsageGroupBy): string {
  switch (groupBy) {
    case 'provider':
      return row.providerId;
    case 'model':
      return `${row.providerId}:${row.modelId}`;
    case 'day':
      return row.date;
    case 'hour':
      return String(Math.floor(row.ts / (60 * 60 * 1000)));
    case 'tool':
      return '';
  }
}

function usageBucket(key: string, rows: PersistedLlmCallRecord[]): UsageBucket {
  const errorCount = rows.filter((row) => row.status === 'error').length;
  return {
    key,
    label: key,
    requests: rows.length,
    inputTokens: sum(rows.map((row) => row.inputTokens)),
    outputTokens: sum(rows.map((row) => row.outputTokens)),
    cacheMissTokens: sum(rows.map((row) => row.cacheMissInputTokens)),
    cacheReadTokens: sum(rows.map((row) => row.cacheHitInputTokens)),
    cacheWriteTokens: sum(rows.map((row) => row.cacheWriteInputTokens)),
    reasoningTokens: sum(rows.map((row) => row.reasoningTokens)),
    totalTokens: sum(rows.map((row) => row.totalTokens)),
    costUsd: sum(rows.map((row) => row.costUsd)),
    avgLatencyMs: rows.length ? Math.round(sum(rows.map((row) => row.latencyMs)) / rows.length) : 0,
    errorRate: rows.length ? errorCount / rows.length : 0,
  };
}

function toolBuckets(rows: PersistedToolInvocationRecord[]): UsageBucket[] {
  const groups = new Map<string, PersistedToolInvocationRecord[]>();
  for (const row of rows) {
    const list = groups.get(row.toolName) ?? [];
    list.push(row);
    groups.set(row.toolName, list);
  }
  return [...groups.entries()]
    .map(([key, groupRows]) => {
      const errorCount = groupRows.filter((row) => row.status === 'error').length;
      const inputBytes = sum(groupRows.map((row) => row.bytesIn));
      const outputBytes = sum(groupRows.map((row) => row.bytesOut));
      return {
        key,
        label: key,
        requests: groupRows.length,
        inputTokens: inputBytes,
        outputTokens: outputBytes,
        cacheMissTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: inputBytes + outputBytes,
        costUsd: 0,
        avgLatencyMs: groupRows.length
          ? Math.round(sum(groupRows.map((row) => row.durationMs)) / groupRows.length)
          : 0,
        errorRate: groupRows.length ? errorCount / groupRows.length : 0,
      } satisfies UsageBucket;
    })
    .sort((a, b) => b.requests - a.requests);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
