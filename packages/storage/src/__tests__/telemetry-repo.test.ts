import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, test } from 'node:test';
import { createTelemetryRepo } from '../telemetry-repo.js';

describe('FileTelemetryRepo', () => {
  test('upserts LLM calls by id and aggregates the latest record', async () => {
    await withRepo(async (repo) => {
      await repo.load();
      repo.insertLlmCall(llmRecord({
        id: 'usage_turn_1',
        inputTokens: 10,
        outputTokens: 20,
        cacheMissInputTokens: 10,
        totalTokens: 30,
      }));
      repo.insertLlmCall(llmRecord({
        id: 'usage_turn_1',
        inputTokens: 30,
        outputTokens: 40,
        cacheMissInputTokens: 30,
        totalTokens: 70,
      }));
      await flushWrites();

      const summary = repo.summary({ range: 'all' });
      const logs = repo.logs({ range: 'all' });

      assert.equal(summary.totalRequests, 1);
      assert.equal(summary.totalTokens.input, 30);
      assert.equal(summary.totalTokens.output, 40);
      assert.equal(summary.totalTokens.cacheMiss, 30);
      assert.equal(summary.totalTokens.total, 70);
      assert.equal(logs.total, 1);
      assert.equal(logs.rows[0]?.inputTokens, 30);
      assert.equal(logs.rows[0]?.cacheMissTokens, 30);
    });
  });

  test('filters logs by range, status, provider, model, and pagination', async () => {
    await withRepo(async (repo) => {
      await repo.load();
      repo.insertLlmCall(llmRecord({ id: 'old', ts: 1, status: 'success', providerId: 'openai', modelId: 'gpt-4o' }));
      repo.insertLlmCall(llmRecord({ id: 'new-success', ts: 20, status: 'success', providerId: 'openai', modelId: 'gpt-4o' }));
      repo.insertLlmCall(llmRecord({ id: 'new-error', ts: 30, status: 'error', providerId: 'anthropic', modelId: 'claude' }));
      await flushWrites();

      const logs = repo.logs(
        { range: { from: 10, to: 40 }, status: 'success', providerId: 'openai', modelId: 'gpt-4o' },
        0,
        10,
      );

      assert.equal(logs.total, 1);
      assert.equal(logs.rows[0]?.id, 'new-success');
    });
  });

  test('filters and returns latest LLM runtime probes by connection slug', async () => {
    await withRepo(async (repo) => {
      await repo.load();
      repo.insertLlmCall(llmRecord({
        id: 'conn-a-old',
        connectionSlug: 'conn-a',
        modelId: 'glm-4.7',
        ts: 10,
        status: 'success',
      }));
      repo.insertLlmCall(llmRecord({
        id: 'conn-b-new',
        connectionSlug: 'conn-b',
        modelId: 'glm-4.7',
        ts: 50,
        status: 'error',
      }));
      repo.insertLlmCall(llmRecord({
        id: 'conn-a-new',
        connectionSlug: 'conn-a',
        modelId: 'glm-4.7',
        ts: 40,
        status: 'aborted',
      }));
      await flushWrites();

      const logs = repo.logs({ range: 'all', connectionSlug: 'conn-a' });
      const latest = repo.latestLlmRuntimeProbe('conn-a', 'glm-4.7');

      assert.equal(logs.total, 2);
      assert.equal(logs.rows[0]?.id, 'conn-a-new');
      assert.equal(logs.rows[0]?.connectionSlug, 'conn-a');
      assert.equal(latest?.id, 'conn-a-new');
      assert.equal(repo.latestLlmRuntimeProbe('missing'), undefined);
    });
  });

  test('builds provider, model, day, hour, and tool buckets', async () => {
    await withRepo(async (repo) => {
      await repo.load();
      repo.insertLlmCall(llmRecord({ id: 'usage_1', providerId: 'openai', modelId: 'gpt-4o', ts: Date.UTC(2026, 0, 1, 1), date: '2026-01-01' }));
      repo.insertLlmCall(llmRecord({ id: 'usage_2', providerId: 'openai', modelId: 'gpt-4o-mini', ts: Date.UTC(2026, 0, 1, 2), date: '2026-01-01' }));
      repo.insertToolInvocation(toolRecord({ id: 'tool_1', toolName: 'Bash', durationMs: 30, status: 'success' }));
      repo.insertToolInvocation(toolRecord({ id: 'tool_2', toolName: 'Bash', durationMs: 90, status: 'error' }));
      await flushWrites();

      assert.equal(repo.buckets({ range: 'all' }, 'provider')[0]?.key, 'openai');
      assert.equal(repo.buckets({ range: 'all' }, 'model').length, 2);
      assert.equal(repo.buckets({ range: 'all' }, 'day')[0]?.key, '2026-01-01');
      assert.equal(repo.buckets({ range: 'all' }, 'hour').length, 2);

      const tool = repo.buckets({ range: 'all' }, 'tool')[0];
      assert.equal(tool?.key, 'Bash');
      assert.equal(tool?.requests, 2);
      assert.equal(tool?.avgLatencyMs, 60);
      assert.equal(tool?.errorRate, 0.5);
    });
  });

  test('persists pricing overrides and reloads them from disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-telemetry-'));
    try {
      const first = createTelemetryRepo(root);
      await first.load();
      await first.upsertPricing({ modelKey: 'openai:gpt-4o', inputUsdPer1M: 2.5, outputUsdPer1M: 10 });

      const second = createTelemetryRepo(root);
      await second.load();

      assert.deepEqual(second.listPricingOverrides(), [
        { modelKey: 'openai:gpt-4o', inputUsdPer1M: 2.5, outputUsdPer1M: 10 },
      ]);
    } finally {
      await flushWrites();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

async function withRepo(fn: (repo: ReturnType<typeof createTelemetryRepo>) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-telemetry-'));
  try {
    await fn(createTelemetryRepo(root));
  } finally {
    await flushWrites();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

function llmRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'usage_1',
    providerId: 'openai',
    modelId: 'gpt-4o',
    inputTokens: 10,
    outputTokens: 20,
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 10,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 30,
    costUsd: 0.001,
    latencyMs: 100,
    status: 'success',
    date: '2026-01-01',
    ts: Date.UTC(2026, 0, 1),
    startedAt: Date.UTC(2026, 0, 1) - 100,
    ...overrides,
  } as Parameters<ReturnType<typeof createTelemetryRepo>['insertLlmCall']>[0];
}

function toolRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tool_1',
    toolName: 'Bash',
    durationMs: 10,
    status: 'success',
    argsSummary: '',
    bytesIn: 0,
    bytesOut: 0,
    date: '2026-01-01',
    ts: Date.UTC(2026, 0, 1),
    startedAt: Date.UTC(2026, 0, 1) - 10,
    ...overrides,
  } as Parameters<ReturnType<typeof createTelemetryRepo>['insertToolInvocation']>[0];
}

function flushWrites(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}
