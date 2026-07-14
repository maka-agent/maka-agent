import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { SessionHeader, StoredMessage } from '@maka/core/session';
import { createSettingsStore as createSettingsStoreWithTelemetry } from '../settings-store.js';
import { createTelemetryRepo } from '../telemetry-repo.js';

function createSettingsStore(workspaceRoot: string, telemetryRepo = createTelemetryRepo(workspaceRoot)) {
  return createSettingsStoreWithTelemetry(workspaceRoot, telemetryRepo);
}

function makeHeader(overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/tmp/maka-workspace',
    cwd: '/tmp/maka-workspace',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Usage fixture',
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'anthropic',
    connectionLocked: true,
    model: 'claude-sonnet-4',
    permissionMode: 'ask',
    schemaVersion: 1,
    ...overrides,
  };
}

async function seedSession(workspaceRoot: string, header: SessionHeader, messages: StoredMessage[]) {
  const sessionDir = join(workspaceRoot, 'sessions', header.id);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, 'session.jsonl'),
    [header, ...messages].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  );
}

describe('SettingsStore.usageStats request logs', () => {
  it('uses telemetry as the complete model-request authority', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-settings-usage-telemetry-'));
    try {
      const telemetryRepo = createTelemetryRepo(workspaceRoot);
      await telemetryRepo.load();
      telemetryRepo.insertLlmCall(llmRecord({
        id: 'provider-error',
        usageAvailable: false,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        status: 'error',
      }));
      telemetryRepo.insertLlmCall(llmRecord({
        id: 'compact',
        callKind: 'semantic_compact',
        inputTokens: 30,
        outputTokens: 5,
        reasoningTokens: 2,
        totalTokens: 40,
        costUsd: 0.02,
      }));

      const stats = await createSettingsStore(workspaceRoot, telemetryRepo).usageStats('all');

      assert.equal(stats.summary.totalRequests, 2);
      assert.equal(stats.summary.usageUnavailableRequests, 1);
      assert.equal(stats.summary.totalTokens, 40);
      assert.equal(stats.summary.totalCostUsd, 0.02);
      assert.equal(stats.byModel[0]?.tokens, 40);
      assert.deepEqual(stats.logs.map((row) => row.id).sort(), ['compact', 'provider-error']);
    } finally {
      await flushTelemetryWrites();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('counts unmetered requests without adding partial token or cost totals', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-settings-usage-unavailable-'));
    try {
      const telemetryRepo = createTelemetryRepo(workspaceRoot);
      await telemetryRepo.load();
      telemetryRepo.insertLlmCall(llmRecord({ id: 'known' }));
      telemetryRepo.insertLlmCall(llmRecord({
        id: 'unknown', usageAvailable: false, inputTokens: 0, outputTokens: 0,
        totalTokens: 0, costUsd: 0,
      }));

      const stats = await createSettingsStore(workspaceRoot, telemetryRepo).usageStats('all');

      assert.equal(stats.summary.totalRequests, 2);
      assert.equal(stats.summary.usageUnavailableRequests, 1);
      assert.equal(stats.summary.totalTokens, 12);
      assert.equal(stats.summary.totalCostUsd, 0.01);
      assert.equal(stats.logs.find((row) => row.id === 'unknown')?.usageAvailable, false);
      assert.equal(stats.byProvider[0]?.requests, 2);
      assert.equal(stats.byProvider[0]?.tokens, 12);
    } finally {
      await flushTelemetryWrites();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('includes tool invocation rows without inflating model usage totals', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-settings-usage-'));
    try {
      await seedSession(workspaceRoot, makeHeader(), [
        {
          type: 'tool_call',
          id: 'tool-1',
          turnId: 'turn-1',
          ts: 11,
          toolName: 'Bash',
          displayName: '终端',
          args: { cmd: 'pwd' },
        },
        {
          type: 'tool_result',
          id: 'tool-result-1',
          turnId: 'turn-1',
          ts: 15,
          toolUseId: 'tool-1',
          isError: true,
          durationMs: 37,
          content: { kind: 'text', text: 'failed' },
        },
      ]);
      const telemetryRepo = createTelemetryRepo(workspaceRoot);
      await telemetryRepo.load();
      telemetryRepo.insertLlmCall(llmRecord({
        sessionId: 'session-1',
        turnId: 'turn-1',
        modelId: 'claude-sonnet-4-runtime',
        inputTokens: 120,
        outputTokens: 30,
        cacheMissInputTokens: 105,
        cacheHitInputTokens: 10,
        cacheWriteInputTokens: 5,
        reasoningTokens: 4,
        totalTokens: 150,
      }));

      const stats = await createSettingsStore(workspaceRoot, telemetryRepo).usageStats('all');

      assert.equal(stats.summary.totalRequests, 1, 'summary counts model requests only');
      assert.equal(stats.summary.totalTokens, 150);
      assert.equal(stats.summary.totalCostUsd, 0.01);
      assert.equal(stats.summary.cacheMiss, 105);
      assert.equal(stats.summary.cacheRead, 10);
      assert.equal(stats.summary.cacheCreation, 5);
      assert.equal(stats.summary.reasoning, 4);
      assert.equal(stats.byProvider.length, 1, 'provider aggregates remain model-only');
      assert.equal(stats.byModel.length, 1, 'model aggregates remain model-only');

      const modelLog = stats.logs.find((log) => log.kind === 'model');
      assert.ok(modelLog);
      assert.equal(modelLog.sessionId, 'session-1');
      assert.equal(modelLog.turnId, 'turn-1');
      assert.equal(modelLog.model, 'claude-sonnet-4-runtime');
      assert.equal(modelLog.inputTokens, 120);
      assert.equal(modelLog.outputTokens, 30);
      assert.equal(modelLog.cacheMiss, 105);
      assert.equal(modelLog.cacheRead, 10);
      assert.equal(modelLog.cacheCreation, 5);
      assert.equal(modelLog.reasoning, 4);

      const toolLog = stats.logs.find((log) => log.kind === 'tool');
      assert.ok(toolLog);
      assert.equal(toolLog.id, 'tool:tool-1');
      assert.equal(toolLog.sessionId, 'session-1');
      assert.equal(toolLog.turnId, 'turn-1');
      assert.equal(toolLog.provider, 'anthropic');
      assert.equal(toolLog.model, 'claude-sonnet-4');
      assert.equal(toolLog.toolName, '终端');
      assert.equal(toolLog.inputTokens, 0);
      assert.equal(toolLog.outputTokens, 0);
      assert.equal(toolLog.latencyMs, 37);
      assert.equal(toolLog.status, 'error');
    } finally {
      await flushTelemetryWrites();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('keeps valid tool rows when one session message line is corrupt', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-settings-usage-corrupt-line-'));
    try {
      const header = makeHeader();
      const sessionDir = join(workspaceRoot, 'sessions', header.id);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'session.jsonl'),
        [
          JSON.stringify(header),
          JSON.stringify({
            type: 'assistant',
            id: 'assistant-1',
            turnId: 'turn-1',
            ts: 10,
            text: 'tracked',
            modelId: 'runtime-model',
          }),
          '{"type":"tool_call"',
          JSON.stringify({
            type: 'tool_call',
            id: 'tool-1',
            turnId: 'turn-1',
            ts: 20,
            toolName: 'Read',
          }),
          JSON.stringify({
            type: 'tool_result',
            turnId: 'turn-1',
            ts: 25,
            toolUseId: 'tool-1',
            isError: false,
            durationMs: 5,
          }),
        ].join('\n') + '\n',
      );

      const stats = await createSettingsStore(workspaceRoot).usageStats('all');

      assert.equal(stats.summary.totalRequests, 0);
      assert.equal(stats.byTool[0]?.tool, 'Read');
      assert.equal(stats.byTool[0]?.calls, 1);
      assert.equal(stats.logs[0]?.id, 'tool:tool-1');
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('keeps legacy session usage when telemetry has no matching request', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-settings-usage-legacy-'));
    try {
      await seedSession(workspaceRoot, makeHeader(), [
        {
          type: 'assistant', id: 'assistant-1', turnId: 'turn-1', ts: 10,
          text: 'tracked', modelId: 'runtime-model',
        },
        {
          type: 'token_usage', id: 'legacy-usage', turnId: 'turn-1', ts: 20,
          input: 10, output: 5, cacheRead: 2, costUsd: 0.02,
        },
      ]);

      const stats = await createSettingsStore(workspaceRoot).usageStats('all');

      assert.equal(stats.summary.totalRequests, 1);
      assert.equal(stats.summary.totalTokens, 15);
      assert.equal(stats.summary.cacheRead, 2);
      assert.equal(stats.summary.totalCostUsd, 0.02);
      assert.equal(stats.logs[0]?.id, 'legacy-usage');
      assert.equal(stats.logs[0]?.model, 'runtime-model');
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('does not double-count legacy session token rows', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-settings-usage-bad-token-row-'));
    try {
      const header = makeHeader();
      const sessionDir = join(workspaceRoot, 'sessions', header.id);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'session.jsonl'),
        [
          JSON.stringify(header),
          JSON.stringify({
            type: 'token_usage',
            id: 'bad-usage',
            turnId: 'turn-1',
            ts: 20,
            input: '10',
            output: 5,
          }),
          JSON.stringify({
            type: 'token_usage',
            id: 'good-usage',
            turnId: 'turn-2',
            ts: 30,
            input: 7,
            output: 3,
          }),
        ].join('\n') + '\n',
      );
      const telemetryRepo = createTelemetryRepo(workspaceRoot);
      await telemetryRepo.load();
      telemetryRepo.insertLlmCall(llmRecord({
        id: 'telemetry-usage', sessionId: 'session-1', turnId: 'turn-2',
      }));

      const stats = await createSettingsStore(workspaceRoot, telemetryRepo).usageStats('all');

      assert.equal(stats.summary.totalRequests, 1);
      assert.equal(stats.summary.totalTokens, 12);
      assert.equal(stats.logs.length, 1);
      assert.equal(stats.logs[0]?.id, 'telemetry-usage');
    } finally {
      await flushTelemetryWrites();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

function llmRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'usage-1',
    providerId: 'anthropic',
    modelId: 'claude-sonnet-4',
    inputTokens: 10,
    outputTokens: 2,
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 10,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 12,
    costUsd: 0.01,
    latencyMs: 100,
    status: 'success',
    date: '2026-01-01',
    ts: Date.UTC(2026, 0, 1),
    startedAt: Date.UTC(2026, 0, 1) - 100,
    ...overrides,
  } as Parameters<ReturnType<typeof createTelemetryRepo>['insertLlmCall']>[0];
}

function flushTelemetryWrites(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}
