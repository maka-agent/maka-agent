import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { after, describe, test } from 'node:test';
import type { LlmConnection, SessionEvent, SessionHeader } from '@maka/core';

import { AiSdkBackend } from '../ai-sdk-backend.js';
import {
  buildComputerUseTools,
  type CuDispatchBackend,
  type CuObservation,
} from '../computer-use-tools.js';
import { buildProviderOptions, getAIModel } from '../model-factory.js';
import { PermissionEngine } from '../permission-engine.js';

const servers: Array<{ close(): Promise<void> }> = [];

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

describe('Anthropic-compatible Computer Use product loops', () => {
  for (const provider of [
    {
      providerType: 'kimi-coding-plan',
      modelId: 'kimi-for-coding',
      baseSuffix: '/coding',
      expectedPath: '/coding/v1/messages',
      auth: 'x-api-key',
      expectedAuth: 'test-key',
      expectedThinking: 'enabled',
      expectedWireOutputLimit: 32_768,
      apiProtocol: undefined,
    },
    {
      providerType: 'kimi-coding-plan',
      modelId: 'k3',
      baseSuffix: '/coding',
      expectedPath: '/coding/v1/messages',
      auth: 'x-api-key',
      expectedAuth: 'test-key',
      expectedThinking: 'adaptive',
      expectedWireOutputLimit: 131_072,
      apiProtocol: undefined,
    },
    {
      providerType: 'minimax-coding-plan',
      modelId: 'MiniMax-M3',
      baseSuffix: '/anthropic',
      expectedPath: '/anthropic/v1/messages',
      auth: 'x-api-key',
      expectedAuth: 'test-key',
      expectedThinking: undefined,
      expectedWireOutputLimit: 128_000,
      apiProtocol: undefined,
    },
    {
      providerType: 'github-copilot',
      modelId: 'future-claude-model',
      baseSuffix: '/copilot',
      expectedPath: '/copilot/v1/messages',
      auth: 'authorization',
      expectedAuth: 'Bearer test-key',
      expectedThinking: undefined,
      expectedWireOutputLimit: 128_000,
      apiProtocol: 'anthropic-messages',
    },
  ] as const) {
    test(`${provider.providerType}/${provider.modelId} completes a multi-step semantic model loop`, async () => {
      const requestBodies: Array<Record<string, unknown>> = [];
      const server = await startJsonServer(async (request, response) => {
        assert.equal(request.method, 'POST');
        assert.equal(request.url, provider.expectedPath);
        assert.equal(request.headers[provider.auth], provider.expectedAuth);
        const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
        assert.equal(body.model, provider.modelId);
        requestBodies.push(body);
        const step = requestBodies.length;
        const toolInput =
          step === 1
            ? { action: 'list_apps' }
            : step === 2
              ? {
                  action: 'observe',
                  app: 'pid:42',
                  window_id: 7,
                  include_screenshot: false,
                }
              : step === 3
                ? semanticInputFromMessages(body.messages)
                : undefined;
        respondAnthropicStream(response, provider.modelId, step, toolInput);
      });
      const value = { current: '' };
      const [computerTool] = buildComputerUseTools({
        backend: fakeSemanticBackend(value),
      });
      const events: SessionEvent[] = [];
      const toolResults: Array<{ isError: boolean }> = [];
      const providerConnection = connection(
        provider.providerType,
        `${server.url}${provider.baseSuffix}`,
        provider.modelId,
        provider.apiProtocol,
        provider.expectedWireOutputLimit,
      );
      const runtime = new AiSdkBackend({
        sessionId: `session-${provider.providerType}`,
        header: header(provider.providerType, provider.modelId),
        appendMessage: async () => {},
        connection: providerConnection,
        apiKey: 'test-key',
        modelId: provider.modelId,
        permissionEngine: new PermissionEngine({
          newId: () => 'permission-id',
          now: () => 1,
        }),
        modelFactory: (input) => getAIModel(input),
        providerOptions: buildProviderOptions(providerConnection, provider.modelId),
        tools: [computerTool],
        maxSteps: 6,
        newId: idGenerator(),
        now: monotonicClock(),
      });

      for await (const event of runtime.send({
        turnId: 'turn-1',
        text: 'Set the fixture field to provider-loop.',
        context: [],
      })) {
        events.push(event);
        if (event.type === 'tool_result') {
          toolResults.push({ isError: event.isError });
        }
      }

      assert.equal(
        value.current,
        'provider-loop',
        JSON.stringify({
          requestCount: requestBodies.length,
          eventTypes: events.map((event) => event.type),
          toolResults,
        }),
      );
      assert.equal(events.at(-1)?.type, 'complete');
      assert.equal(requestBodies.length, 4);
      assert.deepEqual(toolResults, [{ isError: false }, { isError: false }, { isError: false }]);
      assert.deepEqual(
        (requestBodies[0].tools as Array<{ name: string }>).map((tool) => tool.name),
        ['maka_computer'],
      );
      if (provider.expectedThinking) {
        for (const body of requestBodies) {
          assert.equal(
            (body.thinking as { type?: string } | undefined)?.type,
            provider.expectedThinking,
            'Kimi Coding Plan must send its model-specific thinking mode on every turn',
          );
          assert.deepEqual(body.output_config, { effort: 'max' });
        }
      }
      for (const body of requestBodies) {
        assert.equal(
          body.max_tokens,
          provider.expectedWireOutputLimit,
          'Anthropic-compatible requests must honor their model wire output limit',
        );
      }
      assert.ok(
        containsToolResult(requestBodies[3]?.messages, 'toolu-3'),
        'final semantic tool result must be reinjected into the closing provider request',
      );
      const finalObservations = collectJsonObjects(requestBodies[3]?.messages);
      assert.ok(
        finalObservations.some(
          (entry) =>
            Array.isArray(entry.elements) &&
            entry.elements.some(
              (element) => (element as Record<string, unknown>).value === 'provider-loop',
            ),
        ),
        'final provider request must contain the post-action observation',
      );
    });

    test(`${provider.providerType}/${provider.modelId} reinjects a failed semantic action as an error tool result`, async () => {
      const requestBodies: Array<Record<string, unknown>> = [];
      const server = await startJsonServer(async (request, response) => {
        assert.equal(request.method, 'POST');
        assert.equal(request.url, provider.expectedPath);
        assert.equal(request.headers[provider.auth], provider.expectedAuth);
        const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
        assert.equal(body.model, provider.modelId);
        requestBodies.push(body);
        const step = requestBodies.length;
        const toolInput =
          step === 1
            ? {
                action: 'observe',
                app: 'pid:42',
                window_id: 7,
                include_screenshot: false,
              }
            : step === 2
              ? semanticInputFromMessages(body.messages)
              : undefined;
        respondAnthropicStream(response, provider.modelId, step, toolInput);
      });
      const value = { current: 'unchanged' };
      const [computerTool] = buildComputerUseTools({
        backend: failingSemanticBackend(value),
      });
      const events: SessionEvent[] = [];
      const runtime = new AiSdkBackend({
        sessionId: `session-${provider.providerType}-failure`,
        header: header(provider.providerType, provider.modelId),
        appendMessage: async () => {},
        connection: connection(
          provider.providerType,
          `${server.url}${provider.baseSuffix}`,
          provider.modelId,
          provider.apiProtocol,
          provider.expectedWireOutputLimit,
        ),
        apiKey: 'test-key',
        modelId: provider.modelId,
        permissionEngine: new PermissionEngine({
          newId: () => 'permission-id',
          now: () => 1,
        }),
        modelFactory: (input) => getAIModel(input),
        tools: [computerTool],
        maxSteps: 4,
        newId: idGenerator(),
        now: monotonicClock(),
      });

      for await (const event of runtime.send({
        turnId: 'turn-failure',
        text: 'Attempt to update the fixture field.',
        context: [],
      })) {
        events.push(event);
      }

      const toolResults = events.filter(
        (event): event is Extract<SessionEvent, { type: 'tool_result' }> =>
          event.type === 'tool_result',
      );
      assert.equal(requestBodies.length, 3);
      assert.equal(events.at(-1)?.type, 'complete');
      assert.equal(
        events.some((event) => event.type === 'error'),
        false,
      );
      assert.equal(value.current, 'unchanged');
      assert.deepEqual(
        toolResults.map((event) => ({ toolUseId: event.toolUseId, isError: event.isError })),
        [
          { toolUseId: 'toolu-1', isError: false },
          { toolUseId: 'toolu-2', isError: true },
        ],
      );
      const reinjectedFailure = findToolResult(requestBodies[2]?.messages, 'toolu-2');
      assert.ok(reinjectedFailure, 'failed semantic result must reach the next provider request');
      assert.equal(
        reinjectedFailure.is_error ?? reinjectedFailure.isError,
        true,
        `failed semantic result must use the provider error-tool-result protocol: ${JSON.stringify(reinjectedFailure)}`,
      );
      assert.match(JSON.stringify(reinjectedFailure), /outcome_unknown/);
      assert.match(JSON.stringify(reinjectedFailure), /computer\.type failed/);
    });
  }
});

