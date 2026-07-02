import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTurnRecords, isTerminalRuntimeEvent } from '@maka/core';
import type {
  AgentRunEvent,
  AgentRunHeader,
  AgentRunStore,
  CreateSessionInput,
  RuntimeEvent,
  RuntimeEventStore,
  SessionHeader,
  SessionListFilter,
  SessionSummary,
  StoredMessage,
  TurnRecord,
} from '@maka/core';
import type { BackendSendInput, PermissionDecision } from '@maka/core/backend-types';
import type { SessionEvent } from '@maka/core/events';
import { expect } from '../test-helpers.js';
import {
  BackendRegistry,
  SessionManager,
  type BackendFactoryContext,
  type SessionStore,
} from '../session-manager.js';
import type { AgentBackend } from '../ai-sdk-backend.js';
import { commitTerminalRunWithRuntimeFact } from '../terminal-run-commit.js';

describe('SessionManager terminal ledger invariants', () => {
  test('error streams persist a failed terminal fact without non-terminal error ledger rows', async () => {
    const { manager, runStore, session } = await makeHarness([
      { type: 'error', recoverable: false, reason: 'tool_failed', message: 'Tool failed' },
      { type: 'complete', stopReason: 'end_turn' },
    ]);

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));

    const [run] = await runStore.listSessionRuns(session.id);
    if (!run) throw new Error('run was not recorded');
    expect(run.status).toBe('failed');
    expect(run.failureClass).toBe('tool_failed');
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, run.runId);
    expect(runtimeEvents.some((event) => event.content?.kind === 'error' && !isTerminalRuntimeEvent(event))).toBe(false);
    const terminalEvents = runtimeEvents.filter(isTerminalRuntimeEvent);
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.status).toBe('failed');
    expect(terminalEvents[0]?.actions?.stateDelta?.failureClass).toBe('tool_failed');

    const messages = await manager.getMessages(session.id);
    const turnState = messages.find((message) =>
      message.type === 'turn_state' && message.turnId === 'turn-1'
    );
    if (turnState?.type !== 'turn_state') throw new Error('failed turn_state was not projected');
    expect(turnState.status).toBe('failed');
    expect(turnState.errorClass).toBe('tool_failed');
  });

  test('stopSession keeps renderer abortSource on terminal facts and run headers', async () => {
    const store = new TinySessionStore();
    const runStore = new TinyAgentRunStore();
    const backends = new BackendRegistry();
    let backend: StopDuringSendBackend | undefined;
    backends.register('fake', (ctx) => {
      backend = new StopDuringSendBackend(ctx);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(20_000),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());

    const iterator = manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' })[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.type).toBe('text_delta');
    const pendingAbort = iterator.next();
    const stopPromise = manager.stopSession(session.id, { source: 'stop_button' });
    const abort = await pendingAbort;
    expect(abort.value?.type).toBe('abort');
    backend?.allowStopReturn();
    await stopPromise;
    while (!(await iterator.next()).done) {}

    const [run] = await runStore.listSessionRuns(session.id);
    if (!run) throw new Error('run was not recorded');
    expect(run.status).toBe('cancelled');
    expect(run.abortSource).toBe('renderer.stop_button');
    const terminalEvents = (await runStore.readRuntimeEvents(session.id, run.runId)).filter(isTerminalRuntimeEvent);
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.status).toBe('aborted');
    expect(terminalEvents[0]?.actions?.stateDelta?.abortSource).toBe('renderer.stop_button');
  });

  test('terminal run commits reject mismatched terminal RuntimeEvent statuses', async () => {
    const runStore = new TinyAgentRunStore();
    const run = makeRunHeader({ status: 'running' });
    const completedTerminal = runtimeEvent({
      id: 'rt-completed',
      status: 'completed',
      actions: { endInvocation: true },
    });
    await runStore.createRun(run);
    await runStore.appendRuntimeEvent(run.sessionId, run.runId, completedTerminal);

    await assert.rejects(
      commitTerminalRunWithRuntimeFact({
        runStore,
        runtimeEventStore: runStore,
        newId: nextId(),
        sessionId: run.sessionId,
        runId: run.runId,
        turnId: run.turnId,
        status: 'failed',
        ts: 3,
        terminalEvent: completedTerminal,
        terminalEventAlreadyPersisted: true,
        failureClass: 'tool_failed',
      }),
      /terminal RuntimeEvent status completed cannot commit failed run header/,
    );
    expect((await runStore.readRun(run.sessionId, run.runId)).status).toBe('running');
  });
});

