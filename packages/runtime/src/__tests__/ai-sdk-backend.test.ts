import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { LlmConnection, SessionHeader } from '@maka/core';
import type { SessionEvent } from '@maka/core/events';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { ToolResultMessage } from '@maka/core/session';
import type { LlmCallRecord } from '@maka/core/usage-stats/types';
import {
  AiSdkBackend,
  INVALID_TOOL_NAME,
  MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN,
  TOOL_ERROR_RESULT_MAX_CHARS,
  formatSyntheticToolErrorText,
  normalizeAiSdkUsage,
  repairMakaToolCall,
  type MakaTool,
  type RunTraceEvent,
} from '../ai-sdk-backend.js';
import { PermissionEngine } from '../permission-engine.js';

describe('AiSdkBackend model history', () => {
  test('prefers RuntimeEvent prior messages and appends current user once', async () => {
    const model = completionModel();
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(backend.send({
      turnId: 'turn-current',
      text: 'current user',
      context: [
        { type: 'user', id: 'legacy-u', turnId: 'turn-prev', ts: 1, text: 'legacy user' },
        { type: 'assistant', id: 'legacy-a', turnId: 'turn-prev', ts: 2, text: 'legacy assistant', modelId: 'm' },
      ],
      runtimeContext: [
        runtimeTextEvent({ id: 'rt-u', turnId: 'turn-prev', role: 'user', author: 'user', text: 'runtime user' }),
        runtimeTextEvent({ id: 'rt-a', turnId: 'turn-prev', role: 'model', author: 'agent', text: 'runtime assistant' }),
        runtimeTextEvent({ id: 'rt-current', turnId: 'turn-current', role: 'user', author: 'user', text: 'current from runtime' }),
      ],
    }));

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'runtime user' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'runtime assistant' }] },
      { role: 'user', content: [{ type: 'text', text: 'current user' }] },
    ]);
  });

  test('falls back to StoredMessage context when RuntimeEvent projection is empty', async () => {
    const model = completionModel();
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(backend.send({
      turnId: 'turn-current',
      text: 'current user',
      context: [
        { type: 'user', id: 'legacy-u', turnId: 'turn-prev', ts: 1, text: 'legacy user' },
        { type: 'assistant', id: 'legacy-a', turnId: 'turn-prev', ts: 2, text: 'legacy assistant', modelId: 'm' },
      ],
      runtimeContext: [
        {
          id: 'rt-terminal',
          invocationId: 'inv-1',
          runId: 'run-prev',
          sessionId: 'session-1',
          turnId: 'turn-prev',
          ts: 1,
          partial: false,
          role: 'model',
          author: 'agent',
          status: 'completed',
          actions: { endInvocation: true },
        },
      ],
    }));

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'legacy user' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'legacy assistant' }] },
      { role: 'user', content: [{ type: 'text', text: 'current user' }] },
    ]);
  });

  test('preserves RuntimeEvent tool calls and results as structured AI SDK parts', async () => {
    const model = completionModel();
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(backend.send({
      turnId: 'turn-current',
      text: 'current user',
      context: [
        { type: 'user', id: 'legacy-u', turnId: 'turn-prev', ts: 1, text: 'legacy user' },
        { type: 'assistant', id: 'legacy-a', turnId: 'turn-prev', ts: 2, text: 'legacy assistant', modelId: 'm' },
      ],
      runtimeContext: [
        runtimeTextEvent({ id: 'rt-u', turnId: 'turn-prev', role: 'user', author: 'user', text: 'legacy user' }),
        runtimeTextEvent({ id: 'rt-a', turnId: 'turn-prev', role: 'model', author: 'agent', text: 'legacy assistant' }),
        runtimeEvent({
          id: 'rt-call',
          turnId: 'turn-prev',
          role: 'model',
          author: 'agent',
          content: { kind: 'function_call', id: 'tool-1', name: 'Read', args: { path: 'package.json' } },
        }),
        runtimeEvent({
          id: 'rt-result',
          turnId: 'turn-prev',
          role: 'tool',
          author: 'tool',
          content: { kind: 'function_response', id: 'tool-1', name: 'Read', result: 'contents', isError: false },
        }),
      ],
    }));

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'legacy user' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'legacy assistant' }] },
      {
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: 'tool-1',
          toolName: 'Read',
          input: { path: 'package.json' },
          providerExecuted: undefined,
          providerOptions: undefined,
        }],
      },
      {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 'tool-1',
          toolName: 'Read',
          output: { type: 'text', value: 'contents' },
          providerOptions: undefined,
        }],
      },
      { role: 'user', content: [{ type: 'text', text: 'current user' }] },
    ]);
  });

  test('falls back to legacy context when RuntimeEvent tool results are unmatched', async () => {
    const model = completionModel();
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(backend.send({
      turnId: 'turn-current',
      text: 'current user',
      context: [
        { type: 'user', id: 'legacy-u', turnId: 'turn-prev', ts: 1, text: 'legacy user' },
        { type: 'assistant', id: 'legacy-a', turnId: 'turn-prev', ts: 2, text: 'legacy assistant', modelId: 'm' },
      ],
      runtimeContext: [
        runtimeTextEvent({ id: 'rt-u', turnId: 'turn-prev', role: 'user', author: 'user', text: 'runtime user' }),
        runtimeEvent({
          id: 'rt-unmatched-result',
          turnId: 'turn-prev',
          role: 'tool',
          author: 'tool',
          content: { kind: 'function_response', id: 'missing-call', name: 'Read', result: 'contents', isError: false },
        }),
      ],
    }));

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'legacy user' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'legacy assistant' }] },
      { role: 'user', content: [{ type: 'text', text: 'current user' }] },
    ]);
  });

  test('falls back to legacy context when RuntimeEvent replay has unsupported content', async () => {
    const model = completionModel();
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(backend.send({
      turnId: 'turn-current',
      text: 'current user',
      context: [
        { type: 'user', id: 'legacy-u', turnId: 'turn-prev', ts: 1, text: 'legacy user' },
        { type: 'assistant', id: 'legacy-a', turnId: 'turn-prev', ts: 2, text: 'legacy assistant', modelId: 'm' },
      ],
      runtimeContext: [
        runtimeTextEvent({ id: 'rt-u', turnId: 'turn-prev', role: 'user', author: 'user', text: 'runtime user' }),
        runtimeEvent({
          id: 'rt-error',
          turnId: 'turn-prev',
          role: 'system',
          author: 'system',
          content: { kind: 'error', reason: 'tool_failed', message: 'Tool failed' },
        }),
      ],
    }));

    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'legacy user' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'legacy assistant' }] },
      { role: 'user', content: [{ type: 'text', text: 'current user' }] },
    ]);
  });

  test('falls back to legacy context instead of leaking unsupported thinking text', async () => {
    const model = completionModel();
    const openAiConnection = { ...connection(), providerType: 'openai' as const };
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: openAiConnection,
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });

    await drain(backend.send({
      turnId: 'turn-current',
      text: 'current user',
      context: [
        { type: 'user', id: 'legacy-u', turnId: 'turn-prev', ts: 1, text: 'legacy user' },
        { type: 'assistant', id: 'legacy-a', turnId: 'turn-prev', ts: 2, text: 'legacy assistant', modelId: 'm' },
      ],
      runtimeContext: [
        runtimeTextEvent({ id: 'rt-u', turnId: 'turn-prev', role: 'user', author: 'user', text: 'legacy user' }),
        runtimeEvent({
          id: 'rt-thinking',
          turnId: 'turn-prev',
          role: 'model',
          author: 'agent',
          content: { kind: 'thinking', text: 'private chain of thought', signature: 'sig-1' },
        }),
        runtimeTextEvent({ id: 'rt-a', turnId: 'turn-prev', role: 'model', author: 'agent', text: 'legacy assistant' }),
      ],
    }));

    const promptJson = JSON.stringify(compactPrompt(model));
    assert.deepEqual(compactPrompt(model), [
      { role: 'user', content: [{ type: 'text', text: 'legacy user' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'legacy assistant' }] },
      { role: 'user', content: [{ type: 'text', text: 'current user' }] },
    ]);
    assert.equal(promptJson.includes('private chain of thought'), false);
  });
});

