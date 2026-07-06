import { describe, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { DEEP_RESEARCH_SESSION_LABEL, deriveTurnRecords, isTerminalRuntimeEvent } from '@maka/core';
import type {
  CreateSessionInput,
  PermissionMode,
  AgentRunEvent,
  AgentRunHeader,
  AgentRunStore,
  RuntimeEvent,
  RuntimeEventStore,
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
import type { RuntimeKernelLike } from '../runtime-kernel.js';
import { RuntimeReadModel } from '../runtime-read-model.js';
import type { AgentBackend, MakaTool } from '../ai-sdk-backend.js';
import type { InvocationResult } from '../invocation-context.js';
import type { ActiveFullCompactBlock } from '../active-full-compact.js';
import {
  AGENT_WORKSPACE_WORKTREE,
  IMPLEMENTATION_AGENT_ID,
  LOCAL_READ_AGENT_DEFINITION,
  LOCAL_READ_AGENT_ID,
  WEB_RESEARCH_AGENT_DEFINITION,
  WEB_RESEARCH_AGENT_ID,
} from '../agent-catalog.js';

describe('SessionManager manual compaction', () => {
  test('runs backend history compaction as a runtime turn and persists diagnostics', async () => {
    const store = new MemorySessionStore();
    const runStore = new OrderingAgentRunStore();
    const backends = new BackendRegistry();
    const compactCalls: Array<{ turnId: string; runtimeContextCount: number }> = [];
    backends.register('fake', (ctx) => new CompactingTestBackend(ctx, compactCalls));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(10_000),
    });
    const session = await manager.createSession(makeInput({ backend: 'fake', permissionMode: 'bypass' }));

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));
    runStore.operations = [];
    const events = await collectSessionEvents(manager.compactSession(session.id, { turnId: 'turn-compact' }));

    expect(compactCalls).toEqual([{ turnId: 'turn-compact', runtimeContextCount: 3 }]);
    expect(events.map((event) => event.type)).toEqual(['token_usage', 'complete']);
    const usage = events[0];
    if (usage?.type !== 'token_usage') throw new Error('expected token_usage');
    expect(usage.contextBudget?.compactionDecisions?.[0]?.decision).toBe('replaced');

    const messages = await store.readMessages(session.id);
    expect(messages.some((message) => message.type === 'user' && message.text.includes('compact'))).toBe(false);
    expect(messages.some((message) => message.type === 'token_usage' && message.turnId === 'turn-compact')).toBe(true);
    expect(messages.some((message) => message.type === 'turn_state' && message.turnId === 'turn-compact' && message.status === 'completed')).toBe(true);

    const compactRun = (await runStore.listSessionRuns(session.id)).find((run) => run.turnId === 'turn-compact');
    expect(compactRun?.status).toBe('completed');
    expect(runStore.operations).toEqual(['terminalRuntimeEvent', 'completedRunHeader']);
    expect((await runStore.readRuntimeEvents(session.id, compactRun!.runId)).some((event) => event.actions?.tokenUsage?.contextBudget)).toBe(true);
  });

  test('manual compaction stopped before backend start does not write compact artifacts', async () => {
    const store = new MemorySessionStore();
    const readGate = makeGate();
    const readStarted = makeGate();
    let blockPriorRead = false;
    const runStore = new MemoryAgentRunStore({
      beforeRuntimeEventRead: async () => {
        if (!blockPriorRead) return;
        readStarted.release();
        await readGate.promise;
      },
    });
    const backends = new BackendRegistry();
    const compactCalls: Array<{ turnId: string; runtimeContextCount: number }> = [];
    backends.register('fake', (ctx) => new CompactingTestBackend(ctx, compactCalls));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(15_000),
    });
    const session = await manager.createSession(makeInput({ backend: 'fake', permissionMode: 'bypass' }));
    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));

    blockPriorRead = true;
    const compactPromise = collectSessionEvents(manager.compactSession(session.id, { turnId: 'turn-compact' }));
    await readStarted.promise;
    await manager.stopSession(session.id, { source: 'stop_button' });
    readGate.release();
    const compactEvents = await compactPromise.catch(() => []);

    expect(compactCalls).toEqual([]);
    expect(compactEvents.some((event) => event.type === 'token_usage')).toBe(false);
    const compactRun = (await runStore.listSessionRuns(session.id)).find((run) => run.turnId === 'turn-compact');
    expect(compactRun?.status).toBe('cancelled');
  });

  test('manual compaction is stopped through the active runtime run lifecycle', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const compactGate = makeGate();
    const compactStarted = makeGate();
    let compactingBackend: BlockingCompactBackend | undefined;
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new BlockingCompactBackend(ctx, {
      compactGate,
      onCompactStart: (backend) => {
        compactingBackend = backend;
        compactStarted.release();
      },
    }));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(20_000),
    });
    const session = await manager.createSession(makeInput({ backend: 'fake', permissionMode: 'bypass' }));
    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));

    const compactPromise = collectSessionEvents(manager.compactSession(session.id, { turnId: 'turn-compact' }));
    await compactStarted.promise;
    await manager.stopSession(session.id, { source: 'stop_button' });
    compactGate.release();
    const compactEvents = await compactPromise.catch(() => []);

    expect(compactingBackend?.stopCalls).toBe(1);
    expect(compactEvents.some((event) => event.type === 'token_usage')).toBe(false);
    const compactRun = (await runStore.listSessionRuns(session.id)).find((run) => run.turnId === 'turn-compact');
    expect(compactRun?.status).toBe('cancelled');
  });

  test('compactSession rejects while a turn is running and writes no compact artifacts', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const sendGate = makeGate();
    const turnStarted = makeGate();
    const compactCalls: Array<{ turnId: string; runtimeContextCount: number }> = [];
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new ActiveTurnBackend(ctx, { turnStarted, sendGate, compactCalls }));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(25_000),
    });
    const session = await manager.createSession(makeInput({ backend: 'fake', permissionMode: 'bypass' }));

    const sendPromise = (async () => {
      for await (const _event of manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hi' })) {
        // turn held open at the send gate; drained after the compact assertion
      }
    })();
    await turnStarted.promise;

    const compactError = await collectSessionEvents(
      manager.compactSession(session.id, { turnId: 'turn-compact' }),
    ).catch((error: unknown) => error);
    expect(compactError instanceof Error).toBe(true);
    expect(String((compactError as Error).message)).toMatch(/turn is running|wait for the turn/);

    expect(compactCalls).toEqual([]);
    const messages = await store.readMessages(session.id);
    expect(messages.some((message) => message.turnId === 'turn-compact')).toBe(false);
    const compactRun = (await runStore.listSessionRuns(session.id)).find((run) => run.turnId === 'turn-compact');
    expect(compactRun).toBeUndefined();

    sendGate.release();
    await sendPromise;
  });
});

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
    const manager = new SessionManager({ store, runStore, runtimeEventStore: runStore, backends, newId: nextId(), now: nextNow(4_000) });
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

  test('sendMessage delegates through RuntimeKernel while preserving the SessionEvent stream', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    const runtimeKernel = new DelegatingRuntimeKernel([
      { type: 'text_delta', id: 'delegated-delta', turnId: 'turn-1', ts: 1, messageId: 'm-1', text: 'hello' },
      { type: 'complete', id: 'delegated-complete', turnId: 'turn-1', ts: 2, stopReason: 'end_turn' },
    ]);
    const manager = new SessionManager({
      store,
      backends,
      newId: nextId(),
      now: nextNow(6_250),
      runtimeKernel,
    });
    const session = await manager.createSession(makeInput());

    const sessionEvents = await collectSessionEvents(
      manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }),
    );

    expect(runtimeKernel.starts).toEqual([{ sessionId: session.id, input: { turnId: 'turn-1', text: 'hello' } }]);
    expect(sessionEvents.map((event) => event.id)).toEqual(['delegated-delta', 'delegated-complete']);
    expect(sessionEvents.map((event) => event.type)).toEqual(['text_delta', 'complete']);
  });

  test('RuntimeKernel drives RuntimeRunner while preserving the SessionEvent stream', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const runtimeEventStore = new MemoryRuntimeEventStore();
    const backends = new BackendRegistry();
    const observed: InvocationResult[] = [];
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore,
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
    expect(result.events[0]?.content).toEqual({ kind: 'text', text: 'hello' });
    expect(result.events[1]?.content).toEqual({ kind: 'text', text: 'ok' });
    expect(result.events[2]?.status).toBe('completed');

    const runtimeEvents = await runtimeEventStore.readRuntimeEvents(session.id, run.runId);
    expect(runtimeEvents.map((event) => event.id)).toEqual(result.events.map((event) => event.id));
    expect(runtimeEvents.map((event) => event.runId)).toEqual([run.runId, run.runId, run.runId]);
    expect(runtimeEvents.map((event) => event.sessionId)).toEqual([session.id, session.id, session.id]);
    expect(runtimeEvents.map((event) => event.turnId)).toEqual(['turn-1', 'turn-1', 'turn-1']);
    expect(runtimeEvents.map((event) => event.role)).toEqual(['user', 'model', 'system']);
    expect(runtimeEvents[0]?.content).toEqual({ kind: 'text', text: 'hello' });
    expect(runtimeEvents[1]?.content).toEqual({ kind: 'text', text: 'ok' });
    expect(runtimeEvents[2]?.status).toBe('completed');
  });

  test('completed turns are readable when the complete event reaches the renderer', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const runtimeEventStore = new MemoryRuntimeEventStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TextCompleteBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore,
      backends,
      newId: nextId(),
      now: nextNow(6_625),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());
    const iterator = manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' })[Symbol.asyncIterator]();

    expect((await iterator.next()).value?.type).toBe('text_delta');
    const textComplete = (await iterator.next()).value;
    expect(textComplete?.type).toBe('text_complete');
    expect((await iterator.next()).value?.type).toBe('complete');

    const messages = await manager.getMessages(session.id);
    expect(messages.map((message) => message.type)).toEqual(['user', 'assistant', 'turn_state']);
    expect(messages[1]?.id).toBe(textComplete?.type === 'text_complete' ? textComplete.messageId : undefined);

    await iterator.next();
  });

  test('terminal RuntimeEvent is recorded when terminal session projection fails', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_626),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());
    const iterator = manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' })[Symbol.asyncIterator]();

    expect((await iterator.next()).value?.type).toBe('text_delta');
    store.failUpdateHeaderFor.add(session.id);
    expect((await iterator.next()).value?.type).toBe('complete');
    store.failUpdateHeaderFor.delete(session.id);
    await iterator.next();

    const [run] = await runStore.listSessionRuns(session.id);
    if (!run) throw new Error('AgentRunStore run was not created');
    expect(run.status).toBe('completed');
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, run.runId);
    expect(runtimeEvents.filter((event) => event.status === 'completed')).toHaveLength(1);

    const view = await new RuntimeReadModel({
      runStore,
      runtimeEventStore: runStore,
      projectionCache: store,
    }).getSessionView(session.id);
    expect(view.terminalFacts.map((fact) => fact.runStatus)).toEqual(['completed']);
  });

  test('reading messages keeps the session unread marker as a pure query', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_630),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());
    await store.updateHeader(session.id, { hasUnread: true });

    await manager.getMessages(session.id);

    expect((await store.readHeader(session.id)).hasUnread).toBe(true);
  });

  test('markSessionRead clears the session unread marker', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(6_631) });
    const session = await manager.createSession(makeInput());
    await store.updateHeader(session.id, { hasUnread: true, lastMessageAt: 200 });

    await manager.markSessionRead(session.id, 200);

    expect((await store.readHeader(session.id)).hasUnread).toBe(false);
  });

  test('markSessionRead keeps unread when a newer message arrives after the read boundary', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(6_632) });
    const session = await manager.createSession(makeInput());
    await store.updateHeader(session.id, { hasUnread: true, lastMessageAt: 250 });

    await manager.markSessionRead(session.id, 200);

    expect((await store.readHeader(session.id)).hasUnread).toBe(true);
  });

  test('markSessionRead keeps unread when a newer message finalizes between the read check and write', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(6_633) });
    const session = await manager.createSession(makeInput());
    await store.updateHeader(session.id, { hasUnread: true, lastMessageAt: 200 });
    store.interleaveBeforeMarkSessionReadWriteFor.set(session.id, async () => {
      await store.updateHeader(session.id, { hasUnread: true, lastMessageAt: 250 });
    });

    await manager.markSessionRead(session.id, 200);

    const header = await store.readHeader(session.id);
    expect(header.lastMessageAt).toBe(250);
    expect(header.hasUnread).toBe(true);
  });

  test('markSessionRead rejects when the unread header write fails', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(6_634) });
    const session = await manager.createSession(makeInput());
    await store.updateHeader(session.id, { hasUnread: true, lastMessageAt: 200 });
    store.failUpdateHeaderFor.add(session.id);

    await expectRejects(manager.markSessionRead(session.id, 200), /Cannot update header/);

    store.failUpdateHeaderFor.delete(session.id);
    expect((await store.readHeader(session.id)).hasUnread).toBe(true);
  });

  test('terminal header is never persisted without a terminal RuntimeEvent', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore({ failRuntimeEventAppendAfter: 2 });
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_750),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());

    await expectRejects(
      collectSessionEvents(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' })),
      /runtime event append failed/,
    );

    const [run] = await runStore.listSessionRuns(session.id);
    if (!run) throw new Error('AgentRunStore run was not created');
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, run.runId);
    const terminalEvents = runtimeEvents.filter(isTerminalRuntimeEvent);

    expect(['created', 'running', 'waiting_permission'].includes(run.status)).toBe(true);
    expect(run.completedAt).toBeUndefined();
    expect(runtimeEvents.map((event) => event.role)).toEqual(['user', 'model']);
    expect(runtimeEvents[0]?.content).toEqual({ kind: 'text', text: 'hello' });
    expect(runtimeEvents[1]?.id).toBe('turn-1-delta');
    expect(terminalEvents).toEqual([]);

    const view = await new RuntimeReadModel({
      runStore,
      runtimeEventStore: runStore,
      projectionCache: store,
    }).getSessionView(session.id);
    expect(view.messages.some((message) => message.type === 'user')).toBe(true);
    expect((await manager.getMessages(session.id)).some((message) => message.type === 'user')).toBe(true);
  });

  test('backend errors before terminal synthesize a failed terminal RuntimeEvent before the failed header', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new ThrowBeforeTerminalBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_800),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());

    await expectRejects(
      collectSessionEvents(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' })),
      /backend failed before terminal/,
    );

    const [run] = await runStore.listSessionRuns(session.id);
    if (!run) throw new Error('AgentRunStore run was not created');
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, run.runId);
    const terminalEvents = runtimeEvents.filter(isTerminalRuntimeEvent);

    expect(run.status).toBe('failed');
    expect(run.failureClass).toBe('missing_terminal_event');
    expect(runtimeEvents.map((event) => event.role)).toEqual(['user', 'model', 'system']);
    expect(runtimeEvents[0]?.content).toEqual({ kind: 'text', text: 'hello' });
    expect(runtimeEvents[1]?.id).toBe('turn-1-delta');
    expect(runtimeEvents[2]?.id).toBe(terminalEvents[0]?.id);
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.status).toBe('failed');
    expect(terminalEvents[0]?.invocationId).toBe(run.runId);
    expect(terminalEvents[0]?.actions?.stateDelta?.failureClass).toBe('missing_terminal_event');
    expect(terminalEvents[0]?.actions?.stateDelta?.recovered).toBeUndefined();

    const view = await new RuntimeReadModel({
      runStore,
      runtimeEventStore: runStore,
      projectionCache: store,
    }).getSessionView(session.id);
    expect(view.messages.some((message) => message.type === 'user')).toBe(true);
    expect((await manager.getMessages(session.id)).some((message) => message.type === 'user')).toBe(true);
  });

  test('startup recovery preserves the terminal header RuntimeEvent invariant', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore({ failRuntimeEventAppendAfter: 2 });
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_850),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());

    await expectRejects(
      collectSessionEvents(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' })),
      /runtime event append failed/,
    );

    await manager.recoverInterruptedSessions();

    const [run] = await runStore.listSessionRuns(session.id);
    if (!run) throw new Error('AgentRunStore run was not created');
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, run.runId);
    const hasTerminalHeader = ['completed', 'failed', 'cancelled'].includes(run.status);
    const hasTerminalFact = runtimeEvents.some(isTerminalRuntimeEvent);
    expect(!hasTerminalHeader || hasTerminalFact).toBe(true);
    const terminalEvents = runtimeEvents.filter(isTerminalRuntimeEvent);
    expect(run.status).toBe('failed');
    expect(run.failureClass).toBe('app_restarted');
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.status).toBe('failed');
    expect(terminalEvents[0]?.actions?.stateDelta?.recovered).toBe(true);
    expect(terminalEvents[0]?.actions?.stateDelta?.recoveryReason).toBe('run_interrupted');
    expect(terminalEvents[0]?.actions?.stateDelta?.failureClass).toBe('app_restarted');

    const view = await new RuntimeReadModel({
      runStore,
      runtimeEventStore: runStore,
      projectionCache: store,
    }).getSessionView(session.id);
    expect(view.messages.some((message) => message.type === 'user')).toBe(true);
    expect((await manager.getMessages(session.id)).some((message) => message.type === 'user')).toBe(true);
  });

  test('pre-terminal backend errors preserve the terminal invariant before startup recovery', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new ThrowBeforeTerminalBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_875),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());

    await expectRejects(
      collectSessionEvents(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' })),
      /backend failed before terminal/,
    );

    await manager.recoverInterruptedSessions();

    const [run] = await runStore.listSessionRuns(session.id);
    if (!run) throw new Error('AgentRunStore run was not created');
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, run.runId);
    const hasTerminalHeader = ['completed', 'failed', 'cancelled'].includes(run.status);
    const hasTerminalFact = runtimeEvents.some(isTerminalRuntimeEvent);
    expect(!hasTerminalHeader || hasTerminalFact).toBe(true);
    const terminalEvents = runtimeEvents.filter(isTerminalRuntimeEvent);
    expect(run.status).toBe('failed');
    expect(run.failureClass).toBe('missing_terminal_event');
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.status).toBe('failed');
    expect(terminalEvents[0]?.invocationId).toBe(run.runId);
    expect(terminalEvents[0]?.actions?.stateDelta?.recovered).toBeUndefined();
    expect(terminalEvents[0]?.actions?.stateDelta?.recoveryReason).toBeUndefined();
    expect(terminalEvents[0]?.actions?.stateDelta?.failureClass).toBe('missing_terminal_event');

    const view = await new RuntimeReadModel({
      runStore,
      runtimeEventStore: runStore,
      projectionCache: store,
    }).getSessionView(session.id);
    expect(view.messages.some((message) => message.type === 'user')).toBe(true);
    expect((await manager.getMessages(session.id)).some((message) => message.type === 'user')).toBe(true);
  });

  test('sendMessage backfills an empty prior runtime ledger for model context', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let backend: TestBackend | undefined;
    backends.register('fake', (ctx) => {
      backend = new TestBackend(ctx);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(7_000),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());
    await store.appendMessages(session.id, [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'prior question' },
      { type: 'assistant', id: 'legacy-assistant', turnId: 'turn-1', ts: 102, text: 'prior answer', modelId: 'fake-model' },
      { type: 'turn_state', id: 'legacy-state', turnId: 'turn-1', ts: 103, status: 'completed', partialOutputRetained: true },
    ]);
    await runStore.createRun(makeRunHeader({
      sessionId: session.id,
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'completed',
      createdAt: 100,
      updatedAt: 103,
      completedAt: 103,
    }));

    const sessionEvents = await collectSessionEvents(
      manager.sendMessage(session.id, { turnId: 'turn-2', text: 'follow up' }),
    );

    expect(sessionEvents.map((event) => event.type)).toEqual(['text_delta', 'complete']);
    expect(backend?.sendInputs[0]?.context.map((message) => message.type)).toEqual(['user', 'assistant', 'turn_state']);
    expect(backend?.sendInputs[0]?.context.map((message) => 'text' in message ? message.text : message.type)).toEqual([
      'prior question',
      'prior answer',
      'turn_state',
    ]);
    expect(backend?.sendInputs[0]?.runtimeContext?.map((event) => event.runId)).toEqual(['run-1', 'run-1', 'run-1']);
    const repairedRuntimeEvents = await runStore.readRuntimeEvents(session.id, 'run-1');
    expect(repairedRuntimeEvents.map((event) => event.refs?.storedMessageId)).toEqual([
      'legacy-user',
      'legacy-assistant',
      'legacy-state',
    ]);
    expect(repairedRuntimeEvents.at(-1)?.status).toBe('completed');
  });

  test('sendMessage rejects prior runtime context without a valid terminal fact', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let backend: TestBackend | undefined;
    backends.register('fake', (ctx) => {
      backend = new TestBackend(ctx);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(7_050),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());
    await seedRuntimeRun(runStore, makeRunHeader({
      sessionId: session.id,
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'completed',
      createdAt: 100,
      updatedAt: 103,
      completedAt: 103,
    }), [
      runtimeEvent({
        id: 'rt-user',
        sessionId: session.id,
        runId: 'run-1',
        turnId: 'turn-1',
        ts: 101,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'prior question' },
      }),
      runtimeEvent({
        id: 'rt-assistant',
        sessionId: session.id,
        runId: 'run-1',
        turnId: 'turn-1',
        ts: 102,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'prior answer' },
      }),
      runtimeEvent({
        id: 'rt-completed-a',
        sessionId: session.id,
        runId: 'run-1',
        turnId: 'turn-1',
        ts: 103,
        status: 'completed',
        actions: { endInvocation: true },
      }),
      runtimeEvent({
        id: 'rt-completed-b',
        sessionId: session.id,
        runId: 'run-1',
        turnId: 'turn-1',
        ts: 104,
        status: 'completed',
        actions: { endInvocation: true },
      }),
    ]);

    await expectRejects(
      drain(manager.sendMessage(session.id, { turnId: 'turn-2', text: 'follow up' })),
      /valid terminal fact/,
    );
    expect(backend?.sendInputs.length ?? 0).toBe(0);
    const currentRun = (await runStore.listSessionRuns(session.id)).find((run) => run.turnId === 'turn-2');
    if (!currentRun) throw new Error('current AgentRunStore run was not created');
    expect(currentRun.status).toBe('failed');
    expect(currentRun.failureClass).toBe('missing_terminal_event');
    const currentTerminalEvents = (await runStore.readRuntimeEvents(session.id, currentRun.runId)).filter(isTerminalRuntimeEvent);
    expect(currentTerminalEvents).toHaveLength(1);
    expect(currentTerminalEvents[0]?.status).toBe('failed');
    expect(currentTerminalEvents[0]?.actions?.stateDelta?.failureClass).toBe('missing_terminal_event');
  });

  test('sendMessage resumes incomplete legacy backfill for prior context', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore({ failRuntimeEventAppendAfter: 1 });
    const backends = new BackendRegistry();
    let backend: TestBackend | undefined;
    backends.register('fake', (ctx) => {
      backend = new TestBackend(ctx);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(7_100),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());
    await store.appendMessages(session.id, [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'prior question' },
      { type: 'assistant', id: 'legacy-assistant', turnId: 'turn-1', ts: 102, text: 'prior answer', modelId: 'fake-model' },
      { type: 'turn_state', id: 'legacy-state', turnId: 'turn-1', ts: 103, status: 'completed', partialOutputRetained: true },
    ]);
    await runStore.createRun(makeRunHeader({
      sessionId: session.id,
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'completed',
      createdAt: 100,
      updatedAt: 103,
      completedAt: 103,
    }));
    await expectRejects(manager.getMessages(session.id), /runtime event append failed/);

    await drain(manager.sendMessage(session.id, { turnId: 'turn-2', text: 'follow up' }));

    expect(backend?.sendInputs[0]?.runtimeContext?.map((event) => event.refs?.storedMessageId)).toEqual([
      'legacy-user',
      'legacy-assistant',
      'legacy-state',
    ]);
    expect((await runStore.readRuntimeEvents(session.id, 'run-1')).map((event) => event.refs?.storedMessageId)).toEqual([
      'legacy-user',
      'legacy-assistant',
      'legacy-state',
    ]);
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

  test('getMessages does not scan runs before reading a complete runtime ledger', async () => {
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
      userText: 'question',
      assistantText: 'answer',
      legacyIdPrefix: 'legacy',
    });

    await manager.getMessages(session.id);

    expect(runStore.listSessionRunsCalls).toBe(1);
  });

  test('RuntimeReadModel projects messages turns replay and terminal facts without SessionStore messages', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const session = await store.create(makeInput());
    const seeded = await seedRuntimeReadTurn({
      store,
      runStore,
      sessionId: session.id,
      turnId: 'turn-1',
      runId: 'run-1',
      userText: 'runtime question',
      assistantText: 'runtime answer',
      legacyIdPrefix: 'cache',
    });
    store.failReadMessagesFor.add(session.id);

    const view = await new RuntimeReadModel({ runStore, runtimeEventStore: runStore }).getSessionView(session.id);

    expect(view.messages).toEqual(seeded.projectedMessages);
    expect(view.turns).toEqual([{ turnId: 'turn-1', status: 'completed', partialOutputRetained: true }]);
    expect(view.terminalFacts.map((fact) => fact.runStatus)).toEqual(['completed']);
    expect(view.replayPlan.textMessages.map((message) => message.content)).toEqual(['runtime question', 'runtime answer']);
  });

  test('RuntimeReadModel excludes child runs from the default session transcript', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const session = await store.create(makeInput());
    await seedRuntimeReadTurnWithHeader({
      store,
      runStore,
      sessionId: session.id,
      turnId: 'parent-turn',
      runId: 'parent-run',
      userText: 'parent question',
      assistantText: 'parent answer',
      legacyIdPrefix: 'parent',
      header: {},
      tsBase: 100,
    });
    await seedRuntimeReadTurnWithHeader({
      store,
      runStore,
      sessionId: session.id,
      turnId: 'child-turn',
      runId: 'child-run',
      userText: 'child prompt',
      assistantText: 'child private answer',
      legacyIdPrefix: 'child',
      header: { parentRunId: 'parent-run', agentName: 'Researcher' },
      tsBase: 200,
    });

    const view = await new RuntimeReadModel({ runStore, runtimeEventStore: runStore }).getSessionView(session.id);

    expect(view.runs.map((run) => run.runId)).toEqual(['parent-run']);
    expect(view.messages.map((message) => message.turnId)).toEqual(['parent-turn', 'parent-turn', 'parent-turn']);
    expect(view.replayPlan.textMessages.map((message) => message.content)).toEqual(['parent question', 'parent answer']);
  });

  test('projection/cache mismatch does not override RuntimeEvent read output', async () => {
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

    expect(await manager.getMessages(session.id)).toEqual([
      { type: 'user', id: 'rt-user', turnId: 'turn-1', ts: 101, text: 'question' },
      { type: 'turn_state', id: 'rt-complete', turnId: 'turn-1', ts: 103, status: 'completed', partialOutputRetained: false },
    ]);
  });

  test('getMessages backfills low-risk legacy rows when a terminal run has no runtime ledger', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    const legacyMessages: StoredMessage[] = [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'legacy only' },
      { type: 'assistant', id: 'legacy-assistant', turnId: 'turn-1', ts: 102, text: 'legacy answer', modelId: 'fake-model' },
      { type: 'tool_call', id: 'tool-1', turnId: 'turn-1', ts: 103, toolName: 'Read', args: { path: 'README.md' } },
      { type: 'tool_result', id: 'legacy-tool-result', turnId: 'turn-1', ts: 104, toolUseId: 'tool-1', isError: false, content: { kind: 'text', text: 'file body' } },
      { type: 'token_usage', id: 'legacy-usage', turnId: 'turn-1', ts: 105, input: 10, output: 5 },
      { type: 'turn_state', id: 'legacy-state', turnId: 'turn-1', ts: 106, status: 'completed', partialOutputRetained: true },
    ];
    await store.appendMessages(session.id, legacyMessages);
    await runStore.createRun(makeRunHeader({
      sessionId: session.id,
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'completed',
      completedAt: 106,
    }));

    const messages = await manager.getMessages(session.id);
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, 'run-1');

    expect(messages.map((message) => message.type)).toEqual([
      'user',
      'assistant',
      'tool_call',
      'tool_result',
      'token_usage',
      'turn_state',
    ]);
    expect(messages.map((message) => message.id)).toEqual([
      'legacy-user',
      'legacy-assistant',
      'tool-1',
      'legacy-tool-result',
      'legacy-usage',
      'legacy-state',
    ]);
    expect(runtimeEvents.map((event) => event.refs?.storedMessageId)).toEqual([
      'legacy-user',
      'legacy-assistant',
      'tool-1',
      'legacy-tool-result',
      'legacy-usage',
      'legacy-state',
    ]);
    expect(runtimeEvents.at(-1)?.status).toBe('completed');
  });

  test('getMessages backfills assistant text and thinking from one legacy message', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    await store.appendMessages(session.id, [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'question' },
      {
        type: 'assistant',
        id: 'legacy-assistant',
        turnId: 'turn-1',
        ts: 102,
        text: 'answer',
        modelId: 'fake-model',
        thinking: { text: 'reasoning', signature: 'sig-1' },
      },
      { type: 'turn_state', id: 'legacy-state', turnId: 'turn-1', ts: 103, status: 'completed', partialOutputRetained: true },
    ]);
    await runStore.createRun(makeRunHeader({
      sessionId: session.id,
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'completed',
      createdAt: 100,
      updatedAt: 103,
      completedAt: 103,
    }));

    await manager.getMessages(session.id);
    await manager.getMessages(session.id);
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, 'run-1');

    expect(runtimeEvents.map((event) => event.content?.kind ?? event.status)).toEqual([
      'text',
      'text',
      'thinking',
      'completed',
    ]);
    expect(runtimeEvents.map((event) => event.refs?.storedMessageId)).toEqual([
      'legacy-user',
      'legacy-assistant',
      'legacy-assistant',
      'legacy-state',
    ]);
  });

  test('getMessages preserves legacy transcript when fallback repair supplies missing terminal evidence', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    await store.appendMessages(session.id, [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'question' },
      { type: 'assistant', id: 'legacy-assistant', turnId: 'turn-1', ts: 102, text: 'answer', modelId: 'fake-model' },
    ]);
    await runStore.createRun(makeRunHeader({
      sessionId: session.id,
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'completed',
      createdAt: 100,
      updatedAt: 103,
      completedAt: 103,
    }));

    const messages = await manager.getMessages(session.id);
    await manager.getMessages(session.id);
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, 'run-1');

    expect(messages.map((message) => message.type)).toEqual(['user', 'assistant', 'turn_state']);
    expect(messages.map((message) => message.id)).toEqual([
      'legacy-user',
      'legacy-assistant',
      runtimeEvents.at(-1)?.id,
    ]);
    expect(runtimeEvents.map((event) => event.refs?.storedMessageId)).toEqual([
      'legacy-user',
      'legacy-assistant',
      undefined,
    ]);
    expect(runtimeEvents.at(-1)?.status).toBe('failed');
    expect(runtimeEvents.at(-1)?.actions?.stateDelta?.failureClass).toBe('missing_terminal_event');
  });

  test('getMessages resumes incomplete legacy backfill after append failure', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore({ failRuntimeEventAppendAfter: 1 });
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    await store.appendMessages(session.id, [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'question' },
      { type: 'assistant', id: 'legacy-assistant', turnId: 'turn-1', ts: 102, text: 'answer', modelId: 'fake-model' },
      { type: 'turn_state', id: 'legacy-state', turnId: 'turn-1', ts: 103, status: 'completed', partialOutputRetained: true },
    ]);
    await runStore.createRun(makeRunHeader({
      sessionId: session.id,
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'completed',
      createdAt: 100,
      updatedAt: 103,
      completedAt: 103,
    }));

    await expectRejects(manager.getMessages(session.id), /runtime event append failed/);

    const messages = await manager.getMessages(session.id);
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, 'run-1');

    expect(messages.map((message) => message.type)).toEqual(['user', 'assistant', 'turn_state']);
    expect(messages.map((message) => message.id)).toEqual(['legacy-user', 'legacy-assistant', 'legacy-state']);
    expect(runtimeEvents.map((event) => event.refs?.storedMessageId)).toEqual([
      'legacy-user',
      'legacy-assistant',
      'legacy-state',
    ]);
  });

  test('getMessages repairs a non-empty RuntimeEvent ledger that is missing only the terminal fact', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    await store.appendMessages(session.id, [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'question' },
      { type: 'assistant', id: 'legacy-assistant', turnId: 'turn-1', ts: 102, text: 'answer', modelId: 'fake-model' },
      { type: 'turn_state', id: 'legacy-state', turnId: 'turn-1', ts: 103, status: 'completed', partialOutputRetained: true },
    ]);
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
      runtimeEvent({ id: 'rt-assistant', sessionId: session.id, runId: 'run-1', turnId: 'turn-1', ts: 102, role: 'model', author: 'agent', content: { kind: 'text', text: 'answer' } }),
    ]);

    const messages = await manager.getMessages(session.id);
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, 'run-1');

    expect(messages.map((message) => message.type)).toEqual(['user', 'assistant', 'turn_state']);
    expect(messages.at(-1)).toEqual({
      type: 'turn_state',
      id: 'legacy-state',
      turnId: 'turn-1',
      ts: 103,
      status: 'completed',
      partialOutputRetained: true,
    });
    expect(runtimeEvents.slice(0, 2).map((event) => event.id)).toEqual(['rt-user', 'rt-assistant']);
    expect(runtimeEvents.at(-1)?.status).toBe('completed');
    expect(runtimeEvents.at(-1)?.refs?.storedMessageId).toBe('legacy-state');
  });

  test('getMessages repairs multiple missing terminal facts before returning the runtime view', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    await store.appendMessages(session.id, [
      { type: 'user', id: 'legacy-user-1', turnId: 'turn-1', ts: 101, text: 'question 1' },
      { type: 'assistant', id: 'legacy-assistant-1', turnId: 'turn-1', ts: 102, text: 'answer 1', modelId: 'fake-model' },
      { type: 'turn_state', id: 'legacy-state-1', turnId: 'turn-1', ts: 103, status: 'completed', partialOutputRetained: true },
      { type: 'user', id: 'legacy-user-2', turnId: 'turn-2', ts: 201, text: 'question 2' },
      { type: 'assistant', id: 'legacy-assistant-2', turnId: 'turn-2', ts: 202, text: 'answer 2', modelId: 'fake-model' },
      { type: 'turn_state', id: 'legacy-state-2', turnId: 'turn-2', ts: 203, status: 'completed', partialOutputRetained: true },
    ]);
    await seedRuntimeRun(runStore, makeRunHeader({
      sessionId: session.id,
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'completed',
      createdAt: 100,
      updatedAt: 103,
      completedAt: 103,
    }), [
      runtimeEvent({ id: 'rt-user-1', sessionId: session.id, runId: 'run-1', turnId: 'turn-1', ts: 101, role: 'user', author: 'user', content: { kind: 'text', text: 'question 1' } }),
      runtimeEvent({ id: 'rt-assistant-1', sessionId: session.id, runId: 'run-1', turnId: 'turn-1', ts: 102, role: 'model', author: 'agent', content: { kind: 'text', text: 'answer 1' } }),
    ]);
    await seedRuntimeRun(runStore, makeRunHeader({
      sessionId: session.id,
      runId: 'run-2',
      turnId: 'turn-2',
      status: 'completed',
      createdAt: 200,
      updatedAt: 203,
      completedAt: 203,
    }), [
      runtimeEvent({ id: 'rt-user-2', sessionId: session.id, runId: 'run-2', turnId: 'turn-2', ts: 201, role: 'user', author: 'user', content: { kind: 'text', text: 'question 2' } }),
      runtimeEvent({ id: 'rt-assistant-2', sessionId: session.id, runId: 'run-2', turnId: 'turn-2', ts: 202, role: 'model', author: 'agent', content: { kind: 'text', text: 'answer 2' } }),
    ]);

    const messages = await manager.getMessages(session.id);
    const run1TerminalEvents = (await runStore.readRuntimeEvents(session.id, 'run-1')).filter(isTerminalRuntimeEvent);
    const run2TerminalEvents = (await runStore.readRuntimeEvents(session.id, 'run-2')).filter(isTerminalRuntimeEvent);

    expect(messages.filter((message) => message.type === 'turn_state').map((message) => message.turnId)).toEqual([
      'turn-1',
      'turn-2',
    ]);
    expect(run1TerminalEvents).toHaveLength(1);
    expect(run1TerminalEvents[0]?.refs?.storedMessageId).toBe('legacy-state-1');
    expect(run2TerminalEvents).toHaveLength(1);
    expect(run2TerminalEvents[0]?.refs?.storedMessageId).toBe('legacy-state-2');
  });

  test('getMessages does not trust failed legacy terminal state for a completed run header', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    await store.appendMessages(session.id, [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'question' },
      { type: 'assistant', id: 'legacy-assistant', turnId: 'turn-1', ts: 102, text: 'answer', modelId: 'fake-model' },
      { type: 'turn_state', id: 'legacy-state', turnId: 'turn-1', ts: 103, status: 'failed', errorClass: 'tool_failed', partialOutputRetained: true },
    ]);
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
      runtimeEvent({ id: 'rt-assistant', sessionId: session.id, runId: 'run-1', turnId: 'turn-1', ts: 102, role: 'model', author: 'agent', content: { kind: 'text', text: 'answer' } }),
    ]);

    const messages = await manager.getMessages(session.id);
    const repairedRun = await runStore.readRun(session.id, 'run-1');
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, 'run-1');

    expect(repairedRun.status).toBe('failed');
    expect(repairedRun.failureClass).toBe('missing_terminal_event');
    expect(messages.at(-1)).toEqual({
      type: 'turn_state',
      id: runtimeEvents.at(-1)?.id,
      turnId: 'turn-1',
      ts: 103,
      status: 'failed',
      errorClass: 'missing_terminal_event',
      partialOutputRetained: true,
    });
    expect(runtimeEvents.at(-1)?.status).toBe('failed');
  });

  test('getMessages does not trust aborted legacy terminal state for a completed run header', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    await store.appendMessages(session.id, [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'question' },
      { type: 'assistant', id: 'legacy-assistant', turnId: 'turn-1', ts: 102, text: 'answer', modelId: 'fake-model' },
      { type: 'turn_state', id: 'legacy-state', turnId: 'turn-1', ts: 103, status: 'aborted', abortedAt: 103, abortSource: 'user', partialOutputRetained: true },
    ]);
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
      runtimeEvent({ id: 'rt-assistant', sessionId: session.id, runId: 'run-1', turnId: 'turn-1', ts: 102, role: 'model', author: 'agent', content: { kind: 'text', text: 'answer' } }),
    ]);

    const messages = await manager.getMessages(session.id);
    const repairedRun = await runStore.readRun(session.id, 'run-1');
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, 'run-1');

    expect(repairedRun.status).toBe('failed');
    expect(repairedRun.failureClass).toBe('missing_terminal_event');
    expect(messages.at(-1)).toEqual({
      type: 'turn_state',
      id: runtimeEvents.at(-1)?.id,
      turnId: 'turn-1',
      ts: 103,
      status: 'failed',
      errorClass: 'missing_terminal_event',
      partialOutputRetained: true,
    });
    expect(runtimeEvents.at(-1)?.status).toBe('failed');
  });

  test('getMessages does not trust completed legacy terminal state for a failed run header', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    await store.appendMessages(session.id, [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'question' },
      { type: 'assistant', id: 'legacy-assistant', turnId: 'turn-1', ts: 102, text: 'answer', modelId: 'fake-model' },
      { type: 'turn_state', id: 'legacy-state', turnId: 'turn-1', ts: 103, status: 'completed', partialOutputRetained: true },
    ]);
    await seedRuntimeRun(runStore, makeRunHeader({
      sessionId: session.id,
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'failed',
      failureClass: 'tool_failed',
      createdAt: 100,
      updatedAt: 103,
      completedAt: 103,
    }), [
      runtimeEvent({ id: 'rt-user', sessionId: session.id, runId: 'run-1', turnId: 'turn-1', ts: 101, role: 'user', author: 'user', content: { kind: 'text', text: 'question' } }),
      runtimeEvent({ id: 'rt-assistant', sessionId: session.id, runId: 'run-1', turnId: 'turn-1', ts: 102, role: 'model', author: 'agent', content: { kind: 'text', text: 'answer' } }),
    ]);

    const messages = await manager.getMessages(session.id);
    const repairedRun = await runStore.readRun(session.id, 'run-1');
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, 'run-1');

    expect(repairedRun.status).toBe('failed');
    expect(repairedRun.failureClass).toBe('missing_terminal_event');
    expect(messages.at(-1)).toEqual({
      type: 'turn_state',
      id: runtimeEvents.at(-1)?.id,
      turnId: 'turn-1',
      ts: 103,
      status: 'failed',
      errorClass: 'missing_terminal_event',
      partialOutputRetained: true,
    });
    expect(runtimeEvents.at(-1)?.status).toBe('failed');
  });

  test('getMessages preserves failed legacy terminal state when failureClass is missing', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    await store.appendMessages(session.id, [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'question' },
      { type: 'assistant', id: 'legacy-assistant', turnId: 'turn-1', ts: 102, text: 'answer', modelId: 'fake-model' },
      { type: 'turn_state', id: 'legacy-state', turnId: 'turn-1', ts: 103, status: 'failed', errorClass: 'tool_failed', partialOutputRetained: true },
    ]);
    await seedRuntimeRun(runStore, makeRunHeader({
      sessionId: session.id,
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'failed',
      failureClass: undefined,
      createdAt: 100,
      updatedAt: 103,
      completedAt: 103,
    }), [
      runtimeEvent({ id: 'rt-user', sessionId: session.id, runId: 'run-1', turnId: 'turn-1', ts: 101, role: 'user', author: 'user', content: { kind: 'text', text: 'question' } }),
      runtimeEvent({ id: 'rt-assistant', sessionId: session.id, runId: 'run-1', turnId: 'turn-1', ts: 102, role: 'model', author: 'agent', content: { kind: 'text', text: 'answer' } }),
    ]);

    const messages = await manager.getMessages(session.id);
    const repairedRun = await runStore.readRun(session.id, 'run-1');
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, 'run-1');

    expect(repairedRun.status).toBe('failed');
    expect(repairedRun.failureClass).toBe('tool_failed');
    expect(messages.at(-1)).toEqual({
      type: 'turn_state',
      id: 'legacy-state',
      turnId: 'turn-1',
      ts: 103,
      status: 'failed',
      errorClass: 'tool_failed',
      partialOutputRetained: true,
    });
    expect(runtimeEvents.at(-1)?.status).toBe('failed');
  });

  test('getMessages preserves aborted legacy terminal state when abortSource is missing', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    await store.appendMessages(session.id, [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'question' },
      { type: 'assistant', id: 'legacy-assistant', turnId: 'turn-1', ts: 102, text: 'answer', modelId: 'fake-model' },
      { type: 'turn_state', id: 'legacy-state', turnId: 'turn-1', ts: 103, status: 'aborted', abortedAt: 103, partialOutputRetained: true },
    ]);
    await seedRuntimeRun(runStore, makeRunHeader({
      sessionId: session.id,
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'cancelled',
      createdAt: 100,
      updatedAt: 103,
      completedAt: 103,
    }), [
      runtimeEvent({ id: 'rt-user', sessionId: session.id, runId: 'run-1', turnId: 'turn-1', ts: 101, role: 'user', author: 'user', content: { kind: 'text', text: 'question' } }),
      runtimeEvent({ id: 'rt-assistant', sessionId: session.id, runId: 'run-1', turnId: 'turn-1', ts: 102, role: 'model', author: 'agent', content: { kind: 'text', text: 'answer' } }),
    ]);

    const messages = await manager.getMessages(session.id);
    const repairedRun = await runStore.readRun(session.id, 'run-1');
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, 'run-1');

    expect(repairedRun.status).toBe('cancelled');
    expect(messages.at(-1)).toEqual({
      type: 'turn_state',
      id: 'legacy-state',
      turnId: 'turn-1',
      ts: 103,
      status: 'aborted',
      abortedAt: 103,
      abortSource: 'unknown',
      partialOutputRetained: true,
    });
    expect(runtimeEvents.at(-1)?.status).toBe('aborted');
    expect(runtimeEvents.at(-1)?.actions?.stateDelta?.abortSource).toBe('unknown');
  });

  test('getMessages waits for legacy messages before fallback repair', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    await store.appendMessages(session.id, [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'question' },
      { type: 'assistant', id: 'legacy-assistant', turnId: 'turn-1', ts: 102, text: 'answer', modelId: 'fake-model' },
      { type: 'turn_state', id: 'legacy-state', turnId: 'turn-1', ts: 103, status: 'completed', partialOutputRetained: true },
    ]);
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
      runtimeEvent({ id: 'rt-assistant', sessionId: session.id, runId: 'run-1', turnId: 'turn-1', ts: 102, role: 'model', author: 'agent', content: { kind: 'text', text: 'answer' } }),
    ]);

    store.failReadMessagesFor.add(session.id);
    await manager.getMessages(session.id).catch(() => undefined);

    const runAfterBlockedRepair = await runStore.readRun(session.id, 'run-1');
    const runtimeEventsAfterBlockedRepair = await runStore.readRuntimeEvents(session.id, 'run-1');
    expect(runAfterBlockedRepair.status).toBe('completed');
    expect(runAfterBlockedRepair.failureClass).toBeUndefined();
    expect(runtimeEventsAfterBlockedRepair.some(isTerminalRuntimeEvent)).toBe(false);

    store.failReadMessagesFor.delete(session.id);
    const messagesAfterBlockedRepair = await store.readMessages(session.id);
    expect(messagesAfterBlockedRepair.filter((message) => message.type === 'turn_state' && message.status === 'failed')).toHaveLength(0);

    await manager.getMessages(session.id);

    const repairedRun = await runStore.readRun(session.id, 'run-1');
    const repairedRuntimeEvents = await runStore.readRuntimeEvents(session.id, 'run-1');
    const terminalEvents = repairedRuntimeEvents.filter(isTerminalRuntimeEvent);
    expect(repairedRun.status).toBe('completed');
    expect(repairedRun.failureClass).toBeUndefined();
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.status).toBe('completed');
  });

  test('getMessages repairs terminal run headers without terminal evidence as missing_terminal_event failures', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    await store.appendMessages(session.id, [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'question' },
      { type: 'assistant', id: 'legacy-assistant', turnId: 'turn-1', ts: 102, text: 'answer', modelId: 'fake-model' },
    ]);
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
      runtimeEvent({ id: 'rt-assistant', sessionId: session.id, runId: 'run-1', turnId: 'turn-1', ts: 102, role: 'model', author: 'agent', content: { kind: 'text', text: 'answer' } }),
    ]);

    const messages = await manager.getMessages(session.id);
    const repairedRun = await runStore.readRun(session.id, 'run-1');
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, 'run-1');

    expect(repairedRun.status).toBe('failed');
    expect(repairedRun.failureClass).toBe('missing_terminal_event');
    expect(messages.at(-1)).toEqual({
      type: 'turn_state',
      id: runtimeEvents.at(-1)?.id,
      turnId: 'turn-1',
      ts: 103,
      status: 'failed',
      errorClass: 'missing_terminal_event',
      partialOutputRetained: true,
    });
    expect(runtimeEvents.at(-1)?.status).toBe('failed');
    expect(runtimeEvents.at(-1)?.actions?.stateDelta?.failureClass).toBe('missing_terminal_event');
  });

  test('getMessages can retry repair when the failed header update is interrupted', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore({ failUpdateRunOnce: true });
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    await store.appendMessages(session.id, [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'question' },
      { type: 'assistant', id: 'legacy-assistant', turnId: 'turn-1', ts: 102, text: 'answer', modelId: 'fake-model' },
    ]);
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
      runtimeEvent({ id: 'rt-assistant', sessionId: session.id, runId: 'run-1', turnId: 'turn-1', ts: 102, role: 'model', author: 'agent', content: { kind: 'text', text: 'answer' } }),
    ]);

    await expectRejects(manager.getMessages(session.id), /update run failed/);

    const messages = await manager.getMessages(session.id);
    const repairedRun = await runStore.readRun(session.id, 'run-1');
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, 'run-1');

    expect(repairedRun.status).toBe('failed');
    expect(repairedRun.failureClass).toBe('missing_terminal_event');
    expect(messages.at(-1)?.type).toBe('turn_state');
    expect(runtimeEvents.filter((event) => event.status === 'failed')).toHaveLength(1);
  });

  test('getMessages repairs missing failed header class from an existing terminal RuntimeEvent', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    await store.appendMessages(session.id, [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'question' },
      { type: 'assistant', id: 'legacy-assistant', turnId: 'turn-1', ts: 102, text: 'answer', modelId: 'fake-model' },
    ]);
    await seedRuntimeRun(runStore, makeRunHeader({
      sessionId: session.id,
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'failed',
      failureClass: undefined,
      createdAt: 100,
      updatedAt: 103,
      completedAt: 103,
    }), [
      runtimeEvent({ id: 'rt-user', sessionId: session.id, runId: 'run-1', turnId: 'turn-1', ts: 101, role: 'user', author: 'user', content: { kind: 'text', text: 'question' } }),
      runtimeEvent({ id: 'rt-assistant', sessionId: session.id, runId: 'run-1', turnId: 'turn-1', ts: 102, role: 'model', author: 'agent', content: { kind: 'text', text: 'answer' } }),
      runtimeEvent({
        id: 'rt-failed',
        sessionId: session.id,
        runId: 'run-1',
        turnId: 'turn-1',
        ts: 103,
        role: 'system',
        author: 'system',
        status: 'failed',
        content: { kind: 'error', code: 'tool_failed', reason: 'tool_failed', message: 'tool failed' },
        actions: { endInvocation: true, stateDelta: { failureClass: 'tool_failed' } },
      }),
    ]);

    const messages = await manager.getMessages(session.id);
    await manager.getMessages(session.id);
    const repairedRun = await runStore.readRun(session.id, 'run-1');
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, 'run-1');

    expect(repairedRun.failureClass).toBe('tool_failed');
    expect(messages.at(-1)).toEqual({
      type: 'turn_state',
      id: 'rt-failed',
      turnId: 'turn-1',
      ts: 103,
      status: 'failed',
      errorClass: 'tool_failed',
      partialOutputRetained: true,
    });
    expect(runtimeEvents.filter((event) => event.status === 'failed')).toHaveLength(1);
  });

  test('getMessages uses fallback failed header class when an existing terminal RuntimeEvent has no class', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    await store.appendMessages(session.id, [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'question' },
      { type: 'assistant', id: 'legacy-assistant', turnId: 'turn-1', ts: 102, text: 'answer', modelId: 'fake-model' },
    ]);
    await seedRuntimeRun(runStore, makeRunHeader({
      sessionId: session.id,
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'failed',
      failureClass: undefined,
      createdAt: 100,
      updatedAt: 103,
      completedAt: 103,
    }), [
      runtimeEvent({ id: 'rt-user', sessionId: session.id, runId: 'run-1', turnId: 'turn-1', ts: 101, role: 'user', author: 'user', content: { kind: 'text', text: 'question' } }),
      runtimeEvent({ id: 'rt-assistant', sessionId: session.id, runId: 'run-1', turnId: 'turn-1', ts: 102, role: 'model', author: 'agent', content: { kind: 'text', text: 'answer' } }),
      runtimeEvent({
        id: 'rt-failed',
        sessionId: session.id,
        runId: 'run-1',
        turnId: 'turn-1',
        ts: 103,
        role: 'system',
        author: 'system',
        status: 'failed',
        actions: { endInvocation: true },
      }),
    ]);

    await manager.getMessages(session.id);
    await manager.getMessages(session.id);
    const repairedRun = await runStore.readRun(session.id, 'run-1');
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, 'run-1');

    expect(repairedRun.failureClass).toBe('missing_terminal_event');
    expect(runtimeEvents.filter((event) => event.status === 'failed')).toHaveLength(1);
  });

  test('getMessages repairs missing abort source from an existing aborted terminal RuntimeEvent', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    await store.appendMessages(session.id, [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'question' },
      { type: 'assistant', id: 'legacy-assistant', turnId: 'turn-1', ts: 102, text: 'answer', modelId: 'fake-model' },
    ]);
    await seedRuntimeRun(runStore, makeRunHeader({
      sessionId: session.id,
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'cancelled',
      createdAt: 100,
      updatedAt: 103,
      completedAt: 103,
    }), [
      runtimeEvent({ id: 'rt-user', sessionId: session.id, runId: 'run-1', turnId: 'turn-1', ts: 101, role: 'user', author: 'user', content: { kind: 'text', text: 'question' } }),
      runtimeEvent({ id: 'rt-assistant', sessionId: session.id, runId: 'run-1', turnId: 'turn-1', ts: 102, role: 'model', author: 'agent', content: { kind: 'text', text: 'answer' } }),
      runtimeEvent({
        id: 'rt-aborted',
        sessionId: session.id,
        runId: 'run-1',
        turnId: 'turn-1',
        ts: 103,
        role: 'system',
        author: 'system',
        status: 'aborted',
        actions: { endInvocation: true },
      }),
    ]);

    const messages = await manager.getMessages(session.id);
    await manager.getMessages(session.id);
    const repairedRun = await runStore.readRun(session.id, 'run-1') as AgentRunHeader & { abortSource?: string };
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, 'run-1');

    expect(repairedRun.abortSource).toBe('unknown');
    expect(messages.find((message) => message.type === 'turn_state')).toEqual({
      type: 'turn_state',
      id: 'rt-aborted',
      turnId: 'turn-1',
      ts: 103,
      status: 'aborted',
      abortedAt: 103,
      abortSource: 'unknown',
      partialOutputRetained: true,
    });
    expect(runtimeEvents.filter((event) => event.status === 'aborted')).toHaveLength(1);
  });

  test('getMessages serializes concurrent terminal repairs for the same run', async () => {
    const store = new MemorySessionStore();
    let repairReads = 0;
    const runStore = new MemoryAgentRunStore({
      beforeRuntimeEventRead: async (_sessionId, runId) => {
        if (runId !== 'run-1' || repairReads >= 2) return;
        repairReads += 1;
        await Promise.resolve();
      },
    });
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    await store.appendMessages(session.id, [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'question' },
      { type: 'assistant', id: 'legacy-assistant', turnId: 'turn-1', ts: 102, text: 'answer', modelId: 'fake-model' },
    ]);
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
      runtimeEvent({ id: 'rt-assistant', sessionId: session.id, runId: 'run-1', turnId: 'turn-1', ts: 102, role: 'model', author: 'agent', content: { kind: 'text', text: 'answer' } }),
    ]);

    await Promise.all([
      manager.getMessages(session.id),
      manager.getMessages(session.id),
    ]);

    const runtimeEvents = await runStore.readRuntimeEvents(session.id, 'run-1');
    expect(runtimeEvents.filter((event) => event.status === 'failed')).toHaveLength(1);
  });

  test('getMessages repairs only the top-level run required by the read model', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    await store.appendMessages(session.id, [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'question' },
      { type: 'assistant', id: 'legacy-assistant', turnId: 'turn-1', ts: 102, text: 'answer', modelId: 'fake-model' },
    ]);
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
      runtimeEvent({ id: 'rt-assistant', sessionId: session.id, runId: 'run-1', turnId: 'turn-1', ts: 102, role: 'model', author: 'agent', content: { kind: 'text', text: 'answer' } }),
    ]);
    await seedRuntimeRun(runStore, makeRunHeader({
      sessionId: session.id,
      runId: 'child-run',
      turnId: 'child-turn',
      parentRunId: 'run-1',
      parentTurnId: 'turn-1',
      status: 'completed',
      createdAt: 110,
      updatedAt: 112,
      completedAt: 112,
    }), [
      runtimeEvent({ id: 'rt-child-text', sessionId: session.id, runId: 'child-run', turnId: 'child-turn', ts: 111, role: 'model', author: 'agent', content: { kind: 'text', text: 'child answer' } }),
    ]);

    await manager.getMessages(session.id);

    const topLevelEvents = await runStore.readRuntimeEvents(session.id, 'run-1');
    const childEvents = await runStore.readRuntimeEvents(session.id, 'child-run');
    expect(topLevelEvents.some((event) => event.status === 'failed')).toBe(true);
    expect(childEvents.some((event) => event.status === 'failed' || event.status === 'completed')).toBe(false);
  });

  test('getMessages includes in-flight projection cache rows for an active RuntimeEvent run', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    const completed = await seedRuntimeReadTurn({
      store,
      runStore,
      sessionId: session.id,
      turnId: 'turn-1',
      runId: 'run-1',
      userText: 'completed question',
      assistantText: 'completed answer',
      legacyIdPrefix: 'legacy',
    });
    const activeMessages: StoredMessage[] = [
      { type: 'user', id: 'active-user', turnId: 'turn-2', ts: 201, text: 'active question' },
      { type: 'assistant', id: 'active-assistant', turnId: 'turn-2', ts: 202, text: 'partial active answer', modelId: 'fake-model' },
      { type: 'turn_state', id: 'active-state', turnId: 'turn-2', ts: 203, status: 'running', partialOutputRetained: true },
    ];
    await store.appendMessages(session.id, activeMessages);
    await runStore.createRun(makeRunHeader({
      sessionId: session.id,
      runId: 'run-2',
      turnId: 'turn-2',
      status: 'running',
      createdAt: 200,
      updatedAt: 203,
    }));

    const messages = await manager.getMessages(session.id);
    expect(messages).toEqual([...completed.projectedMessages, ...activeMessages]);
    expect(await manager.listTurns(session.id)).toEqual([
      { turnId: 'turn-1', status: 'completed', partialOutputRetained: true },
      { turnId: 'turn-2', status: 'running', partialOutputRetained: true },
    ]);

    const view = await new RuntimeReadModel({
      runStore,
      runtimeEventStore: runStore,
      projectionCache: store,
    }).getSessionView(session.id);
    expect(view.diagnostics.some((diagnostic) =>
      diagnostic.code === 'incomplete_event' &&
      diagnostic.message.includes('in-flight projection cache')
    )).toBe(true);
  });

  test('active RuntimeEvent ledger without a projection cache produces an explicit read-model error', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const session = await store.create(makeInput());
    await runStore.createRun(makeRunHeader({
      sessionId: session.id,
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'running',
    }));

    await expectRejects(
      new RuntimeReadModel({ runStore, runtimeEventStore: runStore }).getSessionView(session.id),
      /RuntimeEvent ledger is incomplete for an active run/,
    );
  });

  test('getMessages rejects when runtime ledger read fails', async () => {
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

    await expectRejects(manager.getMessages(session.id), /RuntimeEvent ledger read failed/);
  });

  test('MAKA_RUNTIME_READ_SOURCE does not force legacy reads when RuntimeEvents are complete', async () => {
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

      expect(await manager.getMessages(session.id)).toEqual(seeded.projectedMessages);
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

  test('mixed projection-cache-only system notes do not override RuntimeEvent projection', async () => {
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

    expect(messages).toEqual(seeded.projectedMessages);
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
    const manager = new SessionManager({ store, runStore, runtimeEventStore: runStore, backends, newId: nextId(), now: nextNow(6_760) });
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
    const manager = new SessionManager({ store, runStore, runtimeEventStore: runStore, backends, newId: nextId(), now: nextNow(6_770) });
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

    const runtimeMessages = await manager.getMessages(child.id);
    expect(runtimeMessages[0]).toMatchObject({ type: 'user', turnId: 'source', text: 'runtime branch context' });
    expect(runtimeMessages[1]).toMatchObject({ type: 'assistant', turnId: 'source', text: 'runtime branch answer' });
  });

  test('branch child next turn receives cloned RuntimeEvent context', async () => {
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
      runStore, runtimeEventStore: runStore, backends,
      newId: nextId(),
      now: nextNow(6_870),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput({ name: 'Parent' }));

    await drain(manager.sendMessage(session.id, { turnId: 'source', text: 'branch seed' }));
    const child = await manager.branchFromTurn(session.id, { sourceTurnId: 'source', name: 'Child' });
    await store.appendMessage(child.id, {
      type: 'assistant',
      id: 'child-cache-only',
      turnId: 'cache-only',
      ts: 6_999,
      text: 'cache-only child context',
      modelId: 'fake-model',
    });

    await drain(manager.sendMessage(child.id, { turnId: 'child-next', text: 'child follow-up' }));

    const childInput = backendInstances[1]?.sendInputs[0];
    if (!childInput) throw new Error('child backend input was not recorded');
    expect(childInput.context.some((message) => message.type === 'user' && message.turnId === 'source' && message.text === 'branch seed')).toBe(true);
    expect(childInput.context.some((message) => message.type === 'assistant' && message.id === 'child-cache-only')).toBe(false);
    expect(childInput.runtimeContext?.map((event) => event.turnId)).toEqual(['source', 'source', 'source']);
    expect(childInput.runtimeContext?.[0]?.sessionId).toBe(child.id);
  });

  test('branchFromTurn never leaves a terminal cloned run header without a terminal RuntimeEvent fact', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore({ failRuntimeEventAppendAfter: 5 });
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

    let branchError: unknown;
    try {
      await manager.branchFromTurn(session.id, { sourceTurnId: 'source', name: 'Child' });
    } catch (error) {
      branchError = error;
    }
    expect(branchError instanceof Error ? branchError.message : String(branchError)).toContain('runtime event append failed');

    const child = (await store.list()).find((summary) => summary.parentSessionId === session.id);
    expect(child).toBeDefined();
    const childRuns = await runStore.listSessionRuns(child!.id);
    for (const run of childRuns) {
      const runtimeEvents = await runStore.readRuntimeEvents(child!.id, run.runId);
      const hasTerminalFact = runtimeEvents.some(isTerminalRuntimeEvent);
      expect(
        run.status === 'completed' ||
        run.status === 'failed' ||
        run.status === 'cancelled'
          ? hasTerminalFact
          : true,
      ).toBe(true);
    }
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

  test('getMessages fails fast when RuntimeReadModel stores are not provided', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(6_760) });
    const session = await manager.createSession(makeInput());
    const legacyMessages: StoredMessage[] = [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'legacy only' },
    ];
    await store.appendMessages(session.id, legacyMessages);

    await expectRejects(manager.getMessages(session.id), /RuntimeReadModel requires AgentRunStore and RuntimeEventStore/);
  });

  test('next turn receives complete prior RuntimeEvent context and projection context', async () => {
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
      runStore, runtimeEventStore: runStore, backends,
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
    expect(secondInput.context.some((message) => message.type === 'user' && message.turnId === 'turn-2')).toBe(false);
    expect(secondInput.runtimeContext?.map((event) => event.turnId)).toEqual(['turn-1', 'turn-1', 'turn-1']);
    expect(secondInput.runtimeContext?.map((event) => event.role)).toEqual(['user', 'model', 'system']);
    expect(secondInput.runtimeContext?.[0]?.content).toEqual({ kind: 'text', text: 'first' });
  });

  test('next turn uses prior RuntimeEvents when terminal header commit was interrupted', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore({ failUpdateRunStatusOnce: 'completed' });
    const backends = new BackendRegistry();
    const backendInstances: TestBackend[] = [];
    backends.register('fake', (ctx) => {
      const backend = new TestBackend(ctx);
      backendInstances.push(backend);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore, runtimeEventStore: runStore, backends,
      newId: nextId(),
      now: nextNow(6_805),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'first' }));
    const [firstRun] = await runStore.listSessionRuns(session.id);
    if (!firstRun) throw new Error('first run was not recorded');
    expect(firstRun.status).toBe('running');
    expect((await runStore.readRuntimeEvents(session.id, firstRun.runId)).some(isTerminalRuntimeEvent)).toBe(true);

    await drain(manager.sendMessage(session.id, { turnId: 'turn-2', text: 'second' }));

    const secondInput = backendInstances[0]?.sendInputs[1];
    if (!secondInput) throw new Error('second backend input was not recorded');
    expect(secondInput.runtimeContext?.map((event) => event.turnId)).toEqual(['turn-1', 'turn-1', 'turn-1']);
    expect(secondInput.runtimeContext?.map((event) => event.role)).toEqual(['user', 'model', 'system']);
    expect(secondInput.runtimeContext?.[0]?.content).toEqual({ kind: 'text', text: 'first' });
  });

  test('next turn projects failed prior RuntimeEvents with the terminal fact failure class', async () => {
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
      runStore, runtimeEventStore: runStore, backends,
      newId: nextId(),
      now: nextNow(6_810),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());
    await seedRuntimeRun(runStore, makeRunHeader({
      sessionId: session.id,
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'running',
      createdAt: 101,
      updatedAt: 103,
    }), [
      runtimeEvent({
        id: 'rt-user',
        sessionId: session.id,
        runId: 'run-1',
        turnId: 'turn-1',
        ts: 101,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'first' },
      }),
      runtimeEvent({
        id: 'rt-assistant',
        sessionId: session.id,
        runId: 'run-1',
        turnId: 'turn-1',
        ts: 102,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'before failure' },
      }),
      runtimeEvent({
        id: 'rt-failed',
        sessionId: session.id,
        runId: 'run-1',
        turnId: 'turn-1',
        ts: 103,
        role: 'system',
        author: 'system',
        status: 'failed',
        actions: { endInvocation: true, stateDelta: { failureClass: 'tool_failed' } },
      }),
    ]);

    await drain(manager.sendMessage(session.id, { turnId: 'turn-2', text: 'second' }));

    const secondInput = backendInstances[0]?.sendInputs[0];
    if (!secondInput) throw new Error('backend input was not recorded');
    expect(secondInput.runtimeContext?.map((event) => event.turnId)).toEqual(['turn-1', 'turn-1', 'turn-1']);
    const turnState = secondInput.context.find((message) =>
      message.type === 'turn_state' && message.turnId === 'turn-1'
    );
    if (turnState?.type !== 'turn_state') throw new Error('prior failed turn_state was not projected');
    expect(turnState.status).toBe('failed');
    expect(turnState.errorClass).toBe('tool_failed');
  });

  test('next turn uses failed terminal RuntimeEvents when failed header commit was interrupted', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore({ failUpdateRunStatusOnce: 'failed' });
    const backends = new BackendRegistry();
    let backend: TurnScriptBackend | undefined;
    backends.register('fake', (ctx) => {
      backend = new TurnScriptBackend(ctx, [
        [{ type: 'complete', stopReason: 'error' }],
        [
          { type: 'text_delta', messageId: 'm2', text: 'second ok' },
          { type: 'complete', stopReason: 'end_turn' },
        ],
      ]);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore, runtimeEventStore: runStore, backends,
      newId: nextId(),
      now: nextNow(6_812),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'first' }));
    const [firstRun] = await runStore.listSessionRuns(session.id);
    if (!firstRun) throw new Error('first run was not recorded');
    expect(firstRun.status).toBe('running');
    const firstRuntimeEvents = await runStore.readRuntimeEvents(session.id, firstRun.runId);
    const firstTerminalEvents = firstRuntimeEvents.filter(isTerminalRuntimeEvent);
    expect(firstTerminalEvents).toHaveLength(1);
    expect(firstTerminalEvents[0]?.status).toBe('failed');
    expect(firstTerminalEvents[0]?.actions?.stateDelta?.failureClass).toBe('runtime_error');

    await drain(manager.sendMessage(session.id, { turnId: 'turn-2', text: 'second' }));

    const secondInput = backend?.sendInputs[1];
    if (!secondInput) throw new Error('second backend input was not recorded');
    expect(secondInput.runtimeContext?.map((event) => event.turnId)).toEqual(['turn-1', 'turn-1']);
    const turnState = secondInput.context.find((message) =>
      message.type === 'turn_state' && message.turnId === 'turn-1'
    );
    if (turnState?.type !== 'turn_state') throw new Error('prior failed turn_state was not projected');
    expect(turnState.status).toBe('failed');
    expect(turnState.errorClass).toBe('runtime_error');
    const terminalEventsAfterSecondTurn = (await runStore.readRuntimeEvents(session.id, firstRun.runId))
      .filter(isTerminalRuntimeEvent);
    expect(terminalEventsAfterSecondTurn).toHaveLength(1);
  });

  test('next parent turn excludes child run RuntimeEvents from model context', async () => {
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
      runStore, runtimeEventStore: runStore, backends,
      newId: nextId(),
      now: nextNow(6_825),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'first' }));
    const [parentRun] = await runStore.listSessionRuns(session.id);
    if (!parentRun) throw new Error('parent run was not recorded');
    await seedRuntimeRun(runStore, makeRunHeader({
      sessionId: session.id,
      runId: 'child-run',
      turnId: 'child-turn',
      status: 'completed',
      createdAt: parentRun.updatedAt + 1,
      updatedAt: parentRun.updatedAt + 4,
      completedAt: parentRun.updatedAt + 4,
      parentRunId: parentRun.runId,
      agentName: 'Researcher',
    }), [
      runtimeEvent({
        id: 'child-user',
        sessionId: session.id,
        runId: 'child-run',
        turnId: 'child-turn',
        ts: parentRun.updatedAt + 2,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'child prompt' },
      }),
      runtimeEvent({
        id: 'child-assistant',
        sessionId: session.id,
        runId: 'child-run',
        turnId: 'child-turn',
        ts: parentRun.updatedAt + 3,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'child private answer' },
      }),
      runtimeEvent({
        id: 'child-complete',
        sessionId: session.id,
        runId: 'child-run',
        turnId: 'child-turn',
        ts: parentRun.updatedAt + 4,
        role: 'system',
        author: 'system',
        status: 'completed',
        actions: { endInvocation: true },
      }),
    ]);

    await drain(manager.sendMessage(session.id, { turnId: 'turn-2', text: 'second' }));

    const secondInput = backendInstances[0]?.sendInputs[1];
    if (!secondInput) throw new Error('second backend input was not recorded');
    expect(secondInput.runtimeContext?.map((event) => event.turnId)).toEqual(['turn-1', 'turn-1', 'turn-1']);
    expect(secondInput.runtimeContext?.some((event) => event.turnId === 'child-turn')).toBe(false);
    expect(secondInput.context.some((message) => message.type === 'user' && message.turnId === 'child-turn')).toBe(false);
  });

  test('child run input records parentRunId and starts without implicit prior context', async () => {
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
      runStore, runtimeEventStore: runStore, backends,
      newId: nextId(),
      now: nextNow(6_835),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'parent context' }));
    const [parentRun] = await runStore.listSessionRuns(session.id);
    if (!parentRun) throw new Error('parent run was not recorded');
    await drain(manager.sendMessage(session.id, {
      turnId: 'child-turn',
      text: 'child prompt',
      parentRunId: parentRun.runId,
      agentName: 'Researcher',
    }));

    const childRun = (await runStore.listSessionRuns(session.id)).find((run) => run.turnId === 'child-turn');
    if (!childRun) throw new Error('child run was not recorded');
    expect(childRun.parentRunId).toBe(parentRun.runId);
    expect(childRun.agentName).toBe('Researcher');

    const childInput = backendInstances[0]?.sendInputs[1];
    if (!childInput) throw new Error('child backend input was not recorded');
    expect(childInput.context).toEqual([]);
    expect(childInput.runtimeContext).toBe(undefined);
  });

  test('startChildTurn uses a separate explore backend with the catalog child definition', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const contexts: BackendFactoryContext[] = [];
    const backendInstances: TestBackend[] = [];
    backends.register('fake', (ctx) => {
      contexts.push(ctx);
      const backend = new TestBackend(ctx);
      backendInstances.push(backend);
      return backend;
    });
    const childTools = [
      testTool('Read'),
      testTool('Bash'),
      testTool('Glob'),
      testTool('WebSearch'),
      testTool('Grep'),
      testTool('ExploreAgent'),
    ];
    const manager = new SessionManager({
      store,
      runStore, runtimeEventStore: runStore, backends,
      childTools,
      newId: nextId(),
      now: nextNow(6_840),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));

    await drain(manager.sendMessage(session.id, { turnId: 'parent-turn', text: 'parent context' }));
    const [parentRun] = await runStore.listSessionRuns(session.id);
    if (!parentRun) throw new Error('parent run was not recorded');

    await drain(manager.startChildTurn(session.id, {
      turnId: 'child-turn',
      parentRunId: parentRun.runId,
      spec: {
        id: LOCAL_READ_AGENT_ID,
        name: 'Injected Name',
        systemPrompt: 'Injected child prompt.',
      },
      prompt: 'inspect the repo',
    }));

    expect(contexts.map((ctx) => ctx.header.permissionMode)).toEqual(['ask', 'explore']);
    expect(contexts[1]?.systemPrompt).toBe(LOCAL_READ_AGENT_DEFINITION.systemPrompt);
    expect(contexts[1]?.tools?.map((tool) => tool.name)).toEqual(['Read', 'Glob', 'Grep']);
    expect(backendInstances).toHaveLength(2);
    expect(backendInstances[0] === backendInstances[1]).toBe(false);
    expect(backendInstances[1]?.sendInputs[0]?.context).toEqual([]);
    expect(backendInstances[1]?.sendInputs[0]?.runtimeContext).toBe(undefined);

    const childRun = (await runStore.listSessionRuns(session.id)).find((run) => run.turnId === 'child-turn');
    expect(childRun?.parentRunId).toBe(parentRun.runId);
    expect(childRun?.agentId).toBe(LOCAL_READ_AGENT_ID);
    expect(childRun?.agentName).toBe(LOCAL_READ_AGENT_DEFINITION.name);
    expect(childRun?.permissionMode).toBe('explore');

    const childMessages = (await store.readMessages(session.id)).filter((message) =>
      'turnId' in message && message.turnId === 'child-turn'
    );
    expect(childMessages).toEqual([]);
  });

  test('startChildTurn uses only WebSearch for the web research child definition', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const contexts: BackendFactoryContext[] = [];
    backends.register('fake', (ctx) => {
      contexts.push(ctx);
      return new TestBackend(ctx);
    });
    const manager = new SessionManager({
      store,
      runStore, runtimeEventStore: runStore, backends,
      childTools: [
        testTool('Read'),
        testTool('Glob'),
        testTool('Grep'),
        testTool('WebSearch'),
        testTool('Bash'),
      ],
      newId: nextId(),
      now: nextNow(6_841),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'execute' }));

    await drain(manager.sendMessage(session.id, { turnId: 'parent-turn', text: 'parent context' }));
    const [parentRun] = await runStore.listSessionRuns(session.id);
    if (!parentRun) throw new Error('parent run was not recorded');

    await drain(manager.startChildTurn(session.id, {
      turnId: 'child-turn',
      parentRunId: parentRun.runId,
      spec: {
        id: WEB_RESEARCH_AGENT_ID,
        name: 'Injected Name',
        systemPrompt: 'Injected child prompt.',
      },
      prompt: 'search the web',
    }));

    expect(contexts.map((ctx) => ctx.header.permissionMode)).toEqual(['execute', 'execute']);
    expect(contexts[1]?.systemPrompt).toBe(WEB_RESEARCH_AGENT_DEFINITION.systemPrompt);
    expect(contexts[1]?.tools?.map((tool) => tool.name)).toEqual(['WebSearch']);

    const childRun = (await runStore.listSessionRuns(session.id)).find((run) => run.turnId === 'child-turn');
    expect(childRun?.agentId).toBe(WEB_RESEARCH_AGENT_ID);
    expect(childRun?.agentName).toBe(WEB_RESEARCH_AGENT_DEFINITION.name);
    expect(childRun?.permissionMode).toBe('execute');
  });

  test('spawnChildAgent returns artifacts recorded for the child turn', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore, runtimeEventStore: runStore, backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      listArtifactsForTurn: async (_sessionId, turnId) => turnId === 'child-turn'
        ? [{
            id: 'artifact-1',
            sessionId: 'session-1',
            turnId,
            createdAt: 200,
            name: 'notes.md',
            kind: 'file',
            relativePath: 'artifacts/notes.md',
            sizeBytes: 12,
            status: 'live',
          }]
        : [],
      newId: nextId(),
      now: nextNow(6_842),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    await drain(manager.sendMessage(session.id, { turnId: 'parent-turn', text: 'parent context' }));
    const [parentRun] = await runStore.listSessionRuns(session.id);
    if (!parentRun) throw new Error('parent run was not recorded');

    const result = await manager.spawnChildAgent(session.id, {
      turnId: 'child-turn',
      parentRunId: parentRun.runId,
      spec: { id: LOCAL_READ_AGENT_ID, name: 'Injected Name', systemPrompt: 'read only' },
      prompt: 'inspect',
    });

    expect(result.agentId).toBe(LOCAL_READ_AGENT_ID);
    expect(result.agentName).toBe(LOCAL_READ_AGENT_DEFINITION.name);
    expect(result.artifactIds).toEqual(['artifact-1']);
  });

  test('spawnChildAgent returns the terminal RuntimeEvent status when the child header commit fails', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore({ failUpdateRunStatusOnce: 'completed' });
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(6_843),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    const parentRun = makeRunHeader({
      sessionId: session.id,
      runId: 'parent-run',
      turnId: 'parent-turn',
      status: 'completed',
      createdAt: 100,
      updatedAt: 110,
      completedAt: 110,
    });
    await seedRuntimeRun(runStore, parentRun, [
      runtimeEvent({ id: 'parent-complete', sessionId: session.id, runId: parentRun.runId, turnId: parentRun.turnId, ts: 110, status: 'completed', actions: { endInvocation: true } }),
    ]);

    const result = await manager.spawnChildAgent(session.id, {
      turnId: 'child-turn',
      parentRunId: parentRun.runId,
      spec: { id: LOCAL_READ_AGENT_ID, name: 'Researcher', systemPrompt: 'read only' },
      prompt: 'inspect',
    });

    expect(result.status).toBe('completed');
    const childRun = (await runStore.listSessionRuns(session.id)).find((run) => run.turnId === 'child-turn');
    expect(childRun?.status).toBe('running');
    const childTerminalEvents = (await runStore.readRuntimeEvents(session.id, childRun!.runId)).filter(isTerminalRuntimeEvent);
    expect(childTerminalEvents).toHaveLength(1);
  });

  test('spawnChildAgent summarizes high-volume child output without returning the full stream', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new HighVolumeDeltaBackend(ctx, 512));
    const manager = new SessionManager({
      store,
      runStore, runtimeEventStore: runStore, backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(6_844),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    await drain(manager.sendMessage(session.id, { turnId: 'parent-turn', text: 'parent context' }));
    const [parentRun] = await runStore.listSessionRuns(session.id);
    if (!parentRun) throw new Error('parent run was not recorded');

    const result = await manager.spawnChildAgent(session.id, {
      turnId: 'child-turn',
      parentRunId: parentRun.runId,
      spec: { id: LOCAL_READ_AGENT_ID, name: 'Researcher', systemPrompt: 'read only' },
      prompt: 'produce a large report',
    });

    expect(result.status).toBe('completed');
    expect(result.eventCount).toBe(513);
    expect(result.summary.length <= 4_000).toBe(true);
    expect(result.summary.startsWith('…')).toBe(true);
    expect(result.summary.includes('chunk-000')).toBe(false);
    expect(result.summary.includes('chunk-511')).toBe(true);
  });

  test('stopSession cancels active child runs and disposes their backend', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const childGate = makeGate();
    const backendInstances: TestBackend[] = [];
    backends.register('fake', (ctx) => {
      const backend = new TestBackend(ctx, ctx.header.permissionMode === 'explore' ? childGate : undefined);
      backendInstances.push(backend);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore, runtimeEventStore: runStore, backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(6_845),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    await drain(manager.sendMessage(session.id, { turnId: 'parent-turn', text: 'parent context' }));
    const [parentRun] = await runStore.listSessionRuns(session.id);
    if (!parentRun) throw new Error('parent run was not recorded');

    const child = manager.startChildTurn(session.id, {
      turnId: 'child-turn',
      parentRunId: parentRun.runId,
      spec: { id: LOCAL_READ_AGENT_ID, name: 'Researcher', systemPrompt: 'read only' },
      prompt: 'inspect slowly',
    })[Symbol.asyncIterator]();
    await child.next();

    await manager.stopSession(session.id, { source: 'stop_button' });
    childGate.release();
    await child.next();
    await child.next();

    const childRun = (await runStore.listSessionRuns(session.id)).find((run) => run.turnId === 'child-turn');
    if (!childRun) throw new Error('child run was not recorded');
    expect(childRun.status).toBe('cancelled');
    expect(store.disposeCount).toBe(1);
    await manager.setPermissionMode(session.id, 'execute');
    expect((await store.readHeader(session.id)).permissionMode).toBe('execute');
  });

  test('spawnChildAgent fails closed instead of running a degraded catalog agent', async () => {
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
      runStore, runtimeEventStore: runStore, backends,
      childTools: [testTool('Read')],
      newId: nextId(),
      now: nextNow(6_847),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'execute' }));
    await drain(manager.sendMessage(session.id, { turnId: 'parent-turn', text: 'parent context' }));
    const [parentRun] = await runStore.listSessionRuns(session.id);
    if (!parentRun) throw new Error('parent run was not recorded');

    await expectRejects(
      manager.spawnChildAgent(session.id, {
        turnId: 'child-turn',
        parentRunId: parentRun.runId,
        spec: {
          id: LOCAL_READ_AGENT_ID,
          name: LOCAL_READ_AGENT_DEFINITION.name,
          systemPrompt: LOCAL_READ_AGENT_DEFINITION.systemPrompt,
        },
        prompt: 'inspect',
      }),
      /Agent "local-read" is unavailable: missing tools: Glob, Grep/,
    );

    expect(backendInstances).toHaveLength(1);
    expect((await runStore.listSessionRuns(session.id)).some((run) => run.turnId === 'child-turn')).toBe(false);

    await expectRejects(
      manager.spawnChildAgent(session.id, {
        turnId: 'web-child-turn',
        parentRunId: parentRun.runId,
        spec: {
          id: WEB_RESEARCH_AGENT_ID,
          name: WEB_RESEARCH_AGENT_DEFINITION.name,
          systemPrompt: WEB_RESEARCH_AGENT_DEFINITION.systemPrompt,
        },
        prompt: 'search',
      }),
      /Agent "web-research" is unavailable: missing tools: WebSearch/,
    );
    expect(backendInstances).toHaveLength(1);
    expect((await runStore.listSessionRuns(session.id)).some((run) => run.turnId === 'web-child-turn')).toBe(false);
  });

  test('agent projections list catalog definitions separately from child runs and read output artifacts by child turn', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore, runtimeEventStore: runStore, backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      listArtifactsForTurn: async (_sessionId, turnId) => turnId === 'child-turn'
        ? [{
            id: 'artifact-1',
            sessionId: 'session-1',
            turnId,
            createdAt: 200,
            name: 'notes.md',
            kind: 'file',
            relativePath: 'artifacts/notes.md',
            sizeBytes: 12,
            status: 'live',
          }]
        : [],
      newId: nextId(),
      now: nextNow(6_848),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'execute' }));
    await seedRuntimeRun(runStore, makeRunHeader({
      sessionId: session.id,
      runId: 'parent-run',
      turnId: 'parent-turn',
      status: 'completed',
      createdAt: 100,
      updatedAt: 110,
      completedAt: 110,
    }), [
      runtimeEvent({ id: 'parent-user', sessionId: session.id, runId: 'parent-run', turnId: 'parent-turn', ts: 101, role: 'user', author: 'user', content: { kind: 'text', text: 'parent' } }),
      runtimeEvent({ id: 'parent-complete', sessionId: session.id, runId: 'parent-run', turnId: 'parent-turn', ts: 110, role: 'system', author: 'system', status: 'completed', actions: { endInvocation: true } }),
    ]);
    await seedRuntimeRun(runStore, makeRunHeader({
      sessionId: session.id,
      runId: 'child-run',
      turnId: 'child-turn',
      status: 'completed',
      createdAt: 120,
      updatedAt: 130,
      completedAt: 130,
      parentRunId: 'parent-run',
      agentId: LOCAL_READ_AGENT_ID,
      agentName: 'Researcher',
      permissionMode: 'explore',
    }), [
      runtimeEvent({ id: 'child-user', sessionId: session.id, runId: 'child-run', turnId: 'child-turn', ts: 121, role: 'user', author: 'user', content: { kind: 'text', text: 'inspect' } }),
      runtimeEvent({ id: 'child-answer', sessionId: session.id, runId: 'child-run', turnId: 'child-turn', ts: 125, role: 'model', author: 'agent', content: { kind: 'text', text: 'child answer' } }),
      runtimeEvent({ id: 'child-complete', sessionId: session.id, runId: 'child-run', turnId: 'child-turn', ts: 130, role: 'system', author: 'system', status: 'completed', actions: { endInvocation: true } }),
    ]);

    const list = await manager.listChildAgents(session.id);
    expect(list.definitions.map((agent) => agent.id)).toEqual([
      LOCAL_READ_AGENT_ID,
      WEB_RESEARCH_AGENT_ID,
      IMPLEMENTATION_AGENT_ID,
    ]);
    expect(list.definitions[0]?.availability).toEqual({ status: 'available' });
    expect(list.definitions[0]?.contract.defaultWriteBack).toBe('summary');
    expect(list.definitions[0]?.contract.workspace).toBe('same_workspace');
    expect(list.definitions[1]?.availability).toEqual({
      status: 'unavailable',
      reason: 'missing_tools',
      missingTools: ['WebSearch'],
    });
    expect(list.definitions[2]?.availability).toEqual({
      status: 'unavailable',
      reason: 'workspace_isolation_unavailable',
      workspace: AGENT_WORKSPACE_WORKTREE,
      requiredRuntime: 'worktree_child_executor',
    });
    expect(list.runs.map((agent) => agent.runId)).toEqual(['child-run']);
    expect(list.runs[0]?.agentId).toBe(LOCAL_READ_AGENT_ID);
    expect(list.runs[0]?.agentName).toBe('Researcher');
    expect(list.runs[0]?.durationMs).toBe(10);

    const output = await manager.readChildAgentOutput(session.id, { runId: 'child-run' });
    expect(output.header.runId).toBe('child-run');
    expect(output.runtimeEvents.map((event) => event.id)).toEqual(['child-user', 'child-answer', 'child-complete']);
    expect(output.artifacts.map((artifact) => artifact.id)).toEqual(['artifact-1']);
  });

  test('child agent projections use the terminal RuntimeEvent fact when the child header is stale', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(6_900),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'execute' }));
    await seedRuntimeRun(runStore, makeRunHeader({
      sessionId: session.id,
      runId: 'parent-run',
      turnId: 'parent-turn',
      status: 'running',
      createdAt: 100,
      updatedAt: 120,
    }), [
      runtimeEvent({ id: 'parent-complete', sessionId: session.id, runId: 'parent-run', turnId: 'parent-turn', ts: 120, status: 'completed', actions: { endInvocation: true } }),
    ]);
    await seedRuntimeRun(runStore, makeRunHeader({
      sessionId: session.id,
      runId: 'child-run',
      turnId: 'child-turn',
      status: 'running',
      createdAt: 130,
      updatedAt: 140,
      parentRunId: 'parent-run',
      agentId: LOCAL_READ_AGENT_ID,
      agentName: 'Researcher',
      permissionMode: 'explore',
    }), [
      runtimeEvent({ id: 'child-answer', sessionId: session.id, runId: 'child-run', turnId: 'child-turn', ts: 135, role: 'model', author: 'agent', content: { kind: 'text', text: 'child answer' } }),
      runtimeEvent({ id: 'child-complete', sessionId: session.id, runId: 'child-run', turnId: 'child-turn', ts: 140, role: 'system', author: 'system', status: 'completed', actions: { endInvocation: true } }),
    ]);

    const list = await manager.listChildAgents(session.id);
    expect(list.runs[0]?.runId).toBe('child-run');
    expect(list.runs[0]?.status).toBe('completed');
    expect(list.runs[0]?.completedAt).toBe(140);
    expect(list.runs[0]?.durationMs).toBe(10);

    const output = await manager.readChildAgentOutput(session.id, { runId: 'child-run' });
    expect(output.header.status).toBe('completed');
    expect(output.header.completedAt).toBe(140);
  });

  test('agent output returns a bounded child inspection instead of full replay internals', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore, runtimeEventStore: runStore, backends,
      newId: nextId(),
      now: nextNow(6_849),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());
    const header = makeRunHeader({
      sessionId: session.id,
      runId: 'child-run',
      turnId: 'child-turn',
      status: 'completed',
      createdAt: 120,
      updatedAt: 200,
      completedAt: 200,
      parentRunId: 'parent-run',
      agentId: LOCAL_READ_AGENT_ID,
      agentName: 'Researcher',
      permissionMode: 'explore',
    });
    await runStore.createRun(header);
    for (let index = 0; index < 25; index += 1) {
      await runStore.appendEvent(session.id, 'child-run', makeRunEvent({
        id: `op-${index}`,
        sessionId: session.id,
        runId: 'child-run',
        turnId: 'child-turn',
        type: 'model_stream_started',
        ts: 120 + index,
      }));
      await runStore.appendRuntimeEvent(session.id, 'child-run', runtimeEvent({
        id: `rt-${index}`,
        sessionId: session.id,
        runId: 'child-run',
        turnId: 'child-turn',
        ts: 120 + index,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: `line ${index}` },
      }));
    }

    const output = await manager.readChildAgentOutput(session.id, { runId: 'child-run', maxEvents: 5 });

    expect(output.header.runId).toBe('child-run');
    expect(output.events.map((event) => event.id)).toEqual(['op-20', 'op-21', 'op-22', 'op-23', 'op-24']);
    expect(output.runtimeEvents.map((event) => event.id)).toEqual(['rt-20', 'rt-21', 'rt-22', 'rt-23', 'rt-24']);
    expect(output.truncated.events).toBe(true);
    expect(output.truncated.runtimeEvents).toBe(true);
    expect('modelReplay' in output).toBe(false);
    expect('projection' in output).toBe(false);
  });

  test('agent output rejects ambiguous child run locators', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore, runtimeEventStore: runStore, backends,
      newId: nextId(),
      now: nextNow(6_850),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());
    await runStore.createRun(makeRunHeader({
      sessionId: session.id,
      runId: 'child-run',
      turnId: 'child-turn',
      status: 'completed',
      createdAt: 120,
      updatedAt: 130,
      completedAt: 130,
      parentRunId: 'parent-run',
      agentId: LOCAL_READ_AGENT_ID,
      agentName: 'Researcher',
      permissionMode: 'explore',
    }));

    await expectRejects(
      manager.readChildAgentOutput(session.id, { runId: 'child-run', turnId: 'child-turn' }),
      /exactly one of runId or turnId/,
    );
  });

  test('next turn still receives RuntimeEvent context when projection cache has extra rows', async () => {
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
      runStore, runtimeEventStore: runStore, backends,
      newId: nextId(),
      now: nextNow(6_850),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'first' }));
    await store.appendMessage(session.id, {
      type: 'assistant',
      id: 'legacy-extra-assistant',
      turnId: 'legacy-extra',
      ts: 6_899,
      text: 'cache-only context',
      modelId: 'fake-model',
    });
    await drain(manager.sendMessage(session.id, { turnId: 'turn-2', text: 'second' }));

    const secondInput = backendInstances[0]?.sendInputs[1];
    if (!secondInput) throw new Error('second backend input was not recorded');
    expect(secondInput.runtimeContext?.map((event) => event.turnId)).toEqual(['turn-1', 'turn-1', 'turn-1']);
    expect(secondInput.context.some((message) => message.type === 'assistant' && message.id === 'legacy-extra-assistant')).toBe(false);
  });

  test('next turn repairs a prior RuntimeEvent ledger before building model context', async () => {
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
      runStore, runtimeEventStore: runStore, backends,
      newId: nextId(),
      now: nextNow(6_900),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());
    await store.appendMessages(session.id, [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'first' },
      { type: 'assistant', id: 'legacy-assistant', turnId: 'turn-1', ts: 102, text: 'answer', modelId: 'fake-model' },
      { type: 'turn_state', id: 'legacy-state', turnId: 'turn-1', ts: 103, status: 'completed', partialOutputRetained: true },
    ]);
    await seedRuntimeRun(runStore, makeRunHeader({
      sessionId: session.id,
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'completed',
      createdAt: 100,
      updatedAt: 103,
      completedAt: 103,
    }), [
      runtimeEvent({ id: 'rt-user', sessionId: session.id, runId: 'run-1', turnId: 'turn-1', ts: 101, role: 'user', author: 'user', content: { kind: 'text', text: 'first' } }),
    ]);

    await drain(manager.sendMessage(session.id, { turnId: 'turn-2', text: 'second' }));

    const firstInput = backendInstances[0]?.sendInputs[0];
    if (!firstInput) throw new Error('backend input was not recorded');
    expect(firstInput.runtimeContext?.map((event) => ({
      role: event.role,
      text: event.content?.kind === 'text' ? event.content.text : undefined,
      status: event.status,
    }))).toEqual([
      { role: 'user', text: 'first', status: undefined },
      { role: 'model', text: 'answer', status: undefined },
      { role: 'system', text: undefined, status: 'completed' },
    ]);
    expect(backendInstances[0]?.sendInputs.length ?? 0).toBe(1);
  });

  test('RuntimeKernel turn runner uses AiSdkFlow instead of an inline mapper flow', async () => {
    const source = await readFile(new URL('../../src/runtime-kernel.ts', import.meta.url), 'utf8');
    const turnRunnerSource = source.slice(
      source.indexOf('private async *runAgentTurn'),
      source.indexOf('async stopSession'),
    );

    expect(turnRunnerSource.includes('new AiSdkFlow')).toBe(true);
    expect(turnRunnerSource.includes('mapSessionEventToRuntimeEvent')).toBe(false);
    expect(turnRunnerSource.includes('createSessionEventMapMemory')).toBe(false);
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

  test('backend build failure after user append writes a failed terminal run fact', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', () => {
      throw new Error('backend init failed');
    });
    const manager = new SessionManager({ store, runStore, runtimeEventStore: runStore, backends, newId: nextId(), now: nextNow(7_500) });
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
    if (!run) throw new Error('AgentRunStore run was not created');
    expect(run.status).toBe('failed');
    expect(run.failureClass).toBe('missing_terminal_event');
    const terminalEvents = (await runStore.readRuntimeEvents(session.id, run.runId)).filter(isTerminalRuntimeEvent);
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.status).toBe('failed');
    expect(terminalEvents[0]?.actions?.stateDelta?.failureClass).toBe('missing_terminal_event');
    expect((await manager.getMessages(session.id)).some((message) => message.type === 'user')).toBe(true);
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
    const manager = new SessionManager({ store, runStore, runtimeEventStore: runStore, backends, newId: nextId(), now: nextNow(9_000) });
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

  test('startup recovery does not treat permission handoff as a completed run fact', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new EventBackend(ctx, [
      { type: 'permission_request', requestId: 'pr-1', toolUseId: 'tool-1', toolName: 'Bash', category: 'shell_safe', reason: 'custom', args: {} },
      { type: 'complete', stopReason: 'permission_handoff' },
    ]));
    const manager = new SessionManager({ store, runStore, runtimeEventStore: runStore, backends, newId: nextId(), now: nextNow(9_010) });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));
    const [runBeforeRecovery] = await runStore.listSessionRuns(session.id);
    expect(runBeforeRecovery?.status).toBe('waiting_permission');

    await manager.recoverInterruptedSessions();

    const [runAfterRecovery] = await runStore.listSessionRuns(session.id);
    expect(runAfterRecovery?.status).toBe('failed');
    expect(runAfterRecovery?.failureClass).toBe('app_restarted');
    const [turn] = await store.listTurns(session.id);
    expect(turn?.status).toBe('failed');
    expect(turn?.errorClass).toBe('app_restarted');
    const terminalEvents = (await runStore.readRuntimeEvents(session.id, runAfterRecovery!.runId))
      .filter(isTerminalRuntimeEvent);
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.status).toBe('failed');
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

  test('complete(stopReason=error) without a prior error event classifies as runtime_error not unknown', async () => {
    // Reproduces the DeepSeek-reasoner smoke failure: the backend ended with
    // stopReason='error' but never emitted a preceding error event, so the
    // run ledger's failureClass was 'unknown'. It should be 'runtime_error'
    // so benchmark scoring can distinguish runtime failures from max_tokens.
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new EventBackend(ctx, [
      { type: 'complete', stopReason: 'error' },
    ]));
    const manager = new SessionManager({
      store, runStore, runtimeEventStore: runStore, backends, newId: nextId(), now: nextNow(10_000),
    });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));

    const [turn] = await store.listTurns(session.id);
    expect(turn?.status).toBe('failed');
    expect(turn?.errorClass).toBe('runtime_error');
    const [run] = await runStore.listSessionRuns(session.id);
    expect(run?.failureClass).toBe('runtime_error');
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
    const manager = new SessionManager({ store, runStore, runtimeEventStore: runStore, backends, newId: nextId(), now: nextNow(12_700) });
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

  test('stopSession persists abortSource on a terminal RuntimeEvent emitted during backend stop', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let backend: StopControlledAbortBackend | undefined;
    backends.register('fake', (ctx) => {
      backend = new StopControlledAbortBackend(ctx);
      return backend;
    });
    const manager = new SessionManager({ store, runStore, runtimeEventStore: runStore, backends, newId: nextId(), now: nextNow(12_710) });
    const session = await manager.createSession(makeInput());

    const iterator = manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' })[Symbol.asyncIterator]();
    await iterator.next();
    const pendingAbort = iterator.next();
    const stopPromise = manager.stopSession(session.id, { source: 'stop_button' });
    const abort = await pendingAbort;
    expect(abort.value?.type).toBe('abort');
    backend?.allowStopReturn();
    await stopPromise;
    while (!(await iterator.next()).done) {}

    const [run] = await runStore.listSessionRuns(session.id);
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, run!.runId);
    const terminalEvents = runtimeEvents.filter((event) => event.status === 'aborted');
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.actions?.stateDelta?.abortSource).toBe('renderer.stop_button');
    const messages = await manager.getMessages(session.id);
    expect(messages.some((message) => message.type === 'user' && message.turnId === 'turn-1')).toBe(true);
    expect(messages.find((message) => message.type === 'turn_state')).toEqual({
      type: 'turn_state',
      id: terminalEvents[0]?.id,
      turnId: 'turn-1',
      ts: 2,
      status: 'aborted',
      abortedAt: 2,
      abortSource: 'renderer.stop_button',
      partialOutputRetained: false,
    });
  });

  test('sendMessage does not emit or persist backend events after the first terminal event', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new EventBackend(ctx, [
      { type: 'text_delta', messageId: 'm1', text: 'before' },
      { type: 'abort', reason: 'user_stop' },
      { type: 'text_delta', messageId: 'm1', text: 'after-terminal' },
      { type: 'complete', stopReason: 'user_stop' },
    ]));
    const manager = new SessionManager({ store, runStore, runtimeEventStore: runStore, backends, newId: nextId(), now: nextNow(12_715) });
    const session = await manager.createSession(makeInput());

    const emitted = await collectSessionEvents(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));
    const [run] = await runStore.listSessionRuns(session.id);
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, run!.runId);
    const turnStates = (await store.readMessages(session.id)).filter((message) =>
      message.type === 'turn_state' && message.turnId === 'turn-1' && message.status !== 'running'
    );

    expect(emitted.map((event) => event.type)).toEqual(['text_delta', 'abort']);
    expect(runtimeEvents.filter((event) => event.role === 'model' && event.content?.kind === 'text').map((event) =>
      event.content?.kind === 'text' ? event.content.text : ''
    )).toEqual(['before']);
    const abortedEvents = runtimeEvents.filter((event) => event.status === 'aborted');
    expect(abortedEvents).toHaveLength(1);
    expect(abortedEvents[0]?.actions?.stateDelta?.abortSource).toBe('user_stop');
    expect(run?.status).toBe('cancelled');
    expect(run?.abortSource).toBe('user_stop');
    expect(turnStates).toHaveLength(1);
    expect(turnStates[0]?.type === 'turn_state' ? turnStates[0].status : undefined).toBe('aborted');
    expect(turnStates[0]?.type === 'turn_state' ? turnStates[0].abortSource : undefined).toBe('user_stop');
  });

  test('sendMessage ignores backend errors thrown after a completed terminal event is recorded', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new ThrowAfterTerminalBackend(ctx));
    const manager = new SessionManager({ store, runStore, runtimeEventStore: runStore, backends, newId: nextId(), now: nextNow(12_716) });
    const session = await manager.createSession(makeInput());

    const emitted = await collectSessionEvents(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));
    const [run] = await runStore.listSessionRuns(session.id);
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, run!.runId);
    const turnStates = (await store.readMessages(session.id)).filter((message) =>
      message.type === 'turn_state' && message.turnId === 'turn-1' && message.status !== 'running'
    );

    expect(emitted.map((event) => event.type)).toEqual(['text_delta', 'complete']);
    expect(run?.status).toBe('completed');
    expect(runtimeEvents.filter((event) => event.role === 'model' && event.content?.kind === 'text').map((event) =>
      event.content?.kind === 'text' ? event.content.text : ''
    )).toEqual(['before']);
    expect(runtimeEvents.filter((event) => event.status === 'completed')).toHaveLength(1);
    expect(runtimeEvents.filter((event) => event.status === 'failed')).toHaveLength(0);
    expect(turnStates).toHaveLength(1);
    expect(turnStates[0]?.type === 'turn_state' ? turnStates[0].status : undefined).toBe('completed');
  });

  test('stopSession keeps aborted state even if the backend emits a late error', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const gate = makeGate();
    backends.register('fake', (ctx) => new LateErrorBackend(ctx, gate));
    const manager = new SessionManager({ store, runStore, runtimeEventStore: runStore, backends, newId: nextId(), now: nextNow(12_720) });
    const session = await manager.createSession(makeInput());

    const iterator = manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' })[Symbol.asyncIterator]();
    await iterator.next();
    await manager.stopSession(session.id, { source: 'stop_button' });

    gate.release();
    await iterator.next();
    await iterator.next();
    await iterator.next();

    expect((await store.readHeader(session.id)).status).toBe('aborted');
    const [turn] = await store.listTurns(session.id);
    expect(turn?.status).toBe('aborted');
    expect(turn?.abortSource).toBe('renderer.stop_button');
    const [run] = await runStore.listSessionRuns(session.id);
    expect(run?.status).toBe('cancelled');
    expect(run?.failureClass).toBeUndefined();
    const events = (await runStore.readEvents(session.id, run!.runId)).map((event) => event.type);
    expect(events).toContain('run_cancelled');
    expect(events.includes('run_failed')).toBe(false);
  });

  test('durable run ledger records lifecycle trace events and redacts obvious secrets', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TraceBackend(ctx));
    const manager = new SessionManager({ store, runStore, runtimeEventStore: runStore, backends, newId: nextId(), now: nextNow(12_750) });
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

  test('durable run ledger records full active compact blocks asynchronously', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new ActiveCompactBlockBackend(ctx));
    const manager = new SessionManager({ store, runStore, runtimeEventStore: runStore, backends, newId: nextId(), now: nextNow(12_775) });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));

    const [run] = await runStore.listSessionRuns(session.id);
    const events = await runStore.readEvents(session.id, run!.runId);
    const compactEvent = events.find((event) => event.type === 'active_full_compact_block_recorded');
    expect(compactEvent?.data?.blockId).toBe('afcompact-test');
    expect(compactEvent?.data?.boundaryKind).toBe('activeFullCompact');
    const block = compactEvent?.data?.block as ActiveFullCompactBlock | undefined;
    expect(block?.kind).toBe('maka.active_full_compact_block');
    expect(block?.summary.text).toBe('persist the full active compact block');
    expect(block?.sourceRefs[0]?.sourceId).toBe('provider-message:0');
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
    const manager = new SessionManager({ store, runStore, runtimeEventStore: runStore, backends, newId: nextId(), now: nextNow(12_810) });
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

  test('startup recovery fails stale child runs without writing child turn_state into the parent transcript', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({ store, runStore, runtimeEventStore: runStore, backends, newId: nextId(), now: nextNow(12_812) });
    const session = await manager.createSession(makeInput({ status: 'running' }));
    await seedRunningTurn(store, session.id, 'parent-turn');
    await seedRun(runStore, makeRunHeader({
      sessionId: session.id,
      runId: 'parent-run',
      turnId: 'parent-turn',
      status: 'running',
    }), [
      makeRunEvent({ sessionId: session.id, runId: 'parent-run', turnId: 'parent-turn', type: 'run_started', ts: 11 }),
      makeRunEvent({ sessionId: session.id, runId: 'parent-run', turnId: 'parent-turn', type: 'tool_started', ts: 12 }),
    ]);
    await seedRun(runStore, makeRunHeader({
      sessionId: session.id,
      runId: 'child-run',
      turnId: 'child-turn',
      status: 'running',
      parentRunId: 'parent-run',
      agentName: 'Researcher',
      permissionMode: 'explore',
    }), [
      makeRunEvent({ sessionId: session.id, runId: 'child-run', turnId: 'child-turn', type: 'run_started', ts: 13 }),
      makeRunEvent({ sessionId: session.id, runId: 'child-run', turnId: 'child-turn', type: 'model_stream_started', ts: 14 }),
    ]);

    const recovered = await manager.recoverInterruptedSessions();

    expect(recovered).toEqual([session.id]);
    const messages = await store.readMessages(session.id);
    expect(messages.some((message) => message.type === 'turn_state' && message.turnId === 'child-turn')).toBe(false);
    const childRun = await runStore.readRun(session.id, 'child-run');
    expect(childRun.status).toBe('failed');
    expect(childRun.failureClass).toBe('app_restarted');
    const childEvents = await runStore.readEvents(session.id, 'child-run');
    expect(childEvents.map((event) => event.type)).toContain('run_failed');
  });

  test('startup recovery uses a completed RuntimeEvent terminal fact before incomplete AgentRun events', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({ store, runStore, runtimeEventStore: runStore, backends, newId: nextId(), now: nextNow(12_815) });
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
    await runStore.appendRuntimeEvent(session.id, 'run-1', runtimeEvent({
      id: 'rt-completed',
      sessionId: session.id,
      runId: 'run-1',
      turnId: 'turn-1',
      ts: 13,
      role: 'system',
      author: 'system',
      status: 'completed',
      actions: { endInvocation: true },
    }));

    const recovered = await manager.recoverInterruptedSessions();

    expect(recovered).toEqual([session.id]);
    expect((await store.readHeader(session.id)).status).toBe('active');
    const [turn] = await store.listTurns(session.id);
    expect(turn?.status).toBe('completed');
    const storedTurnStates = (await store.readMessages(session.id)).filter((message) =>
      message.type === 'turn_state' && message.turnId === 'turn-1'
    );
    expect(storedTurnStates.map((message) => message.type === 'turn_state' ? message.status : '')).toEqual([
      'running',
      'completed',
    ]);
    const [run] = await runStore.listSessionRuns(session.id);
    expect(run?.status).toBe('completed');
    const events = await runStore.readEvents(session.id, 'run-1');
    expect(events.map((event) => event.type)).toEqual(['run_started', 'model_stream_started', 'run_completed']);
    const recoveredEvent = events.find((event) => event.type === 'run_completed');
    expect(recoveredEvent?.data?.recoveryReason).toBe('runtime_event_terminal_fact');
  });

  test('startup recovery maps failed aborted and cancelled RuntimeEvent terminal facts consistently', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({ store, runStore, runtimeEventStore: runStore, backends, newId: nextId(), now: nextNow(12_817) });
    const failed = await manager.createSession(makeInput({ status: 'running' }));
    const aborted = await manager.createSession(makeInput({ status: 'running' }));
    const cancelled = await manager.createSession(makeInput({ status: 'running' }));

    await seedRunningTurn(store, failed.id, 'failed-turn');
    await seedRunningTurn(store, aborted.id, 'aborted-turn');
    await seedRunningTurn(store, cancelled.id, 'cancelled-turn');
    await seedRun(runStore, makeRunHeader({ sessionId: failed.id, runId: 'failed-run', turnId: 'failed-turn', status: 'running' }), [
      makeRunEvent({ sessionId: failed.id, runId: 'failed-run', turnId: 'failed-turn', type: 'run_started', ts: 11 }),
    ]);
    await seedRun(runStore, makeRunHeader({ sessionId: aborted.id, runId: 'aborted-run', turnId: 'aborted-turn', status: 'running' }), [
      makeRunEvent({ sessionId: aborted.id, runId: 'aborted-run', turnId: 'aborted-turn', type: 'run_started', ts: 21 }),
    ]);
    await seedRun(runStore, makeRunHeader({ sessionId: cancelled.id, runId: 'cancelled-run', turnId: 'cancelled-turn', status: 'running' }), [
      makeRunEvent({ sessionId: cancelled.id, runId: 'cancelled-run', turnId: 'cancelled-turn', type: 'run_started', ts: 31 }),
    ]);
    await runStore.appendRuntimeEvent(failed.id, 'failed-run', runtimeEvent({
      id: 'rt-failed',
      sessionId: failed.id,
      runId: 'failed-run',
      turnId: 'failed-turn',
      ts: 12,
      role: 'system',
      author: 'system',
      status: 'failed',
      content: { kind: 'error', reason: 'tool_failed', message: 'Tool failed' },
      actions: { endInvocation: true },
    }));
    await runStore.appendRuntimeEvent(aborted.id, 'aborted-run', runtimeEvent({
      id: 'rt-aborted',
      sessionId: aborted.id,
      runId: 'aborted-run',
      turnId: 'aborted-turn',
      ts: 22,
      role: 'system',
      author: 'system',
      status: 'aborted',
      actions: { endInvocation: true, stateDelta: { abortSource: 'renderer.stop_button' } },
    }));
    await runStore.appendRuntimeEvent(cancelled.id, 'cancelled-run', runtimeEvent({
      id: 'rt-cancelled',
      sessionId: cancelled.id,
      runId: 'cancelled-run',
      turnId: 'cancelled-turn',
      ts: 32,
      role: 'system',
      author: 'system',
      status: 'cancelled',
      actions: { endInvocation: true, stateDelta: { abortSource: 'renderer.stop_button' } },
    }));

    const recovered = await manager.recoverInterruptedSessions();

    expect(recovered).toEqual([failed.id, aborted.id, cancelled.id]);
    expect((await runStore.readRun(failed.id, 'failed-run')).status).toBe('failed');
    expect((await runStore.readRun(failed.id, 'failed-run')).failureClass).toBe('tool_failed');
    expect((await store.listTurns(failed.id))[0]?.status).toBe('failed');
    expect((await store.listTurns(failed.id))[0]?.errorClass).toBe('tool_failed');
    expect((await runStore.readRun(aborted.id, 'aborted-run')).status).toBe('cancelled');
    expect((await store.listTurns(aborted.id))[0]?.status).toBe('aborted');
    expect((await store.listTurns(aborted.id))[0]?.abortSource).toBe('renderer.stop_button');
    expect((await runStore.readRun(cancelled.id, 'cancelled-run')).status).toBe('cancelled');
    expect((await store.listTurns(cancelled.id))[0]?.status).toBe('aborted');
    expect((await store.listTurns(cancelled.id))[0]?.abortSource).toBe('renderer.stop_button');
    expect((await runStore.readEvents(failed.id, 'failed-run')).map((event) => event.type)).toContain('run_failed');
    expect((await runStore.readEvents(aborted.id, 'aborted-run')).map((event) => event.type)).toContain('run_cancelled');
    expect((await runStore.readEvents(cancelled.id, 'cancelled-run')).map((event) => event.type)).toContain('run_cancelled');
  });

  test('startup recovery refuses cache-completed recovery without a RuntimeEvent terminal fact', async () => {
    const unreadableStore = new MemorySessionStore();
    const unreadableRunStore = new MemoryAgentRunStore({ failRuntimeEventReads: true });
    const incompleteStore = new MemorySessionStore();
    const incompleteRunStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const unreadableManager = new SessionManager({
      store: unreadableStore,
      runStore: unreadableRunStore, runtimeEventStore: unreadableRunStore, backends,
      newId: nextId(),
      now: nextNow(12_818),
    });
    const incompleteManager = new SessionManager({
      store: incompleteStore,
      runStore: incompleteRunStore, runtimeEventStore: incompleteRunStore, backends,
      newId: nextId(),
      now: nextNow(12_819),
    });
    const unreadable = await unreadableManager.createSession(makeInput({ status: 'running' }));
    const incomplete = await incompleteManager.createSession(makeInput({ status: 'running' }));

    await seedRunningTurn(unreadableStore, unreadable.id, 'turn-1');
    await unreadableStore.appendMessage(unreadable.id, {
      type: 'assistant',
      id: 'assistant-1',
      turnId: 'turn-1',
      ts: 13,
      text: 'done',
      modelId: 'fake-model',
    });
    await seedRun(unreadableRunStore, makeRunHeader({
      sessionId: unreadable.id,
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'running',
    }), [
      makeRunEvent({ sessionId: unreadable.id, runId: 'run-1', turnId: 'turn-1', type: 'model_stream_completed', ts: 12 }),
    ]);

    await seedRunningTurn(incompleteStore, incomplete.id, 'turn-1');
    await incompleteStore.appendMessage(incomplete.id, {
      type: 'assistant',
      id: 'assistant-1',
      turnId: 'turn-1',
      ts: 13,
      text: 'done',
      modelId: 'fake-model',
    });
    await seedRun(incompleteRunStore, makeRunHeader({
      sessionId: incomplete.id,
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'running',
    }), [
      makeRunEvent({ sessionId: incomplete.id, runId: 'run-1', turnId: 'turn-1', type: 'model_stream_completed', ts: 12 }),
    ]);
    await incompleteRunStore.appendRuntimeEvent(incomplete.id, 'run-1', runtimeEvent({
      id: 'rt-incomplete-failed',
      sessionId: incomplete.id,
      runId: 'run-1',
      turnId: 'turn-1',
      ts: 14,
      role: 'system',
      author: 'system',
      status: 'failed',
      actions: { endInvocation: true },
    }));

    await unreadableManager.recoverInterruptedSessions();
    await incompleteManager.recoverInterruptedSessions();

    expect((await unreadableRunStore.readRun(unreadable.id, 'run-1')).status).toBe('running');
    expect((await unreadableStore.listTurns(unreadable.id))[0]?.status).toBe('running');
    expect((await incompleteRunStore.readRun(incomplete.id, 'run-1')).status).toBe('failed');
    expect((await incompleteStore.listTurns(incomplete.id))[0]?.status).toBe('failed');
    expect((await unreadableRunStore.readEvents(unreadable.id, 'run-1')).find((event) => event.type === 'run_failed')).toBeUndefined();
    expect((await incompleteRunStore.readEvents(incomplete.id, 'run-1')).find((event) => event.type === 'run_failed')?.data?.recoveryReason).toBe('model_stream_completed_without_runtime_terminal');
  });

  test('startup recovery fails stale tool tails while preserving partial output retention', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({ store, runStore, runtimeEventStore: runStore, backends, newId: nextId(), now: nextNow(12_820) });
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
    const manager = new SessionManager({ store, runStore, runtimeEventStore: runStore, backends, newId: nextId(), now: nextNow(12_830) });
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
    const manager = new SessionManager({ store, runStore, runtimeEventStore: runStore, backends, newId: nextId(), now: nextNow(12_840) });
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
    const manager = new SessionManager({ store, runStore, runtimeEventStore: runStore, backends, newId: nextId(), now: nextNow(12_850) });
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

  test('startup recovery treats terminal AgentRun headers without RuntimeEvent facts as missing terminal events', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({ store, runStore, runtimeEventStore: runStore, backends, newId: nextId(), now: nextNow(12_860) });
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

    expect(recovered).toEqual([completed.id, failed.id, cancelled.id]);
    const completedRun = await runStore.readRun(completed.id, 'completed-run');
    expect(completedRun.status).toBe('failed');
    expect(completedRun.failureClass).toBe('missing_terminal_event');
    expect((await runStore.readEvents(completed.id, 'completed-run')).map((event) => event.type)).toEqual(['run_completed']);
    const completedTerminalEvents = (await runStore.readRuntimeEvents(completed.id, 'completed-run')).filter(isTerminalRuntimeEvent);
    expect(completedTerminalEvents.map((event) => event.status)).toEqual(['failed']);
    expect(completedTerminalEvents[0]?.actions?.stateDelta?.failureClass).toBe('missing_terminal_event');
    const failedRun = await runStore.readRun(failed.id, 'failed-run');
    expect(failedRun.status).toBe('failed');
    expect(failedRun.failureClass).toBe('missing_terminal_event');
    expect((await runStore.readEvents(failed.id, 'failed-run')).map((event) => event.type)).toEqual(['run_failed']);
    const failedTerminalEvents = (await runStore.readRuntimeEvents(failed.id, 'failed-run')).filter(isTerminalRuntimeEvent);
    expect(failedTerminalEvents.map((event) => event.status)).toEqual(['failed']);
    expect(failedTerminalEvents[0]?.actions?.stateDelta?.failureClass).toBe('missing_terminal_event');
    const cancelledRun = await runStore.readRun(cancelled.id, 'cancelled-run');
    expect(cancelledRun.status).toBe('failed');
    expect(cancelledRun.failureClass).toBe('missing_terminal_event');
    expect((await runStore.readEvents(cancelled.id, 'cancelled-run')).map((event) => event.type)).toEqual(['run_cancelled']);
    const cancelledTerminalEvents = (await runStore.readRuntimeEvents(cancelled.id, 'cancelled-run')).filter(isTerminalRuntimeEvent);
    expect(cancelledTerminalEvents.map((event) => event.status)).toEqual(['failed']);
    expect(cancelledTerminalEvents[0]?.actions?.stateDelta?.failureClass).toBe('missing_terminal_event');
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
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const events: PartialEvent[] = [
      { type: 'complete', stopReason: 'end_turn' },
    ];
    backends.register('fake', (ctx) => new EventBackend(ctx, events));
    const manager = new SessionManager({ store, runStore, runtimeEventStore: runStore, backends, newId: nextId(), now: nextNow(13_000) });
    const session = await manager.createSession(makeInput());
    await seedRuntimeRun(runStore, makeRunHeader({
      sessionId: session.id,
      runId: 'source-run',
      turnId: 'source',
      status: 'cancelled',
      completedAt: 102,
    }), [
      runtimeEvent({ id: 'source-user', sessionId: session.id, runId: 'source-run', turnId: 'source', ts: 101, role: 'user', author: 'user', content: { kind: 'text', text: 'try this' } }),
      runtimeEvent({ id: 'source-abort', sessionId: session.id, runId: 'source-run', turnId: 'source', ts: 102, role: 'system', author: 'system', status: 'aborted', actions: { endInvocation: true, stateDelta: { abortSource: 'renderer.stop_button' } } }),
    ]);

    await drain(manager.retryTurn(session.id, { sourceTurnId: 'source', turnId: 'retry-1' }));

    const turns = await manager.listTurns(session.id);
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
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new EventBackend(ctx, [
      { type: 'complete', stopReason: 'end_turn' },
    ]));
    const manager = new SessionManager({ store, runStore, runtimeEventStore: runStore, backends, newId: nextId(), now: nextNow(14_000) });
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
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new EventBackend(ctx, [
      { type: 'complete', stopReason: 'end_turn' },
    ]));
    const manager = new SessionManager({ store, runStore, runtimeEventStore: runStore, backends, newId: nextId(), now: nextNow(15_000) });
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

  test('branchFromTurn preserves the parent thinking level for future turns', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const contexts: BackendFactoryContext[] = [];
    backends.register('fake', (ctx) => {
      contexts.push(ctx);
      return new EventBackend(ctx, [{ type: 'complete', stopReason: 'end_turn' }]);
    });
    const manager = new SessionManager({ store, runStore, runtimeEventStore: runStore, backends, newId: nextId(), now: nextNow(15_500) });
    const session = await manager.createSession(makeInput({ name: 'Parent', thinkingLevel: 'high' }));
    await drain(manager.sendMessage(session.id, { turnId: 'source', text: 'context' }));

    const child = await manager.branchFromTurn(session.id, { sourceTurnId: 'source', name: 'Child' });

    expect(child.thinkingLevel).toBe('high');
    expect((await store.readHeader(child.id)).thinkingLevel).toBe('high');
    await drain(manager.sendMessage(child.id, { turnId: 'child-turn', text: 'continue' }));
    expect(contexts.find((ctx) => ctx.sessionId === child.id)?.header.thinkingLevel).toBe('high');
  });
});

