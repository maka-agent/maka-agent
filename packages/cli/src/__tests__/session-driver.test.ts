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
  UserQuestionResponse,
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
      patch: { model: 'claude-opus-4-1', thinkingLevel: undefined },
    }]);
  });

  test('switches connection and model together on an active session', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    await collect(driver.sendPrompt('run tests'));
    await driver.setModel('glm-5.2', 'zai');

    // The connection rides in the same updateSession patch, so the next turn
    // rebuilds the backend on the new provider.
    assert.deepEqual(runtime.sessionUpdates, [{
      sessionId: 'session-1',
      patch: { model: 'glm-5.2', thinkingLevel: undefined, llmConnectionSlug: 'zai' },
    }]);
  });

  test('a same-connection setModel does not churn the connection', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    await collect(driver.sendPrompt('run tests'));
    await driver.setModel('claude-opus-4-1', 'anthropic');

    assert.deepEqual(runtime.sessionUpdates, [{
      sessionId: 'session-1',
      patch: { model: 'claude-opus-4-1', thinkingLevel: undefined },
    }]);
  });

  test('creates the next session on a connection chosen before any session exists', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    await driver.setModel('glm-5.2', 'zai');
    await collect(driver.sendPrompt('run tests'));

    assert.equal(runtime.created[0]?.llmConnectionSlug, 'zai');
    assert.equal(runtime.created[0]?.model, 'glm-5.2');
  });

  test('renames the active session through runtime updateSession', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    await collect(driver.sendPrompt('run tests'));
    await driver.renameSession('watcher 根目录事件风暴修复');

    assert.deepEqual(runtime.sessionUpdates, [{
      sessionId: 'session-1',
      patch: { name: 'watcher 根目录事件风暴修复' },
    }]);
  });

  test('rejects rename before a session starts', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    await assert.rejects(driver.renameSession('too early'), /before a session starts/);
    assert.deepEqual(runtime.sessionUpdates, []);
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
        /Session has no working directory/,
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
    const deleted = sessionSummary({ id: 'deleted-worktree', cwd: missingCwd });
    runtime.sessionSummaries = [deleted];
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    assert.deepEqual(await driver.getSessionResumeAvailability?.(deleted), {
      available: false,
      reason: 'Working directory no longer exists',
    });
    await assert.rejects(
      driver.switchSession('deleted-worktree'),
      new RegExp(`Session cwd no longer exists: ${escapeRegExp(missingCwd)}`),
    );
    assert.equal(driver.getSessionId(), null);
  });

  test('switches across folders and uses the resumed cwd for the next new session', async () => {
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

      const resumed = await driver.switchSession('other-folder');
      driver.startNewSession();
      await collect(driver.sendPrompt('new work here'));

      assert.equal(resumed.summary.cwd, elsewhere);
      assert.equal(runtime.sent[0]?.sessionId, 'session-1');
      assert.equal(runtime.created[1]?.cwd, elsewhere);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  test('adopts the resumed connection and model for the next new session', async () => {
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

      await driver.switchSession('other-conn');
      driver.startNewSession();
      await collect(driver.sendPrompt('new work here'));

      assert.equal(runtime.created[1]?.llmConnectionSlug, 'other-connection');
      assert.equal(runtime.created[1]?.model, 'claude-sonnet-4-5');
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

  test('compacts the active session through the runtime compact API', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
      newId: fixedIds('turn-1', 'turn-compact'),
    });

    await collect(driver.sendPrompt('hello'));
    const events = await collect(driver.compactSession());

    assert.deepEqual(runtime.compacted, [{ sessionId: 'session-1', input: { turnId: 'turn-compact' } }]);
    assert.deepEqual(runtime.sent.map((item) => item.input.text), ['hello']);
    assert.deepEqual(events.map((event) => event.type), ['complete']);
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

  test('routes user-question responses to the active session', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
      newId: nextId('turn'),
    });

    await collect(driver.sendPrompt('choose'));
    await driver.respondToUserQuestion?.({ requestId: 'question-1', answers: ['A', null] });

    assert.deepEqual(runtime.userQuestionResponses, [{
      sessionId: 'session-1',
      response: { requestId: 'question-1', answers: ['A', null] },
    }]);
  });

  test('lists rewind targets newest-first, one per prompted turn, including the latest', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    await collect(driver.sendPrompt('first question'));
    runtime.sessionMessages.set('session-1', [
      storedUserMessage('user-1', 'turn-1', '  first question\nmore detail'),
      storedAssistantMessage('assistant-1', 'turn-1', 'first answer'),
      storedUserMessage('user-2', 'turn-2', 'second question'),
      storedAssistantMessage('assistant-2', 'turn-2', 'second answer'),
      storedUserMessage('user-3', 'turn-3', 'third question'),
    ]);

    const targets = await driver.listRewindTargets();

    // Rewinding resets to *before* a turn, so the latest turn (turn-3) is itself a
    // valid target (undo it, edit its prompt, resend). All prompted turns appear
    // newest-first, label = first non-empty prompt line.
    assert.deepEqual(targets, [
      { turnId: 'turn-3', label: 'third question' },
      { turnId: 'turn-2', label: 'second question' },
      { turnId: 'turn-1', label: 'first question' },
    ]);
  });

  test('surfaces the interrupted latest turn as a rewind target', async () => {
    // Regression: interrupting a turn leaves its (aborted) turn_state as the last
    // message, so the old head-exclusion dropped exactly the turn the user wanted
    // to redo. Every prompted turn is now a target regardless of the trailing
    // message.
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    await collect(driver.sendPrompt('first question'));
    runtime.sessionMessages.set('session-1', [
      storedUserMessage('user-1', 'turn-1', 'first question'),
      storedAssistantMessage('assistant-1', 'turn-1', 'first answer'),
      storedUserMessage('user-2', 'turn-2', 'interrupted question'),
      storedTurnState('state-2', 'turn-2', 'aborted'),
    ]);

    assert.deepEqual(await driver.listRewindTargets(), [
      { turnId: 'turn-2', label: 'interrupted question' },
      { turnId: 'turn-1', label: 'first question' },
    ]);
  });

  test('keeps all prompted turns as targets when the head is a non-prompt turn (e.g. compact)', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    await collect(driver.sendPrompt('first question'));
    // A /compact turn has no user message, so it never becomes a target itself;
    // the prompted turns around it stay listed unchanged.
    runtime.sessionMessages.set('session-1', [
      storedUserMessage('user-1', 'turn-1', 'first question'),
      storedAssistantMessage('assistant-1', 'turn-1', 'first answer'),
      storedUserMessage('user-2', 'turn-2', 'second question'),
      storedAssistantMessage('assistant-2', 'turn-2', 'second answer'),
      storedContextCompactedNote('note-1', 'turn-compact'),
    ]);

    const targets = await driver.listRewindTargets();

    assert.deepEqual(targets, [
      { turnId: 'turn-2', label: 'second question' },
      { turnId: 'turn-1', label: 'first question' },
    ]);
  });

  test('keeps the only prompted turn as a target after a compact', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    await collect(driver.sendPrompt('only question'));
    runtime.sessionMessages.set('session-1', [
      storedUserMessage('user-1', 'turn-1', 'only question'),
      storedAssistantMessage('assistant-1', 'turn-1', 'only answer'),
      storedContextCompactedNote('note-1', 'turn-compact'),
    ]);

    assert.deepEqual(await driver.listRewindTargets(), [
      { turnId: 'turn-1', label: 'only question' },
    ]);
  });

  test('lists no rewind targets before a session starts, but the sole turn once one exists', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    assert.deepEqual(await driver.listRewindTargets(), []);

    await collect(driver.sendPrompt('only question'));
    runtime.sessionMessages.set('session-1', [
      storedUserMessage('user-1', 'turn-1', 'only question'),
      storedAssistantMessage('assistant-1', 'turn-1', 'only answer'),
    ]);
    // The single turn is now rewindable: reset to before it (an empty branch) and
    // refill its prompt.
    assert.deepEqual(await driver.listRewindTargets(), [
      { turnId: 'turn-1', label: 'only question' },
    ]);
  });

  test('rewinds by branching before the turn, switching onto the branch, and returning its prompt', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'maka-rewind-cwd-'));
    try {
      const runtime = new RecordingRuntime();
      runtime.sessionSummaries = [sessionSummary({ id: 'session-1', cwd: repo })];
      runtime.sessionMessages.set('session-1', [
        storedUserMessage('user-1', 'turn-1', 'first question'),
        storedAssistantMessage('assistant-1', 'turn-1', 'first answer'),
        storedUserMessage('user-2', 'turn-2', 'second question\nwith detail'),
      ]);
      const driver = createMakaSessionDriver({
        runtime,
        cwd: repo,
        llmConnectionSlug: 'anthropic',
        model: 'claude-sonnet-4-5',
      });
      await driver.switchSession('session-1');

      const result = await driver.rewindToTurn('turn-2');

      // Branches *before* turn-2 (dropping it), and returns turn-2's full prompt
      // — the whole text, not the one-line label — for the editor to refill.
      assert.deepEqual(runtime.branchedBefore, [{ sessionId: 'session-1', sourceTurnId: 'turn-2' }]);
      assert.deepEqual(runtime.branched, []);
      assert.equal(result.summary.id, 'session-1-branch');
      assert.equal(result.prompt, 'second question\nwith detail');
      assert.equal(driver.getSessionId(), 'session-1-branch');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('rejects rewind to a turn with no user prompt', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    await collect(driver.sendPrompt('first question'));
    runtime.sessionMessages.set('session-1', [
      storedUserMessage('user-1', 'turn-1', 'first question'),
      storedContextCompactedNote('note-1', 'turn-compact'),
    ]);

    await assert.rejects(driver.rewindToTurn('turn-compact'), /no user prompt/);
    assert.deepEqual(runtime.branchedBefore, []);
  });

  test('rejects rewind before a session starts', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    await assert.rejects(driver.rewindToTurn('turn-1'), /before a session starts/);
    assert.deepEqual(runtime.branchedBefore, []);
  });

  test('startNewSession makes the next prompt create a fresh session, keeping settings', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    await driver.setModel('claude-opus-4-1');
    await collect(driver.sendPrompt('first'));
    assert.equal(driver.getSessionId(), 'session-1');

    driver.startNewSession();
    assert.equal(driver.getSessionId(), null);

    await collect(driver.sendPrompt('second'));
    // A second createSession call — the prompt started a new session rather than
    // reusing the old one — and it kept the current model.
    assert.equal(runtime.created.length, 2);
    assert.equal(runtime.created[1]?.model, 'claude-opus-4-1');
    assert.equal(runtime.created[1]?.name, 'second');
  });
});