describe('AiSdkBackend error surfaces', () => {
  test('generalizes model setup errors before emitting renderer events', async () => {
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-live-secret-token-value',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => {
        throw new Error('401 Authorization: Bearer sk-live-secret-token-value');
      },
      tools: [],
      newId: idGenerator(),
      now: () => 1,
    });

    const events: SessionEvent[] = [];
    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }

    const error = events.find((event): event is Extract<SessionEvent, { type: 'error' }> => event.type === 'error');
    assert.equal(error?.message, 'Authentication failed');
    assert.equal(JSON.stringify(events).includes('sk-live-secret-token-value'), false);
  });

  test('redacts and caps synthetic tool error text before storage and model return', () => {
    const raw = `provider exploded: Authorization: Bearer sk-live-secret-token-value ${'x'.repeat(5000)}`;
    const text = formatSyntheticToolErrorText(new Error(raw));

    assert.equal(text.includes('sk-live-secret-token-value'), false);
    assert.ok(text.includes('[redacted]'));
    assert.equal(text.length, TOOL_ERROR_RESULT_MAX_CHARS);
    assert.equal(text.endsWith('…'), true);
  });

  test('writeSyntheticToolResult never persists raw secret-shaped errors', async () => {
    const messages: ToolResultMessage[] = [];
    const events: SessionEvent[] = [];
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        if (message.type === 'tool_result') messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
    });

    await (backend as unknown as {
      writeSyntheticToolResult(
        toolUseId: string,
        turnId: string,
        text: string,
        queue: { push(event: SessionEvent): void },
      ): Promise<void>;
    }).writeSyntheticToolResult(
      'tool-1',
      'turn-1',
      'failed with api_key=sk-live-secret-token-value',
      { push: (event) => events.push(event) },
    );

    assert.equal(JSON.stringify(messages).includes('sk-live-secret-token-value'), false);
    assert.equal(JSON.stringify(events).includes('sk-live-secret-token-value'), false);
    assert.deepEqual(messages[0]?.content, events.find((event) => event.type === 'tool_result')?.content);
  });

  test('failed Bash results preserve terminal stdout and stderr as an error card', async () => {
    const messages: ToolResultMessage[] = [];
    const events: SessionEvent[] = [];
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        if (message.type === 'tool_result') messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
    });
    const tool: MakaTool = {
      name: 'Bash',
      description: 'shell',
      parameters: {},
      permissionRequired: false,
      impl: async () => {
        throw Object.assign(new Error('Command failed with exit code 2'), {
          code: 2,
          stdout: 'stdout before failure\nAuthorization: Bearer sk-live-secret-token-value',
          stderr: 'stderr before failure',
        });
      },
    };

    const execute = (backend as unknown as {
      wrapToolExecute(
        tool: MakaTool,
        turnId: string,
        queue: { push(event: SessionEvent): void },
      ): (args: unknown, ctx: { toolCallId: string; abortSignal: AbortSignal }) => Promise<unknown>;
    }).wrapToolExecute(tool, 'turn-1', { push: (event) => events.push(event) });

    const result = await execute(
      { command: 'printf out; printf err >&2; exit 2' },
      { toolCallId: 'tool-1', abortSignal: new AbortController().signal },
    );

    assert.deepEqual(result, { error: '命令退出码 2' });
    assert.equal(messages[0]?.isError, true);
    assert.deepEqual(messages[0]?.content, events.find((event) => event.type === 'tool_result')?.content);
    assert.deepEqual(messages[0]?.content, {
      kind: 'terminal',
      cwd: '/tmp/maka',
      cmd: 'printf out; printf err >&2; exit 2',
      exitCode: 2,
      stdout: 'stdout before failure\nAuthorization: Bearer [redacted]',
      stderr: 'stderr before failure',
    });
  });

  test('model stream timeout errors carry a stable reason for turn-history UI', () => {
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
    });

    const event = (backend as unknown as {
      makeErrorEvent(turnId: string, err: unknown): Extract<SessionEvent, { type: 'error' }>;
    }).makeErrorEvent('turn-1', new Error('Model stream idle timeout after 120000ms'));

    assert.equal(event.message, 'Request timed out');
    assert.equal(event.reason, 'timeout');
  });
});