class DelegatingRuntimeKernel implements RuntimeKernelLike {
  readonly starts: Array<{ sessionId: string; input: Parameters<RuntimeKernelLike['startTurn']>[1] }> = [];
  readonly stopped: string[] = [];
  readonly permissionResponses: string[] = [];
  activeRuns = false;
  disposed: string[] = [];
  cachedHeaders: SessionHeader[] = [];

  constructor(private readonly events: readonly SessionEvent[] = []) {}

  async *startTurn(
    sessionId: string,
    input: Parameters<RuntimeKernelLike['startTurn']>[1],
  ): AsyncIterable<SessionEvent> {
    this.starts.push({ sessionId, input });
    for (const event of this.events) {
      yield event;
    }
  }

  async *startChildTurn(
    sessionId: string,
    input: Parameters<RuntimeKernelLike['startChildTurn']>[1],
  ): AsyncIterable<SessionEvent> {
    this.starts.push({
      sessionId,
      input: {
        turnId: input.turnId,
        text: input.prompt,
        parentRunId: input.parentRunId,
        agentName: input.spec.name,
      },
    });
    for (const event of this.events) {
      yield event;
    }
  }

  async *compactSession(
    sessionId: string,
    input: Parameters<RuntimeKernelLike['compactSession']>[1] = {},
  ): AsyncIterable<SessionEvent> {
    this.starts.push({ sessionId, input: { turnId: input.turnId ?? 'compact-turn', text: '' } });
    for (const event of this.events) {
      yield event;
    }
  }