class RecordingRuntime {
  readonly created: CreateSessionInput[] = [];
  readonly sent: Array<{ sessionId: string; input: UserMessageInput }> = [];
  readonly compacted: Array<{ sessionId: string; input: { turnId?: string } }> = [];
  readonly permissionResponses: Array<{ sessionId: string; response: PermissionResponse }> = [];
  readonly userQuestionResponses: Array<{ sessionId: string; response: UserQuestionResponse }> = [];
  readonly permissionModes: Array<{ sessionId: string; mode: PermissionMode }> = [];
  readonly sessionUpdates: Array<{ sessionId: string; patch: { model?: string; llmConnectionSlug?: string; thinkingLevel?: import('@maka/core/model-thinking').ThinkingLevel | undefined; name?: string } }> = [];
  readonly branched: Array<{ sessionId: string; sourceTurnId: string }> = [];
  readonly branchedBefore: Array<{ sessionId: string; sourceTurnId: string }> = [];
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

  async *compactSession(sessionId: string, input: { turnId?: string } = {}): AsyncIterable<SessionEvent> {
    this.compacted.push({ sessionId, input });
    yield {
      type: 'complete',
      id: 'event-compact-complete',
      turnId: input.turnId ?? 'turn-compact',
      ts: 3,
      stopReason: 'end_turn',
    };
  }