describe('AiSdkBackend stop', () => {
  test('rejects parked permission requests for the active turn', async () => {
    const permissionEngine = new PermissionEngine({ newId: () => 'permission-id', now: () => 1 });
    permissionEngine.beginTurn('turn-1');
    const verdict = permissionEngine.evaluate({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      toolName: 'Write',
      args: { path: 'notes.md', content: 'hello' },
      mode: 'ask',
    });
    assert.equal(verdict.kind, 'prompt');
    assert.equal(permissionEngine.pendingCount('turn-1'), 1);
    const parked = verdict.kind === 'prompt'
      ? verdict.parked.then(
          () => 'resolved',
          (error: Error) => error.message,
        )
      : Promise.resolve('not-prompt');
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine,
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
    });

    (backend as unknown as { currentTurnId: string }).currentTurnId = 'turn-1';
    await backend.stop('user_stop');

    assert.match(await parked, /Turn turn-1 aborted before permission request permission-id was answered/);
    assert.equal(permissionEngine.pendingCount('turn-1'), 0);
  });
});

describe('AiSdkBackend usage telemetry', () => {
  test('normalizes standard LanguageModelUsage detail token fields', () => {
    const usage = normalizeAiSdkUsage({
      inputTokens: 100,
      outputTokens: 20,
      inputTokenDetails: {
        cacheReadTokens: 30,
        cacheWriteTokens: 10,
      },
      outputTokenDetails: {
        reasoningTokens: 5,
      },
    });

    assert.deepEqual(usage, {
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 30,
      cacheWriteInputTokens: 10,
      reasoningTokens: 5,
      totalTokens: 120,
    });
  });

  test('normalizes cache and reasoning tokens to messages, events, and telemetry', async () => {
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const llmRecords: LlmCallRecord[] = [];
    const chunks: LanguageModelV3StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: 'hello' },
      { type: 'text-end', id: 'text-1' },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: {
            total: 10,
            noCache: 5,
            cacheRead: 3,
            cacheWrite: 2,
          },
          outputTokens: {
            total: 7,
            text: 5,
            reasoning: 2,
          },
        },
      },
    ];
    const model = new MockLanguageModelV3({
      doStream: {
        stream: simulateReadableStream({
          chunks,
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
    });
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      recordLlmCall: (record) => {
        llmRecords.push(record);
      },
    });

    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }

    const usageMessage = messages.find((message) =>
      (message as { type?: string }).type === 'token_usage'
    ) as { input?: number; output?: number; cacheRead?: number; cacheCreation?: number } | undefined;
    const usageEvent = events.find((event) => event.type === 'token_usage') as
      | Extract<SessionEvent, { type: 'token_usage' }>
      | undefined;

    assert.equal((usageMessage as { type?: string } | undefined)?.type, 'token_usage');
    assert.equal((usageMessage as { turnId?: string } | undefined)?.turnId, 'turn-1');
    assert.equal(usageMessage?.input, 10);
    assert.equal(usageMessage?.output, 7);
    assert.equal(usageMessage?.cacheRead, 3);
    assert.equal(usageMessage?.cacheCreation, 2);
    assert.equal(usageEvent?.input, 10);
    assert.equal(usageEvent?.output, 7);
    assert.equal(usageEvent?.cacheRead, 3);
    assert.equal(usageEvent?.cacheCreation, 2);
    assert.equal(llmRecords[0]?.inputTokens, 10);
    assert.equal(llmRecords[0]?.outputTokens, 7);
    assert.equal(llmRecords[0]?.cachedInputTokens, 3);
    assert.equal(llmRecords[0]?.cacheWriteInputTokens, 2);
    assert.equal(llmRecords[0]?.reasoningTokens, 2);
    assert.equal(llmRecords[0]?.totalTokens, 17);
  });
});

