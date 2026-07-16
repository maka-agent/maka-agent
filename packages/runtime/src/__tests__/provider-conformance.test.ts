import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { after, describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core';
import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { fetchProviderModels } from '../model-fetcher.js';
import { buildProviderOptions, getAIModel } from '../model-factory.js';
import { testConnection } from '../test-connection.js';

const servers: Array<{ close(): Promise<void> }> = [];

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

describe('models.dev provider conformance', () => {
  test('GitHub Copilot connection probe validates the selected account model without inference', async () => {
    const server = await startJsonServer((request, response) => {
      assert.equal(request.method, 'GET');
      assert.equal(request.url, '/models');
      assert.equal(request.headers.authorization, 'Bearer github-account-token');
      respondJson(response, 200, {
        data: [{
          id: 'gpt-5.4',
          model_picker_enabled: true,
          supported_endpoints: ['/responses'],
          policy: { state: 'enabled' },
          capabilities: { supports: { tool_calls: true } },
        }],
      });
    });
    const result = await testConnection({
      slug: 'github-copilot',
      name: 'GitHub Copilot',
      providerType: 'github-copilot',
      baseUrl: server.url,
      defaultModel: 'gpt-5.4',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    }, 'github-account-token');

    assert.deepEqual(result, { ok: true, latencyMs: result.latencyMs, modelTested: 'gpt-5.4' });
  });

  test('GitHub Copilot connection probe rejects an account that cannot discover models', async () => {
    const server = await startJsonServer((_request, response) => respondJson(response, 403, {}));
    const result = await testConnection({
      slug: 'github-copilot',
      name: 'GitHub Copilot',
      providerType: 'github-copilot',
      baseUrl: server.url,
      defaultModel: 'gpt-5.4',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    }, 'github-account-token');

    assert.equal(result.ok, false);
  });

  test('OpenAI routes gpt-5* through the Responses wire and other models through Chat Completions by declaration', async () => {
    const requests: string[] = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.authorization, 'Bearer openai-test-key');
      requests.push(request.url ?? '');
      await readBody(request);
      if (request.url === '/v1/responses') {
        respondJson(response, 200, {
          id: 'resp_gpt5',
          object: 'response',
          created_at: 1,
          status: 'completed',
          model: 'gpt-5.5',
          output: [{
            type: 'message',
            id: 'msg_gpt5',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Responses wire.', annotations: [], logprobs: [] }],
          }],
          usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
        });
        return;
      }
      assert.equal(request.url, '/v1/chat/completions');
      respondJson(response, 200, {
        id: 'chatcmpl-gpt4o',
        object: 'chat.completion',
        created: 2,
        model: 'gpt-4o',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Chat wire.' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      });
    });
    const connection: LlmConnection = {
      slug: 'openai',
      name: 'OpenAI',
      providerType: 'openai',
      baseUrl: `${server.url}/v1`,
      defaultModel: 'gpt-5.5',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const gpt5 = await generateText({
      model: getAIModel({ connection, apiKey: 'openai-test-key', modelId: 'gpt-5.5' }),
      prompt: 'Say hi.',
    });
    const gpt4o = await generateText({
      model: getAIModel({ connection, apiKey: 'openai-test-key', modelId: 'gpt-4o' }),
      prompt: 'Say hi.',
    });

    assert.deepEqual(requests, ['/v1/responses', '/v1/chat/completions']);
    assert.equal(gpt5.text, 'Responses wire.');
    assert.equal(gpt4o.text, 'Chat wire.');
  });

  test('OpenCode Go preserves exact discovery ids and reasoning through a two-stage tool loop', async () => {
    const modelId = 'kimi-k2.7-code';
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.headers.authorization, 'Bearer opencode-test-key');
      if (request.method === 'GET' && request.url === '/zen/go/v1/models') {
        respondJson(response, 200, { data: [{ id: modelId }] });
        return;
      }
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/zen/go/v1/chat/completions');
      requestBodies.push(JSON.parse(await readBody(request)) as Record<string, unknown>);
      if (requestBodies.length === 1) {
        respondJson(response, 200, {
          id: 'chatcmpl-opencode-go-tool',
          object: 'chat.completion',
          created: 1,
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              reasoning_content: 'I should call echo and use its result.',
              tool_calls: [{
                id: 'call_opencode_go_echo',
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
        id: 'chatcmpl-opencode-go-final',
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
      slug: 'opencode-go',
      name: 'OpenCode Go',
      providerType: 'opencode-go',
      baseUrl: `${server.url}/zen/go/v1`,
      defaultModel: modelId,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    assert.deepEqual(await fetchProviderModels(connection, 'opencode-test-key'), [{ id: modelId }]);
    const result = await generateText({
      model: getAIModel({ connection, apiKey: 'opencode-test-key', modelId }),
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
    assert.equal(result.steps[0]?.reasoningText, 'I should call echo and use its result.');
    assert.deepEqual(
      (requestBodies[1].messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
      { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'call_opencode_go_echo' },
    );
    assert.equal(result.text, 'Echoed hello.');
  });

  test('OpenCode Zen routes GPT through Responses and preserves tool results across both stages', async () => {
    const modelId = 'gpt-5.5';
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.headers.authorization, 'Bearer opencode-test-key');
      if (request.method === 'GET' && request.url === '/zen/v1/models') {
        respondJson(response, 200, { data: [{ id: modelId }] });
        return;
      }
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/zen/v1/responses');
      requestBodies.push(JSON.parse(await readBody(request)) as Record<string, unknown>);
      if (requestBodies.length === 1) {
        respondJson(response, 200, {
          id: 'resp_opencode_zen_tool',
          object: 'response',
          created_at: 1,
          status: 'completed',
          model: modelId,
          output: [{
            type: 'function_call',
            id: 'fc_opencode_zen_echo',
            call_id: 'call_opencode_zen_echo',
            name: 'echo',
            arguments: '{"text":"hello"}',
            status: 'completed',
          }],
          usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
        });
        return;
      }
      respondJson(response, 200, {
        id: 'resp_opencode_zen_final',
        object: 'response',
        created_at: 2,
        status: 'completed',
        model: modelId,
        output: [{
          type: 'message',
          id: 'msg_opencode_zen_final',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Echoed hello.', annotations: [], logprobs: [] }],
        }],
        usage: { input_tokens: 14, output_tokens: 3, total_tokens: 17 },
      });
    });
    const connection: LlmConnection = {
      slug: 'opencode',
      name: 'OpenCode Zen',
      providerType: 'opencode',
      baseUrl: `${server.url}/zen/v1`,
      defaultModel: modelId,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    assert.deepEqual(await fetchProviderModels(connection, 'opencode-test-key'), [{ id: modelId }]);
    const result = await generateText({
      model: getAIModel({ connection, apiKey: 'opencode-test-key', modelId }),
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
      (requestBodies[1].input as Array<Record<string, unknown>>).find(({ type }) => type === 'function_call_output'),
      { type: 'function_call_output', call_id: 'call_opencode_zen_echo', output: '{"echoed":"hello"}' },
    );
    assert.equal(result.text, 'Echoed hello.');
  });

  test('ZenMux preserves exact model ids and signed reasoning through a two-stage OpenAI Chat tool loop', async () => {
    const modelId = 'moonshotai/kimi-k2.5';
    const reasoningDetails = [{
      type: 'reasoning.text',
      text: 'I should call echo with the requested text.',
      signature: 'deterministic-test-signature',
      format: 'anthropic-claude-v1',
    }];
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer zenmux-test-key');
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      requestBodies.push(body);
      if (requestBodies.length === 1) {
        respondJson(response, 200, {
          id: 'chatcmpl-zenmux-tool',
          object: 'chat.completion',
          created: 1,
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              reasoning: 'I should call echo with the requested text.',
              reasoning_details: reasoningDetails,
              tool_calls: [{
                id: 'call_zenmux_echo',
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
        id: 'chatcmpl-zenmux-final',
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
      slug: 'zenmux',
      name: 'ZenMux',
      providerType: 'zenmux',
      baseUrl: `${server.url}/v1`,
      defaultModel: modelId,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const result = await generateText({
      model: getAIModel({ connection, apiKey: 'zenmux-test-key', modelId }),
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
    assert.equal(result.steps[0]?.reasoningText, 'I should call echo with the requested text.');
    assert.deepEqual(
      (requestBodies[1].messages as Array<Record<string, unknown>>).find(({ role }) => role === 'assistant'),
      {
        role: 'assistant',
        content: null,
        reasoning: 'I should call echo with the requested text.',
        reasoning_details: reasoningDetails,
        tool_calls: [{
          id: 'call_zenmux_echo',
          type: 'function',
          function: { name: 'echo', arguments: '{"text":"hello"}' },
        }],
      },
    );
    assert.deepEqual(
      (requestBodies[1].messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
      { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'call_zenmux_echo' },
    );
    assert.equal(result.text, 'Echoed hello.');
  });

  test('OpenCode connection probes follow each selected model protocol', async () => {
    const requests: Array<{
      url: string;
      headers: IncomingMessage['headers'];
      body: Record<string, unknown>;
    }> = [];
    const server = await startJsonServer(async (request, response) => {
      requests.push({
        url: request.url ?? '',
        headers: request.headers,
        body: JSON.parse(await readBody(request)) as Record<string, unknown>,
      });
      respondJson(response, 200, {});
    });
    const connection: LlmConnection = {
      slug: 'opencode',
      name: 'OpenCode Zen',
      providerType: 'opencode',
      baseUrl: `${server.url}/zen/v1`,
      defaultModel: 'gpt-5.5',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    for (const modelId of ['gpt-5.5', 'claude-opus-4-8', 'gemini-3.5-flash']) {
      assert.equal((await testConnection(connection, 'opencode-test-key', modelId)).ok, true);
    }

    assert.deepEqual(requests.map(({ url }) => url), [
      '/zen/v1/responses',
      '/zen/v1/messages',
      '/zen/v1/models/gemini-3.5-flash:generateContent',
    ]);
    assert.equal(requests[0]?.headers.authorization, 'Bearer opencode-test-key');
    assert.deepEqual(requests[0]?.body.input, [{ role: 'user', content: 'Hi' }]);
    assert.equal(requests[1]?.headers['x-api-key'], 'opencode-test-key');
    assert.deepEqual(requests[1]?.body.messages, [{ role: 'user', content: 'Hi' }]);
    assert.equal(requests[2]?.headers['x-goog-api-key'], 'opencode-test-key');
    assert.deepEqual(requests[2]?.body.contents, [{ role: 'user', parts: [{ text: 'Hi' }] }]);
  });

  test('Vercel Gateway preserves its public discovery boundary and exact model id through a reasoning tool loop', async () => {
    const modelId = 'xai/grok-4.3';
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = await startJsonServer(async (request, response) => {
      if (request.method === 'GET' && request.url === '/v1/models') {
        assert.equal(request.headers.authorization, undefined);
        respondJson(response, 200, {
          object: 'list',
          data: [{
            id: modelId,
            name: 'Grok 4.3',
            type: 'language',
            tags: ['reasoning', 'tool-use'],
            context_window: 1_000_000,
            max_tokens: 1_000_000,
          }],
        });
        return;
      }

      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer vercel-test-key');
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      requestBodies.push(body);
      if (requestBodies.length === 1) {
        respondJson(response, 200, {
          id: 'chatcmpl-vercel-tool',
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
                id: 'call_vercel_echo',
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
        id: 'chatcmpl-vercel-final',
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
      slug: 'vercel',
      name: 'Vercel AI Gateway',
      providerType: 'vercel',
      baseUrl: `${server.url}/v1`,
      defaultModel: modelId,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const models = await fetchProviderModels(connection, 'vercel-test-key');
    assert.deepEqual(models, [{
      id: modelId,
      displayName: 'Grok 4.3',
      contextWindow: 1_000_000,
      maxOutputTokens: 1_000_000,
      capabilities: { reasoning: true, functionCalling: true },
    }]);

    const result = await generateText({
      model: getAIModel({ connection, apiKey: 'vercel-test-key', modelId }),
      prompt: 'Call echo with hello.',
      providerOptions: buildProviderOptions(connection, modelId, 'high') as Record<string, Record<string, string>>,
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
    assert.equal(requestBodies[0]?.reasoning_effort, 'high');
    assert.equal(result.steps[0]?.reasoningText, 'I should call echo with the requested text.');
    assert.deepEqual(
      (requestBodies[1].messages as Array<Record<string, unknown>>).find(({ role }) => role === 'assistant'),
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'I should call echo with the requested text.',
        tool_calls: [{
          id: 'call_vercel_echo',
          type: 'function',
          function: { name: 'echo', arguments: '{"text":"hello"}' },
        }],
      },
    );
    assert.deepEqual(
      (requestBodies[1].messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
      { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'call_vercel_echo' },
    );
    assert.equal(result.text, 'Echoed hello.');
  });

  test('Ollama Cloud authenticates discovery and preserves exact ids and reasoning through a tool loop', async () => {
    const modelId = 'qwen3.5:397b';
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.headers.authorization, 'Bearer ollama-cloud-test-key');
      if (request.method === 'GET' && request.url === '/v1/models') {
        respondJson(response, 200, {
          object: 'list',
          data: [{ id: modelId }, { id: 'gpt-oss:120b' }],
        });
        return;
      }

      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      requestBodies.push(body);
      if (requestBodies.length === 1) {
        respondJson(response, 200, {
          id: 'chatcmpl-ollama-cloud-tool',
          object: 'chat.completion',
          created: 1,
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              reasoning: 'I should call echo with the requested text.',
              tool_calls: [{
                id: 'call_ollama_cloud_echo',
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
        id: 'chatcmpl-ollama-cloud-final',
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
      slug: 'ollama-cloud',
      name: 'Ollama Cloud',
      providerType: 'ollama-cloud',
      baseUrl: `${server.url}/v1`,
      defaultModel: modelId,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    assert.deepEqual(await fetchProviderModels(connection, 'ollama-cloud-test-key'), [
      { id: modelId },
      { id: 'gpt-oss:120b' },
    ]);

    const result = await generateText({
      model: getAIModel({ connection, apiKey: 'ollama-cloud-test-key', modelId }),
      prompt: 'Call echo with hello.',
      providerOptions: buildProviderOptions(connection, modelId, 'high'),
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
    assert.equal(requestBodies[0]?.reasoning_effort, 'high');
    assert.equal(result.steps[0]?.reasoningText, 'I should call echo with the requested text.');
    assert.deepEqual(
      (requestBodies[1].messages as Array<Record<string, unknown>>).find(({ role }) => role === 'assistant'),
      {
        role: 'assistant',
        content: null,
        reasoning: 'I should call echo with the requested text.',
        tool_calls: [{
          id: 'call_ollama_cloud_echo',
          type: 'function',
          function: { name: 'echo', arguments: '{"text":"hello"}' },
        }],
      },
    );
    assert.deepEqual(
      (requestBodies[1].messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
      { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'call_ollama_cloud_echo' },
    );
    assert.equal(result.text, 'Echoed hello.');
  });

  test('LocalAI preserves a configured llama.cpp Qwen3 alias and reasoning through a two-stage tool-call loop', async () => {
    const modelId = 'localai/Qwen3-8B-Instruct-GGUF:Q4_K_M';
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
          id: 'chatcmpl-localai-tool',
          object: 'chat.completion',
          created: 1,
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              reasoning_content: 'I should call echo and use its result.',
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
        id: 'chatcmpl-localai-final',
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
      slug: 'localai',
      name: 'LocalAI',
      providerType: 'localai',
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
    const secondMessages = requestBodies[1]?.messages as Array<{
      role: string;
      content: unknown;
      reasoning_content?: string;
    }>;
    const assistant = secondMessages.find((message) => message.role === 'assistant');
    assert.equal(assistant?.reasoning_content, 'I should call echo and use its result.');
    assert.equal(secondMessages.some((message) => message.role === 'tool'), true);
    assert.equal(JSON.stringify(secondMessages).includes('hello'), true);
    assert.equal(result.text, 'Echo returned hello.');
  });

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
      (requestBodies[0].tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name),
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
      (requestBodies[0].tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name),
      ['echo'],
    );
    assert.deepEqual(
      (requestBodies[1].messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
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
      (requestBodies[0].tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name),
      ['echo'],
    );
    assert.deepEqual(
      (requestBodies[1].messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
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
      (requestBody.tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name),
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
      (requestBody.tools as Array<{ name: string }>).map((entry) => entry.name),
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
      (requestBodies[0].tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name),
      ['echo'],
    );
    assert.deepEqual(
      (requestBodies[1].messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
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
      (requestBodies[0].tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name),
      ['echo'],
    );
    assert.deepEqual(
      (requestBodies[1].messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
      { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'call_echo' },
    );
    assert.equal(result.steps[0]?.toolCalls[0]?.toolName, 'echo');
    assert.deepEqual(result.steps[0]?.toolResults[0]?.output, { echoed: 'hello' });
    assert.equal(result.text, 'Echoed hello.');
  });

  test('DeepInfra discovers exact model ids and completes its documented two-stage tool-call loop', async () => {
    const modelId = 'moonshotai/Kimi-K2.7-Code';
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.headers.authorization, 'Bearer deepinfra-test-key');
      if (request.method === 'GET' && request.url === '/v1/models') {
        respondJson(response, 200, {
          object: 'list',
          data: [
            { id: modelId, object: 'model', owned_by: 'moonshotai' },
            { id: 'BAAI/bge-m3', object: 'model', owned_by: 'BAAI' },
          ],
        });
        return;
      }
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/openai/chat/completions');
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      requestBodies.push(body);
      const messages = body.messages as Array<{ role: string }>;
      if (messages.some(({ role }) => role === 'tool')) {
        respondJson(response, 200, {
          id: 'chatcmpl-deepinfra-final',
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
        id: 'chatcmpl-deepinfra-tool',
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
      slug: 'deepinfra',
      name: 'Deep Infra',
      providerType: 'deepinfra',
      baseUrl: `${server.url}/v1/openai`,
      defaultModel: modelId,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const models = await fetchProviderModels(connection, 'deepinfra-test-key');
    assert.deepEqual(models, [{ id: modelId }]);

    const result = await generateText({
      model: getAIModel({ connection, apiKey: 'deepinfra-test-key', modelId: models[0]!.id }),
      providerOptions: buildProviderOptions(connection, modelId, 'high'),
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
    assert.deepEqual(requestBodies.map((body) => body.reasoning_effort), ['high', 'high']);
    assert.deepEqual(
      (requestBodies[0].tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name),
      ['echo'],
    );
    assert.deepEqual(
      (requestBodies[1].messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
      { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'call_echo' },
    );
    assert.equal(result.steps[0]?.toolCalls[0]?.toolName, 'echo');
    assert.deepEqual(result.steps[0]?.toolCalls[0]?.input, { text: 'hello' });
    assert.deepEqual(result.steps[0]?.toolResults[0]?.output, { echoed: 'hello' });
    assert.equal(result.text, 'Echoed hello.');
  });

  test('Groq discovers exact model ids and completes its documented two-stage tool-call loop', async () => {
    const modelId = 'openai/gpt-oss-120b';
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.headers.authorization, 'Bearer groq-test-key');
      if (request.method === 'GET' && request.url === '/openai/v1/models') {
        respondJson(response, 200, {
          object: 'list',
          data: [
            { id: modelId, object: 'model', owned_by: 'openai' },
            { id: 'whisper-large-v3', object: 'model', owned_by: 'openai' },
          ],
        });
        return;
      }
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/openai/v1/chat/completions');
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      requestBodies.push(body);
      const messages = body.messages as Array<{ role: string }>;
      if (messages.some(({ role }) => role === 'tool')) {
        respondJson(response, 200, {
          id: 'chatcmpl-groq-final',
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
        id: 'chatcmpl-groq-tool',
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
      slug: 'groq',
      name: 'Groq',
      providerType: 'groq',
      baseUrl: `${server.url}/openai/v1`,
      defaultModel: modelId,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const models = await fetchProviderModels(connection, 'groq-test-key');
    assert.deepEqual(models, [{ id: modelId }]);

    const result = await generateText({
      model: getAIModel({ connection, apiKey: 'groq-test-key', modelId: models[0]!.id }),
      providerOptions: buildProviderOptions(connection, modelId, 'high'),
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
    assert.deepEqual(requestBodies.map((body) => body.reasoning_effort), ['high', 'high']);
    assert.deepEqual(
      (requestBodies[0].tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name),
      ['echo'],
    );
    assert.deepEqual(
      (requestBodies[1].messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
      { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'call_echo' },
    );
    assert.equal(result.steps[0]?.toolCalls[0]?.toolName, 'echo');
    assert.deepEqual(result.steps[0]?.toolCalls[0]?.input, { text: 'hello' });
    assert.deepEqual(result.steps[0]?.toolResults[0]?.output, { echoed: 'hello' });
    assert.equal(result.text, 'Echoed hello.');
  });

  test('OpenRouter discovers exact model ids and completes its documented two-stage tool-call loop', async () => {
    const modelId = 'anthropic/claude-sonnet-5';
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.headers.authorization, 'Bearer openrouter-test-key');
      if (request.method === 'GET' && request.url === '/api/v1/models') {
        respondJson(response, 200, {
          object: 'list',
          data: [
            { id: modelId, object: 'model', owned_by: 'anthropic' },
            { id: 'openrouter-test/non-fallback', object: 'model', owned_by: 'openrouter-test' },
          ],
        });
        return;
      }
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/api/v1/chat/completions');
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      requestBodies.push(body);
      const messages = body.messages as Array<{ role: string }>;
      if (messages.some(({ role }) => role === 'tool')) {
        respondJson(response, 200, {
          id: 'chatcmpl-openrouter-final',
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
        id: 'chatcmpl-openrouter-tool',
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
      slug: 'openrouter',
      name: 'OpenRouter',
      providerType: 'openrouter',
      baseUrl: `${server.url}/api/v1`,
      defaultModel: modelId,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const models = await fetchProviderModels(connection, 'openrouter-test-key');
    assert.deepEqual(models, [{ id: modelId }]);

    const result = await generateText({
      model: getAIModel({ connection, apiKey: 'openrouter-test-key', modelId: models[0]!.id }),
      providerOptions: buildProviderOptions(connection, modelId, 'high'),
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
    assert.deepEqual(requestBodies.map((body) => body.reasoning_effort), ['high', 'high']);
    assert.deepEqual(
      (requestBodies[0].tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name),
      ['echo'],
    );
    assert.deepEqual(
      (requestBodies[1].messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
      { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'call_echo' },
    );
    assert.equal(result.steps[0]?.toolCalls[0]?.toolName, 'echo');
    assert.deepEqual(result.steps[0]?.toolCalls[0]?.input, { text: 'hello' });
    assert.deepEqual(result.steps[0]?.toolResults[0]?.output, { echoed: 'hello' });
    assert.equal(result.text, 'Echoed hello.');
  });

  test('Cloudflare Workers AI uses snapshot models and completes its documented two-stage tool-call loop', async () => {
    const modelId = '@cf/moonshotai/kimi-k2.6';
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.headers.authorization, 'Bearer cloudflare-workers-ai-test-token');
      assert.equal(request.method, 'POST');
      assert.equal(
        request.url,
        '/client/v4/accounts/account-123/ai/v1/chat/completions',
      );
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      requestBodies.push(body);
      const messages = body.messages as Array<{ role: string }>;
      if (messages.some(({ role }) => role === 'tool')) {
        respondJson(response, 200, {
          id: 'chatcmpl-cloudflare-final',
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
        id: 'chatcmpl-cloudflare-tool',
        object: 'chat.completion',
        created: 1,
        model: modelId,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            reasoning: 'I should call echo and use its result.',
            tool_calls: [{
              id: 'call_cloudflare_echo',
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
      slug: 'cloudflare-workers-ai',
      name: 'Cloudflare Workers AI',
      providerType: 'cloudflare-workers-ai',
      baseUrl: `${server.url}/client/v4/accounts/account-123/ai/v1`,
      defaultModel: modelId,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const models = await fetchProviderModels(
      connection,
      'cloudflare-workers-ai-test-token',
    );
    assert.equal(requestBodies.length, 0, 'snapshot fallback must not invent a discovery request');
    assert.equal(models[0]?.id, modelId);
    assert.ok(models.every((model) => model.id.startsWith('@cf/')));

    const result = await generateText({
      model: getAIModel({
        connection,
        apiKey: 'cloudflare-workers-ai-test-token',
        modelId,
      }),
      providerOptions: buildProviderOptions(connection, modelId, 'high'),
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
    assert.deepEqual(requestBodies.map((body) => body.reasoning_effort), ['high', 'high']);
    assert.deepEqual(
      (requestBodies[0].tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name),
      ['echo'],
    );
    const secondMessages = requestBodies[1]?.messages as Array<{
      role: string;
      content: string | null;
      reasoning?: string;
      reasoning_content?: string;
    }>;
    const assistantMessage = secondMessages.find(({ role }) => role === 'assistant');
    assert.equal(assistantMessage?.reasoning, 'I should call echo and use its result.');
    assert.equal(assistantMessage?.reasoning_content, undefined);
    assert.deepEqual(
      secondMessages.find(({ role }) => role === 'tool'),
      {
        role: 'tool',
        content: '{"echoed":"hello"}',
        tool_call_id: 'call_cloudflare_echo',
      },
    );
    assert.equal(result.steps[0]?.toolCalls[0]?.toolName, 'echo');
    assert.deepEqual(result.steps[0]?.toolResults[0]?.output, { echoed: 'hello' });
    assert.equal(result.text, 'Echoed hello.');
  });

  test('Hugging Face discovers tool-capable routed models and preserves its two-stage OpenAI wire', async () => {
    const discoveredModelId = 'openai/gpt-oss-120b';
    const modelId = `${discoveredModelId}:preferred`;
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.headers.authorization, 'Bearer hf-test-token');
      if (request.method === 'GET' && request.url === '/v1/models') {
        respondJson(response, 200, {
          object: 'list',
          data: [
            {
              id: discoveredModelId,
              object: 'model',
              owned_by: 'openai',
              providers: [{ provider: 'together', status: 'live', supports_tools: true }],
            },
            {
              id: 'sentence-transformers/all-MiniLM-L6-v2',
              object: 'model',
              owned_by: 'sentence-transformers',
              providers: [{ provider: 'hf-inference', status: 'live', supports_tools: false }],
            },
          ],
        });
        return;
      }

      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      requestBodies.push(body);
      if (requestBodies.length === 1) {
        respondJson(response, 200, {
          id: 'chatcmpl-hf-tool',
          object: 'chat.completion',
          created: 1,
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              reasoning_content: 'I should call echo and use its result.',
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
        id: 'chatcmpl-hf-final',
        object: 'chat.completion',
        created: 2,
        model: modelId,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Echoed hello.' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 14, completion_tokens: 5, total_tokens: 19 },
      });
    });
    const connection: LlmConnection = {
      slug: 'huggingface',
      name: 'Hugging Face',
      providerType: 'huggingface',
      baseUrl: `${server.url}/v1`,
      defaultModel: modelId,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const models = await fetchProviderModels(connection, 'hf-test-token');
    assert.deepEqual(models, [{ id: discoveredModelId, capabilities: { functionCalling: true } }]);

    const result = await generateText({
      model: getAIModel({ connection, apiKey: 'hf-test-token', modelId }),
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
    const secondMessages = requestBodies[1]?.messages as Array<{
      role: string;
      content: unknown;
      reasoning_content?: string;
    }>;
    assert.equal(
      secondMessages.find(({ role }) => role === 'assistant')?.reasoning_content,
      'I should call echo and use its result.',
    );
    assert.deepEqual(
      secondMessages.find(({ role }) => role === 'tool'),
      { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'call_echo' },
    );
    assert.equal(result.steps[0]?.toolCalls[0]?.toolName, 'echo');
    assert.deepEqual(result.steps[0]?.toolResults[0]?.output, { echoed: 'hello' });
    assert.equal(result.text, 'Echoed hello.');
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
      (requestBodies[0].tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name),
      ['echo'],
    );
    assert.deepEqual(
      (requestBodies[1].messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
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
      (requestBodies[0].tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name),
      ['echo'],
    );
    assert.deepEqual(
      (requestBodies[1].messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
      { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'call_tencent_echo' },
    );
    assert.deepEqual(
      (requestBodies[1].messages as Array<Record<string, unknown>>).find(({ role }) => role === 'assistant'),
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
      (requestBodies[1].messages as Array<Record<string, unknown>>).find(({ role }) => role === 'assistant'),
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
      (requestBodies[1].messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
      { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'call_tencent_coding_plan_echo' },
    );
    assert.equal(result.steps[0]?.toolCalls[0]?.toolName, 'echo');
    assert.deepEqual(result.steps[0]?.toolResults[0]?.output, { echoed: 'hello' });
    assert.equal(result.text, 'Echoed hello.');
  });

  test('Volcengine Ark Coding Plan preserves fallback model reasoning through a two-stage tool-call loop', async () => {
    const modelId = 'glm-5.2';
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.headers.authorization, 'Bearer volcengine-coding-plan-test-key');
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/api/coding/v3/chat/completions');
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      requestBodies.push(body);
      if (requestBodies.length === 1) {
        respondJson(response, 200, {
          id: 'chatcmpl-volcengine-coding-plan-tool',
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
                id: 'call_volcengine_coding_plan_echo',
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
        id: 'chatcmpl-volcengine-coding-plan-final',
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
      slug: 'volcengine-coding-plan',
      name: 'Volcengine Ark Coding Plan (China)',
      providerType: 'volcengine-coding-plan',
      baseUrl: `${server.url}/api/coding/v3`,
      defaultModel: modelId,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const models = await fetchProviderModels(connection, 'volcengine-coding-plan-test-key');
    assert.deepEqual(models.map(({ id }) => id), [
      'ark-code-latest',
      'doubao-seed-2.0-code',
      'doubao-seed-2.0-pro',
      'doubao-seed-2.0-lite',
      'doubao-seed-code',
      'minimax-m2.7',
      'minimax-m3',
      'glm-5.2',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'kimi-k2.6',
      'kimi-k2.7-code',
    ]);

    const result = await generateText({
      model: getAIModel({ connection, apiKey: 'volcengine-coding-plan-test-key', modelId }),
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
      (requestBodies[1].messages as Array<Record<string, unknown>>).find(({ role }) => role === 'assistant'),
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'I should call echo with the requested text.',
        tool_calls: [{
          id: 'call_volcengine_coding_plan_echo',
          type: 'function',
          function: { name: 'echo', arguments: '{"text":"hello"}' },
        }],
      },
    );
    assert.deepEqual(
      (requestBodies[1].messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
      { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'call_volcengine_coding_plan_echo' },
    );
    assert.equal(result.steps[0]?.toolCalls[0]?.toolName, 'echo');
    assert.deepEqual(result.steps[0]?.toolResults[0]?.output, { echoed: 'hello' });
    assert.equal(result.text, 'Echoed hello.');
  });

  test('Tencent Token Plan uses its official snapshot and preserves the exact model id through a two-stage tool-call loop', async () => {
    const modelId = 'hy3';
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.headers.authorization, 'Bearer tencent-token-plan-test-key');
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/plan/v3/chat/completions');
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      requestBodies.push(body);
      if (requestBodies.length === 1) {
        respondJson(response, 200, {
          id: 'chatcmpl-tencent-token-plan-tool',
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
                id: 'call_tencent_token_plan_echo',
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
        id: 'chatcmpl-tencent-token-plan-final',
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
      slug: 'tencent-token-plan',
      name: 'Tencent Token Plan',
      providerType: 'tencent-token-plan',
      baseUrl: `${server.url}/plan/v3`,
      defaultModel: modelId,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const models = await fetchProviderModels(connection, 'tencent-token-plan-test-key');
    assert.deepEqual(models.map(({ id }) => id), [
      'tc-code-latest',
      'deepseek-v4-flash-202605',
      'deepseek-v4-pro-202606',
      'minimax-m2.5',
      'minimax-m2.7',
      'glm-5',
      'glm-5.1',
      'kimi-k2.5',
      'hy3',
      'hy3-preview',
    ]);

    const result = await generateText({
      model: getAIModel({ connection, apiKey: 'tencent-token-plan-test-key', modelId }),
      prompt: 'Call echo with hello.',
      providerOptions: buildProviderOptions(connection, modelId, 'high') as Record<string, Record<string, string>>,
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
    assert.equal(requestBodies[0]?.reasoning_effort, 'high');
    assert.equal(result.steps[0]?.reasoningText, 'I should call echo with the requested text.');
    assert.deepEqual(requestBodies.map((body) => body.model), [modelId, modelId]);
    assert.deepEqual(
      (requestBodies[1].messages as Array<Record<string, unknown>>).find(({ role }) => role === 'assistant'),
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'I should call echo with the requested text.',
        tool_calls: [{
          id: 'call_tencent_token_plan_echo',
          type: 'function',
          function: { name: 'echo', arguments: '{"text":"hello"}' },
        }],
      },
    );
    assert.deepEqual(
      (requestBodies[1].messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
      { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'call_tencent_token_plan_echo' },
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
      (requestBodies[0].tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name),
      ['echo'],
    );
    assert.deepEqual(
      (requestBodies[1].messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
      { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'call_stepfun_echo' },
    );
    assert.deepEqual(
      (requestBodies[1].messages as Array<Record<string, unknown>>).find(({ role }) => role === 'assistant'),
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

  for (const stepfunPlan of [
    {
      label: 'China',
      providerType: 'stepfun-step-plan',
      name: 'StepFun Step Plan (China)',
      apiKey: 'stepfun-step-plan-test-key',
      models: ['step-3.7-flash', 'step-3.5-flash-2603', 'step-3.5-flash', 'step-router-v1'],
    },
    {
      label: 'Global',
      providerType: 'stepfun-ai-step-plan',
      name: 'StepFun Step Plan (Global)',
      apiKey: 'stepfun-global-step-plan-test-key',
      models: ['step-3.7-flash', 'step-3.5-flash-2603', 'step-3.5-flash'],
    },
  ] as const) test(`StepFun Step Plan ${stepfunPlan.label} preserves its snapshot model through the documented two-stage tool-call loop`, async () => {
    const modelId = 'step-3.7-flash';
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.headers.authorization, `Bearer ${stepfunPlan.apiKey}`);
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/step_plan/v1/chat/completions');
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      requestBodies.push(body);
      if (requestBodies.length === 1) {
        respondJson(response, 200, {
          id: 'chatcmpl-stepfun-step-plan-tool',
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
                id: 'call_stepfun_step_plan_echo',
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
        id: 'chatcmpl-stepfun-step-plan-final',
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
      slug: stepfunPlan.providerType,
      name: stepfunPlan.name,
      providerType: stepfunPlan.providerType,
      baseUrl: `${server.url}/step_plan/v1`,
      defaultModel: modelId,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const models = await fetchProviderModels(connection, stepfunPlan.apiKey);
    assert.deepEqual(models.map((model) => model.id), [...stepfunPlan.models]);

    const result = await generateText({
      model: getAIModel({ connection, apiKey: stepfunPlan.apiKey, modelId: models[0]!.id }),
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

    assert.equal(requestBodies.length, 2, 'snapshot discovery must not call an undocumented /models endpoint');
    assert.equal(result.steps[0]?.reasoningText, 'I should call echo with the requested text.');
    assert.deepEqual(requestBodies.map((body) => body.model), [modelId, modelId]);
    assert.deepEqual(
      (requestBodies[1].messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
      { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'call_stepfun_step_plan_echo' },
    );
    assert.deepEqual(
      (requestBodies[1].messages as Array<Record<string, unknown>>).find(({ role }) => role === 'assistant'),
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'I should call echo with the requested text.',
        tool_calls: [{
          id: 'call_stepfun_step_plan_echo',
          type: 'function',
          function: { name: 'echo', arguments: '{"text":"hello"}' },
        }],
      },
    );
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
      (requestBodies[0].tools as Array<{ function: { name: string } }>).map((entry) => entry.function.name),
      ['echo'],
    );
    assert.deepEqual(
      (requestBodies[1].messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
      { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'call_ark_echo' },
    );
    assert.deepEqual(
      (requestBodies[1].messages as Array<Record<string, unknown>>).find(({ role }) => role === 'assistant'),
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

  for (const provider of [
    { type: 'xiaomi', label: 'Xiaomi', modelId: 'mimo-v2.5', basePath: '/v1', apiKey: 'xiaomi-test-key' },
    { type: 'zai', label: 'Z.AI', modelId: 'glm-5.2', basePath: '/api/paas/v4', apiKey: 'zai-test-key' },
  ] as const) {
    test(`${provider.label} discovers exact account model ids and completes a tool-call loop`, async () => {
      const requestBodies: Array<Record<string, unknown>> = [];
      const server = await startJsonServer(async (request, response) => {
        assert.equal(request.headers.authorization, `Bearer ${provider.apiKey}`);
        if (request.method === 'GET' && request.url === `${provider.basePath}/models`) {
          respondJson(response, 200, {
            object: 'list',
            data: [{ id: provider.modelId, object: 'model', owned_by: provider.type }],
          });
          return;
        }

        assert.equal(request.method, 'POST');
        assert.equal(request.url, `${provider.basePath}/chat/completions`);
        requestBodies.push(JSON.parse(await readBody(request)) as Record<string, unknown>);
        if (requestBodies.length === 1) {
          respondJson(response, 200, {
            id: `chatcmpl-${provider.type}-tool`,
            object: 'chat.completion',
            created: 1,
            model: provider.modelId,
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
          id: `chatcmpl-${provider.type}-final`,
          object: 'chat.completion',
          created: 2,
          model: provider.modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Echoed hello.' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
        });
      });
      const connection: LlmConnection = {
        slug: provider.type,
        name: provider.label,
        providerType: provider.type,
        baseUrl: `${server.url}${provider.basePath}`,
        defaultModel: provider.modelId,
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      };

      assert.deepEqual(await fetchProviderModels(connection, provider.apiKey), [{ id: provider.modelId }]);

      const result = await generateText({
        model: getAIModel({ connection, apiKey: provider.apiKey, modelId: provider.modelId }),
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

      assert.deepEqual(requestBodies.map((body) => body.model), [provider.modelId, provider.modelId]);
      assert.deepEqual(
        (requestBodies[1].messages as Array<{ role: string; content: string }>).find(({ role }) => role === 'tool'),
        { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'call_echo' },
      );
      assert.deepEqual(result.steps[0]?.toolResults[0]?.output, { echoed: 'hello' });
      assert.equal(result.text, 'Echoed hello.');
    });
  }
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
