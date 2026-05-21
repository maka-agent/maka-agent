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
