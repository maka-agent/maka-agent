import { describe, test } from 'node:test';
import type { AgentRunEvent, AgentRunHeader, AgentRunStore } from '@maka/core';

import { expect } from '../test-helpers.js';
import { AgentRun, type AgentRunHooks } from '../agent-run.js';
import type { SessionStore } from '../session-manager.js';

describe('AgentRun', () => {
  test('finalize fails a run that never observed a terminal session event', async () => {
    const runStore = new MemoryAgentRunStore();
    const header = makeHeader();
    const run = new AgentRun({
      sessionId: header.id,
      header,
      userInput: { turnId: 'turn-1', text: 'hello' },
      store: {} as SessionStore,
      runStore,
      newId: nextId(),
      now: nextNow(100),
      recordSessionMessages: false,
      hooks: makeHooks(header),
    });
    await runStore.createRun(makeRunHeader({
      sessionId: run.sessionId,
      runId: run.runId,
      turnId: run.turnId,
      status: 'running',
    }));

    await run.finalize();

    const repaired = await runStore.readRun(run.sessionId, run.runId);
    expect(repaired.status).toBe('failed');
    expect(repaired.failureClass).toBe('missing_terminal_event');
  });
});

class MemoryAgentRunStore implements AgentRunStore {
  private headers = new Map<string, AgentRunHeader>();
  private events = new Map<string, AgentRunEvent[]>();

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
      .map((header) => ({ ...header }));
  }

  async appendEvent(sessionId: string, runId: string, event: AgentRunEvent): Promise<void> {
    const eventKey = key(sessionId, runId);
    this.events.set(eventKey, [...(this.events.get(eventKey) ?? []), { ...event }]);
  }

  async readEvents(sessionId: string, runId: string): Promise<AgentRunEvent[]> {
    return [...(this.events.get(key(sessionId, runId)) ?? [])];
  }
}

function makeHooks(header: ReturnType<typeof makeHeader>): AgentRunHooks {
  return {
    ensureActive: async () => {
      throw new Error('not used');
    },
    registerRun: () => {},
    unregisterRun: () => {},
    updateHeader: async () => header,
    updateStatus: async () => {},
    appendTurnState: async () => {},
  };
}

function makeHeader() {
  return {
    id: 'session-1',
    name: 'Session',
    workspaceRoot: '/tmp/cwd',
    cwd: '/tmp/cwd',
    backend: 'fake' as const,
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask' as const,
    status: 'active' as const,
    createdAt: 1,
    lastUsedAt: 1,
    updatedAt: 1,
    labels: [],
    isFlagged: false,
    isArchived: false,
    hasUnread: false,
    connectionLocked: false,
    schemaVersion: 1 as const,
  };
}

function makeRunHeader(overrides: Partial<AgentRunHeader>): AgentRunHeader {
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

function nextId(): () => string {
  let seq = 0;
  return () => `id-${(seq += 1)}`;
}

function nextNow(start: number): () => number {
  let value = start;
  return () => value++;
}

function key(sessionId: string, runId: string): string {
  return `${sessionId}:${runId}`;
}
