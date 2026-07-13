import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { after, describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core';
import { generateText, tool } from 'ai';
import { z } from 'zod';
import { fetchProviderModels } from '../model-fetcher.js';
import { getAIModel } from '../model-factory.js';

const servers: Array<{ close(): Promise<void> }> = [];

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

describe('models.dev provider conformance', () => {
  test('SiliconFlow discovers exact model ids and completes an OpenAI-compatible tool-call turn', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.headers.authorization, 'Bearer sf-test-key');
      if (request.method === 'GET' && request.url === '/v1/models?sub_type=chat') {
        respondJson(response, 200, { data: [{ id: 'moonshotai/Kimi-K2.6' }] });
        return;
      }
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      requestBody = JSON.parse(await readBody(request)) as Record<string, unknown>;
      respondJson(response, 200, {
        id: 'chatcmpl-siliconflow',
        object: 'chat.completion',
        created: 1,
        model: 'moonshotai/Kimi-K2.6',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_echo',
              type: 'function',
              function: { name: 'echo', arguments: '{"text":"hello"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
      });
    });
    const connection: LlmConnection = {
      slug: 'siliconflow',
      name: 'SiliconFlow',
      providerType: 'siliconflow',
      baseUrl: `${server.url}/v1`,
      defaultModel: 'moonshotai/Kimi-K2.6',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const models = await fetchProviderModels(connection, 'sf-test-key');
    assert.deepEqual(models, [{ id: 'moonshotai/Kimi-K2.6' }]);

    const result = await generateText({
      model: getAIModel({
        connection,
        apiKey: 'sf-test-key',
        modelId: 'moonshotai/Kimi-K2.6',
        fetch: globalThis.fetch,
      }),
      prompt: 'Call echo with hello.',
      tools: {
        echo: tool({
          description: 'Echo text',
          inputSchema: z.object({ text: z.string() }),
        }),
      },
    });

    assert.equal(requestBody?.model, 'moonshotai/Kimi-K2.6');
    assert.deepEqual(
      (requestBody?.tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name),
      ['echo'],
    );
    assert.equal(result.toolCalls[0]?.toolName, 'echo');
    assert.deepEqual(result.toolCalls[0]?.input, { text: 'hello' });
  });
});

async function startJsonServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error) => {
      response.destroy(error as Error);
    });
  });
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

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
