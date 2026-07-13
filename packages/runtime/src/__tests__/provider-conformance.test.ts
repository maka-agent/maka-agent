import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { after, describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core';
import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { fetchProviderModels } from '../model-fetcher.js';
import { buildProviderOptions, getAIModel } from '../model-factory.js';

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

  test('NVIDIA discovers exact account model ids and completes its documented two-stage tool-call loop', async () => {
    const modelId = 'nvidia/nemotron-3-super-120b-a12b';
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.headers.authorization, 'Bearer nvidia-test-key');
      if (request.method === 'GET' && request.url === '/v1/models') {
        respondJson(response, 200, {
          data: [
            { id: modelId, object: 'model', owned_by: 'nvidia' },
            { id: 'nvidia/nv-embed-v1', object: 'model', owned_by: 'nvidia' },
          ],
        });
        return;
      }
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      requestBodies.push(body);
      const messages = body.messages as Array<{ role: string }>;
      if (messages.some(({ role }) => role === 'tool')) {
        respondJson(response, 200, {
          id: 'chatcmpl-nvidia-final',
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
        return;
      }
      respondJson(response, 200, {
        id: 'chatcmpl-nvidia-tool',
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
    });
    const connection: LlmConnection = {
      slug: 'nvidia',
      name: 'NVIDIA',
      providerType: 'nvidia',
      baseUrl: `${server.url}/v1`,
      defaultModel: modelId,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const models = await fetchProviderModels(connection, 'nvidia-test-key');
    assert.deepEqual(models, [{ id: modelId }]);

    const result = await generateText({
      model: getAIModel({ connection, apiKey: 'nvidia-test-key', modelId: models[0]!.id }),
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
    assert.deepEqual(requestBodies.map((body) => body.model), [modelId, modelId]);
    assert.deepEqual(
      (requestBodies[0]?.tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name),
      ['echo'],
    );
    assert.deepEqual(
      (requestBodies[1]?.messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
      { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'call_echo' },
    );
    assert.equal(result.steps[0]?.toolCalls[0]?.toolName, 'echo');
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

  test('Together AI discovers exact account model ids and completes a Chat Completions tool-call loop', async () => {
    const modelId = 'MiniMaxAI/MiniMax-M3';
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.headers.authorization, 'Bearer together-test-key');
      if (request.method === 'GET' && request.url === '/v1/models') {
        respondJson(response, 200, {
          object: 'list',
          data: [{ id: modelId, object: 'model', owned_by: 'MiniMaxAI' }],
        });
        return;
      }
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      requestBodies.push(JSON.parse(await readBody(request)) as Record<string, unknown>);
      if (requestBodies.length === 2) {
        respondJson(response, 200, {
          id: 'chatcmpl-together-final',
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
        return;
      }
      respondJson(response, 200, {
        id: 'chatcmpl-together-tool',
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
    });
    const connection: LlmConnection = {
      slug: 'together',
      name: 'Together AI',
      providerType: 'togetherai',
      baseUrl: `${server.url}/v1`,
      defaultModel: modelId,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const models = await fetchProviderModels(connection, 'together-test-key');
    assert.deepEqual(models, [{ id: modelId }]);

    const result = await generateText({
      model: getAIModel({ connection, apiKey: 'together-test-key', modelId }),
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
    assert.deepEqual(requestBodies.map((body) => body.model), [modelId, modelId]);
    assert.deepEqual(
      (requestBodies[0]?.tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name),
      ['echo'],
    );
    assert.deepEqual(
      (requestBodies[1]?.messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
      { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'call_echo' },
    );
    assert.equal(result.steps[0]?.toolCalls[0]?.toolName, 'echo');
    assert.deepEqual(result.steps[0]?.toolResults[0]?.output, { echoed: 'hello' });
    assert.equal(result.text, 'Echoed hello.');
  });

  test('Fireworks discovers exact serverless model paths and completes a two-stage tool-call loop', async () => {
    const modelId = 'accounts/fireworks/models/kimi-k2p6';
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.headers.authorization, 'Bearer fireworks-test-key');
      if (request.method === 'GET' && request.url === '/v1/accounts?pageSize=200') {
        respondJson(response, 200, {
          accounts: [{ name: 'accounts/acme' }],
          nextPageToken: 'accounts-next',
        });
        return;
      }
      if (request.method === 'GET' && request.url === '/v1/accounts?pageSize=200&pageToken=accounts-next') {
        respondJson(response, 200, { accounts: [{ name: 'accounts/team' }] });
        return;
      }
      if (
        request.method === 'GET'
        && request.url === '/v1/accounts/acme/models?filter=supports_serverless%3Dtrue&pageSize=200'
      ) {
        respondJson(response, 200, {
          models: [{
            name: 'accounts/acme/models/custom-agent',
            displayName: 'Custom Agent',
            supportsTools: true,
            supportsServerless: true,
          }],
          nextPageToken: 'models-next',
        });
        return;
      }
      if (
        request.method === 'GET'
        && request.url === '/v1/accounts/acme/models?filter=supports_serverless%3Dtrue&pageSize=200&pageToken=models-next'
      ) {
        respondJson(response, 200, {
          models: [{
            name: 'accounts/acme/models/custom-agent-v2',
            displayName: 'Custom Agent V2',
            supportsTools: true,
            supportsServerless: true,
          }],
        });
        return;
      }
      if (
        request.method === 'GET'
        && request.url === '/v1/accounts/team/models?filter=supports_serverless%3Dtrue&pageSize=200'
      ) {
        respondJson(response, 200, {
          models: [{
            name: 'accounts/team/models/team-agent',
            displayName: 'Team Agent',
            supportsTools: true,
            supportsServerless: true,
          }],
        });
        return;
      }
      if (
        request.method === 'GET'
        && request.url === '/v1/accounts/fireworks/models?filter=supports_serverless%3Dtrue&pageSize=200'
      ) {
        respondJson(response, 200, {
          models: [{
            name: modelId,
            displayName: 'Kimi K2.6',
            contextLength: 262_000,
            supportsImageInput: true,
            supportsTools: true,
            supportsServerless: true,
          }],
        });
        return;
      }

      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/inference/v1/chat/completions');
      requestBodies.push(JSON.parse(await readBody(request)) as Record<string, unknown>);
      if (requestBodies.length === 1) {
        respondJson(response, 200, {
          id: 'chatcmpl-fireworks-tool',
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
        id: 'chatcmpl-fireworks-final',
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
      slug: 'fireworks-ai',
      name: 'Fireworks AI',
      providerType: 'fireworks-ai',
      baseUrl: `${server.url}/inference/v1`,
      defaultModel: modelId,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const models = await fetchProviderModels(connection, 'fireworks-test-key');
    assert.deepEqual(models, [
      {
        id: 'accounts/acme/models/custom-agent',
        displayName: 'Custom Agent',
        capabilities: { functionCalling: true },
      },
      {
        id: 'accounts/acme/models/custom-agent-v2',
        displayName: 'Custom Agent V2',
        capabilities: { functionCalling: true },
      },
      {
        id: 'accounts/team/models/team-agent',
        displayName: 'Team Agent',
        capabilities: { functionCalling: true },
      },
      {
        id: modelId,
        displayName: 'Kimi K2.6',
        contextWindow: 262_000,
        capabilities: { vision: true, functionCalling: true },
      },
    ]);

    const result = await generateText({
      model: getAIModel({ connection, apiKey: 'fireworks-test-key', modelId }),
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

    assert.deepEqual(requestBodies.map((body) => body.model), [modelId, modelId]);
    assert.deepEqual(
      (requestBodies[1]?.messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
      { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'call_echo' },
    );
    assert.equal(result.text, 'Echoed hello.');
  });

  for (const testCase of [
    {
      label: 'complex local model id',
      discoveredModelIds: ['hf.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M'],
      modelId: 'hf.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M',
    },
    {
      label: 'cloud alias distinct from its local model id',
      discoveredModelIds: ['qwen3.5', 'qwen3.5:cloud'],
      modelId: 'qwen3.5:cloud',
    },
  ] as const) {
    test(`Ollama preserves an exact ${testCase.label} through local discovery and a no-secret tool-call loop`, async () => {
      await assertOllamaModelContract(testCase.discoveredModelIds, testCase.modelId);
    });
  }

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

  test('Tencent TokenHub preserves its exact model id through discovery and the documented two-stage tool-call loop', async () => {
    const modelId = 'hy3-preview';
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.headers.authorization, 'Bearer tencent-tokenhub-test-key');
      if (request.method === 'GET' && request.url === '/v1/models') {
        respondJson(response, 200, { object: 'list', data: [{ id: modelId }] });
        return;
      }

      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      requestBodies.push(body);
      if (requestBodies.length === 1) {
        respondJson(response, 200, {
          id: 'chatcmpl-tencent-tool',
          object: 'chat.completion',
          created: 1,
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              reasoning_content: 'I should call echo with the requested text.',
              tool_calls: [{
                id: 'call_tencent_echo',
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
        id: 'chatcmpl-tencent-final',
        object: 'chat.completion',
        created: 2,
        model: modelId,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Echoed hello.' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 14, completion_tokens: 3, total_tokens: 17 },
      });
    });
    const connection: LlmConnection = {
      slug: 'tencent-tokenhub',
      name: 'Tencent TokenHub',
      providerType: 'tencent-tokenhub',
      baseUrl: `${server.url}/v1`,
      defaultModel: modelId,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const models = await fetchProviderModels(connection, 'tencent-tokenhub-test-key');
    assert.deepEqual(models, [{ id: modelId }]);

    const result = await generateText({
      model: getAIModel({ connection, apiKey: 'tencent-tokenhub-test-key', modelId: models[0]!.id }),
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
    assert.equal(result.steps[0]?.reasoningText, 'I should call echo with the requested text.');
    assert.deepEqual(requestBodies.map((body) => body.model), [modelId, modelId]);
    assert.deepEqual(
      (requestBodies[0]?.tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name),
      ['echo'],
    );
    assert.deepEqual(
      (requestBodies[1]?.messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
      { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'call_tencent_echo' },
    );
    assert.deepEqual(
      (requestBodies[1]?.messages as Array<Record<string, unknown>>).find(({ role }) => role === 'assistant'),
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'I should call echo with the requested text.',
        tool_calls: [{
          id: 'call_tencent_echo',
          type: 'function',
          function: { name: 'echo', arguments: '{"text":"hello"}' },
        }],
      },
    );
    assert.equal(result.steps[0]?.toolCalls[0]?.toolName, 'echo');
    assert.deepEqual(result.steps[0]?.toolResults[0]?.output, { echoed: 'hello' });
    assert.equal(result.text, 'Echoed hello.');
  });

  test('Tencent Coding Plan uses fallback models and preserves its exact model id through a two-stage tool-call loop', async () => {
    const modelId = 'glm-5';
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.headers.authorization, 'Bearer tencent-coding-plan-test-key');
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/coding/v3/chat/completions');
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      requestBodies.push(body);
      if (requestBodies.length === 1) {
        respondJson(response, 200, {
          id: 'chatcmpl-tencent-coding-plan-tool',
          object: 'chat.completion',
          created: 1,
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              reasoning_content: 'I should call echo with the requested text.',
              tool_calls: [{
                id: 'call_tencent_coding_plan_echo',
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
        id: 'chatcmpl-tencent-coding-plan-final',
        object: 'chat.completion',
        created: 2,
        model: modelId,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Echoed hello.' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 14, completion_tokens: 3, total_tokens: 17 },
      });
    });
    const connection: LlmConnection = {
      slug: 'tencent-coding-plan',
      name: 'Tencent Coding Plan (China)',
      providerType: 'tencent-coding-plan',
      baseUrl: `${server.url}/coding/v3`,
      defaultModel: modelId,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const models = await fetchProviderModels(connection, 'tencent-coding-plan-test-key');
    assert.deepEqual(models.map(({ id }) => id), [
      'tc-code-latest',
      'glm-5',
      'minimax-m2.5',
      'kimi-k2.5',
    ]);

    const result = await generateText({
      model: getAIModel({ connection, apiKey: 'tencent-coding-plan-test-key', modelId }),
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
    assert.equal(result.steps[0]?.reasoningText, 'I should call echo with the requested text.');
    assert.deepEqual(requestBodies.map((body) => body.model), [modelId, modelId]);
    assert.deepEqual(
      (requestBodies[1]?.messages as Array<Record<string, unknown>>).find(({ role }) => role === 'assistant'),
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'I should call echo with the requested text.',
        tool_calls: [{
          id: 'call_tencent_coding_plan_echo',
          type: 'function',
          function: { name: 'echo', arguments: '{"text":"hello"}' },
        }],
      },
    );
    assert.deepEqual(
      (requestBodies[1]?.messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
      { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'call_tencent_coding_plan_echo' },
    );
    assert.equal(result.steps[0]?.toolCalls[0]?.toolName, 'echo');
    assert.deepEqual(result.steps[0]?.toolResults[0]?.output, { echoed: 'hello' });
    assert.equal(result.text, 'Echoed hello.');
  });

  for (const stepfun of [
    { label: 'StepFun China', providerType: 'stepfun', apiKey: 'stepfun-test-key' },
    { label: 'StepFun Global', providerType: 'stepfun-ai', apiKey: 'stepfun-global-test-key' },
  ] as const) test(`${stepfun.label} preserves its exact model id through discovery and the documented two-stage tool-call loop`, async () => {
    const modelId = 'step-3.7-flash';
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.headers.authorization, `Bearer ${stepfun.apiKey}`);
      if (request.method === 'GET' && request.url === '/v1/models') {
        respondJson(response, 200, { object: 'list', data: [{ id: modelId }] });
        return;
      }

      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      requestBodies.push(body);
      if (requestBodies.length === 1) {
        respondJson(response, 200, {
          id: 'chatcmpl-stepfun-tool',
          object: 'chat.completion',
          created: 1,
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              reasoning: 'I should call echo with the requested text.',
              tool_calls: [{
                id: 'call_stepfun_echo',
                type: 'function',
                function: { name: 'echo', arguments: '{"text":"hello"}' },
              }],
            },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        });
        return;
      }

      respondJson(response, 200, {
        id: 'chatcmpl-stepfun-final',
        object: 'chat.completion',
        created: 2,
        model: modelId,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Echoed hello.' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 14, completion_tokens: 3, total_tokens: 17 },
      });
    });
    const connection: LlmConnection = {
      slug: stepfun.providerType,
      name: stepfun.label,
      providerType: stepfun.providerType,
      baseUrl: `${server.url}/v1`,
      defaultModel: modelId,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const models = await fetchProviderModels(connection, stepfun.apiKey);
    assert.deepEqual(models, [{ id: modelId }]);

    const result = await generateText({
      model: getAIModel({ connection, apiKey: stepfun.apiKey, modelId: models[0]!.id }),
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
    assert.equal(result.steps[0]?.reasoningText, 'I should call echo with the requested text.');
    assert.deepEqual(requestBodies.map((body) => body.model), [modelId, modelId]);
    assert.deepEqual(
      (requestBodies[0]?.tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name),
      ['echo'],
    );
    assert.deepEqual(
      (requestBodies[1]?.messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
      { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'call_stepfun_echo' },
    );
    assert.deepEqual(
      (requestBodies[1]?.messages as Array<Record<string, unknown>>).find(({ role }) => role === 'assistant'),
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'I should call echo with the requested text.',
        tool_calls: [{
          id: 'call_stepfun_echo',
          type: 'function',
          function: { name: 'echo', arguments: '{"text":"hello"}' },
        }],
      },
    );
    assert.equal(result.steps[0]?.toolCalls[0]?.toolName, 'echo');
    assert.deepEqual(result.steps[0]?.toolResults[0]?.output, { echoed: 'hello' });
    assert.equal(result.text, 'Echoed hello.');
  });

  test('Volcengine Ark preserves its snapshot model id through the documented two-stage tool-call loop', async () => {
    const modelId = 'doubao-seed-2-0-pro-260215';
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.headers.authorization, 'Bearer ark-test-key');
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/api/v3/chat/completions');
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      requestBodies.push(body);
      if (requestBodies.length === 1) {
        respondJson(response, 200, {
          id: 'chatcmpl-ark-tool',
          object: 'chat.completion',
          created: 1,
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              reasoning_content: 'I should call echo with the requested text.',
              tool_calls: [{
                id: 'call_ark_echo',
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
        id: 'chatcmpl-ark-final',
        object: 'chat.completion',
        created: 2,
        model: modelId,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Echoed hello.' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 14, completion_tokens: 3, total_tokens: 17 },
      });
    });
    const connection: LlmConnection = {
      slug: 'volcengine-ark',
      name: 'Volcengine Ark (China)',
      providerType: 'volcengine-ark',
      baseUrl: `${server.url}/api/v3`,
      defaultModel: modelId,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const models = await fetchProviderModels(connection, 'ark-test-key');
    assert.deepEqual(models, [{ id: modelId }]);

    const result = await generateText({
      model: getAIModel({ connection, apiKey: 'ark-test-key', modelId: models[0]!.id }),
      prompt: 'Call echo with hello.',
      providerOptions: buildProviderOptions(connection, modelId),
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
    assert.deepEqual(requestBodies[0]?.thinking, { type: 'enabled' });
    assert.equal(result.steps[0]?.reasoningText, 'I should call echo with the requested text.');
    assert.deepEqual(requestBodies.map((body) => body.model), [modelId, modelId]);
    assert.deepEqual(
      (requestBodies[0]?.tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name),
      ['echo'],
    );
    assert.deepEqual(
      (requestBodies[1]?.messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
      { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'call_ark_echo' },
    );
    assert.deepEqual(
      (requestBodies[1]?.messages as Array<Record<string, unknown>>).find(({ role }) => role === 'assistant'),
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'I should call echo with the requested text.',
        tool_calls: [{
          id: 'call_ark_echo',
          type: 'function',
          function: { name: 'echo', arguments: '{"text":"hello"}' },
        }],
      },
    );
    assert.equal(result.steps[0]?.toolCalls[0]?.toolName, 'echo');
    assert.deepEqual(result.steps[0]?.toolResults[0]?.output, { echoed: 'hello' });
    assert.equal(result.text, 'Echoed hello.');
  });
});

async function assertOllamaModelContract(
  discoveredModelIds: readonly string[],
  modelId: string,
): Promise<void> {
  const requestBodies: Array<Record<string, unknown>> = [];
  const server = await startJsonServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/api/tags') {
      assert.equal(request.headers.authorization, undefined);
      respondJson(response, 200, {
        models: discoveredModelIds.map((id) => ({ name: id, model: id })),
      });
      return;
    }
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, undefined);
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

  assert.deepEqual(await fetchProviderModels(connection, ''), discoveredModelIds.map((id) => ({ id })));

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
}

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
