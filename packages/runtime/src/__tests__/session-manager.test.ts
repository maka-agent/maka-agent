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
    await this.updateHeader(sessionId, { isArchived: true });
  }

  async unarchive(sessionId: string): Promise<void> {
    await this.updateHeader(sessionId, { isArchived: false });
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
