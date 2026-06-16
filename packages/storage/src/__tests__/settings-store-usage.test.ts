import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { SessionHeader, StoredMessage } from '@maka/core/session';
import { createSettingsStore } from '../settings-store.js';

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
  it('includes tool invocation rows without inflating model usage totals', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-settings-usage-'));
    try {
      await seedSession(workspaceRoot, makeHeader(), [
        {
          type: 'assistant',
          id: 'assistant-1',
          turnId: 'turn-1',
          ts: 10,
          text: 'I will inspect it.',
          modelId: 'claude-sonnet-4-runtime',
        },
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
        {
          type: 'token_usage',
          id: 'usage-1',
          turnId: 'turn-1',
          ts: 20,
          input: 120,
          output: 30,
          cacheMissInput: 105,
          cacheRead: 10,
          cacheCreation: 5,
          reasoning: 4,
          costUsd: 0.01,
        },
      ]);

      const stats = await createSettingsStore(workspaceRoot).usageStats('all');

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
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