describe('AiSdkBackend RunTrace', () => {
  test('records turn, model, usage, and completion trace events without changing SessionEvents', async () => {
    const trace: RunTraceEvent[] = [];
    const events: SessionEvent[] = [];
    const model = new MockLanguageModelV3({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'hello' },
            { type: 'text-end', id: 'text-1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: {
                  total: 4,
                  noCache: 4,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: {
                  total: 2,
                  text: 1,
                  reasoning: 1,
                },
              },
            },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
    });
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      recordRunTrace: (event) => {
        trace.push(event);
      },
    });

    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }

    assert.deepEqual(
      trace.map((event) => event.type),
      ['turn_started', 'model_resolved', 'model_stream_started', 'usage_recorded', 'model_stream_completed'],
    );
    assert.deepEqual(
      trace.map((event) => event.phase),
      ['turn', 'model', 'model', 'usage', 'model'],
    );
    assert.equal(trace[0]?.sessionId, 'session-1');
    assert.equal(trace[0]?.turnId, 'turn-1');
    assert.equal(trace.find((event) => event.type === 'usage_recorded')?.data?.inputTokens, 4);
    assert.equal(trace.find((event) => event.type === 'usage_recorded')?.data?.reasoningTokens, 1);
    assert.deepEqual(
      events.map((event) => event.type).filter((type) => type === 'text_delta' || type === 'token_usage' || type === 'complete'),
      ['text_delta', 'token_usage', 'complete'],
    );
  });

  test('trace recorder failures are best-effort and do not change model execution', async () => {
    const events: SessionEvent[] = [];
    const model = new MockLanguageModelV3({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'hello' },
            { type: 'text-end', id: 'text-1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: {
                  total: 1,
                  text: 1,
                  reasoning: 0,
                },
              },
            },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
    });
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => model,
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      recordRunTrace: () => {
        throw new Error('trace sink unavailable');
      },
    });

    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }

    assert.deepEqual(
      events.map((event) => event.type).filter((type) => type === 'text_delta' || type === 'token_usage' || type === 'complete'),
      ['text_delta', 'token_usage', 'complete'],
    );
  });


  test('records permission and tool trace events for denied tools', async () => {
    const trace: RunTraceEvent[] = [];
    const events: SessionEvent[] = [];
    const permissionEngine = new PermissionEngine({ newId: idGenerator(), now: () => 1 });
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header('ask'),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine,
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      permissionTimeoutMs: 1_000,
    });
    (backend as unknown as {
      currentRunTrace: { emit(eventPhase: string, eventType: string, message: string, data?: Record<string, unknown>): void };
      currentWatchdog: { pause(): void; resume(): void };
    }).currentRunTrace = {
      emit: (phase, type, message, data) => {
        trace.push({
          id: `trace-${trace.length + 1}`,
          sessionId: 'session-1',
          turnId: 'turn-1',
          ts: trace.length + 1,
          phase: phase as RunTraceEvent['phase'],
          type: type as RunTraceEvent['type'],
          message,
          ...(data ? { data } : {}),
        });
      },
    };
    (backend as unknown as {
      currentWatchdog: { pause(): void; resume(): void };
    }).currentWatchdog = { pause() {}, resume() {} };
    const tool: MakaTool = {
      name: 'Write',
      description: 'write file',
      parameters: {},
      permissionRequired: true,
      impl: async () => ({ ok: true }),
    };
    const execute = (backend as unknown as {
      wrapToolExecute(
        tool: MakaTool,
        turnId: string,
        queue: { push(event: SessionEvent): void },
      ): (args: unknown, ctx: { toolCallId: string; abortSignal: AbortSignal }) => Promise<unknown>;
    }).wrapToolExecute(tool, 'turn-1', { push: (event) => events.push(event) });

    const pending = execute(
      { path: 'notes.md', content: 'hello' },
      { toolCallId: 'tool-1', abortSignal: new AbortController().signal },
    );
    await waitFor(() => events.some((event) => event.type === 'permission_request'));
    const request = events.find((event) => event.type === 'permission_request') as
      | Extract<SessionEvent, { type: 'permission_request' }>
      | undefined;
    assert.ok(request);
    permissionEngine.recordResponse('turn-1', {
      requestId: request.requestId,
      decision: 'deny',
    });
    await pending;

    assert.deepEqual(
      trace.map((event) => event.type),
      ['tool_started', 'permission_requested', 'permission_decided', 'tool_failed'],
    );
    assert.deepEqual(
      trace.map((event) => event.phase),
      ['tool', 'permission', 'permission', 'tool'],
    );
    assert.equal(trace.find((event) => event.type === 'permission_decided')?.data?.decision, 'deny');
    assert.equal(trace.find((event) => event.type === 'tool_failed')?.data?.errorClass, 'Permission');
  });

  test('records abort trace when stop is requested', async () => {
    const trace: RunTraceEvent[] = [];
    const permissionEngine = new PermissionEngine({ newId: () => 'permission-id', now: () => 1 });
    permissionEngine.beginTurn('turn-1');
    const verdict = permissionEngine.evaluate({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      toolName: 'Write',
      args: { path: 'notes.md', content: 'hello' },
      mode: 'ask',
    });
    assert.equal(verdict.kind, 'prompt');
    const parked = verdict.kind === 'prompt'
      ? verdict.parked.then(
          () => 'resolved',
          (error: Error) => error.message,
        )
      : Promise.resolve('not-prompt');
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine,
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });
    (backend as unknown as {
      currentTurnId: string;
      currentRunTrace: { abortRequested(reason: string): void };
    }).currentTurnId = 'turn-1';
    (backend as unknown as {
      currentRunTrace: { abortRequested(reason: string): void };
    }).currentRunTrace = {
      abortRequested: (reason) => {
        trace.push({
          id: 'trace-1',
          sessionId: 'session-1',
          turnId: 'turn-1',
          ts: 1,
          phase: 'abort',
          type: 'abort_requested',
          message: 'Abort requested',
          data: { reason },
        });
      },
    };

    await backend.stop('redirect');

    assert.equal(trace.length, 1);
    assert.equal(trace[0]?.type, 'abort_requested');
    assert.equal(trace[0]?.data?.reason, 'redirect');
    assert.match(await parked, /Turn turn-1 aborted before permission request permission-id was answered/);
    assert.equal(permissionEngine.pendingCount('turn-1'), 0);
  });
});

