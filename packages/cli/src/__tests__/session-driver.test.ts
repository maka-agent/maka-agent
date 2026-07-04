import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CreateSessionInput, PermissionMode, PermissionResponse, SessionEvent, SessionSummary, UserMessageInput } from '@maka/core';
import { createMakaSessionDriver } from '../session-driver.js';

describe('Maka session driver', () => {
  test('creates an ask-permission session from the first prompt and streams the turn', async () => {
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
      permissionMode: 'ask',
    }]);
    assert.deepEqual(runtime.sent, [{
      sessionId: 'session-1',
      input: { turnId: 'turn-1', text: 'please inspect this workspace' },
    }]);
    assert.deepEqual(events.map((event) => event.type), ['text_delta', 'complete']);
  });

  test('can still create a bypass session when explicitly requested', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
      permissionMode: 'bypass',
      newId: nextId('turn'),
    });

    await collect(driver.sendPrompt('ship fast'));

    assert.equal(runtime.created[0]?.permissionMode, 'bypass');
  });

  test('uses an updated permission mode for a new session', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    await driver.setPermissionMode('execute');
    await collect(driver.sendPrompt('run tests'));

    assert.equal(runtime.created[0]?.permissionMode, 'execute');
  });

  test('updates permission mode on an active session', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    await collect(driver.sendPrompt('run tests'));
    await driver.setPermissionMode('execute');

    assert.deepEqual(runtime.permissionModes, [{
      sessionId: 'session-1',
      mode: 'execute',
    }]);
  });

  test('uses an updated model for a new session', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    await driver.setModel('claude-opus-4-1');
    await collect(driver.sendPrompt('run tests'));

    assert.equal(runtime.created[0]?.model, 'claude-opus-4-1');
  });

  test('updates model on an active session', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    await collect(driver.sendPrompt('run tests'));
    await driver.setModel('claude-opus-4-1');

    assert.deepEqual(runtime.sessionUpdates, [{
      sessionId: 'session-1',
      patch: { model: 'claude-opus-4-1' },
    }]);
  });

  test('switches to an existing session for the next prompt', async () => {
    const runtime = new RecordingRuntime();
    runtime.sessionSummaries = [{
      id: 'session-2',
      name: 'Existing chat',
      isFlagged: false,
      isArchived: false,
      labels: [],
      hasUnread: false,
      status: 'active',
      backend: 'ai-sdk',
      llmConnectionSlug: 'anthropic',
      model: 'claude-opus-4-1',
      permissionMode: 'execute',
    }];
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    const summary = await driver.switchSession('session-2');
    await collect(driver.sendPrompt('continue'));

    assert.equal(summary.id, 'session-2');
    assert.deepEqual(runtime.created, []);
    assert.equal(runtime.sent[0]?.sessionId, 'session-2');
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

  test('routes permission responses to the active session', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
      newId: nextId('turn'),
    });

    await collect(driver.sendPrompt('run tests'));
    await driver.respondToPermission({
      requestId: 'permission-1',
      decision: 'allow',
      rememberForTurn: true,
    });

    assert.deepEqual(runtime.permissionResponses, [{
      sessionId: 'session-1',
      response: {
        requestId: 'permission-1',
        decision: 'allow',
        rememberForTurn: true,
      },
    }]);
  });
});

class RecordingRuntime {
  readonly created: CreateSessionInput[] = [];
  readonly sent: Array<{ sessionId: string; input: UserMessageInput }> = [];
  readonly permissionResponses: Array<{ sessionId: string; response: PermissionResponse }> = [];
  readonly permissionModes: Array<{ sessionId: string; mode: PermissionMode }> = [];
  readonly sessionUpdates: Array<{ sessionId: string; patch: { model?: string } }> = [];
  sessionSummaries: SessionSummary[] = [];

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

  async respondToPermission(sessionId: string, response: PermissionResponse): Promise<void> {
    this.permissionResponses.push({ sessionId, response });
  }

  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<SessionSummary> {
    this.permissionModes.push({ sessionId, mode });
    return {
      id: sessionId,
      name: 'New Chat',
      isFlagged: false,
      isArchived: false,
      labels: [],
      hasUnread: false,
      status: 'active',
      backend: 'ai-sdk',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
      permissionMode: mode,
    };
  }

  async updateSession(sessionId: string, patch: { model?: string }): Promise<SessionSummary> {
    this.sessionUpdates.push({ sessionId, patch });
    return {
      id: sessionId,
      name: 'New Chat',
      isFlagged: false,
      isArchived: false,
      labels: [],
      hasUnread: false,
      status: 'active',
      backend: 'ai-sdk',
      llmConnectionSlug: 'anthropic',
      model: patch.model ?? 'claude-sonnet-4-5',
      permissionMode: 'ask',
    };
  }

  async listSessions(): Promise<SessionSummary[]> {
    return this.sessionSummaries;
  }
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