  async stopSession(sessionId: string): Promise<void> {
    this.stopped.push(sessionId);
  }

  async respondToPermission(
    sessionId: string,
    _response: Parameters<RuntimeKernelLike['respondToPermission']>[1],
  ): Promise<void> {
    this.permissionResponses.push(sessionId);
  }

  hasActiveRuns(): boolean {
    return this.activeRuns;
  }

  updateCachedHeader(_sessionId: string, header: SessionHeader): void {
    this.cachedHeaders.push(header);
  }

  async disposeBackend(sessionId: string): Promise<void> {
    this.disposed.push(sessionId);
  }
}

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

class CompactingTestBackend extends TestBackend {
  constructor(
    ctx: BackendFactoryContext,
    private readonly compactCalls: Array<{ turnId: string; runtimeContextCount: number }>,
  ) {
    super(ctx);
  }

  async compactHistory(input: { turnId: string; runtimeContext: readonly RuntimeEvent[] }) {
    this.compactCalls.push({ turnId: input.turnId, runtimeContextCount: input.runtimeContext.length });
    return compactHistoryResult();
  }
}

class BlockingCompactBackend extends TestBackend {
  stopCalls = 0;

  constructor(
    ctx: BackendFactoryContext,
    private readonly options: {
      compactGate: Gate;
      onCompactStart: (backend: BlockingCompactBackend) => void;
    },
  ) {
    super(ctx);
  }

