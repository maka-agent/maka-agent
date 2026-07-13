import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { after, describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core';
import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { fetchProviderModels } from '../model-fetcher.js';
import { getAIModel } from '../model-factory.js';

const servers: Array<{ close(): Promise<void> }> = [];

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

describe('models.dev provider conformance', () => {
  test('LM Studio preserves an exact model id through discovery and a two-stage tool-call loop', async () => {
    const modelId = 'lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-GGUF';
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.headers.authorization, undefined);
      if (request.method === 'GET' && request.url === '/v1/models') {
        respondJson(response, 200, { data: [{ id: modelId }] });
        return;
      }

      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      requestBodies.push(body);
      if (requestBodies.length === 1) {
        respondJson(response, 200, {
          id: 'chatcmpl-lm-studio-tool',
          object: 'chat.completion',
          created: 1,
          model: modelId,
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
        return;
      }

      respondJson(response, 200, {
        id: 'chatcmpl-lm-studio-final',
        object: 'chat.completion',
        created: 2,
        model: modelId,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Echo returned hello.' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 14, completion_tokens: 5, total_tokens: 19 },
      });
    });
    const connection: LlmConnection = {
      slug: 'lm-studio',
      name: 'LM Studio',
      providerType: 'lm-studio',
      baseUrl: `${server.url}/v1`,
      defaultModel: modelId,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const models = await fetchProviderModels(connection, '');
    assert.deepEqual(models, [{ id: modelId }]);

    const result = await generateText({
      model: getAIModel({ connection, apiKey: '', modelId: models[0]!.id }),
      prompt: 'Call echo with hello, then report the result.',
      stopWhen: stepCountIs(2),
      tools: {
        echo: tool({
          description: 'Echo text',
          inputSchema: z.object({ text: z.string() }),
          execute: async ({ text }) => ({ echoed: text }),
        }),
      },
    });

    assert.equal(requestBodies.length, 2);
    assert.deepEqual(requestBodies.map((body) => body.model), [modelId, modelId]);
    assert.deepEqual(
      (requestBodies[0]?.tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name),
      ['echo'],
    );
    const secondMessages = requestBodies[1]?.messages as Array<{ role: string; content: unknown }>;
    assert.equal(secondMessages.some((message) => message.role === 'tool'), true);
    assert.equal(JSON.stringify(secondMessages).includes('hello'), true);
    assert.equal(result.text, 'Echo returned hello.');
  });

  test('Cerebras discovers exact account model ids and completes its documented two-stage tool-call loop', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.headers.authorization, 'Bearer cerebras-test-key');
      if (request.method === 'GET' && request.url === '/v1/models') {
        respondJson(response, 200, { data: [{ id: 'gpt-oss-120b' }] });
        return;
      }
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      requestBodies.push(body);
      const messages = body.messages as Array<{ role: string }>;
      if (messages.some(({ role }) => role === 'tool')) {
        respondJson(response, 200, {
          id: 'chatcmpl-cerebras-final',
          object: 'chat.completion',
          created: 2,
          model: 'gpt-oss-120b',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Echoed hello.' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
        });
        return;
      }
      respondJson(response, 200, {
        id: 'chatcmpl-cerebras-tool',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-oss-120b',
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
      slug: 'cerebras',
      name: 'Cerebras',
      providerType: 'cerebras',
      baseUrl: `${server.url}/v1`,
      defaultModel: 'gpt-oss-120b',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const models = await fetchProviderModels(connection, 'cerebras-test-key');
    assert.deepEqual(models, [{ id: 'gpt-oss-120b' }]);

    const result = await generateText({
      model: getAIModel({
        connection,
        apiKey: 'cerebras-test-key',
        modelId: models[0]!.id,
      }),
      prompt: 'Call echo with hello.',
      stopWhen: stepCountIs(2),
      tools: {
        echo: tool({
          description: 'Echo text',
          inputSchema: z.object({ text: z.string() }),
          execute: async ({ text }) => ({ echoed: text }),
        }),
      },
    });

    assert.equal(requestBodies.length, 2);
    assert.deepEqual(requestBodies.map((body) => body.model), ['gpt-oss-120b', 'gpt-oss-120b']);
    assert.deepEqual(
      (requestBodies[0]?.tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name),
      ['echo'],
    );
    assert.deepEqual(
      (requestBodies[1]?.messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
      { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'call_echo' },
    );
    assert.equal(result.steps[0]?.toolCalls[0]?.toolName, 'echo');
    assert.deepEqual(result.steps[0]?.toolCalls[0]?.input, { text: 'hello' });
    assert.deepEqual(result.steps[0]?.toolResults[0]?.output, { echoed: 'hello' });
    assert.equal(result.text, 'Echoed hello.');
  });

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

  test('MiniMax Coding Plan preserves an exact model id through discovery and an Anthropic tool-call turn', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers['x-api-key'], 'minimax-plan-test-key');
      if (request.method === 'GET' && request.url === '/anthropic/v1/models') {
        respondJson(response, 200, { data: [{ id: 'MiniMax-M2.7-highspeed' }] });
        return;
      }
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/anthropic/v1/messages');
      requestBody = JSON.parse(await readBody(request)) as Record<string, unknown>;
      respondJson(response, 200, {
        id: 'msg_minimax_plan',
        type: 'message',
        role: 'assistant',
        model: 'MiniMax-M2.7-highspeed',
        content: [{
          type: 'tool_use',
          id: 'toolu_echo',
          name: 'echo',
          input: { text: 'hello' },
        }],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 4 },
      });
    });
    const connection: LlmConnection = {
      slug: 'minimax-plan',
      name: 'MiniMax Coding Plan',
      providerType: 'minimax-coding-plan',
      baseUrl: `${server.url}/anthropic`,
      defaultModel: 'MiniMax-M2.7-highspeed',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const models = await fetchProviderModels(connection, 'minimax-plan-test-key');
    assert.deepEqual(models, [{ id: 'MiniMax-M2.7-highspeed' }]);

    const result = await generateText({
      model: getAIModel({
        connection,
        apiKey: 'minimax-plan-test-key',
        modelId: models[0]!.id,
      }),
      prompt: 'Call echo with hello.',
      tools: {
        echo: tool({
          description: 'Echo text',
          inputSchema: z.object({ text: z.string() }),
        }),
      },
    });

    assert.equal(requestBody?.model, 'MiniMax-M2.7-highspeed');
    assert.deepEqual(
      (requestBody?.tools as Array<{ name: string }>).map((entry) => entry.name),
      ['echo'],
    );
    assert.equal(result.toolCalls[0]?.toolName, 'echo');
    assert.deepEqual(result.toolCalls[0]?.input, { text: 'hello' });
  });

  test('xAI discovers exact account model ids and completes an OpenAI-compatible tool-call loop', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.headers.authorization, 'Bearer xai-test-key');
      if (request.method === 'GET' && request.url === '/v1/models') {
        respondJson(response, 200, {
          object: 'list',
          data: [{ id: 'grok-4.5', object: 'model', owned_by: 'xai' }],
        });
        return;
      }
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      requestBodies.push(JSON.parse(await readBody(request)) as Record<string, unknown>);
      if (requestBodies.length === 2) {
        respondJson(response, 200, {
          id: 'chatcmpl-xai-final',
          object: 'chat.completion',
          created: 2,
          model: 'grok-4.5',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Echoed hello.' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
        });
        return;
      }
      respondJson(response, 200, {
        id: 'chatcmpl-xai',
        object: 'chat.completion',
        created: 1,
        model: 'grok-4.5',
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
      slug: 'xai',
      name: 'xAI',
      providerType: 'xai',
      baseUrl: `${server.url}/v1`,
      defaultModel: 'grok-4.5',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const models = await fetchProviderModels(connection, 'xai-test-key');
    assert.deepEqual(models, [{ id: 'grok-4.5' }]);

    const result = await generateText({
      model: getAIModel({ connection, apiKey: 'xai-test-key', modelId: 'grok-4.5' }),
      prompt: 'Call echo with hello.',
      stopWhen: stepCountIs(2),
      tools: {
        echo: tool({
          description: 'Echo text',
          inputSchema: z.object({ text: z.string() }),
          execute: async ({ text }) => ({ echoed: text }),
        }),
      },
    });

    assert.equal(requestBodies.length, 2);
    assert.deepEqual(requestBodies.map((body) => body.model), ['grok-4.5', 'grok-4.5']);
    assert.deepEqual(
      (requestBodies[0]?.tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name),
      ['echo'],
    );
    assert.deepEqual(
      (requestBodies[1]?.messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
      { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'call_echo' },
    );
    assert.equal(result.steps[0]?.toolCalls[0]?.toolName, 'echo');
    assert.deepEqual(result.steps[0]?.toolCalls[0]?.input, { text: 'hello' });
    assert.deepEqual(result.steps[0]?.toolResults[0]?.output, { echoed: 'hello' });
    assert.equal(result.text, 'Echoed hello.');
  });

  test('Ollama discovers an exact local model id and completes a no-secret tool-call loop', async () => {
    const modelId = 'hf.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M';
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = await startJsonServer(async (request, response) => {
      if (request.method === 'GET' && request.url === '/api/tags') {
        assert.equal(request.headers.authorization, undefined);
        respondJson(response, 200, { models: [{ name: modelId, model: modelId }] });
        return;
      }
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer ollama');
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      requestBodies.push(body);
      if (requestBodies.length === 1) {
        respondJson(response, 200, {
          id: 'chatcmpl-ollama-tool',
          object: 'chat.completion',
          created: 1,
          model: modelId,
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
        return;
      }
      respondJson(response, 200, {
        id: 'chatcmpl-ollama-final',
        object: 'chat.completion',
        created: 2,
        model: modelId,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Echoed hello.' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      });
    });
    const connection: LlmConnection = {
      slug: 'ollama-local',
      name: 'Ollama',
      providerType: 'ollama',
      baseUrl: `${server.url}/v1`,
      defaultModel: modelId,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    assert.deepEqual(await fetchProviderModels(connection, ''), [{ id: modelId }]);

    const result = await generateText({
      model: getAIModel({ connection, apiKey: '', modelId }),
      prompt: 'Call echo with hello, then report the result.',
      tools: {
        echo: tool({
          description: 'Echo text',
          inputSchema: z.object({ text: z.string() }),
          execute: async ({ text }) => ({ text }),
        }),
      },
      stopWhen: stepCountIs(2),
    });

    assert.equal(result.text, 'Echoed hello.');
    assert.equal(requestBodies.length, 2);
    assert.deepEqual(requestBodies.map((body) => body.model), [modelId, modelId]);
    assert.deepEqual(
      (requestBodies[0]?.tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name),
      ['echo'],
    );
    const secondMessages = requestBodies[1]?.messages as Array<{ role: string; content: string }>;
    const toolMessage = secondMessages.find((message) => message.role === 'tool');
    assert.ok(toolMessage);
    assert.deepEqual(JSON.parse(toolMessage.content), { text: 'hello' });
  });

  test('Mistral discovers exact account model ids and completes its documented tool-call loop', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    let modelListRequests = 0;
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.headers.authorization, 'Bearer mistral-test-key');
      if (request.method === 'GET' && request.url === '/v1/models') {
        modelListRequests += 1;
        const model = {
            id: 'mistral-large-latest',
            object: 'model',
            owned_by: 'mistralai',
            capabilities: { completion_chat: true, function_calling: true },
        };
        respondJson(response, 200, modelListRequests === 1 ? [model] : { object: 'list', data: [model] });
        return;
      }
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      requestBodies.push(JSON.parse(await readBody(request)) as Record<string, unknown>);
      if (requestBodies.length === 2) {
        respondJson(response, 200, {
          id: 'cmpl-mistral-final',
          object: 'chat.completion',
          created: 2,
          model: 'mistral-large-latest',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Echoed hello.' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
        });
        return;
      }
      respondJson(response, 200, {
        id: 'cmpl-mistral-tool',
        object: 'chat.completion',
        created: 1,
        model: 'mistral-large-latest',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'D681PevKs',
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
      slug: 'mistral',
      name: 'Mistral',
      providerType: 'mistral',
      baseUrl: `${server.url}/v1`,
      defaultModel: 'mistral-large-latest',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const models = await fetchProviderModels(connection, 'mistral-test-key');
    assert.deepEqual(models, [{ id: 'mistral-large-latest' }]);
    const wrappedModels = await fetchProviderModels(connection, 'mistral-test-key');
    assert.deepEqual(wrappedModels, [{ id: 'mistral-large-latest' }]);

    const result = await generateText({
      model: getAIModel({ connection, apiKey: 'mistral-test-key', modelId: 'mistral-large-latest' }),
      prompt: 'Call echo with hello.',
      stopWhen: stepCountIs(2),
      tools: {
        echo: tool({
          description: 'Echo text',
          inputSchema: z.object({ text: z.string() }),
          execute: async ({ text }) => ({ echoed: text }),
        }),
      },
    });

    assert.equal(requestBodies.length, 2);
    assert.deepEqual(requestBodies.map((body) => body.model), ['mistral-large-latest', 'mistral-large-latest']);
    assert.deepEqual(
      (requestBodies[0]?.tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name),
      ['echo'],
    );
    assert.deepEqual(
      (requestBodies[1]?.messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
      { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'D681PevKs' },
    );
    assert.equal(result.steps[0]?.toolCalls[0]?.toolName, 'echo');
    assert.deepEqual(result.steps[0]?.toolCalls[0]?.input, { text: 'hello' });
    assert.deepEqual(result.steps[0]?.toolResults[0]?.output, { echoed: 'hello' });
    assert.equal(result.text, 'Echoed hello.');
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
