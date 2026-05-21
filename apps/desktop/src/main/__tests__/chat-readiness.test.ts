import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection, SessionHeader } from '@maka/core';
import {
  NO_REAL_CONNECTION_CODE,
  assertSessionCanSend,
  errorCode,
  requireReadyConnection,
  type ReadyConnectionDeps,
} from '../chat-readiness.js';

describe('chat readiness guard', () => {
  test('blocks missing, fake, missing, disabled, and secretless model references', async () => {
    const table: Array<{
      name: string;
      slug: string | null | undefined;
      deps: ReadyConnectionDeps;
      includes: string;
    }> = [
      {
        name: 'no default model',
        slug: null,
        deps: deps(),
        includes: '还没有配置默认模型',
      },
      {
        name: 'implicit fake slug',
        slug: 'fake',
        deps: deps(),
        includes: '还没有配置默认模型',
      },
      {
        name: 'malformed model ref',
        slug: 'missing',
        deps: deps(),
        includes: '找不到模型连接 "missing"',
      },
      {
        name: 'disabled provider',
        slug: 'anthropic',
        deps: deps({ connection: connection({ enabled: false }), apiKey: 'sk-test' }),
        includes: '已禁用',
      },
      {
        name: 'provider requires secret but has none',
        slug: 'anthropic',
        deps: deps({ connection: connection(), apiKey: null }),
        includes: '缺少 API key',
      },
    ];

    for (const entry of table) {
      await assertRejectsReadiness(entry.name, () => requireReadyConnection(entry.slug, entry.deps), entry.includes);
    }
  });

  test('blocks connections with no usable model or model outside enabled list', async () => {
    await assertRejectsReadiness(
      'blank default model',
      () => requireReadyConnection('custom', deps({
        connection: connection({ slug: 'custom', providerType: 'openai-compatible', defaultModel: '' }),
        apiKey: 'sk-test',
      })),
      '没有可用模型',
    );

    await assertRejectsReadiness(
      'empty model list',
      () => requireReadyConnection('custom', deps({
        connection: connection({ slug: 'custom', models: [] }),
        apiKey: 'sk-test',
      })),
      '没有启用任何模型',
    );

    await assertRejectsReadiness(
      'requested model outside enabled list',
      () => requireReadyConnection('custom', deps({
        connection: connection({
          slug: 'custom',
          defaultModel: 'glm-4.7',
          models: [{ id: 'glm-4.7' }],
        }),
        apiKey: 'sk-test',
      }), 'gpt-4o'),
      '不在连接 "Anthropic" 的启用模型列表中',
    );
  });

  test('allows none-auth local providers and real providers with secrets', async () => {
    const local = await requireReadyConnection(
      'ollama',
      deps({ connection: connection({ slug: 'ollama', providerType: 'ollama', name: 'Ollama', defaultModel: 'llama3.2' }) }),
    );
    assert.equal(local.connection.slug, 'ollama');
    assert.equal(local.apiKey, '');
    assert.equal(local.model, 'llama3.2');

    const real = await requireReadyConnection(
      'anthropic',
      deps({ connection: connection(), apiKey: 'sk-ant-test' }),
      'claude-3-5-sonnet-20241022',
    );
    assert.equal(real.connection.slug, 'anthropic');
    assert.equal(real.apiKey, 'sk-ant-test');
    assert.equal(real.model, 'claude-3-5-sonnet-20241022');
  });

  test('send path blocks explicit fake sessions and revalidates old ai sessions', async () => {
    await assertRejectsReadiness(
      'explicit fake session',
      () => assertSessionCanSend(header({ backend: 'fake', llmConnectionSlug: 'fake', model: 'fake-model' }), deps()),
      'FakeBackend',
    );

    await assertRejectsReadiness(
      'old ai session after provider deletion',
      () => assertSessionCanSend(header({ llmConnectionSlug: 'deleted' }), deps()),
      '找不到模型连接 "deleted"',
    );

    await assertRejectsReadiness(
      'old ai session after key removal',
      () => assertSessionCanSend(header(), deps({ connection: connection(), apiKey: null })),
      '缺少 API key',
    );

    await assert.doesNotReject(() =>
      assertSessionCanSend(header(), deps({ connection: connection(), apiKey: 'sk-test' })),
    );
  });
});

async function assertRejectsReadiness(name: string, fn: () => Promise<unknown>, includes: string): Promise<void> {
  await assert.rejects(
    fn,
    (error) => {
      assert.equal(errorCode(error), NO_REAL_CONNECTION_CODE, name);
      assert.match((error as Error).message, new RegExp(escapeRegExp(includes)), name);
      return true;
    },
  );
}

function deps(input: { connection?: LlmConnection | null; apiKey?: string | null } = {}): ReadyConnectionDeps {
  return {
    async getConnection(_slug: string) {
      return input.connection ?? null;
    },
    async getApiKey(_slug: string) {
      return input.apiKey ?? null;
    },
  };
}

function connection(patch: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: 'anthropic',
    name: 'Anthropic',
    providerType: 'anthropic',
    defaultModel: 'claude-3-5-sonnet-20241022',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function header(patch: Partial<SessionHeader> = {}): Pick<SessionHeader, 'backend' | 'llmConnectionSlug' | 'model'> {
  return {
    backend: 'ai-sdk',
    llmConnectionSlug: 'anthropic',
    model: 'claude-3-5-sonnet-20241022',
    ...patch,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