function fakeSemanticBackend(value: { current: string }): CuDispatchBackend {
  const observation = (): CuObservation => ({
    observationId: 'backend-observation',
    appId: 'pid:42',
    pid: 42,
    windowId: 7,
    contentFingerprint: 'fixture',
    elements: [
      {
        elementId: 'field-1',
        role: 'AXTextField',
        label: 'CUA Lab Set Value Field',
        value: value.current,
        identity: {
          role: 'AXTextField',
          label: 'CUA Lab Set Value Field',
          value: value.current,
        },
      },
    ],
  });
  return {
    async preflight() {
      return { accessibility: true, screenRecording: true };
    },
    async listApps() {
      return [
        {
          appId: 'pid:42',
          pid: 42,
          name: 'Codex CUA Lab',
          windowCount: 1,
          windows: [{ windowId: 7, title: 'Codex CUA Lab' }],
        },
      ];
    },
    async observeApp() {
      return observation();
    },
    async runSemantic(action) {
      assert.equal(action.type, 'set_value');
      if (action.type === 'set_value') value.current = action.value;
      return {
        outcome: {
          ok: true,
          tier: 'ax',
          verified: true,
          evidence: { path: 'ax', effect: 'confirmed' },
        },
        observation: observation(),
      };
    },
    async run(action) {
      return {
        outcome: {
          ok: false,
          error: 'unsupported_action',
          message: `${action.type} disabled`,
        },
      };
    },
  };
}

