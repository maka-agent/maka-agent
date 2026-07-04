import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core';
import { buildSubscriptionModelFetch } from '../subscription-model-fetch.js';

describe('subscription model fetch', () => {
  test('cloaks Claude subscription requests by default', async () => {
    let observedHeaders = new Headers();
    let observedBody = '';
    const modelFetch = buildSubscriptionModelFetch({
      connection: claudeSubscriptionConnection(),
      sessionId: 'session-123',
      modelId: 'claude-sonnet-4-5',
      fetchFn: async (_url, init) => {
        observedHeaders = new Headers(init?.headers);
        observedBody = String(init?.body ?? '');
        return Response.json({ ok: true });
      },
      claude: {
        deviceId: 'device-123',
        accountUuid: 'account-123',
      },
    });

    assert.ok(modelFetch);
    await modelFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'x-api-key': '' },
      body: JSON.stringify({
        stream: false,
        system: 'Use the Maka system prompt.',
        messages: [{ role: 'user', content: 'hello from Maka' }],
      }),
    });

    const body = JSON.parse(observedBody);
    assert.equal(observedHeaders.get('user-agent'), 'claude-cli/2.1.153 (external, cli)');
    assert.equal(observedHeaders.get('x-api-key'), null);
    assert.equal(observedHeaders.get('X-Claude-Code-Session-Id'), 'session-123');
    assert.equal(body.metadata.user_id, JSON.stringify({
      device_id: 'device-123',
      account_uuid: 'account-123',
      session_id: 'session-123',
    }));
    assert.equal(body.system[0].text.startsWith('x-anthropic-billing-header:'), true);
    assert.equal(body.system[1].text, "You are Claude Code, Anthropic's official CLI for Claude.");
    assert.equal(body.system[2].text, 'Use the Maka system prompt.');
  });

  test('leaves Claude subscription requests untouched when the cloak opt-out is disabled', async () => {
    const modelFetch = buildSubscriptionModelFetch({
      connection: claudeSubscriptionConnection(),
      sessionId: 'session-123',
      modelId: 'claude-sonnet-4-5',
      claude: {
        cloakEnabled: false,
        deviceId: 'device-123',
        accountUuid: 'account-123',
      },
    });

    assert.equal(modelFetch, undefined);
  });

  test('rejects Claude subscription cloaking without complete metadata', () => {
    assert.throws(
      () => buildSubscriptionModelFetch({
        connection: claudeSubscriptionConnection(),
        sessionId: 'session-123',
        modelId: 'claude-sonnet-4-5',
      }),
      /Claude subscription cloaking requires deviceId and accountUuid metadata/,
    );
    assert.throws(
      () => buildSubscriptionModelFetch({
        connection: claudeSubscriptionConnection(),
        sessionId: 'session-123',
        modelId: 'claude-sonnet-4-5',
        claude: {
          deviceId: 'device-123',
          accountUuid: '',
        },
      }),
      /Claude subscription cloaking requires deviceId and accountUuid metadata/,
    );
  });

  test('maps Codex OAuth requests into the ChatGPT backend request shape', async () => {
    let observedHeaders = new Headers();
    let observedBody = '';
    const modelFetch = buildSubscriptionModelFetch({
      connection: codexSubscriptionConnection(),
      sessionId: 'session-123',
      modelId: 'gpt-5.5',
      fetchFn: async (_url, init) => {
        observedHeaders = new Headers(init?.headers);
        observedBody = String(init?.body ?? '');
        return Response.json({ ok: true });
      },
    });

    assert.ok(modelFetch);
    await modelFetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
      body: JSON.stringify({
        system: 'Use the Maka system prompt.',
        input: [{ role: 'user', content: 'hi' }],
      }),
    });

    const body = JSON.parse(observedBody);
    assert.equal(observedHeaders.get('originator'), 'codex_cli_rs');
    assert.equal(observedHeaders.get('session_id'), 'session-123');
    assert.equal(observedHeaders.get('x-client-request-id'), 'session-123');
    assert.equal(body.instructions, 'Use the Maka system prompt.');
    assert.equal(body.store, false);
    assert.equal(body.parallel_tool_calls, true);
    assert.equal(body.text.verbosity, 'medium');
  });
});

function claudeSubscriptionConnection(): LlmConnection {
  return {
    slug: 'claude-subscription',
    name: 'Claude OAuth',
    providerType: 'claude-subscription',
    defaultModel: 'claude-sonnet-4-5',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function codexSubscriptionConnection(): LlmConnection {
  return {
    slug: 'codex-subscription',
    name: 'OpenAI OAuth',
    providerType: 'codex-subscription',
    defaultModel: 'gpt-5.5',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