type ScriptEvent =
  | Omit<Extract<SessionEvent, { type: 'text_delta' }>, 'id' | 'turnId' | 'ts'>
  | Omit<Extract<SessionEvent, { type: 'error' }>, 'id' | 'turnId' | 'ts'>
  | Omit<Extract<SessionEvent, { type: 'abort' }>, 'id' | 'turnId' | 'ts'>
  | Omit<Extract<SessionEvent, { type: 'complete' }>, 'id' | 'turnId' | 'ts'>;

async function makeHarness(events: readonly ScriptEvent[]): Promise<{
  manager: SessionManager;
  runStore: TinyAgentRunStore;
  session: SessionSummary;
}> {
  const store = new TinySessionStore();
  const runStore = new TinyAgentRunStore();
  const backends = new BackendRegistry();
  backends.register('fake', (ctx) => new ScriptBackend(ctx, events));
  const manager = new SessionManager({
    store,
    runStore,
    runtimeEventStore: runStore,
    backends,
    newId: nextId(),
    now: nextNow(10_000),
    runtimeSource: 'test',
  });
  const session = await manager.createSession(makeInput());
  return { manager, runStore, session };
}

class ScriptBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly sessionId: string;

  constructor(ctx: BackendFactoryContext, private readonly events: readonly ScriptEvent[]) {
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

class StopDuringSendBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly sessionId: string;
  private readonly stopStarted = deferred<void>();
  private readonly stopReturned = deferred<void>();

  constructor(ctx: BackendFactoryContext) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    yield {
      type: 'text_delta',
      id: `${input.turnId}-text`,
      turnId: input.turnId,
      ts: 1,
      messageId: 'message-1',
      text: 'before stop',
    };
    await this.stopStarted.promise;
    yield {
      type: 'abort',
      id: `${input.turnId}-abort`,
      turnId: input.turnId,
      ts: 2,
      reason: 'user_stop',
    };
  }

  async stop(_reason: 'user_stop' | 'redirect'): Promise<void> {
    this.stopStarted.resolve();
    await this.stopReturned.promise;
  }

  allowStopReturn(): void {
    this.stopReturned.resolve();
  }

  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

class TinySessionStore implements SessionStore {
  private headers = new Map<string, SessionHeader>();
  private messages = new Map<string, StoredMessage[]>();