function failingSemanticBackend(value: { current: string }): CuDispatchBackend {
  const backend = fakeSemanticBackend(value);
  return {
    ...backend,
    async runSemantic(action) {
      assert.equal(action.type, 'set_value');
      return {
        outcome: {
          ok: false,
          error: 'outcome_unknown',
          message: 'fixture refused the semantic mutation',
        },
      };
    },
  };
}

function semanticInputFromMessages(messages: unknown) {
  const values = collectJsonObjects(messages);
  const observation = values.find(
    (value) => typeof value.observation_id === 'string' && Array.isArray(value.elements),
  );
  assert.ok(observation, 'provider request must include the observation tool result');
  const field = (observation.elements as Array<Record<string, unknown>>).find(
    (element) => element.label === 'CUA Lab Set Value Field',
  );
  assert.ok(field);
  return {
    action: 'set_value',
    observation_id: observation.observation_id,
    element_id: field.element_id,
    value: 'provider-loop',
  };
}

function collectJsonObjects(value: unknown): Array<Record<string, unknown>> {
  if (typeof value === 'string') {
    const candidates = [value];
    const marker = value.lastIndexOf('Fresh observation:\n');
    if (marker >= 0) candidates.push(value.slice(marker + 'Fresh observation:\n'.length));
    return candidates.flatMap((candidate) => {
      try {
        const parsed = JSON.parse(candidate);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? [parsed as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
  }
  if (Array.isArray(value)) return value.flatMap(collectJsonObjects);
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(collectJsonObjects);
}

function containsToolResult(value: unknown, toolUseId: string): boolean {
  return Boolean(findToolResult(value, toolUseId));
}

function findToolResult(value: unknown, toolUseId: string): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const result = findToolResult(entry, toolUseId);
      if (result) return result;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.type === 'tool_result' &&
    (record.tool_use_id === toolUseId || record.toolUseId === toolUseId)
  ) {
    return record;
  }
  for (const entry of Object.values(record)) {
    const result = findToolResult(entry, toolUseId);
    if (result) return result;
  }
  return undefined;
}

function respondAnthropicStream(
  response: ServerResponse,
  model: string,
  step: number,
  toolInput: Record<string, unknown> | undefined,
) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  });
  const send = (event: string, data: unknown) => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send('message_start', {
    type: 'message_start',
    message: {
      id: `msg-${step}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });
  if (toolInput) {
    send('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: `toolu-${step}`,
        name: 'maka_computer',
        input: toolInput,
      },
    });
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 5 },
    });
  } else {
    send('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: 'done' },
    });
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    });
  }
  send('message_stop', { type: 'message_stop' });
  response.end();
}

function header(providerType: LlmConnection['providerType'], model: string): SessionHeader {
  return {
    id: `session-${providerType}`,
    workspaceRoot: '/tmp/maka',
    cwd: '/tmp/maka',
    createdAt: 1,
    lastUsedAt: 1,
    name: providerType,
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: providerType,
    connectionLocked: true,
    model,
    permissionMode: 'bypass',
    schemaVersion: 1,
  };
}

function connection(
  providerType: LlmConnection['providerType'],
  baseUrl: string,
  model: string,
  apiProtocol?: 'anthropic-messages',
  maxOutputTokens?: number,
): LlmConnection {
  return {
    slug: providerType,
    name: providerType,
    providerType,
    baseUrl,
    defaultModel: model,
    ...(apiProtocol ? { models: [{ id: model, apiProtocol, maxOutputTokens }] } : {}),
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

let id = 0;
function idGenerator() {
  return () => `id-${++id}`;
}

function monotonicClock() {
  let value = 1_000;
  return () => ++value;
}

async function startJsonServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
) {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const control = {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
  servers.push(control);
  return control;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function respondJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
