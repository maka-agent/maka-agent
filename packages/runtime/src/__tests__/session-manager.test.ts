import { describe, test } from 'node:test';
import { DEEP_RESEARCH_SESSION_LABEL, deriveTurnRecords } from '@maka/core';
import type {
  CreateSessionInput,
  PermissionMode,
  SessionEvent,
  SessionHeader,
  SessionListFilter,
  SessionSummary,
  StoredMessage,
  TurnRecord,
} from '@maka/core';
import type { BackendSendInput, PermissionDecision } from '@maka/core/backend-types';
import { expect } from '../test-helpers.js';
import {
  BackendRegistry,
  SessionManager,
  headerToSummary,
  type BackendFactoryContext,
  type SessionStore,
} from '../session-manager.js';
import type { AgentBackend } from '../ai-sdk-backend.js';

describe('SessionManager permission mode updates', () => {
  test('updates header, rebuilds active backend, and writes an audit note', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    const builtModes: PermissionMode[] = [];
    backends.register('fake', (ctx) => {
      builtModes.push(ctx.header.permissionMode);
      return new TestBackend(ctx);
    });
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(1_000) });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));
    expect(builtModes).toEqual(['ask']);

    const summary = await manager.setPermissionMode(session.id, 'execute');
    expect(summary.permissionMode).toBe('execute');
    expect((await store.readHeader(session.id)).permissionMode).toBe('execute');
    expect(store.disposeCount).toBe(1);

    const messages = await store.readMessages(session.id);
    const modeNote = messages.find((message) => message.type === 'system_note' && message.kind === 'mode_change');
    if (modeNote?.type !== 'system_note') throw new Error('mode_change note was not written');
    expect(modeNote?.data).toEqual({ from: 'ask', to: 'execute' });

    await drain(manager.sendMessage(session.id, { turnId: 'turn-2', text: 'again' }));
    expect(builtModes).toEqual(['ask', 'execute']);
  });

  test('rejects mode changes while a turn is actively streaming', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    const gate = makeGate();
    backends.register('fake', (ctx) => new TestBackend(ctx, gate));
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(2_000) });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));

    const iterator = manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' })[Symbol.asyncIterator]();
    await iterator.next();

    await expectRejects(
      manager.setPermissionMode(session.id, 'explore'),
      /当前对话正在运行/,
    );
    expect((await store.readHeader(session.id)).permissionMode).toBe('ask');

    gate.release();
    await iterator.next();
    await iterator.next();
  });

  test('keeps mode changes blocked until all overlapping turns finish', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    const firstGate = makeGate();
    const secondGate = makeGate();
    const gates = [firstGate, secondGate];
    backends.register('fake', (ctx) => new TestBackend(ctx, gates.shift()));
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(4_000) });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));

    const first = manager.sendMessage(session.id, { turnId: 'turn-1', text: 'first' })[Symbol.asyncIterator]();
    await first.next();
    const second = manager.sendMessage(session.id, { turnId: 'turn-2', text: 'second' })[Symbol.asyncIterator]();
    await second.next();

    firstGate.release();
    await first.next();
    await first.next();
    expect((await store.readHeader(session.id)).status).toBe('running');

    await expectRejects(
      manager.setPermissionMode(session.id, 'execute'),
      /当前对话正在运行/,
    );

    secondGate.release();
    await second.next();
    await second.next();
    expect((await store.readHeader(session.id)).status).toBe('active');

    const summary = await manager.setPermissionMode(session.id, 'execute');
    expect(summary.permissionMode).toBe('execute');
  });

  test('no-op mode changes do not append duplicate audit notes', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(3_000) });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));

    const summary = await manager.setPermissionMode(session.id, 'ask');

    expect(summary.permissionMode).toBe('ask');
    expect((await store.readMessages(session.id)).length).toBe(0);
  });

  test('leaving explore clears the deep research label so visible read-only copy stays truthful', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(6_000) });
    const session = await manager.createSession(makeInput({
      permissionMode: 'explore',
      labels: [DEEP_RESEARCH_SESSION_LABEL, 'kept'],
    }));

    const summary = await manager.setPermissionMode(session.id, 'ask');

    expect(summary.permissionMode).toBe('ask');
    expect(summary.labels).toEqual(['kept']);
    expect((await store.readHeader(session.id)).labels).toEqual(['kept']);

    const messages = await store.readMessages(session.id);
    const modeNote = messages.find((message) => message.type === 'system_note' && message.kind === 'mode_change');
    if (modeNote?.type !== 'system_note') throw new Error('mode_change note was not written');
    expect(modeNote.data).toEqual({ from: 'explore', to: 'ask' });
  });

  test('backend configuration updates rebuild an already-active backend', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    const built: string[] = [];
    backends.register('fake', (ctx) => {
      built.push(`${ctx.header.backend}:${ctx.header.llmConnectionSlug}:${ctx.header.model}`);
      return new TestBackend(ctx);
    });
    backends.register('ai-sdk', (ctx) => {
      built.push(`${ctx.header.backend}:${ctx.header.llmConnectionSlug}:${ctx.header.model}`);
      return new TestBackend(ctx);
    });
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(5_000) });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));
    expect(built).toEqual(['fake:fake:fake-model']);

    const summary = await manager.updateSession(session.id, {
      backend: 'ai-sdk',
      llmConnectionSlug: 'zai-coding-plan',
      model: 'glm-4.7',
    });
    expect(summary.backend).toBe('ai-sdk');
    expect(summary.llmConnectionSlug).toBe('zai-coding-plan');
    expect(store.disposeCount).toBe(1);

    await drain(manager.sendMessage(session.id, { turnId: 'turn-2', text: 'again' }));
    expect(built).toEqual(['fake:fake:fake-model', 'ai-sdk:zai-coding-plan:glm-4.7']);
  });

  test('metadata-only updates keep the active backend instance', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    const built: string[] = [];
    backends.register('fake', (ctx) => {
      built.push(ctx.header.name);
      return new TestBackend(ctx);
    });
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(6_000) });
    const session = await manager.createSession(makeInput({ name: 'Before' }));

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));
    await manager.updateSession(session.id, { name: 'After' });

    expect(store.disposeCount).toBe(0);
    await drain(manager.sendMessage(session.id, { turnId: 'turn-2', text: 'again' }));
    expect(built).toEqual(['Before']);
  });

  test('rejects backend configuration updates while a turn is actively streaming', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    const gate = makeGate();
    backends.register('fake', (ctx) => new TestBackend(ctx, gate));
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(7_000) });
    const session = await manager.createSession(makeInput());

    const iterator = manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' })[Symbol.asyncIterator]();
    await iterator.next();

    await expectRejects(
      manager.updateSession(session.id, {
        backend: 'ai-sdk',
        llmConnectionSlug: 'zai-coding-plan',
        model: 'glm-4.7',
      }),
      /Cannot change backend configuration while a turn is running/,
    );
    const header = await store.readHeader(session.id);
    expect(header.backend).toBe('fake');
    expect(header.llmConnectionSlug).toBe('fake');

    gate.release();
    await iterator.next();
    await iterator.next();
  });

  test('backend build failure after user append marks turn failed and session blocked', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    backends.register('fake', () => {
      throw new Error('backend init failed');
    });
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(7_500) });
    const session = await manager.createSession(makeInput());

    await expectRejects(
      drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' })),
      /backend init failed/,
    );

    const header = await store.readHeader(session.id);
    expect(header.status).toBe('blocked');
    expect(header.blockedReason).toBe('unknown');
    const messages = await store.readMessages(session.id);
    expect(messages.some((message) => message.type === 'user' && message.turnId === 'turn-1')).toBe(true);
    const turn = (await store.listTurns(session.id)).find((candidate) => candidate.turnId === 'turn-1');
    expect(turn?.status).toBe('failed');
  });

  test('marks a session running while a turn is in flight and active after completion', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    const gate = makeGate();
    backends.register('fake', (ctx) => new TestBackend(ctx, gate));
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(8_000) });
    const session = await manager.createSession(makeInput());

    const iterator = manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' })[Symbol.asyncIterator]();
    await iterator.next();
    expect((await store.readHeader(session.id)).status).toBe('running');

    gate.release();
    await iterator.next();
    await iterator.next();
    const header = await store.readHeader(session.id);
    expect(header.status).toBe('active');
    expect(header.blockedReason).toBe(undefined);
    const turns = await store.listTurns(session.id);
    expect(turns.find((turn) => turn.turnId === 'turn-1')?.status).toBe('completed');
  });

  test('marks permission handoff as waiting_for_user', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new EventBackend(ctx, [
      { type: 'permission_request', requestId: 'pr-1', toolUseId: 'tool-1', toolName: 'Bash', category: 'shell_safe', reason: 'custom', args: {} },
      { type: 'complete', stopReason: 'permission_handoff' },
    ]));
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(9_000) });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));

    const header = await store.readHeader(session.id);
    expect(header.status).toBe('waiting_for_user');
    expect(header.blockedReason).toBe(undefined);
  });

  test('rejects mode changes while a tool permission request is waiting', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new EventBackend(ctx, [
      { type: 'permission_request', requestId: 'pr-1', toolUseId: 'tool-1', toolName: 'Bash', category: 'shell_safe', reason: 'custom', args: {} },
      { type: 'complete', stopReason: 'permission_handoff' },
    ]));
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(9_500) });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));

    await expectRejects(
      manager.setPermissionMode(session.id, 'execute'),
      /当前有工具调用正在等待确认/,
    );
    expect((await store.readHeader(session.id)).permissionMode).toBe('ask');
    const messages = await store.readMessages(session.id);
    expect(messages.some((message) => message.type === 'system_note' && message.kind === 'mode_change')).toBe(false);
  });

  test('marks backend errors as blocked with a generalized reason', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new EventBackend(ctx, [
      { type: 'error', recoverable: false, reason: 'tool_failed', message: 'Tool failed' },
    ]));
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(10_000) });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));

    const header = await store.readHeader(session.id);
    expect(header.status).toBe('blocked');
    expect(header.blockedReason).toBe('tool_failed');
    const [turn] = await store.listTurns(session.id);
    expect(turn?.status).toBe('failed');
    expect(turn?.errorClass).toBe('tool_failed');
  });

  test('does not let a late complete event overwrite a prior turn error', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new EventBackend(ctx, [
      { type: 'error', recoverable: false, reason: 'tool_failed', message: 'Tool failed' },
      { type: 'complete', stopReason: 'end_turn' },
    ]));
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(10_500) });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));

    const states = (await store.readMessages(session.id)).filter((message) =>
      message.type === 'turn_state' && message.turnId === 'turn-1'
    );
    expect(states.map((state) => state.type === 'turn_state' ? state.status : '')).toEqual(['running', 'failed']);
    const [turn] = await store.listTurns(session.id);
    expect(turn?.status).toBe('failed');
    expect(turn?.errorClass).toBe('tool_failed');
  });

  test('marks aborts as aborted', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new EventBackend(ctx, [
      { type: 'abort', reason: 'user_stop' },
    ]));
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(11_000) });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));

    const header = await store.readHeader(session.id);
    expect(header.status).toBe('aborted');
    const [turn] = await store.listTurns(session.id);
    expect(turn?.status).toBe('aborted');
    expect(turn?.partialOutputRetained).toBe(false);
  });

  test('cancel keeps partial assistant output and marks the turn aborted', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new PartialAbortBackend(ctx));
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(12_000) });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));

    const [turn] = await store.listTurns(session.id);
    expect(turn?.status).toBe('aborted');
    expect(turn?.partialOutputRetained).toBe(true);
    expect((await store.readMessages(session.id)).some((message) =>
      message.type === 'assistant' && message.turnId === 'turn-1' && message.text === 'partial answer',
    )).toBe(true);
  });

  test('stopSession records renderer abort source for diagnostics', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    const gate = makeGate();
    backends.register('fake', (ctx) => new TestBackend(ctx, gate));
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(12_500) });
    const session = await manager.createSession(makeInput());

    const iterator = manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' })[Symbol.asyncIterator]();
    await iterator.next();
    await manager.stopSession(session.id, { source: 'stop_button' });

    const [turn] = await store.listTurns(session.id);
    expect(turn?.status).toBe('aborted');
    expect(turn?.abortSource).toBe('renderer.stop_button');
    const abortNote = (await store.readMessages(session.id)).find((message) =>
      message.type === 'system_note' && message.kind === 'abort'
    );
    expect(abortNote?.type).toBe('system_note');
    if (abortNote?.type !== 'system_note') throw new Error('abort note missing');
    expect(abortNote.data).toEqual({ source: 'renderer.stop_button' });
  });

  test('stopSession keeps aborted state even if the backend emits a late completion', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    const gate = makeGate();
    backends.register('fake', (ctx) => new TestBackend(ctx, gate));
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(12_700) });
    const session = await manager.createSession(makeInput());

    const iterator = manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' })[Symbol.asyncIterator]();
    await iterator.next();
    await manager.stopSession(session.id, { source: 'stop_button' });

    gate.release();
    await iterator.next();
    await iterator.next();

    expect((await store.readHeader(session.id)).status).toBe('aborted');
    const [turn] = await store.listTurns(session.id);
    expect(turn?.status).toBe('aborted');
    expect(turn?.abortSource).toBe('renderer.stop_button');
  });

  test('startup recovery marks persisted running turns as failed instead of leaving them stuck', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(12_800) });
    const running = await manager.createSession(makeInput({ status: 'running' }));
    const waiting = await manager.createSession(makeInput({ status: 'waiting_for_user' }));
    const activeStuck = await manager.createSession(makeInput({ status: 'active' }));
    const failedThenCompleted = await manager.createSession(makeInput({ status: 'active' }));
    const activeDone = await manager.createSession(makeInput({ status: 'active' }));

    await store.appendMessages(running.id, [
      { type: 'user', id: 'running-user', turnId: 'running-turn', ts: 10, text: 'still running' },
      { type: 'turn_state', id: 'running-state', turnId: 'running-turn', ts: 11, status: 'running', partialOutputRetained: false },
    ]);
    await store.appendMessages(waiting.id, [
      { type: 'user', id: 'waiting-user', turnId: 'waiting-turn', ts: 20, text: 'waiting' },
      { type: 'turn_state', id: 'waiting-state', turnId: 'waiting-turn', ts: 21, status: 'running', partialOutputRetained: false },
    ]);
    await store.appendMessages(activeStuck.id, [
      { type: 'user', id: 'active-stuck-user', turnId: 'active-stuck-turn', ts: 30, text: 'already active but stuck' },
      { type: 'turn_state', id: 'active-stuck-state', turnId: 'active-stuck-turn', ts: 31, status: 'running', partialOutputRetained: false },
    ]);
    await store.appendMessages(failedThenCompleted.id, [
      { type: 'user', id: 'failed-completed-user', turnId: 'failed-completed-turn', ts: 32, text: 'failed then completed' },
      { type: 'turn_state', id: 'failed-completed-running', turnId: 'failed-completed-turn', ts: 33, status: 'running', partialOutputRetained: false },
      { type: 'turn_state', id: 'failed-completed-failed', turnId: 'failed-completed-turn', ts: 34, status: 'failed', errorClass: 'tool_failed', partialOutputRetained: false },
      { type: 'turn_state', id: 'failed-completed-completed', turnId: 'failed-completed-turn', ts: 35, status: 'completed', partialOutputRetained: false },
    ]);
    await store.appendMessages(activeDone.id, [
      { type: 'user', id: 'active-user', turnId: 'active-turn', ts: 30, text: 'done' },
      { type: 'turn_state', id: 'active-state', turnId: 'active-turn', ts: 31, status: 'completed', partialOutputRetained: false },
    ]);

    const recovered = await manager.recoverInterruptedSessions();

    expect(recovered).toEqual([running.id, waiting.id, activeStuck.id, failedThenCompleted.id]);
    expect((await store.readHeader(running.id)).status).toBe('active');
    expect((await store.readHeader(waiting.id)).status).toBe('active');
    expect((await store.readHeader(activeStuck.id)).status).toBe('active');
    expect((await store.readHeader(failedThenCompleted.id)).status).toBe('active');
    expect((await store.readHeader(activeDone.id)).status).toBe('active');
    const runningTurn = (await store.listTurns(running.id)).find((turn) => turn.turnId === 'running-turn');
    const waitingTurn = (await store.listTurns(waiting.id)).find((turn) => turn.turnId === 'waiting-turn');
    const activeStuckTurn = (await store.listTurns(activeStuck.id)).find((turn) => turn.turnId === 'active-stuck-turn');
    const failedThenCompletedTurn = (await store.listTurns(failedThenCompleted.id)).find((turn) => turn.turnId === 'failed-completed-turn');
    const activeTurn = (await store.listTurns(activeDone.id)).find((turn) => turn.turnId === 'active-turn');
    expect(runningTurn?.status).toBe('failed');
    expect(runningTurn?.errorClass).toBe('app_restarted');
    expect(waitingTurn?.status).toBe('failed');
    expect(waitingTurn?.errorClass).toBe('app_restarted');
    expect(activeStuckTurn?.status).toBe('failed');
    expect(activeStuckTurn?.errorClass).toBe('app_restarted');
    expect(failedThenCompletedTurn?.status).toBe('failed');
    expect(failedThenCompletedTurn?.errorClass).toBe('tool_failed');
    expect(activeTurn?.status).toBe('completed');
  });

  test('startup recovery does not leave persisted running sessions stuck when message read fails', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(12_900) });
    const running = await manager.createSession(makeInput({ status: 'running' }));
    const active = await manager.createSession(makeInput({ status: 'active' }));
    store.failReadMessagesFor.add(running.id);
    store.failReadMessagesFor.add(active.id);

    const recovered = await manager.recoverInterruptedSessions();

    expect(recovered).toEqual([running.id]);
    expect((await store.readHeader(running.id)).status).toBe('active');
    expect((await store.readHeader(active.id)).status).toBe('active');
  });

  test('retry creates a new sibling turn and does not rewrite the aborted source turn', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    const events: PartialEvent[] = [
      { type: 'abort', reason: 'user_stop' },
    ];
    backends.register('fake', (ctx) => new EventBackend(ctx, events));
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(13_000) });
    const session = await manager.createSession(makeInput());
    await drain(manager.sendMessage(session.id, { turnId: 'source', text: 'try this' }));

    events.splice(0, events.length, { type: 'complete', stopReason: 'end_turn' });
    await drain(manager.retryTurn(session.id, { sourceTurnId: 'source', turnId: 'retry-1' }));

    const turns = await store.listTurns(session.id);
    expect(turns.find((turn) => turn.turnId === 'source')?.status).toBe('aborted');
    const retry = turns.find((turn) => turn.turnId === 'retry-1');
    expect(retry?.status).toBe('completed');
    expect(retry?.retriedFromTurnId).toBe('source');
    const retryUser = (await store.readMessages(session.id))
      .find((message) => message.type === 'user' && message.turnId === 'retry-1');
    expect(retryUser?.type === 'user' ? retryUser.text : undefined).toBe('try this');
  });

  test('regenerate creates a new sibling turn from a completed source turn', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new EventBackend(ctx, [
      { type: 'complete', stopReason: 'end_turn' },
    ]));
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(14_000) });
    const session = await manager.createSession(makeInput());
    await drain(manager.sendMessage(session.id, { turnId: 'source', text: 'answer this' }));

    await drain(manager.regenerateTurn(session.id, { sourceTurnId: 'source', turnId: 'regen-1' }));

    const turns = await store.listTurns(session.id);
    expect(turns.find((turn) => turn.turnId === 'source')?.status).toBe('completed');
    const regen = turns.find((turn) => turn.turnId === 'regen-1');
    expect(regen?.status).toBe('completed');
    expect(regen?.regeneratedFromTurnId).toBe('source');
  });

  test('branchFromTurn creates a new session with parent lineage and copied message boundary', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new EventBackend(ctx, [
      { type: 'complete', stopReason: 'end_turn' },
    ]));
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(15_000) });
    const session = await manager.createSession(makeInput({ name: 'Parent' }));
    await drain(manager.sendMessage(session.id, { turnId: 'source', text: 'context' }));
    await drain(manager.sendMessage(session.id, { turnId: 'after', text: 'do not copy' }));

    const child = await manager.branchFromTurn(session.id, { sourceTurnId: 'source', name: 'Child' });

    expect(child.parentSessionId).toBe(session.id);
    expect(child.branchOfTurnId).toBe('source');
    const childMessages = await store.readMessages(child.id);
    expect(childMessages.some((message) => (message as { turnId?: string }).turnId === 'source')).toBe(true);
    expect(childMessages.some((message) => (message as { turnId?: string }).turnId === 'after')).toBe(false);
    expect(childMessages.some((message) => message.type === 'turn_state')).toBe(false);
  });
});

class TestBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly sessionId: string;

  constructor(private readonly ctx: BackendFactoryContext, private readonly gate?: Gate) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    yield { type: 'text_delta', id: `${input.turnId}-delta`, turnId: input.turnId, ts: 1, messageId: `${input.turnId}-m`, text: 'ok' };
    await this.gate?.promise;
    yield { type: 'complete', id: `${input.turnId}-complete`, turnId: input.turnId, ts: 2, stopReason: 'end_turn' };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}

  async dispose(): Promise<void> {
    if (this.ctx.store instanceof MemorySessionStore) {
      this.ctx.store.disposeCount += 1;
    }
  }
}

type PartialEvent =
  | Omit<Extract<SessionEvent, { type: 'permission_request' }>, 'id' | 'turnId' | 'ts'>
  | Omit<Extract<SessionEvent, { type: 'complete' }>, 'id' | 'turnId' | 'ts'>
  | Omit<Extract<SessionEvent, { type: 'error' }>, 'id' | 'turnId' | 'ts'>
  | Omit<Extract<SessionEvent, { type: 'abort' }>, 'id' | 'turnId' | 'ts'>;

class EventBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly sessionId: string;

  constructor(private readonly ctx: BackendFactoryContext, private readonly events: PartialEvent[]) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    let index = 0;
    for (const event of this.events) {
      index += 1;
      yield {
        ...event,
        id: `${input.turnId}-${index}`,
        turnId: input.turnId,
        ts: index,
      } as SessionEvent;
    }
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

class PartialAbortBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly sessionId: string;

  constructor(private readonly ctx: BackendFactoryContext) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    await this.ctx.store.appendMessage(this.sessionId, {
      type: 'assistant',
      id: `${input.turnId}-assistant`,
      turnId: input.turnId,
      ts: 12_001,
      text: 'partial answer',
      modelId: 'fake-model',
    });
    yield { type: 'abort', id: `${input.turnId}-abort`, turnId: input.turnId, ts: 12_002, reason: 'user_stop' };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

class MemorySessionStore implements SessionStore {
  private headers = new Map<string, SessionHeader>();
  private messages = new Map<string, StoredMessage[]>();
  readonly failReadMessagesFor = new Set<string>();
  disposeCount = 0;

  async create(input: CreateSessionInput): Promise<SessionHeader> {
    const header: SessionHeader = {
      id: `session-${this.headers.size + 1}`,
      workspaceRoot: '/tmp/workspace',
      cwd: input.cwd,
      createdAt: 1,
      lastUsedAt: 1,
      name: input.name ?? 'New Chat',
      isFlagged: false,
      labels: input.labels ?? [],
      isArchived: false,
      status: input.status ?? 'active',
      ...(input.blockedReason ? { blockedReason: input.blockedReason } : {}),
      statusUpdatedAt: 1,
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      ...(input.branchOfTurnId ? { branchOfTurnId: input.branchOfTurnId } : {}),
      hasUnread: false,
      backend: input.backend,
      llmConnectionSlug: input.llmConnectionSlug,
      connectionLocked: false,
      model: input.model ?? 'fake-model',
      permissionMode: input.permissionMode,
      schemaVersion: 1,
    };
    this.headers.set(header.id, header);
    this.messages.set(header.id, []);
    return header;
  }