  async create(input: CreateSessionInput): Promise<SessionHeader> {
    const header: SessionHeader = {
      id: `session-${this.headers.size + 1}`,
      workspaceRoot: '/tmp/workspace',
      cwd: input.cwd,
      createdAt: 1,
      lastUsedAt: 1,
      name: input.name ?? 'Session',
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
    return clone(header);
  }

  async list(_filter?: SessionListFilter): Promise<SessionSummary[]> {
    return Array.from(this.headers.values()).map((header) => ({
      id: header.id,
      name: header.name,
      isFlagged: header.isFlagged,
      isArchived: header.isArchived,
      labels: header.labels,
      hasUnread: header.hasUnread,
      ...(header.lastMessageAt !== undefined ? { lastMessageAt: header.lastMessageAt } : {}),
      status: header.status,
      ...(header.blockedReason ? { blockedReason: header.blockedReason } : {}),
      ...(header.statusUpdatedAt !== undefined ? { statusUpdatedAt: header.statusUpdatedAt } : {}),
      ...(header.parentSessionId ? { parentSessionId: header.parentSessionId } : {}),
      ...(header.branchOfTurnId ? { branchOfTurnId: header.branchOfTurnId } : {}),
      backend: header.backend,
      llmConnectionSlug: header.llmConnectionSlug,
      model: header.model,
      permissionMode: header.permissionMode,
    }));
  }

  async readHeader(sessionId: string): Promise<SessionHeader> {
    const header = this.headers.get(sessionId);
    if (!header) throw new Error(`Unknown session ${sessionId}`);
    return clone(header);
  }

  async readMessages(sessionId: string): Promise<StoredMessage[]> {
    return clone(this.messages.get(sessionId) ?? []);
  }

  async listTurns(sessionId: string): Promise<TurnRecord[]> {
    return deriveTurnRecords(await this.readMessages(sessionId));
  }

  async appendMessage(sessionId: string, message: StoredMessage): Promise<void> {
    await this.appendMessages(sessionId, [message]);
  }

  async appendMessages(sessionId: string, messages: StoredMessage[]): Promise<void> {
    this.messages.set(sessionId, [...(this.messages.get(sessionId) ?? []), ...clone(messages)]);
  }

  async updateHeader(sessionId: string, patch: Partial<SessionHeader>): Promise<SessionHeader> {
    const current = await this.readHeader(sessionId);
    const next = { ...current, ...patch };
    this.headers.set(sessionId, next);
    return clone(next);
  }

  async markSessionReadThrough(sessionId: string, _readThroughTs: number): Promise<SessionHeader> {
    return this.readHeader(sessionId);
  }

  async archive(sessionId: string): Promise<void> {
    await this.updateHeader(sessionId, { isArchived: true, status: 'archived' });
  }

  async unarchive(sessionId: string): Promise<void> {
    await this.updateHeader(sessionId, { isArchived: false, status: 'active' });
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

class TinyAgentRunStore implements AgentRunStore, RuntimeEventStore {
  private headers = new Map<string, AgentRunHeader>();
  private events = new Map<string, AgentRunEvent[]>();
  private runtimeEvents = new Map<string, RuntimeEvent[]>();

  async createRun(header: AgentRunHeader): Promise<AgentRunHeader> {
    this.headers.set(key(header.sessionId, header.runId), clone(header));
    return clone(header);
  }

  async updateRun(sessionId: string, runId: string, patch: Partial<AgentRunHeader>): Promise<AgentRunHeader> {
    const current = await this.readRun(sessionId, runId);
    const next = { ...current, ...patch, sessionId, runId };
    this.headers.set(key(sessionId, runId), clone(next));
    return clone(next);
  }

  async readRun(sessionId: string, runId: string): Promise<AgentRunHeader> {
    const header = this.headers.get(key(sessionId, runId));
    if (!header) throw new Error(`Unknown run ${runId}`);
    return clone(header);
  }

  async listSessionRuns(sessionId: string): Promise<AgentRunHeader[]> {
    return Array.from(this.headers.values())
      .filter((header) => header.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId))
      .map(clone);
  }

  async appendEvent(sessionId: string, runId: string, event: AgentRunEvent): Promise<void> {
    const eventKey = key(sessionId, runId);
    this.events.set(eventKey, [...(this.events.get(eventKey) ?? []), clone(event)]);
  }

  async readEvents(sessionId: string, runId: string): Promise<AgentRunEvent[]> {
    return clone(this.events.get(key(sessionId, runId)) ?? []);
  }

  async appendRuntimeEvent(sessionId: string, runId: string, event: RuntimeEvent): Promise<void> {
    const eventKey = key(sessionId, runId);
    this.runtimeEvents.set(eventKey, [...(this.runtimeEvents.get(eventKey) ?? []), clone(event)]);
  }

  async readRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]> {
    return clone(this.runtimeEvents.get(key(sessionId, runId)) ?? []);
  }

  async readSessionRuntimeEvents(sessionId: string): Promise<RuntimeEvent[]> {
    const ordered: Array<{ event: RuntimeEvent; runId: string; eventIndex: number }> = [];
    for (const [eventKey, events] of this.runtimeEvents.entries()) {
      const [eventSessionId, runId] = eventKey.split(':');
      if (eventSessionId !== sessionId || !runId) continue;
      events.forEach((event, eventIndex) => ordered.push({ event: clone(event), runId, eventIndex }));
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
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function runtimeEvent(overrides: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    id: 'rt-event',
    invocationId: 'inv-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 2,
    partial: false,
    role: 'system',
    author: 'system',
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

function deferred<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void } {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function key(sessionId: string, runId: string): string {
  return `${sessionId}:${runId}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