describe('AiSdkBackend tool permission category hints', () => {
  test('permissionRequired=false fast path preserves tool-call/result ordering and telemetry', async () => {
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const telemetry: Array<{ status: string; toolCallId?: string }> = [];
    let implCalled = false;
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header('ask'),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      recordToolInvocation: (record) => {
        telemetry.push({ status: record.status, toolCallId: record.toolCallId });
      },
    });
    const tool: MakaTool = {
      name: 'Read',
      description: 'read file',
      parameters: {},
      permissionRequired: false,
      impl: async () => {
        implCalled = true;
        return { kind: 'text', text: 'hello' };
      },
    };
    const execute = (backend as unknown as {
      wrapToolExecute(
        tool: MakaTool,
        turnId: string,
        queue: { push(event: SessionEvent): void },
      ): (args: unknown, ctx: { toolCallId: string; abortSignal: AbortSignal }) => Promise<unknown>;
    }).wrapToolExecute(tool, 'turn-1', { push: (event) => events.push(event) });

    const result = await execute(
      { path: 'notes.md' },
      { toolCallId: 'tool-1', abortSignal: new AbortController().signal },
    );

    assert.equal(implCalled, true);
    assert.deepEqual(result, { kind: 'text', text: 'hello' });
    assert.deepEqual(
      messages
        .map((message) => (message as { type?: string }).type)
        .filter((type) => type === 'tool_call' || type === 'tool_result'),
      ['tool_call', 'tool_result'],
    );
    assert.deepEqual(
      events
        .map((event) => event.type)
        .filter((type) => type === 'tool_start' || type === 'tool_result'),
      ['tool_start', 'tool_result'],
    );
    assert.equal(events.some((event) => event.type === 'permission_request'), false);
    assert.deepEqual(telemetry, [
      { status: 'success', toolCallId: 'tool-1' },
    ]);
  });

  test('permission prompt timeout expires one request, resumes watchdog, and writes an error result', async () => {
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const permissionEngine = new PermissionEngine({ newId: idGenerator(), now: () => 1 });
    let implCalled = false;
    let pauseCount = 0;
    let resumeCount = 0;
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header('ask'),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine,
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
      permissionTimeoutMs: 1,
    });
    const tool: MakaTool = {
      name: 'Write',
      description: 'write file',
      parameters: {},
      permissionRequired: true,
      impl: async () => {
        implCalled = true;
        return { ok: true };
      },
    };
    (backend as unknown as {
      currentWatchdog: { pause(): void; resume(): void };
    }).currentWatchdog = {
      pause: () => {
        pauseCount += 1;
      },
      resume: () => {
        resumeCount += 1;
      },
    };

    const execute = (backend as unknown as {
      wrapToolExecute(
        tool: MakaTool,
        turnId: string,
        queue: { push(event: SessionEvent): void },
      ): (args: unknown, ctx: { toolCallId: string; abortSignal: AbortSignal }) => Promise<unknown>;
    }).wrapToolExecute(tool, 'turn-1', { push: (event) => events.push(event) });

    const result = await execute(
      { path: 'notes.md', content: 'hello' },
      { toolCallId: 'tool-1', abortSignal: new AbortController().signal },
    );
    const permissionRequest = events.find((event) => event.type === 'permission_request') as
      | Extract<SessionEvent, { type: 'permission_request' }>
      | undefined;
    const toolResult = events.find((event) => event.type === 'tool_result') as
      | Extract<SessionEvent, { type: 'tool_result' }>
      | undefined;

    assert.equal(implCalled, false);
    assert.equal(pauseCount, 1);
    assert.equal(resumeCount, 1);
    assert.equal(permissionEngine.pendingCount('turn-1'), 0);
    assert.equal(permissionEngine.recordResponse('turn-1', {
      requestId: permissionRequest?.requestId ?? 'missing',
      decision: 'allow',
    }), null);
    assert.match((result as { error?: string }).error ?? '', /Permission flow aborted/);
    assert.match((result as { error?: string }).error ?? '', /timed out/);
    assert.equal(toolResult?.isError, true);
    assert.equal(
      messages.some((message) =>
        (message as { type?: string; toolUseId?: string; isError?: boolean }).type === 'tool_result' &&
        (message as { toolUseId?: string }).toolUseId === 'tool-1' &&
        (message as { isError?: boolean }).isError === true,
      ),
      true,
    );
  });

  test('permission denial records decision ack, resumes watchdog, and never runs impl', async () => {
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const permissionEngine = new PermissionEngine({ newId: idGenerator(), now: () => 1 });
    let implCalled = false;
    let pauseCount = 0;
    let resumeCount = 0;
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header('ask'),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine,
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
      permissionTimeoutMs: 1_000,
    });
    const tool: MakaTool = {
      name: 'Write',
      description: 'write file',
      parameters: {},
      permissionRequired: true,
      impl: async () => {
        implCalled = true;
        return { ok: true };
      },
    };
    (backend as unknown as {
      currentWatchdog: { pause(): void; resume(): void };
    }).currentWatchdog = {
      pause: () => {
        pauseCount += 1;
      },
      resume: () => {
        resumeCount += 1;
      },
    };
    const execute = (backend as unknown as {
      wrapToolExecute(
        tool: MakaTool,
        turnId: string,
        queue: { push(event: SessionEvent): void },
      ): (args: unknown, ctx: { toolCallId: string; abortSignal: AbortSignal }) => Promise<unknown>;
    }).wrapToolExecute(tool, 'turn-1', { push: (event) => events.push(event) });

    const pending = execute(
      { path: 'notes.md', content: 'hello' },
      { toolCallId: 'tool-1', abortSignal: new AbortController().signal },
    );
    await waitFor(() => events.some((event) => event.type === 'permission_request'));
    const request = events.find((event) => event.type === 'permission_request') as
      | Extract<SessionEvent, { type: 'permission_request' }>
      | undefined;
    assert.ok(request);

    const accepted = permissionEngine.recordResponse('turn-1', {
      requestId: request.requestId,
      decision: 'deny',
      rememberForTurn: true,
    });
    assert.ok(accepted);
    const result = await pending;

    assert.equal(implCalled, false);
    assert.equal(pauseCount, 1);
    assert.equal(resumeCount, 1);
    assert.deepEqual(result, { error: '用户已拒绝权限请求' });
    assert.equal(messages.some((message) => (message as { type?: string }).type === 'tool_call'), true);
    assert.equal(
      messages.some((message) =>
        (message as { type?: string; decision?: string; rememberForTurn?: boolean }).type === 'permission_decision' &&
        (message as { decision?: string }).decision === 'deny' &&
        (message as { rememberForTurn?: boolean }).rememberForTurn === true,
      ),
      true,
    );
    assert.equal(
      events.some((event) =>
        event.type === 'permission_decision_ack' &&
        event.decision === 'deny' &&
        event.rememberForTurn === true,
      ),
      true,
    );
    assert.equal(
      events.some((event) => event.type === 'tool_result' && event.toolUseId === 'tool-1' && event.isError === true),
      true,
    );
  });

  test('tool failure telemetry classifies and redacts generic implementation errors', async () => {
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const telemetry: Array<{ status: string; errorClass?: string; bytesOut: number }> = [];
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header('ask'),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
      recordToolInvocation: (record) => {
        telemetry.push({
          status: record.status,
          errorClass: record.errorClass,
          bytesOut: record.bytesOut ?? 0,
        });
      },
    });
    const tool: MakaTool = {
      name: 'Write',
      description: 'write file',
      parameters: {},
      permissionRequired: false,
      impl: async () => {
        const error = new Error('401 Authorization: Bearer sk-live-secret-token-value');
        Object.assign(error, { code: 401 });
        throw error;
      },
    };
    const execute = (backend as unknown as {
      wrapToolExecute(
        tool: MakaTool,
        turnId: string,
        queue: { push(event: SessionEvent): void },
      ): (args: unknown, ctx: { toolCallId: string; abortSignal: AbortSignal }) => Promise<unknown>;
    }).wrapToolExecute(tool, 'turn-1', { push: (event) => events.push(event) });

    const result = await execute(
      { path: 'notes.md', content: 'hello' },
      { toolCallId: 'tool-1', abortSignal: new AbortController().signal },
    );
    const resultText = (result as { error?: string }).error ?? '';
    const serialized = JSON.stringify({ messages, events, result });

    assert.match(resultText, /Authorization: Bearer \[redacted\]/);
    assert.equal(serialized.includes('sk-live-secret-token-value'), false);
    assert.equal(
      events.some((event) => event.type === 'tool_result' && event.toolUseId === 'tool-1' && event.isError === true),
      true,
    );
    assert.deepEqual(telemetry, [
      { status: 'error', errorClass: 'Auth', bytesOut: 0 },
    ]);
  });

  test('flushes output deltas before successful and failed tool results', async () => {
    const events: SessionEvent[] = [];
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header('ask'),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: monotonicClock(),
    });
    const successTool: MakaTool = {
      name: 'Streamer',
      description: 'streams output',
      parameters: {},
      permissionRequired: false,
      impl: async (_args, ctx) => {
        ctx.emitOutput('stdout', 'success chunk');
        return { ok: true };
      },
    };
    const failureTool: MakaTool = {
      name: 'Streamer',
      description: 'streams then fails',
      parameters: {},
      permissionRequired: false,
      impl: async (_args, ctx) => {
        ctx.emitOutput('stderr', 'failure chunk');
        throw new Error('tool failed');
      },
    };
    const wrap = (tool: MakaTool) => (backend as unknown as {
      wrapToolExecute(
        tool: MakaTool,
        turnId: string,
        queue: { push(event: SessionEvent): void },
      ): (args: unknown, ctx: { toolCallId: string; abortSignal: AbortSignal }) => Promise<unknown>;
    }).wrapToolExecute(tool, 'turn-1', { push: (event) => events.push(event) });

    await wrap(successTool)({}, {
      toolCallId: 'tool-success',
      abortSignal: new AbortController().signal,
    });
    await wrap(failureTool)({}, {
      toolCallId: 'tool-failure',
      abortSignal: new AbortController().signal,
    });
    const eventKeys = events.map((event) => `${event.type}:${'toolUseId' in event ? event.toolUseId : ''}`);

    assert.ok(
      eventKeys.indexOf('tool_output_delta:tool-success') <
      eventKeys.indexOf('tool_result:tool-success'),
      'successful tool output must flush before its result event',
    );
    assert.ok(
      eventKeys.indexOf('tool_output_delta:tool-failure') <
      eventKeys.indexOf('tool_result:tool-failure'),
      'failed tool output must flush before its result event',
    );
  });

  test('passes categoryHint through PermissionEngine before tool execution', async () => {
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header('explore'),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
    });
    const tool: MakaTool = {
      name: 'ExploreAgent',
      description: 'read-only worker',
      parameters: {},
      permissionRequired: true,
      categoryHint: 'subagent',
      impl: async () => ({ ok: true }),
    };

    const execute = (backend as unknown as {
      wrapToolExecute(
        tool: MakaTool,
        turnId: string,
        queue: { push(event: SessionEvent): void },
      ): (args: unknown, ctx: { toolCallId: string; abortSignal: AbortSignal }) => Promise<unknown>;
    }).wrapToolExecute(tool, 'turn-1', { push: (event) => events.push(event) });

    const result = await execute({ objective: 'map PawWork subagent lifecycle' }, {
      toolCallId: 'tool-1',
      abortSignal: new AbortController().signal,
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(events.some((event) => event.type === 'permission_request'), false);
    assert.equal(messages.some((message) => (message as { type?: string }).type === 'tool_result'), true);
    assert.equal(
      (messages.find((message) => (message as { type?: string }).type === 'tool_call') as { intent?: string } | undefined)?.intent,
      '只读探索：map PawWork subagent lifecycle',
    );
    assert.equal(
      (events.find((event) => event.type === 'tool_start') as { intent?: string } | undefined)?.intent,
      '只读探索：map PawWork subagent lifecycle',
    );
  });

  test('caps concurrent read-only subagent tools in one turn', async () => {
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header('explore'),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
    });
    let implStarted = 0;
    const release: Array<() => void> = [];
    const tool: MakaTool = {
      name: 'ExploreAgent',
      description: 'read-only worker',
      parameters: {},
      permissionRequired: true,
      categoryHint: 'subagent',
      impl: async () => {
        implStarted += 1;
        return new Promise((resolve) => {
          release.push(() => resolve({ ok: true }));
        });
      },
    };
    const execute = (backend as unknown as {
      wrapToolExecute(
        tool: MakaTool,
        turnId: string,
        queue: { push(event: SessionEvent): void },
      ): (args: unknown, ctx: { toolCallId: string; abortSignal: AbortSignal }) => Promise<unknown>;
    }).wrapToolExecute(tool, 'turn-1', { push: (event) => events.push(event) });

    const pending = Array.from({ length: MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN }, (_, index) => execute(
      { objective: `research ${index}` },
      { toolCallId: `tool-${index}`, abortSignal: new AbortController().signal },
    ));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(implStarted, MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN);

    const rejected = await execute(
      { objective: 'overflow' },
      { toolCallId: 'tool-overflow', abortSignal: new AbortController().signal },
    );
    assert.deepEqual(rejected, {
      error: '只读探索并发过多：同一轮最多 5 个子代理。请等待已有探索完成后再继续。',
    });
    assert.equal(implStarted, MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN);
    assert.equal(events.some((event) => event.type === 'tool_result' && event.toolUseId === 'tool-overflow' && event.isError), true);
    assert.equal(JSON.stringify(messages).includes('tool-overflow'), true);

    release.forEach((resume) => resume());
    await Promise.all(pending);
  });

  test('maps structured subagent terminal states to persisted tool status', async () => {
    const messages: unknown[] = [];
    const events: SessionEvent[] = [];
    const telemetry: Array<{ status: string; toolCallId?: string }> = [];
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header('explore'),
      appendMessage: async (message) => {
        messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
      recordToolInvocation: (record) => {
        telemetry.push({ status: record.status, toolCallId: record.toolCallId });
      },
    });
    const tool: MakaTool = {
      name: 'ExploreAgent',
      description: 'read-only worker',
      parameters: {},
      permissionRequired: true,
      categoryHint: 'subagent',
      impl: async (args: unknown) => {
        const input = args as { reason?: string };
        return {
        kind: 'explore_agent',
        ok: false,
        mode: 'read_only',
        objective: 'bad scope',
        roots: [],
        queries: [],
        filesInspected: 0,
        filesSkipped: 0,
        bytesRead: 0,
        progress: [],
        candidateFiles: [],
        matches: [],
        notes: [],
          reason: input.reason === 'aborted' ? 'aborted' : 'invalid_root',
          message: input.reason === 'aborted' ? '只读探索已取消。' : '范围无效。',
        };
      },
    };
    const execute = (backend as unknown as {
      wrapToolExecute(
        tool: MakaTool,
        turnId: string,
        queue: { push(event: SessionEvent): void },
      ): (args: unknown, ctx: { toolCallId: string; abortSignal: AbortSignal }) => Promise<unknown>;
    }).wrapToolExecute(tool, 'turn-1', { push: (event) => events.push(event) });

    await execute({ objective: 'bad scope' }, {
      toolCallId: 'tool-failed',
      abortSignal: new AbortController().signal,
    });
    await execute({ objective: 'cancelled', reason: 'aborted' }, {
      toolCallId: 'tool-aborted',
      abortSignal: new AbortController().signal,
    });

    assert.equal(
      (messages.find((message) =>
        (message as { type?: string; toolUseId?: string }).type === 'tool_result' &&
        (message as { toolUseId?: string }).toolUseId === 'tool-failed',
      ) as { isError?: boolean } | undefined)?.isError,
      true,
    );
    assert.equal(
      (events.find((event) => event.type === 'tool_result' && event.toolUseId === 'tool-aborted') as { isError?: boolean } | undefined)?.isError,
      true,
    );
    assert.deepEqual(telemetry, [
      { status: 'error', toolCallId: 'tool-failed' },
      { status: 'aborted', toolCallId: 'tool-aborted' },
    ]);
  });

  test('maps aborted OfficeDocument results to aborted tool telemetry', async () => {
    const events: SessionEvent[] = [];
    const telemetry: Array<{ status: string; toolCallId?: string }> = [];
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header('ask'),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
      recordToolInvocation: (record) => {
        telemetry.push({ status: record.status, toolCallId: record.toolCallId });
      },
    });
    const tool: MakaTool = {
      name: 'OfficeDocument',
      description: 'read office',
      parameters: {},
      permissionRequired: false,
      impl: async () => ({
        kind: 'office_document',
        ok: false,
        operation: 'view',
        path: 'slides.pptx',
        args: ['view', 'slides.pptx', 'outline'],
        reason: 'officecli_aborted',
        message: 'officecli 操作已取消。',
      }),
    };
    const execute = (backend as unknown as {
      wrapToolExecute(
        tool: MakaTool,
        turnId: string,
        queue: { push(event: SessionEvent): void },
      ): (args: unknown, ctx: { toolCallId: string; abortSignal: AbortSignal }) => Promise<unknown>;
    }).wrapToolExecute(tool, 'turn-1', { push: (event) => events.push(event) });

    await execute({ path: 'slides.pptx', operation: 'view' }, {
      toolCallId: 'tool-office-aborted',
      abortSignal: new AbortController().signal,
    });

    assert.equal(
      (events.find((event) => event.type === 'tool_result') as { isError?: boolean } | undefined)?.isError,
      true,
    );
    assert.deepEqual(telemetry, [
      { status: 'aborted', toolCallId: 'tool-office-aborted' },
    ]);
  });
});

