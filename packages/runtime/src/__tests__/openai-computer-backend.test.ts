import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type {
  LlmConnection,
  SessionEvent,
  SessionHeader,
  StoredMessage,
} from '@maka/core';

import { OpenAIComputerBackend } from '../openai-computer-backend.js';
import type { OpenAIComputerRequest } from '../openai-computer-codec.js';
import { PermissionEngine } from '../permission-engine.js';
import type { MakaTool } from '../tool-runtime.js';

describe('OpenAIComputerBackend', () => {
  test('runs OpenAI actions through ToolRuntime and persists final response text', async () => {
    const harness = createHarness({
      permissionMode: 'bypass',
      responses: [
        computerResponse([{ type: 'click', button: 'left', x: 12, y: 34 }]),
        finalResponse('done'),
      ],
    });

    const events = await collect(harness.backend.send(sendInput()));

    assert.deepEqual(events.map((event) => event.type), [
      'tool_start',
      'tool_result',
      'tool_start',
      'tool_result',
      'text_complete',
      'complete',
    ]);
    assert.deepEqual(harness.actions.map((args) => args.action), ['left_click', 'screenshot']);
    assert.deepEqual(harness.messages.map((message) => message.type), [
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'assistant',
    ]);
    const textComplete = events.find((event) => event.type === 'text_complete');
    assert.equal(textComplete?.type === 'text_complete' ? textComplete.text : undefined, 'done');
    const assistant = harness.messages.find((message) => message.type === 'assistant');
    assert.equal(assistant?.type === 'assistant' ? assistant.text : undefined, 'done');
    assert.equal(harness.telemetry.length, 2);
  });

  test('parks the background pump until SessionManager-style permission response arrives', async () => {
    const harness = createHarness({
      permissionMode: 'ask',
      responses: [
        computerResponse([{ type: 'click', button: 'left', x: 12, y: 34 }]),
        finalResponse('allowed'),
      ],
    });
    const iterator = harness.backend.send(sendInput())[Symbol.asyncIterator]();

    assert.equal((await iterator.next()).value?.type, 'tool_start');
    const permission = (await iterator.next()).value;
    assert.equal(permission?.type, 'permission_request');
    assert.equal(harness.actions.length, 0);
    if (permission?.type !== 'permission_request') throw new Error('permission request missing');

    await harness.backend.respondToPermission({
      requestId: permission.requestId,
      decision: 'allow',
      rememberForTurn: true,
    });
    const remaining = await collectIterator(iterator);

    assert.deepEqual(remaining.map((event) => event.type), [
      'permission_decision_ack',
      'tool_result',
      'tool_start',
      'tool_result',
      'text_complete',
      'complete',
    ]);
    assert.deepEqual(harness.actions.map((args) => args.action), ['left_click', 'screenshot']);
    assert.equal(harness.messages.some((message) => message.type === 'permission_decision'), true);
  });

  test('maps safety checks to local permission and executes a confirmed click once', async () => {
    const harness = createHarness({
      permissionMode: 'bypass',
      responses: [
        computerResponse(
          [{ type: 'click', button: 'left', x: 20, y: 40 }],
          [{ id: 'safe-1', code: 'confirm', message: 'Confirm click' }],
        ),
        finalResponse('clicked'),
      ],
    });
    const iterator = harness.backend.send(sendInput())[Symbol.asyncIterator]();

    const permission = (await iterator.next()).value;
    assert.equal(permission?.type, 'permission_request');
    if (permission?.type !== 'permission_request') throw new Error('safety permission request missing');
    await harness.backend.respondToPermission({
      requestId: permission.requestId,
      decision: 'allow',
    });
    const remaining = await collectIterator(iterator);

    assert.deepEqual(remaining.map((event) => event.type), [
      'permission_decision_ack',
      'tool_start',
      'tool_result',
      'tool_start',
      'tool_result',
      'text_complete',
      'complete',
    ]);
    assert.equal(harness.actions.filter((args) => args.action === 'left_click').length, 1);
    const continuation = harness.requests[1];
    const output = Array.isArray(continuation?.input) ? continuation.input[0] : undefined;
    assert.deepEqual(output?.acknowledged_safety_checks, [{
      id: 'safe-1',
      code: 'confirm',
      message: 'Confirm click',
    }]);
  });

  test('emits tool failure before terminal backend error', async () => {
    const harness = createHarness({
      permissionMode: 'bypass',
      responses: [
        computerResponse([{ type: 'click', button: 'left', x: 12, y: 34 }]),
      ],
      impl: async () => ({ text: 'computer.left_click failed: target_not_found' }),
    });

    const events = await collect(harness.backend.send(sendInput()));

    assert.deepEqual(events.map((event) => event.type), [
      'tool_start',
      'tool_result',
      'error',
      'complete',
    ]);
    const toolResult = events.find((event) => event.type === 'tool_result');
    assert.equal(toolResult?.type === 'tool_result' ? toolResult.isError : undefined, true);
    const complete = events.at(-1);
    assert.equal(complete?.type === 'complete' ? complete.stopReason : undefined, 'error');
  });

  test('stop aborts a turn parked on permission and dispose is idempotent', async () => {
    const harness = createHarness({
      permissionMode: 'ask',
      responses: [
        computerResponse([{ type: 'click', button: 'left', x: 12, y: 34 }]),
      ],
    });
    const iterator = harness.backend.send(sendInput())[Symbol.asyncIterator]();

    assert.equal((await iterator.next()).value?.type, 'tool_start');
    assert.equal((await iterator.next()).value?.type, 'permission_request');
    await harness.backend.stop('user_stop');
    const remaining = await collectIterator(iterator);

    assert.deepEqual(remaining.map((event) => event.type), [
      'tool_result',
      'abort',
      'complete',
    ]);
    assert.equal(harness.actions.length, 0);
    await harness.backend.dispose();
    await harness.backend.dispose();
  });
});

