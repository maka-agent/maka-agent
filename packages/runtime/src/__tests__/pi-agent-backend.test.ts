import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { BackendKind, SessionEvent, SessionHeader, StoredMessage } from '@maka/core';

import { PermissionEngine } from '../permission-engine.js';
import {
  PiAgentBackend,
  normalizePiAgentFrame,
  type PiAgentFrame,
  type PiAgentTransport,
} from '../pi-agent-backend.js';

describe('PiAgentBackend skeleton', () => {
  test('normalizes fake transport text and tool frames to Maka events and storage records', async () => {
    const messages: StoredMessage[] = [];
    const backend = new PiAgentBackend({
      sessionId: 'session-1',
      header: header({ permissionMode: 'execute' }),
      appendMessage: async (message) => { messages.push(message); },
      permissionEngine: new PermissionEngine({ newId: nextId('perm'), now: nextNow(1_000) }),
      transport: frames([
        { type: 'text_delta', text: 'hello ' },
        { type: 'tool_start', toolUseId: 'tool-1', toolName: 'Read', args: { path: 'README.md' } },
        { type: 'tool_output_delta', toolUseId: 'tool-1', stream: 'stdout', chunk: 'reading\n' },
        { type: 'tool_result', toolUseId: 'tool-1', content: { kind: 'text', text: 'file body' } },
        { type: 'text_delta', text: 'world' },
        { type: 'complete' },
      ]),
      newId: nextId('id'),
      now: nextNow(2_000),
    });

    const events = await drain(backend.send({ turnId: 'turn-1', text: 'inspect', context: [] }));

    assert.deepEqual(events.map((event) => event.type), [
      'text_delta',
      'tool_start',
      'tool_output_delta',
      'tool_result',
      'text_delta',
      'text_complete',
      'complete',
    ]);
    assert.equal(messages.some((message) => message.type === 'assistant' && message.text === 'hello world'), true);
    assert.equal(messages.some((message) => message.type === 'tool_call' && message.toolName === 'Read'), true);
    assert.equal(messages.some((message) => message.type === 'tool_result' && message.toolUseId === 'tool-1'), true);
  });

  test('parks ACP permission requests until respondToPermission resolves them', async () => {
    const messages: StoredMessage[] = [];
    const backend = new PiAgentBackend({
      sessionId: 'session-1',
      header: header({ permissionMode: 'ask' }),
      appendMessage: async (message) => { messages.push(message); },
      permissionEngine: new PermissionEngine({ newId: nextId('permission'), now: nextNow(3_000) }),
      transport: frames([
        {
          type: 'permission_request',
          toolUseId: 'tool-1',
          toolName: 'Bash',
          args: { command: 'rm -rf tmp' },
          categoryHint: 'shell_unsafe',
        },
        { type: 'tool_result', toolUseId: 'tool-1', content: { kind: 'text', text: 'executed' } },
        { type: 'complete' },
      ]),
      newId: nextId('id'),
      now: nextNow(4_000),
    });

    const iterator = backend.send({ turnId: 'turn-1', text: 'delete temp files', context: [] })[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.value?.type, 'permission_request');
    const requestId = first.value?.type === 'permission_request' ? first.value.requestId : '';

    const secondPromise = iterator.next();
    const race = await Promise.race([
      secondPromise.then(() => 'advanced'),
      sleep(10).then(() => 'parked'),
    ]);
    assert.equal(race, 'parked');
    assert.equal(messages.some((message) => message.type === 'tool_result'), false);

    await backend.respondToPermission({ requestId, decision: 'deny' });
    const second = await secondPromise;
    assert.equal(second.value?.type, 'permission_decision_ack');
    const third = await iterator.next();
    assert.equal(third.value?.type, 'tool_result');
    assert.equal(third.value?.type === 'tool_result' ? third.value.isError : false, true);
  });

  test('suppresses later child output for a denied permission request', async () => {
    const messages: StoredMessage[] = [];
    const backend = new PiAgentBackend({
      sessionId: 'session-1',
      header: header({ permissionMode: 'ask' }),
      appendMessage: async (message) => { messages.push(message); },
      permissionEngine: new PermissionEngine({ newId: nextId('permission'), now: nextNow(4_500) }),
      transport: frames([
        {
          type: 'permission_request',
          toolUseId: 'tool-1',
          toolName: 'Bash',
          args: { command: 'rm -rf tmp' },
          categoryHint: 'shell_unsafe',
        },
        { type: 'tool_start', toolUseId: 'tool-1', toolName: 'Bash', args: { command: 'rm -rf tmp' } },
        { type: 'tool_output_delta', toolUseId: 'tool-1', stream: 'stdout', chunk: 'deleted tmp\n' },
        { type: 'tool_result', toolUseId: 'tool-1', content: { kind: 'text', text: 'executed' } },
        { type: 'complete' },
      ]),
      newId: nextId('id'),
      now: nextNow(4_600),
    });

    const iterator = backend.send({ turnId: 'turn-1', text: 'delete temp files', context: [] })[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.value?.type, 'permission_request');
    const requestId = first.value?.type === 'permission_request' ? first.value.requestId : '';

    const secondPromise = iterator.next();
    await backend.respondToPermission({ requestId, decision: 'deny' });
    const events = [
      (await secondPromise).value,
      (await iterator.next()).value,
      (await iterator.next()).value,
    ].filter(Boolean) as SessionEvent[];

    assert.deepEqual(events.map((event) => event.type), ['permission_decision_ack', 'tool_result', 'complete']);
    const toolResults = messages.filter((message) => message.type === 'tool_result');
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0]?.type === 'tool_result' ? toolResults[0].isError : false, true);
    assert.equal(JSON.stringify(toolResults).includes('executed'), false);
  });

  test('stop aborts a parked permission request and disposes the transport', async () => {
    let stopReason: string | null = null;
    let disposed = false;
    const backend = new PiAgentBackend({
      sessionId: 'session-1',
      header: header({ permissionMode: 'ask' }),
      appendMessage: async () => {},
      permissionEngine: new PermissionEngine({ newId: nextId('permission'), now: nextNow(5_000) }),
      transport: {
        ...frames([
          {
            type: 'permission_request',
            toolUseId: 'tool-1',
            toolName: 'Bash',
            args: { command: 'rm -rf tmp' },
            categoryHint: 'shell_unsafe',
          },
        ]),
        stop: async (reason) => { stopReason = reason; },
        dispose: async () => { disposed = true; },
      },
      newId: nextId('id'),
      now: nextNow(6_000),
    });

    const iterator = backend.send({ turnId: 'turn-1', text: 'delete temp files', context: [] })[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.value?.type, 'permission_request');

    await backend.stop('user_stop');
    const second = await iterator.next();
    assert.equal(second.value?.type, 'tool_result');
    assert.equal(second.value?.type === 'tool_result' ? second.value.isError : false, true);
    assert.equal(stopReason, 'user_stop');

    await backend.dispose();
    assert.equal(disposed, true);
  });

  test('frame guard ignores unknown ACP frames before they reach renderer event code', () => {
    assert.equal(normalizePiAgentFrame({ type: 'session/update', raw: true }), null);
    assert.deepEqual(
      normalizePiAgentFrame({ type: 'tool_output_delta', toolUseId: 'tool-1', stream: 'nonsense', chunk: 'ok' }),
      { type: 'tool_output_delta', toolUseId: 'tool-1', stream: 'stdout', chunk: 'ok' },
    );
  });
});

function frames(items: PiAgentFrame[]): PiAgentTransport {
  return {
    async *send() {
      for (const item of items) yield item;
    },
  };
}

async function drain(iterable: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function header(overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/tmp/maka',
    cwd: '/tmp/maka',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Pi test',
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    hasUnread: false,
    backend: 'pi-agent' as BackendKind,
    llmConnectionSlug: 'pi-agent',
    connectionLocked: true,
    model: 'pi-test',
    permissionMode: 'ask',
    schemaVersion: 1,
    ...overrides,
  };
}

function nextId(prefix: string): () => string {
  let counter = 0;
  return () => `${prefix}-${++counter}`;
}

function nextNow(start: number): () => number {
  let now = start;
  return () => now++;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