  async list(_filter?: SessionListFilter): Promise<SessionSummary[]> {
    return Array.from(this.headers.values()).map(headerToSummary);
  }

  async readHeader(sessionId: string): Promise<SessionHeader> {
    const header = this.headers.get(sessionId);
    if (!header) throw new Error(`Unknown session ${sessionId}`);
    return header;
  }

  async readMessages(sessionId: string): Promise<StoredMessage[]> {
    if (this.failReadMessagesFor.has(sessionId)) throw new Error(`Cannot read messages for ${sessionId}`);
    return [...(this.messages.get(sessionId) ?? [])];
  }

  async listTurns(sessionId: string): Promise<TurnRecord[]> {
    return deriveTurnRecords(await this.readMessages(sessionId));
  }

  async appendMessage(sessionId: string, message: StoredMessage): Promise<void> {
    await this.appendMessages(sessionId, [message]);
  }

  async appendMessages(sessionId: string, messages: StoredMessage[]): Promise<void> {
    this.messages.set(sessionId, [...(this.messages.get(sessionId) ?? []), ...messages]);
  }

  async updateHeader(sessionId: string, patch: Partial<SessionHeader>): Promise<SessionHeader> {
    const current = await this.readHeader(sessionId);
    const next = { ...current, ...patch };
    this.headers.set(sessionId, next);
    return next;
  }

