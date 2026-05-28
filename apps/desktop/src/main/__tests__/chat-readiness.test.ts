import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection, SessionHeader } from '@maka/core';
import {
  NO_REAL_CONNECTION_CODE,
  assertSessionCanSend,
  ensureSessionCanSendOrRebind,
  errorCode,
  requireReadyConnection,
  errorReason,
  shouldRebindSessionToDefault,
  type ReadyConnectionDeps,
} from '../chat-readiness.js';

describe('chat readiness guard', () => {
  test('blocks missing, fake, missing, disabled, and secretless model references', async () => {
    const table: Array<{
      name: string;
      slug: string | null | undefined;
      deps: ReadyConnectionDeps;
      includes: string;
      reason: string;
    }> = [
      {
        name: 'no default model',
        slug: null,
        deps: deps(),
        includes: '还没有配置默认模型',
        reason: 'missing_default_connection',
      },
      {
        name: 'implicit fake slug',
        slug: 'fake',
        deps: deps(),
        includes: '还没有配置默认模型',
        reason: 'missing_default_connection',
      },
      {
        name: 'malformed model ref',
        slug: 'missing',
        deps: deps(),
        includes: '找不到模型连接 "missing"',
        reason: 'connection_missing',
      },
      {
        name: 'disabled provider',
        slug: 'anthropic',
        deps: deps({ connection: connection({ enabled: false }), apiKey: 'sk-test' }),
        includes: '已禁用',
        reason: 'connection_disabled',
      },
      {
        name: 'provider requires secret but has none',
        slug: 'anthropic',
        deps: deps({ connection: connection(), apiKey: null }),
        includes: '缺少 API key',
        reason: 'missing_api_key',
      },
    ];

    for (const entry of table) {
      await assertRejectsReadiness(entry.name, () => requireReadyConnection(entry.slug, entry.deps), entry.includes, entry.reason);
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
      'missing_model',
    );

    await assertRejectsReadiness(
      'empty model list',
      () => requireReadyConnection('custom', deps({
        connection: connection({ slug: 'custom', models: [] }),
        apiKey: 'sk-test',
      })),
      '没有启用任何模型',
      'empty_model_list',
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
      'model_not_enabled',
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

  test('blocks OAuth subscription providers until the subscription send path is wired', async () => {
    await assertRejectsReadiness(
      'claude subscription send path not wired',
      () => requireReadyConnection(
        'claude-subscription',
        deps({
          connection: connection({
            slug: 'claude-subscription',
            name: 'Claude Subscription',
            providerType: 'claude-subscription',
            defaultModel: 'claude-sonnet-4-5-20250929',
          }),
          apiKey: 'legacy-oauth-secret',
        }),
      ),
      '聊天发送通路尚未接入',
      'oauth_subscription_not_wired',
    );
  });

  test('send path blocks explicit fake sessions and revalidates old ai sessions', async () => {
    await assertRejectsReadiness(
      'explicit fake session',
      () => assertSessionCanSend(header({ backend: 'fake', llmConnectionSlug: 'fake', model: 'fake-model' }), deps()),
      'FakeBackend',
      'fake_backend',
    );

    await assertRejectsReadiness(
      'old ai session after provider deletion',
      () => assertSessionCanSend(header({ llmConnectionSlug: 'deleted' }), deps()),
      '找不到模型连接 "deleted"',
      'connection_missing',
    );

    await assertRejectsReadiness(
      'old ai session after key removal',
      () => assertSessionCanSend(header(), deps({ connection: connection(), apiKey: null })),
      '缺少 API key',
      'missing_api_key',
    );

    await assert.doesNotReject(() =>
      assertSessionCanSend(header(), deps({ connection: connection(), apiKey: 'sk-test' })),
    );
  });

  test('PR110a regression: model_not_enabled error names the REQUESTED model, not defaultModel', async () => {
    // @kenji PR110a review gate: when caller passes `requestedModel`,
    // the failing reason MUST reference the requested model (not the
    // connection's defaultModel). The refactor to delegate to core
    // `isConnectionReady` must preserve this 1:1 mapping.
    await assert.rejects(
      () => requireReadyConnection(
        'anthropic',
        deps({
          connection: connection({
            defaultModel: 'claude-3-5-sonnet-20241022',
            models: [{ id: 'claude-3-5-sonnet-20241022' }],
          }),
          apiKey: 'sk-test',
        }),
        'gpt-4o-NOT-IN-LIST', // the request that should appear in the error
      ),
      (error) => {
        const message = (error as Error).message;
        assert.match(message, /gpt-4o-NOT-IN-LIST/, 'requested model must appear in error copy');
        assert.doesNotMatch(message, /claude-3-5-sonnet-20241022/, 'defaultModel must NOT leak into requested-model error');
        assert.equal(errorReason(error), 'model_not_enabled');
        return true;
      },
    );
  });

  test('PR110a regression: missing_model error fires when both requested and default are empty', async () => {
    await assertRejectsReadiness(
      'no requested, no default',
      () => requireReadyConnection('custom', deps({
        connection: connection({ slug: 'custom', defaultModel: '' }),
        apiKey: 'sk-test',
      })),
      '没有可用模型',
      'missing_model',
    );
  });

  // PR-HEALTH-1 — E4 lock (three-layer separation):
  // requireReadyConnection (send gate) must NOT consider lastTestStatus.
  // Credential test outcome is a validation-layer concern; the send gate
  // answers "fact: can we attempt a real send right now?" — credentials
  // exist, model is enabled, backend is real. lastTestStatus is advisory
  // (a past observation); send-time is when we find out for real.
  test('E4: lastTestStatus does NOT gate requireReadyConnection (send path stays validation-independent)', async () => {
    for (const lastTestStatus of [undefined, 'verified', 'needs_reauth', 'error'] as const) {
      const ready = await requireReadyConnection(
        'anthropic',
        deps({
          connection: connection({ lastTestStatus }),
          apiKey: 'sk-test',
        }),
      );
      assert.equal(
        ready.connection.slug,
        'anthropic',
        `lastTestStatus=${lastTestStatus} must NOT block send (validation ≠ send gate)`,
      );
      assert.equal(ready.model, 'claude-3-5-sonnet-20241022');
    }
  });

  test('classifies stale sessions that can be rebound to the current default model', () => {
    for (const reason of ['fake_backend', 'connection_missing', 'missing_model', 'empty_model_list', 'model_not_enabled']) {
      assert.equal(shouldRebindSessionToDefault(reason), true, reason);
    }

    for (const reason of ['missing_default_connection', 'connection_disabled', 'missing_api_key', 'oauth_subscription_not_wired', undefined]) {
      assert.equal(shouldRebindSessionToDefault(reason), false, String(reason));
    }
  });

  test('rebinds stale ai-sdk sessions to a ready default connection before send', async () => {
    const updates: unknown[] = [];
    const result = await ensureSessionCanSendOrRebind(
      'session-1',
      header({ llmConnectionSlug: 'fake-claude', model: 'fake-model' }),
      {
        readyConnectionDeps: keyedDeps({
          'zai-coding-plan': {
            connection: connection({
              slug: 'zai-coding-plan',
              name: 'Z.AI Coding Plan',
              providerType: 'zai-coding-plan',
              defaultModel: 'glm-4.7',
              models: [{ id: 'glm-4.7' }],
            }),
            apiKey: 'sk-zai',
          },
        }),
        async getDefaultSlug() {
          return 'zai-coding-plan';
        },
        async updateSession(_sessionId, patch) {
          updates.push(patch);
        },
      },
    );

    assert.deepEqual(result, { rebound: true, connectionSlug: 'zai-coding-plan', modelId: 'glm-4.7' });
    assert.deepEqual(updates, [{
      backend: 'ai-sdk',
      llmConnectionSlug: 'zai-coding-plan',
      model: 'glm-4.7',
      connectionLocked: true,
    }]);
  });

  test('rebinds old fake sessions to a ready default connection before send', async () => {
    const updates: unknown[] = [];
    const result = await ensureSessionCanSendOrRebind(
      'session-1',
      header({ backend: 'fake', llmConnectionSlug: 'fake', model: 'fake-model' }),
      {
        readyConnectionDeps: keyedDeps({
          anthropic: { connection: connection(), apiKey: 'sk-test' },
        }),
        async getDefaultSlug() {
          return 'anthropic';
        },
        async updateSession(_sessionId, patch) {
          updates.push(patch);
        },
      },
    );

    assert.deepEqual(result, {
      rebound: true,
      connectionSlug: 'anthropic',
      modelId: 'claude-3-5-sonnet-20241022',
    });
    assert.equal(updates.length, 1);
  });

  test('keeps the original readiness error when no ready default exists for rebind', async () => {
    await assertRejectsReadiness(
      'fake session without ready default',
      () => ensureSessionCanSendOrRebind(
        'session-1',
        header({ backend: 'fake', llmConnectionSlug: 'fake', model: 'fake-model' }),
        {
          readyConnectionDeps: keyedDeps({}),
          async getDefaultSlug() {
            return null;
          },
          async updateSession() {
            throw new Error('must not update');
          },
        },
      ),
      'FakeBackend',
      'fake_backend',
    );
  });
});

async function assertRejectsReadiness(name: string, fn: () => Promise<unknown>, includes: string, reason: string): Promise<void> {
  await assert.rejects(
    fn,
    (error) => {
      assert.equal(errorCode(error), NO_REAL_CONNECTION_CODE, name);
      assert.equal(errorReason(error), reason, name);
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

function keyedDeps(entries: Record<string, { connection: LlmConnection; apiKey?: string | null }>): ReadyConnectionDeps {
  return {
    async getConnection(slug: string) {
      return entries[slug]?.connection ?? null;
    },
    async getApiKey(slug: string) {
      return entries[slug]?.apiKey ?? null;
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