function createHarness(input: {
  permissionMode: SessionHeader['permissionMode'];
  responses: unknown[];
  impl?: MakaTool['impl'];
}) {
  const messages: StoredMessage[] = [];
  const requests: OpenAIComputerRequest[] = [];
  const actions: Array<Record<string, unknown>> = [];
  const telemetry: unknown[] = [];
  let nextId = 0;
  let now = 1_000;
  const newId = () => `id-${++nextId}`;
  const permissionEngine = new PermissionEngine({ newId, now: () => ++now });
  const computerTool: MakaTool = {
    name: 'computer',
    displayName: 'Computer',
    description: 'test computer',
    parameters: {},
    categoryHint: 'computer_use',
    impl: input.impl ?? (async (args) => {
      const action = args as Record<string, unknown>;
      actions.push(action);
      if (action.action === 'screenshot') {
        return {
          text: 'computer.screenshot ok',
          screenshot: { base64: 'AA==', mimeType: 'image/png' },
        };
      }
      return { text: `computer.${String(action.action)} ok` };
    }),
  };
  const header = {
    id: 'session-1',
    workspaceRoot: '/tmp',
    cwd: '/tmp',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'test',
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'openai',
    connectionLocked: true,
    model: 'gpt-test',
    permissionMode: input.permissionMode,
    schemaVersion: 1,
  } satisfies SessionHeader;
  const connection = {
    slug: 'openai',
    name: 'OpenAI',
    providerType: 'openai',
    defaultModel: 'gpt-test',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  } satisfies LlmConnection;
  const responses = [...input.responses];
  const backend = new OpenAIComputerBackend({
    sessionId: header.id,
    header,
    connection,
    modelId: header.model,
    dialect: 'ga',
    transport: {
      async create(request) {
        requests.push(request);
        return responses.shift();
      },
    },
    computerTool,
    appendMessage: async (message) => { messages.push(message); },
    permissionEngine,
    newId,
    now: () => ++now,
    recordToolInvocation: (record) => { telemetry.push(record); },
  });
  return { backend, messages, requests, actions, telemetry };
}

function sendInput() {
  return {
    turnId: 'turn-1',
    text: 'click it',
    context: [],
  };
}

function computerResponse(
  actions: unknown[],
  pendingSafetyChecks: unknown[] = [],
) {
  return {
    id: 'resp-1',
    status: 'completed',
    error: null,
    output: [{
      type: 'computer_call',
      id: 'item-1',
      call_id: 'call-1',
      status: 'completed',
      pending_safety_checks: pendingSafetyChecks,
      actions,
    }],
  };
}

function finalResponse(text: string) {
  return {
    id: 'resp-2',
    status: 'completed',
    error: null,
    output: [{
      type: 'message',
      content: [{ type: 'output_text', text }],
    }],
  };
}

async function collect(iterable: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

async function collectIterator(
  iterator: AsyncIterator<SessionEvent>,
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) return events;
    events.push(next.value);
  }
}