  async stopSession(_sessionId: string): Promise<void> {}

  async respondToPermission(sessionId: string, response: PermissionResponse): Promise<void> {
    this.permissionResponses.push({ sessionId, response });
  }

  async respondToUserQuestion(sessionId: string, response: UserQuestionResponse): Promise<void> {
    this.userQuestionResponses.push({ sessionId, response });
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

  async updateSession(sessionId: string, patch: { model?: string; llmConnectionSlug?: string; thinkingLevel?: import('@maka/core/model-thinking').ThinkingLevel | undefined; name?: string }): Promise<SessionSummary> {
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
      llmConnectionSlug: patch.llmConnectionSlug ?? 'anthropic',
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

  async branchFromTurn(sessionId: string, input: { sourceTurnId: string; name?: string }): Promise<SessionSummary> {
    this.branched.push({ sessionId, sourceTurnId: input.sourceTurnId });
    return this.recordBranch(sessionId);
  }

  async branchBeforeTurn(sessionId: string, input: { sourceTurnId: string; name?: string }): Promise<SessionSummary> {
    this.branchedBefore.push({ sessionId, sourceTurnId: input.sourceTurnId });
    return this.recordBranch(sessionId);
  }

  private recordBranch(sessionId: string): SessionSummary {
    // Model a branch by adding a new summary to the list switchSession reads.
    const source = this.sessionSummaries.find((session) => session.id === sessionId);
    const branch: SessionSummary = {
      ...(source ?? sessionSummary({ id: sessionId })),
      id: `${sessionId}-branch`,
    };
    this.sessionSummaries = [...this.sessionSummaries, branch];
    this.sessionMessages.set(branch.id, this.sessionMessages.get(sessionId) ?? []);
    return branch;
  }
}

function nextId(prefix: string): () => string {
  let count = 0;
  return () => `${prefix}-${++count}`;
}

function fixedIds(...ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? ids[ids.length - 1] ?? 'id';
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

function storedContextCompactedNote(id: string, turnId: string): StoredMessage {
  return {
    type: 'system_note',
    id,
    turnId,
    ts: 3,
    kind: 'context_compacted',
  };
}

function storedTurnState(id: string, turnId: string, status: 'completed' | 'aborted' | 'failed'): StoredMessage {
  return {
    type: 'turn_state',
    id,
    turnId,
    ts: 4,
    status,
    partialOutputRetained: false,
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
