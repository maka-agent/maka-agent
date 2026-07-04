import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type {
  CreateSessionInput,
  PermissionMode,
  PermissionResponse,
  SessionEvent,
  SessionSummary,
  StoredMessage,
  UserMessageInput,
} from '@maka/core';
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
    const repo = await mkdtemp(join(tmpdir(), 'maka-switch-cwd-'));
    try {
      const runtime = new RecordingRuntime();
      runtime.sessionSummaries = [{
        id: 'session-2',
        cwd: repo,
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
      runtime.sessionMessages.set('session-2', [
        storedUserMessage('user-1', 'turn-1', 'previous question'),
        storedAssistantMessage('assistant-1', 'turn-1', 'previous answer'),
      ]);
      const driver = createMakaSessionDriver({
        runtime,
        cwd: repo,
        llmConnectionSlug: 'anthropic',
        model: 'claude-sonnet-4-5',
      });

      const summary = await driver.switchSession('session-2');
      await collect(driver.sendPrompt('continue'));

      assert.equal(summary.summary.id, 'session-2');
      assert.deepEqual(summary.messages.map((message) => message.id), ['user-1', 'assistant-1']);
      assert.deepEqual(runtime.created, []);
      assert.equal(runtime.sent[0]?.sessionId, 'session-2');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('rejects a session summary without a cwd and leaves the active session unchanged', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'maka-active-cwd-'));
    try {
      const runtime = new RecordingRuntime();
      runtime.sessionSummaries = [{ ...sessionSummary({ id: 'no-cwd' }), cwd: undefined }];
      const driver = createMakaSessionDriver({
        runtime,
        cwd: repo,
        llmConnectionSlug: 'anthropic',
        model: 'claude-sonnet-4-5',
      });
      await collect(driver.sendPrompt('hi'));

      await assert.rejects(
        driver.switchSession('no-cwd'),
        /Session belongs to a different folder/,
      );

      await collect(driver.sendPrompt('again'));
      assert.equal(runtime.sent[0]?.sessionId, 'session-1');
      assert.equal(runtime.sent[1]?.sessionId, 'session-1');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('rejects switching to a session whose cwd no longer exists', async () => {
    const missingCwd = await mkdtemp(join(tmpdir(), 'maka-missing-session-cwd-'));
    await rm(missingCwd, { recursive: true, force: true });
    const runtime = new RecordingRuntime();
    runtime.sessionSummaries = [
      sessionSummary({ id: 'deleted-worktree', cwd: missingCwd }),
    ];
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    await assert.rejects(
      driver.switchSession('deleted-worktree'),
      new RegExp(`Session cwd no longer exists: ${escapeRegExp(missingCwd)}`),
    );
    assert.equal(driver.getSessionId(), null);
  });

  test('refuses to switch across folders and leaves the active session unchanged', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'maka-active-cwd-'));
    const elsewhere = await mkdtemp(join(tmpdir(), 'maka-other-cwd-'));
    try {
      const runtime = new RecordingRuntime();
      runtime.sessionSummaries = [sessionSummary({ id: 'other-folder', cwd: elsewhere })];
      const driver = createMakaSessionDriver({
        runtime,
        cwd: repo,
        llmConnectionSlug: 'anthropic',
        model: 'claude-sonnet-4-5',
      });
      await collect(driver.sendPrompt('hi'));

      await assert.rejects(
        driver.switchSession('other-folder'),
        /Session belongs to a different folder/,
      );

      // The rejected switch must not move the active session: the next prompt
      // still lands on the original session.
      await collect(driver.sendPrompt('again'));
      assert.equal(runtime.sent[0]?.sessionId, 'session-1');
      assert.equal(runtime.sent[1]?.sessionId, 'session-1');
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  test('refuses to switch across connections and leaves the active session unchanged', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'maka-active-cwd-'));
    try {
      const runtime = new RecordingRuntime();
      runtime.sessionSummaries = [
        sessionSummary({ id: 'other-conn', cwd: repo, llmConnectionSlug: 'other-connection' }),
      ];
      const driver = createMakaSessionDriver({
        runtime,
        cwd: repo,
        llmConnectionSlug: 'anthropic',
        model: 'claude-sonnet-4-5',
      });
      await collect(driver.sendPrompt('hi'));

      await assert.rejects(
        driver.switchSession('other-conn'),
        /Session uses a different connection/,
      );

      await collect(driver.sendPrompt('again'));
      assert.equal(runtime.sent[0]?.sessionId, 'session-1');
      assert.equal(runtime.sent[1]?.sessionId, 'session-1');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('lists current-cwd sessions before other recent sessions', async () => {
    const runtime = new RecordingRuntime();
    runtime.sessionSummaries = [
      sessionSummary({ id: 'other-newer', cwd: '/other', lastMessageAt: 30 }),
      sessionSummary({ id: 'cwd-newer', cwd: '/repo', lastMessageAt: 20 }),
      sessionSummary({ id: 'cwd-older', cwd: '/repo', lastMessageAt: 10 }),
    ];
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    const sessions = await driver.listSessions();

    assert.deepEqual(sessions.map((session) => session.id), [
      'cwd-newer',
      'cwd-older',
      'other-newer',
    ]);
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
  readonly sessionMessages = new Map<string, StoredMessage[]>();
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

  async getMessages(sessionId: string): Promise<StoredMessage[]> {
    return this.sessionMessages.get(sessionId) ?? [];
  }
}

function nextId(prefix: string): () => string {
  let count = 0;
  return () => `${prefix}-${++count}`;
}

function sessionSummary(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: 'session',
    cwd: '/repo',
    name: 'Existing chat',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'anthropic',
    model: 'claude-sonnet-4-5',
    permissionMode: 'ask',
    ...overrides,
  };
}

function storedUserMessage(id: string, turnId: string, text: string): StoredMessage {
  return {
    type: 'user',
    id,
    turnId,
    ts: 1,
    text,
  };
}

function storedAssistantMessage(id: string, turnId: string, text: string): StoredMessage {
  return {
    type: 'assistant',
    id,
    turnId,
    ts: 2,
    text,
    modelId: 'claude-sonnet-4-5',
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
