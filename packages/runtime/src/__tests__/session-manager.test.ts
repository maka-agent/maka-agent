import { describe, test } from 'node:test';
import type {
  CreateSessionInput,
  PermissionMode,
  SessionEvent,
  SessionHeader,
  SessionListFilter,
  SessionSummary,
  StoredMessage,
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
      /Cannot change permission mode while a turn is running/,
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
      /Cannot change permission mode while a turn is running/,
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

class MemorySessionStore implements SessionStore {
  private headers = new Map<string, SessionHeader>();
  private messages = new Map<string, StoredMessage[]>();
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
    return [...(this.messages.get(sessionId) ?? [])];
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
