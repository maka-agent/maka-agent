import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { after, describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core';
import { fetchProviderModels } from '../model-fetcher.js';

const servers: Array<{ close(): Promise<void> }> = [];

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

describe('fetchProviderModels', () => {
  test('Vercel AI Gateway discovers the complete public language-model list without exposing its inference key', async () => {
    const modelId = 'anthropic/claude-opus-4.8';
    const server = await startJsonServer((request, response) => {
      assert.equal(request.method, 'GET');
      assert.equal(request.url, '/v1/models');
      assert.equal(request.headers.authorization, undefined);
      respondJson(response, 200, {
        object: 'list',
        data: [
          {
            id: modelId,
            object: 'model',
            name: 'Claude Opus 4.8',
            type: 'language',
            context_window: 1_000_000,
            max_tokens: 128_000,
            tags: ['reasoning', 'tool-use', 'vision'],
          },
          {
            id: 'openai/text-embedding-3-small',
            object: 'model',
            name: 'Text Embedding 3 Small',
            type: 'embedding',
          },
        ],
      });
    });

    const models = await fetchProviderModels({
      slug: 'vercel',
      name: 'Vercel AI Gateway',
      providerType: 'vercel',
      baseUrl: `${server.url}/v1`,
      defaultModel: modelId,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    }, 'vercel-inference-key');

    assert.deepEqual(models, [{
      id: modelId,
      displayName: 'Claude Opus 4.8',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: { vision: true, reasoning: true, functionCalling: true },
    }]);
  });

  test('LocalAI discovers exact model aliases without sending empty authorization', async () => {
    const modelId = 'localai/Qwen3-8B-Instruct-GGUF:Q4_K_M';
    const server = await startJsonServer((request, response) => {
      assert.equal(request.method, 'GET');
      assert.equal(request.url, '/v1/models');
      assert.equal(request.headers.authorization, undefined);
      respondJson(response, 200, { data: [{ id: modelId }] });
    });

    const models = await fetchProviderModels({
      slug: 'localai',
      name: 'LocalAI',
      providerType: 'localai',
      baseUrl: `${server.url}/v1`,
      defaultModel: modelId,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    }, '');

    assert.deepEqual(models, [{ id: modelId }]);
  });

  test('LocalAI sends a user-supplied API key as Bearer during discovery', async () => {
    const server = await startJsonServer((request, response) => {
      assert.equal(request.headers.authorization, 'Bearer localai-user-key');
      respondJson(response, 200, { data: [{ id: 'qwen3-8b' }] });
    });

    await fetchProviderModels({
      slug: 'localai-keyed',
      name: 'LocalAI protected',
      providerType: 'localai',
      baseUrl: `${server.url}/v1`,
      defaultModel: 'qwen3-8b',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    }, 'localai-user-key');
  });

  test('LM Studio discovers exact local model ids without authentication', async () => {
    const server = await startJsonServer((request, response) => {
      assert.equal(request.method, 'GET');
      assert.equal(request.url, '/v1/models');
      assert.equal(request.headers.authorization, undefined);
      respondJson(response, 200, {
        data: [
          { id: 'lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-GGUF' },
          { id: 'mlx-community/Qwen3-4B-Instruct-4bit' },
        ],
      });
    });

    const models = await fetchProviderModels({
      slug: 'lm-studio',
      name: 'LM Studio',
      providerType: 'lm-studio',
      baseUrl: `${server.url}/v1`,
      defaultModel: '',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    }, '');

    assert.deepEqual(models, [
      { id: 'lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-GGUF' },
      { id: 'mlx-community/Qwen3-4B-Instruct-4bit' },
    ]);
  });

  test('Z.ai fetches live /models results, including IDs outside fallback defaults', async () => {
    let observedAuth = '';
    let observedContentType = '';
    const server = await startJsonServer((request, response) => {
      observedAuth = request.headers.authorization ?? '';
      observedContentType = request.headers['content-type'] ?? '';
      assert.equal(request.method, 'GET');
      assert.equal(request.url, '/models');
      respondJson(response, 200, {
        data: [
          { id: 'glm-4.6' },
          { id: 'glm-z1-air' },
        ],
      });
    });

    const models = await fetchProviderModels(
      { ...zaiConnection(), baseUrl: server.url },
      'zai-live-secret',
    );

    assert.equal(observedAuth, 'Bearer zai-live-secret');
    assert.equal(observedContentType, 'application/json');
    assert.deepEqual(models, [{ id: 'glm-4.6' }, { id: 'glm-z1-air' }]);
  });

  test('Z.ai baseUrl trailing slash is trimmed before appending /models', async () => {
    let observedPath = '';
    const server = await startJsonServer((request, response) => {
      observedPath = request.url ?? '';
      respondJson(response, 200, { data: [{ id: 'glm-live' }] });
    });

    const models = await fetchProviderModels(
      { ...zaiConnection(), baseUrl: `${server.url}/` },
      'zai-live-secret',
    );

    assert.equal(observedPath, '/models');
    assert.deepEqual(models, [{ id: 'glm-live' }]);
  });

  test('provider model capability fields are preserved when present', async () => {
    const server = await startJsonServer((_request, response) => {
      respondJson(response, 200, {
        data: [
          {
            id: 'kimi-k2.7',
            supports_image_in: true,
            supports_reasoning: true,
            context_length: 262_144,
          },
          { id: 'moonshot-v1-8k', supports_image_in: false },
        ],
      });
    });

    const models = await fetchProviderModels({
      slug: 'moonshot',
      name: 'Moonshot',
      providerType: 'moonshot',
      baseUrl: server.url,
      defaultModel: 'kimi-k2.7',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    }, 'moonshot-secret');

    assert.deepEqual(models, [
      {
        id: 'kimi-k2.7',
        contextWindow: 262_144,
        capabilities: { vision: true, reasoning: true },
      },
      { id: 'moonshot-v1-8k', capabilities: { vision: false } },
    ]);
  });

  test('provider fetch failures throw generalized errors instead of returning fallback models', async () => {
    const server = await startJsonServer((_request, response) => {
      respondJson(response, 401, {
        error: 'bad token',
        authorization: 'Bearer zai-live-secret',
      });
    });

    await assert.rejects(
      () => fetchProviderModels({ ...zaiConnection(), baseUrl: server.url }, 'zai-live-secret'),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'Authentication failed');
        assert.equal(error.message.includes('zai-live-secret'), false);
        return true;
      },
    );
  });

  test('OpenAI-compatible providers fetch live /models instead of returning fallback defaults', async () => {
    const server = await startJsonServer((request, response) => {
      assert.equal(request.url, '/v1/models');
      assert.equal(request.headers.authorization, 'Bearer relay-secret');
      respondJson(response, 200, {
        data: [
          { id: 'custom-live-model' },
        ],
      });
    });

    const models = await fetchProviderModels({
      slug: 'relay',
      name: 'Relay',
      providerType: 'openai-compatible',
      baseUrl: `${server.url}/v1`,
      defaultModel: 'custom-live-model',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    }, 'relay-secret');

    assert.deepEqual(models, [{ id: 'custom-live-model' }]);
  });

  test('Google Gemini appends /models to a /v1beta base URL without doubling the version segment', async () => {
    let observedPath = '';
    let observedKey = '';
    const server = await startJsonServer((request, response) => {
      observedPath = request.url ?? '';
      const url = new URL(request.url ?? '', 'http://test.local');
      observedKey = url.searchParams.get('key') ?? '';
      assert.equal(request.method, 'GET');
      respondJson(response, 200, {
        models: [
          { name: 'models/gemini-2.5-flash' },
          { name: 'models/gemini-2.0-flash' },
        ],
      });
    });

    const models = await fetchProviderModels(
      { ...googleConnection(), baseUrl: `${server.url}/v1beta` },
      'google-api-key',
    );

    // baseUrl already ends with /v1beta — the fetcher must append /models,
    // not /v1beta/models (which would double the version segment and 404).
    assert.equal(observedPath, '/v1beta/models?key=google-api-key');
    assert.equal(observedKey, 'google-api-key');
    assert.deepEqual(models, [{ id: 'gemini-2.5-flash' }, { id: 'gemini-2.0-flash' }]);
  });

  test('Claude subscription model fetch uses OAuth bearer headers, not x-api-key', async () => {
    let observedAuth = '';
    let observedApiKey = '';
    let observedBeta = '';
    let observedApp = '';
    const server = await startJsonServer((request, response) => {
      observedAuth = request.headers.authorization ?? '';
      observedApiKey = (request.headers['x-api-key'] as string | undefined) ?? '';
      observedBeta = (request.headers['anthropic-beta'] as string | undefined) ?? '';
      observedApp = (request.headers['x-app'] as string | undefined) ?? '';
      assert.equal(request.url, '/v1/models');
      respondJson(response, 200, {
        data: [
          { id: 'claude-sonnet-4-5-20250929' },
        ],
      });
    });

    const models = await fetchProviderModels({
      slug: 'claude-subscription',
      name: 'Claude OAuth',
      providerType: 'claude-subscription',
      baseUrl: server.url,
      defaultModel: 'claude-sonnet-4-5-20250929',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    }, 'oauth-access-token');

    assert.equal(observedAuth, 'Bearer oauth-access-token');
    assert.equal(observedApiKey, '');
    assert.match(observedBeta, /oauth-2025-04-20/);
    assert.equal(observedApp, 'cli');
    assert.deepEqual(models, [{ id: 'claude-sonnet-4-5-20250929' }]);
  });

  test('Claude subscription model fetch accepts a stored /v1 base URL without doubling it', async () => {
    let observedPath = '';
    const server = await startJsonServer((request, response) => {
      observedPath = request.url ?? '';
      respondJson(response, 200, { data: [{ id: 'claude-haiku-4-5-20251001' }] });
    });

    const models = await fetchProviderModels({
      slug: 'claude-subscription',
      name: 'Claude OAuth',
      providerType: 'claude-subscription',
      baseUrl: `${server.url}/v1`,
      defaultModel: 'claude-haiku-4-5-20251001',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    }, 'oauth-access-token');

    assert.equal(observedPath, '/v1/models');
    assert.deepEqual(models, [{ id: 'claude-haiku-4-5-20251001' }]);
  });

  test('MiniMax Coding Plan discovers exact model ids with Anthropic API-key authentication', async () => {
    let observedAuthorization = '';
    let observedApiKey = '';
    const server = await startJsonServer((request, response) => {
      observedAuthorization = request.headers.authorization ?? '';
      observedApiKey = (request.headers['x-api-key'] as string | undefined) ?? '';
      assert.equal(request.method, 'GET');
      assert.equal(request.url, '/anthropic/v1/models');
      respondJson(response, 200, {
        data: [
          { id: 'MiniMax-M3' },
          { id: 'MiniMax-M2.7-highspeed' },
        ],
      });
    });

    const models = await fetchProviderModels({
      slug: 'minimax-plan',
      name: 'MiniMax Coding Plan',
      providerType: 'minimax-coding-plan',
      baseUrl: `${server.url}/anthropic`,
      defaultModel: 'MiniMax-M3',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    }, 'minimax-plan-secret');

    assert.equal(observedAuthorization, '');
    assert.equal(observedApiKey, 'minimax-plan-secret');
    assert.deepEqual(models, [{ id: 'MiniMax-M3' }, { id: 'MiniMax-M2.7-highspeed' }]);
  });

  test('Codex subscription model fetch uses the pinned subscription model list', async () => {
    const models = await fetchProviderModels({
      slug: 'codex-subscription',
      name: 'Codex OAuth',
      providerType: 'codex-subscription',
      defaultModel: 'gpt-5.5',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    }, 'oauth-access-token');

    assert.deepEqual(models, [
      { id: 'gpt-5.5' },
      { id: 'gpt-5.4' },
      { id: 'gpt-5.4-mini' },
      { id: 'gpt-5.3-codex-spark' },
    ]);
  });

  test('successful empty provider responses stay fetched-empty instead of falling back', async () => {
    const server = await startJsonServer((_request, response) => {
      respondJson(response, 200, { data: [] });
    });

    const models = await fetchProviderModels(
      { ...zaiConnection(), baseUrl: server.url },
      'zai-live-secret',
    );

    assert.deepEqual(models, []);
  });
});

async function startJsonServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const control = {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
  servers.push(control);
  return control;
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function zaiConnection(): LlmConnection {
  return {
    slug: 'zai',
    name: 'Z.ai',
    providerType: 'zai-coding-plan',
    defaultModel: 'glm-4.7',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function googleConnection(): LlmConnection {
  return {
    slug: 'google',
    name: 'Google Gemini',
    providerType: 'google',
    defaultModel: 'gemini-2.5-flash',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