  async compactHistory(_input: { turnId: string; runtimeContext: readonly RuntimeEvent[] }) {
    this.options.onCompactStart(this);
    await this.options.compactGate.promise;
    return compactHistoryResult();
  }

  override async stop(): Promise<void> {
    this.stopCalls += 1;
  }
}

class ActiveTurnBackend extends TestBackend {
  constructor(
    ctx: BackendFactoryContext,
    private readonly options: {
      turnStarted: Gate;
      sendGate: Gate;
      compactCalls: Array<{ turnId: string; runtimeContextCount: number }>;
    },
  ) {
    super(ctx, options.sendGate);
  }

  override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.options.turnStarted.release();
    yield* super.send(input);
  }

  async compactHistory(input: { turnId: string; runtimeContext: readonly RuntimeEvent[] }) {
    this.options.compactCalls.push({ turnId: input.turnId, runtimeContextCount: input.runtimeContext.length });
    return compactHistoryResult();
  }
}

function compactHistoryResult() {
  return {
    contextBudget: {
      enabled: true,
      policyName: 'unit-budget',
      estimatedTokensBefore: 1000,
      estimatedTokensAfter: 400,
      keptTurns: 1,
      droppedTurns: 1,
      keptEvents: 1,
      droppedEvents: 1,
      compactionDecisions: [{
        stage: 'priorReplay' as const,
        sourceKind: 'runtimeEvents' as const,
        decision: 'replaced' as const,
        boundaryKind: 'historyCompact',
        estimatedTokensSaved: 600,
      }],
    },
  };
}

class HighVolumeDeltaBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly sessionId: string;

  constructor(ctx: BackendFactoryContext, private readonly chunkCount: number) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const messageId = `${input.turnId}-m`;
    for (let index = 0; index < this.chunkCount; index += 1) {
      yield {
        type: 'text_delta',
        id: `${input.turnId}-delta-${index}`,
        turnId: input.turnId,
        ts: index + 1,
        messageId,
        text: `chunk-${String(index).padStart(3, '0')}:${'x'.repeat(32)}\n`,
      };
    }
    yield {
      type: 'complete',
      id: `${input.turnId}-complete`,
      turnId: input.turnId,
      ts: this.chunkCount + 1,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

class TextCompleteBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly sessionId: string;

  constructor(ctx: BackendFactoryContext) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const messageId = `${input.turnId}-m`;
    yield {
      type: 'text_delta',
      id: `${input.turnId}-delta`,
      turnId: input.turnId,
      ts: 7_000,
      messageId,
      text: 'ok',
    };
    yield {
      type: 'text_complete',
      id: `${input.turnId}-text-complete`,
      turnId: input.turnId,
      ts: 7_001,
      messageId,
      text: 'ok',
    };
    yield {
      type: 'complete',
      id: `${input.turnId}-complete`,
      turnId: input.turnId,
      ts: 7_002,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

class LateErrorBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly sessionId: string;

  constructor(private readonly ctx: BackendFactoryContext, private readonly gate: Gate) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    yield { type: 'text_delta', id: `${input.turnId}-delta`, turnId: input.turnId, ts: 1, messageId: `${input.turnId}-m`, text: 'ok' };
    await this.gate.promise;
    yield { type: 'error', id: `${input.turnId}-error`, turnId: input.turnId, ts: 2, recoverable: false, reason: 'late_error', message: 'late backend error' };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {
    if (this.ctx.store instanceof MemorySessionStore) {
      this.ctx.store.disposeCount += 1;
    }
  }
}

class StopControlledAbortBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly sessionId: string;
  private releaseAbort: () => void = () => {};
  private releaseStop: () => void = () => {};
  private readonly abortGate = new Promise<void>((resolve) => {
    this.releaseAbort = resolve;
  });
  private readonly stopGate = new Promise<void>((resolve) => {
    this.releaseStop = resolve;
  });

  constructor(ctx: BackendFactoryContext) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    yield { type: 'text_delta', id: `${input.turnId}-delta`, turnId: input.turnId, ts: 1, messageId: `${input.turnId}-m`, text: 'ok' };
    await this.abortGate;
    yield { type: 'abort', id: `${input.turnId}-abort`, turnId: input.turnId, ts: 2, reason: 'user_stop' };
    yield { type: 'complete', id: `${input.turnId}-complete`, turnId: input.turnId, ts: 3, stopReason: 'user_stop' };
  }

  async stop(): Promise<void> {
    this.releaseAbort();
    await this.stopGate;
  }

  allowStopReturn(): void {
    this.releaseStop();
  }

  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