describe('AiSdkBackend tool-call repair', () => {
  test('repairs provider tool-name case drift to the canonical Maka tool name', () => {
    const repaired = repairMakaToolCall({
      toolCall: {
        toolCallId: 'tool-1',
        toolName: 'bash',
        input: '{"command":"pwd"}',
      },
      availableToolNames: ['Bash', 'Read'],
      error: new Error('No such tool'),
    });

    assert.equal(repaired?.toolName, 'Bash');
    assert.equal(repaired?.input, '{"command":"pwd"}');
  });

  test('routes unrepairable tool calls into the structured invalid tool', () => {
    const repaired = repairMakaToolCall({
      toolCall: {
        toolCallId: 'tool-1',
        toolName: 'DeleteEverything',
        input: '{"path":"/"}',
      },
      availableToolNames: ['Bash', 'Read'],
      error: new Error('No such tool: Authorization: Bearer sk-live-secret-token-value'),
    });

    assert.equal(repaired?.toolName, INVALID_TOOL_NAME);
    const input = JSON.parse(repaired?.input ?? '{}') as { tool?: string; error?: string };
    assert.equal(input.tool, 'DeleteEverything');
    assert.match(input.error ?? '', /No such tool/);
    assert.equal((input.error ?? '').includes('sk-live-secret-token-value'), false);
  });

  test('does not recursively repair the internal invalid tool', () => {
    const repaired = repairMakaToolCall({
      toolCall: {
        toolCallId: 'tool-1',
        toolName: INVALID_TOOL_NAME,
        input: '{}',
      },
      availableToolNames: ['Bash', 'Read'],
      error: new Error('Invalid tool failed'),
    });

    assert.equal(repaired, null);
  });
});

