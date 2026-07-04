import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CreateSessionInput, SessionEvent, SessionSummary, UserMessageInput } from '@maka/core';
import { createMakaSessionDriver } from '../session-driver.js';

describe('Maka session driver', () => {
  test('creates a bypass session from the first prompt and streams the turn', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
      newId: nextId('turn'),
    });

    const events = await collect(driver.sendPrompt('please inspect this workspace'));

    assert.equal(driver.getSessionId(), 'session-1');
    assert.deepEqual(runtime.created, [{
      cwd: '/repo',
      name: 'please inspect this workspace',
      backend: 'ai-sdk',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
      permissionMode: 'bypass',
    }]);
    assert.deepEqual(runtime.sent, [{
      sessionId: 'session-1',
      input: { turnId: 'turn-1', text: 'please inspect this workspace' },
    }]);
    assert.deepEqual(events.map((event) => event.type), ['text_delta', 'complete']);
  });

  test('uses the default turn id generator when one is not injected', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    await collect(driver.sendPrompt('hi'));

    assert.match(runtime.sent[0]?.input.turnId ?? '', /^[0-9a-f-]{36}$/);
  });
});

class RecordingRuntime {
  readonly created: CreateSessionInput[] = [];
  readonly sent: Array<{ sessionId: string; input: UserMessageInput }> = [];

  async createSession(input: CreateSessionInput): Promise<SessionSummary> {
    this.created.push(input);
    return {
      id: 'session-1',
      name: input.name ?? 'New Chat',
      isFlagged: false,
      isArchived: false,
      labels: [],
      hasUnread: false,
      status: input.status ?? 'active',
      backend: input.backend,
      llmConnectionSlug: input.llmConnectionSlug,
      model: input.model ?? '',
      permissionMode: input.permissionMode,
    };
  }

  async *sendMessage(sessionId: string, input: UserMessageInput): AsyncIterable<SessionEvent> {
    this.sent.push({ sessionId, input });
    yield {
      type: 'text_delta',
      id: 'event-1',
      turnId: input.turnId,
      ts: 1,
      messageId: 'message-1',
      text: 'ok',
    };
    yield {
      type: 'complete',
      id: 'event-2',
      turnId: input.turnId,
      ts: 2,
      stopReason: 'end_turn',
    };
  }

  async stopSession(_sessionId: string): Promise<void> {}
}

function nextId(prefix: string): () => string {
  let count = 0;
  return () => `${prefix}-${++count}`;
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