type PartialEvent =
  | Omit<Extract<SessionEvent, { type: 'text_delta' }>, 'id' | 'turnId' | 'ts'>
  | Omit<Extract<SessionEvent, { type: 'permission_request' }>, 'id' | 'turnId' | 'ts'>
  | Omit<Extract<SessionEvent, { type: 'complete' }>, 'id' | 'turnId' | 'ts'>
  | Omit<Extract<SessionEvent, { type: 'error' }>, 'id' | 'turnId' | 'ts'>
  | Omit<Extract<SessionEvent, { type: 'abort' }>, 'id' | 'turnId' | 'ts'>;

class TurnScriptBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly sessionId: string;
  readonly sendInputs: BackendSendInput[] = [];

  constructor(private readonly ctx: BackendFactoryContext, private readonly turns: PartialEvent[][]) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.sendInputs.push(input);
    const events = this.turns[this.sendInputs.length - 1] ?? [
      { type: 'text_delta', messageId: `${input.turnId}-m`, text: 'ok' },
      { type: 'complete', stopReason: 'end_turn' },
    ];
    let index = 0;
    for (const event of events) {
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

class ThrowAfterTerminalBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly sessionId: string;

  constructor(ctx: BackendFactoryContext) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    yield { type: 'text_delta', id: `${input.turnId}-delta`, turnId: input.turnId, ts: 1, messageId: `${input.turnId}-m`, text: 'before' };
    yield { type: 'complete', id: `${input.turnId}-complete`, turnId: input.turnId, ts: 2, stopReason: 'end_turn' };
    throw new Error('cleanup after terminal failed');
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

class ThrowBeforeTerminalBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly sessionId: string;

  constructor(ctx: BackendFactoryContext) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    yield { type: 'text_delta', id: `${input.turnId}-delta`, turnId: input.turnId, ts: 1, messageId: `${input.turnId}-m`, text: 'before' };
    throw new Error('backend failed before terminal');
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

class ActiveCompactBlockBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly sessionId: string;

  constructor(private readonly ctx: BackendFactoryContext) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.ctx.recordActiveFullCompactBlock?.(activeCompactBlockFixture(this.sessionId, input.turnId));
    yield { type: 'complete', id: `${input.turnId}-complete`, turnId: input.turnId, ts: 4, stopReason: 'end_turn' };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

function activeCompactBlockFixture(sessionId: string, turnId: string): ActiveFullCompactBlock {
  return {
    kind: 'maka.active_full_compact_block',
    version: 1,
    blockId: 'afcompact-test',
    sessionId,
    turnId,
    createdAt: 12_775,
    highWaterName: 'test-high-water',
    highWaterSeq: 2,
    trigger: {
      reason: 'high_water',
      stepNumber: 2,
      estimatedTokensBefore: 100,
      thresholdTokens: 50,
    },
    coverage: {
      turnIds: [turnId],
      runtimeEventIds: ['runtime-1'],
      providerMessageSourceIds: ['provider-message:0'],
      toolCallIds: ['tool-1'],
      contentKinds: ['text'],
      bodySha256: ['a'.repeat(64)],
    },
    summary: {
      schemaVersion: 1,
      text: 'persist the full active compact block',
      processState: ['qemu-system-x86_64 pid=4242'],
    },
    limitations: ['test fixture'],
    sourceRefs: [{
      kind: 'runtime_event',
      sourceId: 'provider-message:0',
      messageIndex: 0,
      sessionId,
      turnId,
      runtimeEventId: 'runtime-1',
      toolCallId: 'tool-1',
      contentKind: 'text',
      bodySha256: 'a'.repeat(64),
    }],
    estimatedTokens: 42,
  };
}

class MemorySessionStore implements SessionStore {
  private headers = new Map<string, SessionHeader>();
  private messages = new Map<string, StoredMessage[]>();
  readonly failReadMessagesFor = new Set<string>();
  readonly failNextReadMessagesFor = new Map<string, number>();
  readonly failListTurnsFor = new Set<string>();
  readonly failUpdateHeaderFor = new Set<string>();
  readonly interleaveBeforeMarkSessionReadWriteFor = new Map<string, () => Promise<void> | void>();
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
      ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
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
    await this.runMarkSessionReadInterleave(sessionId);
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
    if (this.failUpdateHeaderFor.has(sessionId)) throw new Error(`Cannot update header for ${sessionId}`);
    const current = await this.readHeader(sessionId);
    const next = { ...current, ...patch };
    this.headers.set(sessionId, next);
    return next;
  }

  async markSessionReadThrough(sessionId: string, readThroughTs: number): Promise<SessionHeader> {
    await this.runMarkSessionReadInterleave(sessionId);
    if (this.failUpdateHeaderFor.has(sessionId)) throw new Error(`Cannot update header for ${sessionId}`);
    const current = await this.readHeader(sessionId);
    if (!current.hasUnread) return current;
    if (current.lastMessageAt !== undefined && current.lastMessageAt > readThroughTs) return current;
    const next = { ...current, hasUnread: false };
    this.headers.set(sessionId, next);
    return next;
  }

  private async runMarkSessionReadInterleave(sessionId: string): Promise<void> {
    const hook = this.interleaveBeforeMarkSessionReadWriteFor.get(sessionId);
    if (!hook) return;
    this.interleaveBeforeMarkSessionReadWriteFor.delete(sessionId);
    await hook();
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

class MemoryAgentRunStore implements AgentRunStore, RuntimeEventStore {
  listSessionRunsCalls = 0;
  private headers = new Map<string, AgentRunHeader>();
  private events = new Map<string, AgentRunEvent[]>();
  private runtimeEvents = new Map<string, RuntimeEvent[]>();
  private runtimeEventAppendCount = 0;

  constructor(private readonly options: {
    failRuntimeEventAppends?: boolean;
    failRuntimeEventAppendAfter?: number;
    failRuntimeEventReads?: boolean;
    failUpdateRunOnce?: boolean;
    failUpdateRunStatusOnce?: AgentRunHeader['status'];
    beforeRuntimeEventRead?: (sessionId: string, runId: string) => Promise<void> | void;
  } = {}) {}

  async createRun(header: AgentRunHeader): Promise<AgentRunHeader> {
    this.headers.set(key(header.sessionId, header.runId), { ...header });
    return { ...header };
  }

  async updateRun(sessionId: string, runId: string, patch: Partial<AgentRunHeader>): Promise<AgentRunHeader> {
    if (this.options.failUpdateRunOnce) {
      this.options.failUpdateRunOnce = false;
      throw new Error('update run failed');
    }
    if (patch.status && patch.status === this.options.failUpdateRunStatusOnce) {
      this.options.failUpdateRunStatusOnce = undefined;
      throw new Error('update run failed');
    }
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
    this.listSessionRunsCalls += 1;
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
    this.runtimeEventAppendCount += 1;
    if (
      this.options.failRuntimeEventAppendAfter !== undefined &&
      this.runtimeEventAppendCount > this.options.failRuntimeEventAppendAfter
    ) {
      this.options.failRuntimeEventAppendAfter = undefined;
      throw new Error('runtime event append failed');
    }
    const eventKey = key(sessionId, runId);
    this.runtimeEvents.set(eventKey, [...(this.runtimeEvents.get(eventKey) ?? []), copyRuntimeEvent(event)]);
  }

  async readRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]> {
    if (this.options.failRuntimeEventReads) throw new Error('runtime event read failed');
    await this.options.beforeRuntimeEventRead?.(sessionId, runId);
    return (this.runtimeEvents.get(key(sessionId, runId)) ?? []).map(copyRuntimeEvent);
  }

  async readSessionRuntimeEvents(sessionId: string): Promise<RuntimeEvent[]> {
    const ordered: Array<{ event: RuntimeEvent; runId: string; eventIndex: number }> = [];
    for (const [eventKey, events] of this.runtimeEvents.entries()) {
      const [eventSessionId, runId] = eventKey.split(':');
      if (eventSessionId !== sessionId || !runId) continue;
      events.forEach((event, eventIndex) => ordered.push({ event: copyRuntimeEvent(event), runId, eventIndex }));
    }
    ordered.sort((a, b) =>
      a.event.ts - b.event.ts ||
      a.runId.localeCompare(b.runId) ||
      a.eventIndex - b.eventIndex ||
      a.event.id.localeCompare(b.event.id)
    );
    return ordered.map((item) => item.event);
  }
}

class OrderingAgentRunStore extends MemoryAgentRunStore {
  operations: string[] = [];

  override async updateRun(sessionId: string, runId: string, patch: Partial<AgentRunHeader>): Promise<AgentRunHeader> {
    const next = await super.updateRun(sessionId, runId, patch);
    if (patch.status === 'completed') this.operations.push('completedRunHeader');
    return next;
  }

  override async appendRuntimeEvent(sessionId: string, runId: string, event: RuntimeEvent): Promise<void> {
    await super.appendRuntimeEvent(sessionId, runId, event);
    if (isTerminalRuntimeEvent(event)) this.operations.push('terminalRuntimeEvent');
  }
}

class MemoryRuntimeEventStore implements RuntimeEventStore {
  private runtimeEvents = new Map<string, RuntimeEvent[]>();

  constructor(private readonly options: { failRuntimeEventAppends?: boolean; failRuntimeEventReads?: boolean } = {}) {}

  async appendRuntimeEvent(sessionId: string, runId: string, event: RuntimeEvent): Promise<void> {
    if (this.options.failRuntimeEventAppends) throw new Error('runtime event append failed');
    const eventKey = key(sessionId, runId);
    this.runtimeEvents.set(eventKey, [...(this.runtimeEvents.get(eventKey) ?? []), copyRuntimeEvent(event)]);
  }

  async readRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]> {
    if (this.options.failRuntimeEventReads) throw new Error('runtime event read failed');
    return (this.runtimeEvents.get(key(sessionId, runId)) ?? []).map(copyRuntimeEvent);
  }

  async readSessionRuntimeEvents(sessionId: string): Promise<RuntimeEvent[]> {
    const ordered: Array<{ event: RuntimeEvent; runId: string; eventIndex: number }> = [];
    for (const [eventKey, events] of this.runtimeEvents.entries()) {
      const [eventSessionId, runId] = eventKey.split(':');
      if (eventSessionId !== sessionId || !runId) continue;
      events.forEach((event, eventIndex) => ordered.push({ event: copyRuntimeEvent(event), runId, eventIndex }));
    }
    ordered.sort((a, b) =>
      a.event.ts - b.event.ts ||
      a.runId.localeCompare(b.runId) ||
      a.eventIndex - b.eventIndex ||
      a.event.id.localeCompare(b.event.id)
    );
    return ordered.map((item) => item.event);
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

function testTool(name: string): MakaTool {
  return {
    name,
    description: `${name} test tool`,
    parameters: {},
    permissionRequired: false,
    impl: async () => ({ ok: true }),
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

function makeManagerForReadCutover(store: MemorySessionStore, runStore: AgentRunStore & RuntimeEventStore): SessionManager {
  const backends = new BackendRegistry();
  backends.register('fake', (ctx) => new TestBackend(ctx));
  return new SessionManager({ store, runStore, runtimeEventStore: runStore, backends, newId: nextId(), now: nextNow(6_755) });
}

async function seedRuntimeReadTurn(input: {
  store: MemorySessionStore;
  runStore: AgentRunStore & RuntimeEventStore;
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
  runStore: AgentRunStore & RuntimeEventStore;
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
  runStore: AgentRunStore & RuntimeEventStore,
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