  async archive(sessionId: string): Promise<void> {
    await this.updateHeader(sessionId, { isArchived: true, status: 'archived', statusUpdatedAt: 1 });
  }

  async unarchive(sessionId: string): Promise<void> {
    await this.updateHeader(sessionId, { isArchived: false, status: 'active', blockedReason: undefined, statusUpdatedAt: 1 });
  }

  async setFlagged(sessionId: string, isFlagged: boolean): Promise<void> {
    await this.updateHeader(sessionId, { isFlagged });
  }

  async rename(sessionId: string, name: string): Promise<void> {
    await this.updateHeader(sessionId, { name });
  }

  async remove(sessionId: string): Promise<void> {
    this.headers.delete(sessionId);
    this.messages.delete(sessionId);
  }
}

interface Gate {
  promise: Promise<void>;
  release(): void;
}

function makeGate(): Gate {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function makeInput(overrides: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    cwd: '/tmp/cwd',
    backend: 'fake',
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask',
    name: 'Session',
    labels: [],
    ...overrides,
  };
}

function nextId(): () => string {
  let id = 0;
  return () => `id-${++id}`;
}

function nextNow(start: number): () => number {
  let ts = start;
  return () => ++ts;
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of iterable) {
    // consume
  }
}

async function expectRejects(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(err instanceof Error ? err.message : String(err)).toMatch(pattern);
    return;
  }
  throw new Error('Expected promise to reject');
}
