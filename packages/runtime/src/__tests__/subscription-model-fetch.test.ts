import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core';
import { buildSubscriptionModelFetch } from '../subscription-model-fetch.js';

describe('subscription model fetch', () => {
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