function completionModel(): MockLanguageModelV3 {
  const chunks: LanguageModelV3StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: {
          total: 1,
          noCache: 1,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: {
          total: 1,
          text: 1,
          reasoning: 0,
        },
      },
    },
  ];
  return new MockLanguageModelV3({
    doStream: {
      stream: simulateReadableStream({
        chunks,
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    },
  });
}

function runtimeTextEvent(input: {
  id: string;
  turnId: string;
  role: 'user' | 'model';
  author: 'user' | 'agent';
  text: string;
}): RuntimeEvent {
  return {
    id: input.id,
    invocationId: 'inv-1',
    runId: 'run-prev',
    sessionId: 'session-1',
    turnId: input.turnId,
    ts: 1,
    partial: false,
    role: input.role,
    author: input.author,
    content: { kind: 'text', text: input.text },
  };
}

function runtimeEvent(input: {
  id: string;
  turnId: string;
  role: RuntimeEvent['role'];
  author: RuntimeEvent['author'];
  content?: RuntimeEvent['content'];
  status?: RuntimeEvent['status'];
  actions?: RuntimeEvent['actions'];
}): RuntimeEvent {
  return {
    id: input.id,
    invocationId: 'inv-1',
    runId: 'run-prev',
    sessionId: 'session-1',
    turnId: input.turnId,
    ts: 1,
    partial: false,
    role: input.role,
    author: input.author,
    ...(input.content ? { content: input.content } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.actions ? { actions: input.actions } : {}),
  };
}

function compactPrompt(model: MockLanguageModelV3): unknown {
  return model.doStreamCalls[0]?.prompt.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of iterable) {
    // consume
  }
}

function header(permissionMode: SessionHeader['permissionMode'] = 'ask'): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/tmp/maka',
    cwd: '/tmp/maka',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Test',
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'anthropic-main',
    connectionLocked: true,
    model: 'claude-sonnet-4-5-20250929',
    permissionMode,
    schemaVersion: 1,
  };
}

function connection(): LlmConnection {
  return {
    slug: 'anthropic-main',
    name: 'Anthropic',
    providerType: 'anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function idGenerator(): () => string {
  let index = 0;
  return () => `id-${++index}`;
}

function monotonicClock(): () => number {
  let value = 1_000;
  return () => ++value;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('condition was not met before timeout');
}
