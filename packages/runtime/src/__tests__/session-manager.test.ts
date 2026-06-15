import { describe, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { DEEP_RESEARCH_SESSION_LABEL, deriveTurnRecords } from '@maka/core';
import type {
  CreateSessionInput,
  PermissionMode,
  AgentRunEvent,
  AgentRunHeader,
  AgentRunStore,
  RuntimeEvent,
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
import type { InvocationResult } from '../invocation-context.js';

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
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const firstGate = makeGate();
    const secondGate = makeGate();
    const gates = [firstGate, secondGate];
    backends.register('fake', (ctx) => new TestBackend(ctx, gates.shift()));
    const manager = new SessionManager({ store, runStore, backends, newId: nextId(), now: nextNow(4_000) });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));

    const first = manager.sendMessage(session.id, { turnId: 'turn-1', text: 'first' })[Symbol.asyncIterator]();
    await first.next();
    const second = manager.sendMessage(session.id, { turnId: 'turn-2', text: 'second' })[Symbol.asyncIterator]();
    await second.next();

    firstGate.release();
    await first.next();
    await first.next();
    expect((await store.readHeader(session.id)).status).toBe('running');
    const afterFirstRuns = await runStore.listSessionRuns(session.id);
    expect(afterFirstRuns.find((run) => run.turnId === 'turn-1')?.status).toBe('completed');
    expect(afterFirstRuns.find((run) => run.turnId === 'turn-2')?.status).toBe('running');

    await expectRejects(
      manager.setPermissionMode(session.id, 'execute'),
      /当前对话正在运行/,
    );

    secondGate.release();
    await second.next();
    await second.next();
    expect((await store.readHeader(session.id)).status).toBe('active');
    const finalRuns = await runStore.listSessionRuns(session.id);
    expect(finalRuns.map((run) => [run.turnId, run.status])).toEqual([
      ['turn-1', 'completed'],
      ['turn-2', 'completed'],
    ]);
    const firstEvents = await runStore.readEvents(session.id, finalRuns[0]!.runId);
    expect(firstEvents.map((event) => event.type)).toContain('run_created');
    expect(firstEvents.map((event) => event.type)).toContain('run_started');
    expect(firstEvents.map((event) => event.type)).toContain('run_completed');

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

  test('sendMessage is driven through RuntimeRunner while preserving the SessionEvent stream', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const observed: InvocationResult[] = [];
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_500),
      runtimeSource: 'test',
      runtimeInvocationObserver: (result) => {
        observed.push(result);
      },
    });
    const session = await manager.createSession(makeInput());

    const sessionEvents = await collectSessionEvents(
      manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }),
    );

    expect(sessionEvents.map((event) => event.type)).toEqual(['text_delta', 'complete']);
    expect(sessionEvents.map((event) => event.id)).toEqual(['turn-1-delta', 'turn-1-complete']);
    expect(observed.length).toBe(1);

    const [run] = await runStore.listSessionRuns(session.id);
    if (!run) throw new Error('AgentRunStore run was not created');
    const result = observed[0]!;
    expect(result.runId).toBe(run.runId);
    expect(result.sessionId).toBe(session.id);
    expect(result.turnId).toBe('turn-1');
    expect(result.status).toBe('completed');
    expect(result.events.map((event) => event.runId)).toEqual([run.runId, run.runId, run.runId]);
    expect(result.events.map((event) => event.sessionId)).toEqual([session.id, session.id, session.id]);
    expect(result.events.map((event) => event.turnId)).toEqual(['turn-1', 'turn-1', 'turn-1']);
    expect(result.events.map((event) => event.role)).toEqual(['user', 'model', 'system']);
    expect(result.events.map((event) => event.id)).toEqual(['id-7', 'turn-1-delta', 'turn-1-complete']);
    expect(result.events[0]?.content).toEqual({ kind: 'text', text: 'hello' });
    expect(result.events[1]?.content).toEqual({ kind: 'text', text: 'ok' });
    expect(result.events[2]?.status).toBe('completed');

    const runtimeEvents = await runStore.readRuntimeEvents(session.id, run.runId);
    expect(runtimeEvents.map((event) => event.id)).toEqual(['id-7', 'turn-1-delta', 'turn-1-complete']);
    expect(runtimeEvents.map((event) => event.runId)).toEqual([run.runId, run.runId, run.runId]);
    expect(runtimeEvents.map((event) => event.sessionId)).toEqual([session.id, session.id, session.id]);
    expect(runtimeEvents.map((event) => event.turnId)).toEqual(['turn-1', 'turn-1', 'turn-1']);
    expect(runtimeEvents.map((event) => event.role)).toEqual(['user', 'model', 'system']);
    expect(runtimeEvents[0]?.content).toEqual({ kind: 'text', text: 'hello' });
    expect(runtimeEvents[1]?.content).toEqual({ kind: 'text', text: 'ok' });
    expect(runtimeEvents[2]?.status).toBe('completed');
  });

  test('runtime event ledger write failure does not fail sendMessage', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore({ failRuntimeEventAppends: true });
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_750),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());

    const sessionEvents = await collectSessionEvents(
      manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }),
    );

    expect(sessionEvents.map((event) => event.type)).toEqual(['text_delta', 'complete']);
    expect(sessionEvents.map((event) => event.id)).toEqual(['turn-1-delta', 'turn-1-complete']);
    const [run] = await runStore.listSessionRuns(session.id);
    if (!run) throw new Error('AgentRunStore run was not created');
    expect(await runStore.readRuntimeEvents(session.id, run.runId)).toEqual([]);
  });

  test('getMessages prefers RuntimeEvent-projected messages when legacy rows are present', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    const seeded = await seedRuntimeReadTurn({
      store,
      runStore,
      sessionId: session.id,
      turnId: 'turn-1',
      runId: 'run-1',
      userText: 'runtime question',
      assistantText: 'runtime answer',
      legacyIdPrefix: 'legacy',
    });

    const messages = await manager.getMessages(session.id);

    expect(messages).toEqual(seeded.projectedMessages);
    expect(JSON.stringify(messages.map((message) => message.id)) === JSON.stringify(seeded.legacyMessages.map((message) => message.id))).toBe(false);
  });

  test('getMessages falls back to legacy when projection is missing a legacy semantic row', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    const legacyMessages: StoredMessage[] = [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'question' },
      { type: 'assistant', id: 'legacy-assistant', turnId: 'turn-1', ts: 102, text: 'legacy answer', modelId: 'fake-model' },
      { type: 'turn_state', id: 'legacy-state', turnId: 'turn-1', ts: 103, status: 'completed', partialOutputRetained: true },
    ];
    await store.appendMessages(session.id, legacyMessages);
    await seedRuntimeRun(runStore, makeRunHeader({
      sessionId: session.id,
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'completed',
      createdAt: 100,
      updatedAt: 103,
      completedAt: 103,
    }), [
      runtimeEvent({ id: 'rt-user', sessionId: session.id, runId: 'run-1', turnId: 'turn-1', ts: 101, role: 'user', author: 'user', content: { kind: 'text', text: 'question' } }),
      runtimeEvent({ id: 'rt-complete', sessionId: session.id, runId: 'run-1', turnId: 'turn-1', ts: 103, role: 'system', author: 'system', status: 'completed', actions: { endInvocation: true } }),
    ]);

    expect(await manager.getMessages(session.id)).toEqual(legacyMessages);
  });

  test('getMessages falls back to legacy when a terminal run has no runtime ledger', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    const legacyMessages: StoredMessage[] = [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'legacy only' },
      { type: 'turn_state', id: 'legacy-state', turnId: 'turn-1', ts: 102, status: 'completed', partialOutputRetained: false },
    ];
    await store.appendMessages(session.id, legacyMessages);
    await runStore.createRun(makeRunHeader({
      sessionId: session.id,
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'completed',
      completedAt: 102,
    }));

    expect(await manager.getMessages(session.id)).toEqual(legacyMessages);
  });

  test('getMessages falls back to legacy when runtime ledger read fails', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore({ failRuntimeEventReads: true });
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    const seeded = await seedRuntimeReadTurn({
      store,
      runStore,
      sessionId: session.id,
      turnId: 'turn-1',
      runId: 'run-1',
      userText: 'legacy question',
      assistantText: 'legacy answer',
      legacyIdPrefix: 'legacy',
    });

    expect(await manager.getMessages(session.id)).toEqual(seeded.legacyMessages);
  });

  test('MAKA_RUNTIME_READ_SOURCE=legacy forces legacy reads even when RuntimeEvents are complete', async () => {
    const previous = process.env.MAKA_RUNTIME_READ_SOURCE;
    process.env.MAKA_RUNTIME_READ_SOURCE = 'legacy';
    try {
      const store = new MemorySessionStore();
      const runStore = new MemoryAgentRunStore();
      const manager = makeManagerForReadCutover(store, runStore);
      const session = await manager.createSession(makeInput());
      const seeded = await seedRuntimeReadTurn({
        store,
        runStore,
        sessionId: session.id,
        turnId: 'turn-1',
        runId: 'run-1',
        userText: 'legacy forced question',
        assistantText: 'legacy forced answer',
        legacyIdPrefix: 'legacy',
      });

      expect(await manager.getMessages(session.id)).toEqual(seeded.legacyMessages);
    } finally {
      if (previous === undefined) delete process.env.MAKA_RUNTIME_READ_SOURCE;
      else process.env.MAKA_RUNTIME_READ_SOURCE = previous;
    }
  });

  test('listTurns derives from the RuntimeEvent-primary message view', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    await seedRuntimeReadTurn({
      store,
      runStore,
      sessionId: session.id,
      turnId: 'turn-1',
      runId: 'run-1',
      userText: 'runtime question',
      assistantText: 'runtime answer',
      legacyIdPrefix: 'legacy',
    });
    store.failListTurnsFor.add(session.id);

    const turns = await manager.listTurns(session.id);

    expect(turns).toEqual([
      {
        turnId: 'turn-1',
        status: 'completed',
        partialOutputRetained: true,
      },
    ]);
  });

  test('mixed legacy-only system notes force legacy fallback instead of disappearing', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    const seeded = await seedRuntimeReadTurn({
      store,
      runStore,
      sessionId: session.id,
      turnId: 'turn-1',
      runId: 'run-1',
      userText: 'question',
      assistantText: 'answer',
      legacyIdPrefix: 'legacy',
    });
    const legacyNote: StoredMessage = {
      type: 'system_note',
      id: 'legacy-note',
      ts: 104,
      kind: 'mode_change',
      data: { from: 'ask', to: 'execute' },
    };
    await store.appendMessage(session.id, legacyNote);

    const messages = await manager.getMessages(session.id);

    expect(messages).toEqual([...seeded.legacyMessages, legacyNote]);
  });

  test('getMessages orders RuntimeEvent-primary reads by session event chronology across runs', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    await seedRuntimeRun(runStore, makeRunHeader({
      sessionId: session.id,
      runId: 'slow-run',
      turnId: 'slow',
      status: 'completed',
      createdAt: 100,
      updatedAt: 107,
      completedAt: 107,
    }), [
      runtimeEvent({
        id: 'slow-user',
        sessionId: session.id,
        runId: 'slow-run',
        turnId: 'slow',
        ts: 101,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'slow question' },
        refs: { storedMessageId: 'slow-user-message' },
      }),
      runtimeEvent({
        id: 'slow-assistant',
        sessionId: session.id,
        runId: 'slow-run',
        turnId: 'slow',
        ts: 106,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'slow answer' },
        refs: { storedMessageId: 'slow-assistant-message' },
      }),
      runtimeEvent({
        id: 'slow-complete',
        sessionId: session.id,
        runId: 'slow-run',
        turnId: 'slow',
        ts: 107,
        role: 'system',
        author: 'system',
        status: 'completed',
        actions: { endInvocation: true },
      }),
    ]);
    await seedRuntimeRun(runStore, makeRunHeader({
      sessionId: session.id,
      runId: 'fast-run',
      turnId: 'fast',
      status: 'completed',
      createdAt: 102,
      updatedAt: 105,
      completedAt: 105,
    }), [
      runtimeEvent({
        id: 'fast-user',
        sessionId: session.id,
        runId: 'fast-run',
        turnId: 'fast',
        ts: 103,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'fast question' },
        refs: { storedMessageId: 'fast-user-message' },
      }),
      runtimeEvent({
        id: 'fast-assistant',
        sessionId: session.id,
        runId: 'fast-run',
        turnId: 'fast',
        ts: 104,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'fast answer' },
        refs: { storedMessageId: 'fast-assistant-message' },
      }),
      runtimeEvent({
        id: 'fast-complete',
        sessionId: session.id,
        runId: 'fast-run',
        turnId: 'fast',
        ts: 105,
        role: 'system',
        author: 'system',
        status: 'completed',
        actions: { endInvocation: true },
      }),
    ]);
    store.failNextReadMessagesFor.set(session.id, 1);

    const messages = await manager.getMessages(session.id);

    expect(messages.map((message) => `${message.type}:${'turnId' in message ? message.turnId : 'none'}:${message.ts}`)).toEqual([
      'user:slow:101',
      'user:fast:103',
      'assistant:fast:104',
      'turn_state:fast:105',
      'assistant:slow:106',
      'turn_state:slow:107',
    ]);
  });

  test('retry finds aborted source turns and user messages through the RuntimeEvent-primary view', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new EventBackend(ctx, [
      { type: 'complete', stopReason: 'end_turn' },
    ]));
    const manager = new SessionManager({ store, runStore, backends, newId: nextId(), now: nextNow(6_760) });
    const session = await manager.createSession(makeInput());
    await seedRuntimeRun(runStore, makeRunHeader({
      sessionId: session.id,
      runId: 'source-run',
      turnId: 'source',
      status: 'cancelled',
      createdAt: 100,
      updatedAt: 102,
      completedAt: 102,
    }), [
      runtimeEvent({ id: 'source-user', sessionId: session.id, runId: 'source-run', turnId: 'source', ts: 101, role: 'user', author: 'user', content: { kind: 'text', text: 'runtime retry text' } }),
      runtimeEvent({ id: 'source-abort', sessionId: session.id, runId: 'source-run', turnId: 'source', ts: 102, role: 'system', author: 'system', status: 'aborted', actions: { endInvocation: true, stateDelta: { abortSource: 'renderer.stop_button' } } }),
    ]);
    store.failNextReadMessagesFor.set(session.id, 1);

    await drain(manager.retryTurn(session.id, { sourceTurnId: 'source', turnId: 'retry-1' }));

    const retryUser = (await store.readMessages(session.id))
      .find((message) => message.type === 'user' && message.turnId === 'retry-1');
    expect(retryUser?.type === 'user' ? retryUser.text : undefined).toBe('runtime retry text');
  });

  test('regenerate finds completed source turns through the RuntimeEvent-primary view', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new EventBackend(ctx, [
      { type: 'complete', stopReason: 'end_turn' },
    ]));
    const manager = new SessionManager({ store, runStore, backends, newId: nextId(), now: nextNow(6_770) });
    const session = await manager.createSession(makeInput());
    await seedRuntimeReadTurn({
      store,
      runStore,
      sessionId: session.id,
      turnId: 'source',
      runId: 'source-run',
      userText: 'runtime regenerate text',
      assistantText: 'runtime answer',
      legacyIdPrefix: 'legacy',
    });
    store.failNextReadMessagesFor.set(session.id, 1);

    await drain(manager.regenerateTurn(session.id, { sourceTurnId: 'source', turnId: 'regen-1' }));

    const messages = await store.readMessages(session.id);
    const regenUser = messages.find((message) => message.type === 'user' && message.turnId === 'regen-1');
    expect(regenUser?.type === 'user' ? regenUser.text : undefined).toBe('runtime regenerate text');
    const regenState = deriveTurnRecords(messages).find((turn) => turn.turnId === 'regen-1');
    expect(regenState?.regeneratedFromTurnId).toBe('source');
  });

  test('branchFromTurn copies through the RuntimeEvent-primary message boundary', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput({ name: 'Parent' }));
    await seedRuntimeReadTurn({
      store,
      runStore,
      sessionId: session.id,
      turnId: 'source',
      runId: 'source-run',
      userText: 'runtime branch context',
      assistantText: 'runtime branch answer',
      legacyIdPrefix: 'legacy',
    });
    store.failNextReadMessagesFor.set(session.id, 1);

    const child = await manager.branchFromTurn(session.id, { sourceTurnId: 'source', name: 'Child' });

    const childMessages = await store.readMessages(child.id);
    expect(childMessages[0]).toMatchObject({ type: 'user', turnId: 'source', text: 'runtime branch context' });
    expect(childMessages[1]).toMatchObject({ type: 'assistant', turnId: 'source', text: 'runtime branch answer' });
    expect(childMessages[2]).toMatchObject({ type: 'system_note', kind: 'session_start' });
    expect(childMessages.some((message) => message.type === 'turn_state')).toBe(false);
  });

  test('multi-run RuntimeEvent projection preserves retry regenerate and branch lineage on turns', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    await seedRuntimeReadTurn({
      store,
      runStore,
      sessionId: session.id,
      turnId: 'root',
      runId: 'root-run',
      userText: 'root question',
      assistantText: 'root answer',
      legacyIdPrefix: 'root-legacy',
    });
    await seedRuntimeReadTurnWithHeader({
      store,
      runStore,
      sessionId: session.id,
      turnId: 'retry',
      runId: 'retry-run',
      userText: 'retry question',
      assistantText: 'retry answer',
      legacyIdPrefix: 'retry-legacy',
      header: { parentTurnId: 'root', retriedFromTurnId: 'root' },
      tsBase: 200,
    });
    await seedRuntimeReadTurnWithHeader({
      store,
      runStore,
      sessionId: session.id,
      turnId: 'regen',
      runId: 'regen-run',
      userText: 'regen question',
      assistantText: 'regen answer',
      legacyIdPrefix: 'regen-legacy',
      header: { parentTurnId: 'root', regeneratedFromTurnId: 'root' },
      tsBase: 300,
    });
    await seedRuntimeReadTurnWithHeader({
      store,
      runStore,
      sessionId: session.id,
      turnId: 'branch',
      runId: 'branch-run',
      userText: 'branch question',
      assistantText: 'branch answer',
      legacyIdPrefix: 'branch-legacy',
      header: { parentSessionId: 'parent-session', branchOfTurnId: 'root' },
      tsBase: 400,
    });
    store.failNextReadMessagesFor.set(session.id, 1);

    const turns = await manager.listTurns(session.id);

    expect(turns.find((turn) => turn.turnId === 'retry')).toMatchObject({
      status: 'completed',
      parentTurnId: 'root',
      retriedFromTurnId: 'root',
    });
    expect(turns.find((turn) => turn.turnId === 'regen')).toMatchObject({
      status: 'completed',
      parentTurnId: 'root',
      regeneratedFromTurnId: 'root',
    });
    expect(turns.find((turn) => turn.turnId === 'branch')).toMatchObject({
      status: 'completed',
      parentSessionId: 'parent-session',
      branchOfTurnId: 'root',
    });
  });

  test('getMessages keeps legacy SessionStore behavior when no runStore is provided', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(6_760) });
    const session = await manager.createSession(makeInput());
    const legacyMessages: StoredMessage[] = [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'legacy only' },
    ];
    await store.appendMessages(session.id, legacyMessages);

    expect(await manager.getMessages(session.id)).toEqual(legacyMessages);
  });

  test('next turn receives complete prior RuntimeEvent context alongside legacy context', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const backendInstances: TestBackend[] = [];
    backends.register('fake', (ctx) => {
      const backend = new TestBackend(ctx);
      backendInstances.push(backend);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_800),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'first' }));
    await drain(manager.sendMessage(session.id, { turnId: 'turn-2', text: 'second' }));

    const secondInput = backendInstances[0]?.sendInputs[1];
    if (!secondInput) throw new Error('second backend input was not recorded');
    expect(secondInput.context.some((message) => message.type === 'user' && message.turnId === 'turn-1')).toBe(true);
    expect(secondInput.context.some((message) => message.type === 'user' && message.turnId === 'turn-2')).toBe(true);
    expect(secondInput.runtimeContext?.map((event) => event.turnId)).toEqual(['turn-1', 'turn-1', 'turn-1']);
    expect(secondInput.runtimeContext?.map((event) => event.role)).toEqual(['user', 'model', 'system']);
    expect(secondInput.runtimeContext?.[0]?.content).toEqual({ kind: 'text', text: 'first' });
  });

  test('next turn remains legacy-only when prior RuntimeEvent ledger is unusable', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore({ failRuntimeEventAppends: true });
    const backends = new BackendRegistry();
    const backendInstances: TestBackend[] = [];
    backends.register('fake', (ctx) => {
      const backend = new TestBackend(ctx);
      backendInstances.push(backend);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_900),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'first' }));
    await drain(manager.sendMessage(session.id, { turnId: 'turn-2', text: 'second' }));

    const secondInput = backendInstances[0]?.sendInputs[1];
    if (!secondInput) throw new Error('second backend input was not recorded');
    expect(secondInput.runtimeContext).toBeUndefined();
    expect(secondInput.context.some((message) => message.type === 'user' && message.turnId === 'turn-1')).toBe(true);
    expect(secondInput.context.some((message) => message.type === 'user' && message.turnId === 'turn-2')).toBe(true);
  });

  test('sendMessage production source uses AiSdkFlow instead of an inline mapper flow', async () => {
    const source = await readFile(new URL('../../src/session-manager.ts', import.meta.url), 'utf8');
    const sendMessageSource = source.slice(
      source.indexOf('async *sendMessage'),
      source.indexOf('async stopSession'),
    );

    expect(sendMessageSource.includes('new AiSdkFlow')).toBe(true);
    expect(sendMessageSource.includes('mapSessionEventToRuntimeEvent')).toBe(false);
    expect(sendMessageSource.includes('createSessionEventMapMemory')).toBe(false);
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
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', () => {
      throw new Error('backend init failed');
    });
    const manager = new SessionManager({ store, runStore, backends, newId: nextId(), now: nextNow(7_500) });
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
    const [run] = await runStore.listSessionRuns(session.id);
    expect(run?.status).toBe('failed');
    expect(run?.failureClass).toBe('Error');
    const events = await runStore.readEvents(session.id, run!.runId);
    expect(events.map((event) => event.type)).toContain('run_failed');
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
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new EventBackend(ctx, [
      { type: 'permission_request', requestId: 'pr-1', toolUseId: 'tool-1', toolName: 'Bash', category: 'shell_safe', reason: 'custom', args: {} },
      { type: 'complete', stopReason: 'permission_handoff' },
    ]));
    const manager = new SessionManager({ store, runStore, backends, newId: nextId(), now: nextNow(9_000) });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));

    const header = await store.readHeader(session.id);
    expect(header.status).toBe('waiting_for_user');
    expect(header.blockedReason).toBe(undefined);
    const [run] = await runStore.listSessionRuns(session.id);
    const events = await runStore.readEvents(session.id, run!.runId);
    expect(events.some((event) =>
      event.type === 'run_status_changed' &&
      event.data?.sessionStatus === 'waiting_for_user'
    )).toBe(true);
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
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const gate = makeGate();
    backends.register('fake', (ctx) => new TestBackend(ctx, gate));
    const manager = new SessionManager({ store, runStore, backends, newId: nextId(), now: nextNow(12_700) });
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
    const [run] = await runStore.listSessionRuns(session.id);
    expect(run?.status).toBe('cancelled');
    const events = await runStore.readEvents(session.id, run!.runId);
    expect(events.map((event) => event.type)).toContain('run_cancelled');
  });

  test('durable run ledger records lifecycle trace events and redacts obvious secrets', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TraceBackend(ctx));
    const manager = new SessionManager({ store, runStore, backends, newId: nextId(), now: nextNow(12_750) });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));

    const [run] = await runStore.listSessionRuns(session.id);
    expect(run?.backendKind).toBe('fake');
    expect(run?.llmConnectionSlug).toBe('fake');
    expect(run?.modelId).toBe('fake-model');
    expect(run?.permissionMode).toBe('ask');
    expect(run?.status).toBe('completed');
    const events = await runStore.readEvents(session.id, run!.runId);
    expect(events.map((event) => event.type)).toContain('model_stream_started');
    expect(events.map((event) => event.type)).toContain('usage_recorded');
    expect(events.map((event) => event.type)).toContain('run_completed');
    expect(JSON.stringify(events).includes('sk-live-secret-token-value')).toBe(false);
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

  test('startup recovery uses AgentRun ledger to fail stale running model-started runs', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({ store, runStore, backends, newId: nextId(), now: nextNow(12_810) });
    const session = await manager.createSession(makeInput({ status: 'running' }));
    await seedRunningTurn(store, session.id, 'turn-1');
    await seedRun(runStore, makeRunHeader({
      sessionId: session.id,
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'running',
    }), [
      makeRunEvent({ sessionId: session.id, runId: 'run-1', turnId: 'turn-1', type: 'run_started', ts: 11 }),
      makeRunEvent({ sessionId: session.id, runId: 'run-1', turnId: 'turn-1', type: 'model_stream_started', ts: 12 }),
    ]);

    const recovered = await manager.recoverInterruptedSessions();

    expect(recovered).toEqual([session.id]);
    expect((await store.readHeader(session.id)).status).toBe('active');
    const [turn] = await store.listTurns(session.id);
    expect(turn?.status).toBe('failed');
    expect(turn?.errorClass).toBe('app_restarted');
    const [run] = await runStore.listSessionRuns(session.id);
    expect(run?.status).toBe('failed');
    expect(run?.failureClass).toBe('app_restarted');
    const events = await runStore.readEvents(session.id, 'run-1');
    expect(events.map((event) => event.type)).toContain('run_failed');
  });

  test('startup recovery fails stale tool tails while preserving partial output retention', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({ store, runStore, backends, newId: nextId(), now: nextNow(12_820) });
    const session = await manager.createSession(makeInput({ status: 'running' }));
    await seedRunningTurn(store, session.id, 'turn-1');
    await store.appendMessage(session.id, {
      type: 'assistant',
      id: 'partial-assistant',
      turnId: 'turn-1',
      ts: 13,
      text: 'partial output',
      modelId: 'fake-model',
    });
    await seedRun(runStore, makeRunHeader({
      sessionId: session.id,
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'running',
    }), [
      makeRunEvent({ sessionId: session.id, runId: 'run-1', turnId: 'turn-1', type: 'run_started', ts: 11 }),
      makeRunEvent({ sessionId: session.id, runId: 'run-1', turnId: 'turn-1', type: 'tool_started', ts: 12 }),
    ]);

    await manager.recoverInterruptedSessions();

    const [turn] = await store.listTurns(session.id);
    expect(turn?.status).toBe('failed');
    expect(turn?.errorClass).toBe('app_restarted');
    expect(turn?.partialOutputRetained).toBe(true);
    const [run] = await runStore.listSessionRuns(session.id);
    expect(run?.status).toBe('failed');
  });

  test('startup recovery does not leave stale permission waits stuck', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({ store, runStore, backends, newId: nextId(), now: nextNow(12_830) });
    const session = await manager.createSession(makeInput({ status: 'waiting_for_user' }));
    await seedRunningTurn(store, session.id, 'turn-1');
    await seedRun(runStore, makeRunHeader({
      sessionId: session.id,
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'waiting_permission',
    }), [
      makeRunEvent({ sessionId: session.id, runId: 'run-1', turnId: 'turn-1', type: 'permission_requested', ts: 12 }),
    ]);

    await manager.recoverInterruptedSessions();

    expect((await store.readHeader(session.id)).status).toBe('active');
    const [turn] = await store.listTurns(session.id);
    expect(turn?.status).toBe('failed');
    expect(turn?.errorClass).toBe('app_restarted');
    const [run] = await runStore.listSessionRuns(session.id);
    expect(run?.status).toBe('failed');
    expect(run?.failureClass).toBe('app_restarted');
  });

  test('startup recovery repairs stale completed model tails without leaving running runs', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({ store, runStore, backends, newId: nextId(), now: nextNow(12_840) });
    const session = await manager.createSession(makeInput({ status: 'running' }));
    await seedRunningTurn(store, session.id, 'turn-1');
    await seedRun(runStore, makeRunHeader({
      sessionId: session.id,
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'running',
    }), [
      makeRunEvent({ sessionId: session.id, runId: 'run-1', turnId: 'turn-1', type: 'model_stream_started', ts: 11 }),
      makeRunEvent({ sessionId: session.id, runId: 'run-1', turnId: 'turn-1', type: 'model_stream_completed', ts: 12 }),
    ]);

    await manager.recoverInterruptedSessions();

    expect((await store.readHeader(session.id)).status).toBe('active');
    const [run] = await runStore.listSessionRuns(session.id);
    expect(run?.status === 'running' || run?.status === 'waiting_permission').toBe(false);
    const [turn] = await store.listTurns(session.id);
    expect(turn?.status === 'running').toBe(false);
  });

  test('startup recovery tolerates corrupt AgentRun events and records a conservative failed state', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({ store, runStore, backends, newId: nextId(), now: nextNow(12_850) });
    const session = await manager.createSession(makeInput({ status: 'running' }));
    await seedRunningTurn(store, session.id, 'turn-1');
    await seedRun(runStore, makeRunHeader({
      sessionId: session.id,
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'running',
    }), [
      makeRunEvent({ sessionId: session.id, runId: 'run-1', turnId: 'turn-1', type: 'run_started', ts: 11 }),
      makeRunEvent({
        sessionId: session.id,
        runId: 'run-1',
        turnId: 'turn-1',
        type: 'event_corrupt',
        ts: 12,
        message: 'Invalid AgentRun event JSONL line',
      }),
    ]);

    const recovered = await manager.recoverInterruptedSessions();

    expect(recovered).toEqual([session.id]);
    const [run] = await runStore.listSessionRuns(session.id);
    expect(run?.status).toBe('failed');
    expect(run?.failureClass).toBe('app_restarted');
    const events = await runStore.readEvents(session.id, 'run-1');
    expect(events.map((event) => event.type)).toContain('event_corrupt');
    expect(events.map((event) => event.type)).toContain('run_failed');
  });

  test('startup recovery keeps terminal AgentRun ledger entries idempotent', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({ store, runStore, backends, newId: nextId(), now: nextNow(12_860) });
    const completed = await manager.createSession(makeInput({ status: 'active' }));
    const failed = await manager.createSession(makeInput({ status: 'active' }));
    const cancelled = await manager.createSession(makeInput({ status: 'active' }));
    await seedRun(runStore, makeRunHeader({
      sessionId: completed.id,
      runId: 'completed-run',
      turnId: 'completed-turn',
      status: 'completed',
      completedAt: 20,
    }), [
      makeRunEvent({ sessionId: completed.id, runId: 'completed-run', turnId: 'completed-turn', type: 'run_completed', ts: 20 }),
    ]);
    await seedRun(runStore, makeRunHeader({
      sessionId: failed.id,
      runId: 'failed-run',
      turnId: 'failed-turn',
      status: 'failed',
      failureClass: 'tool_failed',
      completedAt: 21,
    }), [
      makeRunEvent({ sessionId: failed.id, runId: 'failed-run', turnId: 'failed-turn', type: 'run_failed', ts: 21, data: { failureClass: 'tool_failed' } }),
    ]);
    await seedRun(runStore, makeRunHeader({
      sessionId: cancelled.id,
      runId: 'cancelled-run',
      turnId: 'cancelled-turn',
      status: 'cancelled',
      completedAt: 22,
    }), [
      makeRunEvent({ sessionId: cancelled.id, runId: 'cancelled-run', turnId: 'cancelled-turn', type: 'run_cancelled', ts: 22 }),
    ]);

    const recovered = await manager.recoverInterruptedSessions();

    expect(recovered).toEqual([]);
    expect((await runStore.readRun(completed.id, 'completed-run')).status).toBe('completed');
    expect((await runStore.readEvents(completed.id, 'completed-run')).map((event) => event.type)).toEqual(['run_completed']);
    expect((await runStore.readRun(failed.id, 'failed-run')).failureClass).toBe('tool_failed');
    expect((await runStore.readEvents(failed.id, 'failed-run')).map((event) => event.type)).toEqual(['run_failed']);
    expect((await runStore.readRun(cancelled.id, 'cancelled-run')).status).toBe('cancelled');
    expect((await runStore.readEvents(cancelled.id, 'cancelled-run')).map((event) => event.type)).toEqual(['run_cancelled']);
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
  readonly sendInputs: BackendSendInput[] = [];

  constructor(private readonly ctx: BackendFactoryContext, private readonly gate?: Gate) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.sendInputs.push(input);
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

class TraceBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly sessionId: string;

  constructor(private readonly ctx: BackendFactoryContext) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.ctx.recordRunTrace?.({
      id: `${input.turnId}-trace-start`,
      sessionId: this.sessionId,
      turnId: input.turnId,
      ts: 1,
      phase: 'model',
      type: 'model_stream_started',
      message: 'Model stream started with Bearer sk-live-secret-token-value',
      data: {
        activeTools: ['Read'],
        credential: 'sk-live-secret-token-value',
      },
    });
    yield { type: 'text_delta', id: `${input.turnId}-delta`, turnId: input.turnId, ts: 2, messageId: `${input.turnId}-m`, text: 'ok' };
    this.ctx.recordRunTrace?.({
      id: `${input.turnId}-trace-usage`,
      sessionId: this.sessionId,
      turnId: input.turnId,
      ts: 3,
      phase: 'usage',
      type: 'usage_recorded',
      message: 'Token usage recorded',
      data: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    yield { type: 'complete', id: `${input.turnId}-complete`, turnId: input.turnId, ts: 4, stopReason: 'end_turn' };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

class MemorySessionStore implements SessionStore {
  private headers = new Map<string, SessionHeader>();
  private messages = new Map<string, StoredMessage[]>();
  readonly failReadMessagesFor = new Set<string>();
  readonly failNextReadMessagesFor = new Map<string, number>();
  readonly failListTurnsFor = new Set<string>();
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
    const remainingFailures = this.failNextReadMessagesFor.get(sessionId) ?? 0;
    if (remainingFailures > 0) {
      if (remainingFailures === 1) this.failNextReadMessagesFor.delete(sessionId);
      else this.failNextReadMessagesFor.set(sessionId, remainingFailures - 1);
      throw new Error(`Cannot read messages for ${sessionId}`);
    }
    if (this.failReadMessagesFor.has(sessionId)) throw new Error(`Cannot read messages for ${sessionId}`);
    return [...(this.messages.get(sessionId) ?? [])];
  }

  async listTurns(sessionId: string): Promise<TurnRecord[]> {
    if (this.failListTurnsFor.has(sessionId)) throw new Error(`Cannot list turns for ${sessionId}`);
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

class MemoryAgentRunStore implements AgentRunStore {
  private headers = new Map<string, AgentRunHeader>();
  private events = new Map<string, AgentRunEvent[]>();
  private runtimeEvents = new Map<string, RuntimeEvent[]>();

  constructor(private readonly options: { failRuntimeEventAppends?: boolean; failRuntimeEventReads?: boolean } = {}) {}

  async createRun(header: AgentRunHeader): Promise<AgentRunHeader> {
    this.headers.set(key(header.sessionId, header.runId), { ...header });
    return { ...header };
  }

  async updateRun(sessionId: string, runId: string, patch: Partial<AgentRunHeader>): Promise<AgentRunHeader> {
    const current = await this.readRun(sessionId, runId);
    const next = { ...current, ...patch, sessionId, runId };
    this.headers.set(key(sessionId, runId), next);
    return { ...next };
  }

  async readRun(sessionId: string, runId: string): Promise<AgentRunHeader> {
    const header = this.headers.get(key(sessionId, runId));
    if (!header) throw new Error(`Unknown run ${runId}`);
    return { ...header };
  }

  async listSessionRuns(sessionId: string): Promise<AgentRunHeader[]> {
    return Array.from(this.headers.values())
      .filter((header) => header.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId))
      .map((header) => ({ ...header }));
  }

  async appendEvent(sessionId: string, runId: string, event: AgentRunEvent): Promise<void> {
    const eventKey = key(sessionId, runId);
    this.events.set(eventKey, [...(this.events.get(eventKey) ?? []), copyEvent(event)]);
  }

  async readEvents(sessionId: string, runId: string): Promise<AgentRunEvent[]> {
    return (this.events.get(key(sessionId, runId)) ?? []).map(copyEvent);
  }

  async appendRuntimeEvent(sessionId: string, runId: string, event: RuntimeEvent): Promise<void> {
    if (this.options.failRuntimeEventAppends) throw new Error('runtime event append failed');
    const eventKey = key(sessionId, runId);
    this.runtimeEvents.set(eventKey, [...(this.runtimeEvents.get(eventKey) ?? []), copyRuntimeEvent(event)]);
  }

  async readRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]> {
    if (this.options.failRuntimeEventReads) throw new Error('runtime event read failed');
    return (this.runtimeEvents.get(key(sessionId, runId)) ?? []).map(copyRuntimeEvent);
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

function makeRunHeader(overrides: Partial<AgentRunHeader> = {}): AgentRunHeader {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    status: 'running',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/tmp/cwd',
    permissionMode: 'ask',
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  };
}

function makeRunEvent(overrides: Partial<AgentRunEvent> = {}): AgentRunEvent {
  return {
    type: 'run_started',
    id: `${overrides.runId ?? 'run-1'}-${overrides.type ?? 'run_started'}-${overrides.ts ?? 10}`,
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 10,
    ...overrides,
  };
}

function makeManagerForReadCutover(store: MemorySessionStore, runStore: AgentRunStore): SessionManager {
  const backends = new BackendRegistry();
  backends.register('fake', (ctx) => new TestBackend(ctx));
  return new SessionManager({ store, runStore, backends, newId: nextId(), now: nextNow(6_755) });
}

async function seedRuntimeReadTurn(input: {
  store: MemorySessionStore;
  runStore: AgentRunStore;
  sessionId: string;
  turnId: string;
  runId: string;
  userText: string;
  assistantText: string;
  legacyIdPrefix: string;
}): Promise<{ legacyMessages: StoredMessage[]; projectedMessages: StoredMessage[] }> {
  const header = makeRunHeader({
    sessionId: input.sessionId,
    runId: input.runId,
    turnId: input.turnId,
    status: 'completed',
    createdAt: 100,
    updatedAt: 103,
    completedAt: 103,
  });
  const events = [
    runtimeEvent({
      id: `${input.runId}-user-event`,
      sessionId: input.sessionId,
      runId: input.runId,
      turnId: input.turnId,
      ts: 101,
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: input.userText },
      refs: { storedMessageId: `${input.runId}-projected-user` },
    }),
    runtimeEvent({
      id: `${input.runId}-assistant-event`,
      sessionId: input.sessionId,
      runId: input.runId,
      turnId: input.turnId,
      ts: 102,
      role: 'model',
      author: 'agent',
      content: { kind: 'text', text: input.assistantText },
      refs: { storedMessageId: `${input.runId}-projected-assistant` },
    }),
    runtimeEvent({
      id: `${input.runId}-complete-event`,
      sessionId: input.sessionId,
      runId: input.runId,
      turnId: input.turnId,
      ts: 103,
      role: 'system',
      author: 'system',
      status: 'completed',
      actions: { endInvocation: true },
    }),
  ];
  const legacyMessages: StoredMessage[] = [
    { type: 'user', id: `${input.legacyIdPrefix}-user`, turnId: input.turnId, ts: 101, text: input.userText },
    { type: 'assistant', id: `${input.legacyIdPrefix}-assistant`, turnId: input.turnId, ts: 102, text: input.assistantText, modelId: 'fake-model' },
    { type: 'turn_state', id: `${input.legacyIdPrefix}-state`, turnId: input.turnId, ts: 103, status: 'completed', partialOutputRetained: true },
  ];
  const projectedMessages: StoredMessage[] = [
    { type: 'user', id: `${input.runId}-projected-user`, turnId: input.turnId, ts: 101, text: input.userText },
    { type: 'assistant', id: `${input.runId}-projected-assistant`, turnId: input.turnId, ts: 102, text: input.assistantText, modelId: 'fake-model' },
    { type: 'turn_state', id: `${input.runId}-complete-event`, turnId: input.turnId, ts: 103, status: 'completed', partialOutputRetained: true },
  ];
  await input.store.appendMessages(input.sessionId, legacyMessages);
  await seedRuntimeRun(input.runStore, header, events);
  return { legacyMessages, projectedMessages };
}

async function seedRuntimeReadTurnWithHeader(input: {
  store: MemorySessionStore;
  runStore: AgentRunStore;
  sessionId: string;
  turnId: string;
  runId: string;
  userText: string;
  assistantText: string;
  legacyIdPrefix: string;
  header: Partial<AgentRunHeader>;
  tsBase: number;
}): Promise<void> {
  const header = makeRunHeader({
    sessionId: input.sessionId,
    runId: input.runId,
    turnId: input.turnId,
    status: 'completed',
    createdAt: input.tsBase,
    updatedAt: input.tsBase + 3,
    completedAt: input.tsBase + 3,
    ...input.header,
  });
  const events = [
    runtimeEvent({
      id: `${input.runId}-user-event`,
      sessionId: input.sessionId,
      runId: input.runId,
      turnId: input.turnId,
      ts: input.tsBase + 1,
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: input.userText },
      refs: { storedMessageId: `${input.runId}-projected-user` },
    }),
    runtimeEvent({
      id: `${input.runId}-assistant-event`,
      sessionId: input.sessionId,
      runId: input.runId,
      turnId: input.turnId,
      ts: input.tsBase + 2,
      role: 'model',
      author: 'agent',
      content: { kind: 'text', text: input.assistantText },
      refs: { storedMessageId: `${input.runId}-projected-assistant` },
    }),
    runtimeEvent({
      id: `${input.runId}-complete-event`,
      sessionId: input.sessionId,
      runId: input.runId,
      turnId: input.turnId,
      ts: input.tsBase + 3,
      role: 'system',
      author: 'system',
      status: 'completed',
      actions: { endInvocation: true },
    }),
  ];
  await input.store.appendMessages(input.sessionId, [
    { type: 'user', id: `${input.legacyIdPrefix}-user`, turnId: input.turnId, ts: input.tsBase + 1, text: input.userText },
    { type: 'assistant', id: `${input.legacyIdPrefix}-assistant`, turnId: input.turnId, ts: input.tsBase + 2, text: input.assistantText, modelId: 'fake-model' },
    {
      type: 'turn_state',
      id: `${input.legacyIdPrefix}-state`,
      turnId: input.turnId,
      ts: input.tsBase + 3,
      status: 'completed',
      ...(input.header.parentTurnId ? { parentTurnId: input.header.parentTurnId } : {}),
      ...(input.header.retriedFromTurnId ? { retriedFromTurnId: input.header.retriedFromTurnId } : {}),
      ...(input.header.regeneratedFromTurnId ? { regeneratedFromTurnId: input.header.regeneratedFromTurnId } : {}),
      ...(input.header.branchOfTurnId ? { branchOfTurnId: input.header.branchOfTurnId } : {}),
      ...(input.header.parentSessionId ? { parentSessionId: input.header.parentSessionId } : {}),
      partialOutputRetained: true,
    },
  ]);
  await seedRuntimeRun(input.runStore, header, events);
}

async function seedRun(
  runStore: AgentRunStore,
  header: AgentRunHeader,
  events: AgentRunEvent[],
): Promise<void> {
  await runStore.createRun(header);
  for (const event of events) {
    await runStore.appendEvent(header.sessionId, header.runId, event);
  }
}

async function seedRuntimeRun(
  runStore: AgentRunStore,
  header: AgentRunHeader,
  events: RuntimeEvent[],
): Promise<void> {
  await runStore.createRun(header);
  for (const event of events) {
    await runStore.appendRuntimeEvent(header.sessionId, header.runId, event);
  }
}

function runtimeEvent(overrides: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    id: 'rt-event',
    invocationId: 'inv-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 100,
    partial: false,
    role: 'system',
    author: 'system',
    ...overrides,
  };
}

async function seedRunningTurn(store: MemorySessionStore, sessionId: string, turnId: string): Promise<void> {
  await store.appendMessages(sessionId, [
    { type: 'user', id: `${turnId}-user`, turnId, ts: 9, text: 'interrupted turn' },
    { type: 'turn_state', id: `${turnId}-state`, turnId, ts: 10, status: 'running', partialOutputRetained: false },
  ]);
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

async function collectSessionEvents(iterable: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
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

function key(sessionId: string, runId: string): string {
  return `${sessionId}:${runId}`;
}

function copyEvent(event: AgentRunEvent): AgentRunEvent {
  return {
    ...event,
    ...(event.data ? { data: { ...event.data } } : {}),
  };
}

function copyRuntimeEvent(event: RuntimeEvent): RuntimeEvent {
  return JSON.parse(JSON.stringify(event)) as RuntimeEvent;
}
