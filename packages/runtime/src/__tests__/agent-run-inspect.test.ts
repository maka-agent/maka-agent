import { describe, test } from 'node:test';
import type { AgentRunEvent, AgentRunHeader, AgentRunStore, RuntimeEvent } from '@maka/core';
import { expect } from '../test-helpers.js';
import { inspectAgentRunReadModel } from '../agent-run-inspect.js';

const sessionId = 'session-1';
const runId = 'run-1';
const turnId = 'turn-1';
const ts = 1_800_000_000_000;

describe('inspectAgentRunReadModel', () => {
  test('returns consistent diagnostics for a complete run', async () => {
    const runStore = new MemoryAgentRunStore();
    await runStore.createRun(makeHeader({ status: 'completed', completedAt: ts + 10, updatedAt: ts + 10 }));
    await runStore.appendEvent(sessionId, runId, makeRunEvent({ type: 'run_started', ts: ts + 1 }));
    await runStore.appendEvent(sessionId, runId, makeRunEvent({ type: 'run_completed', ts: ts + 10 }));
    await runStore.appendRuntimeEvent(sessionId, runId, makeRuntimeEvent({
      id: 'rt-user',
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'hello' },
      ts: ts + 2,
    }));
    await runStore.appendRuntimeEvent(sessionId, runId, makeRuntimeEvent({
      id: 'rt-assistant',
      role: 'model',
      author: 'agent',
      content: { kind: 'text', text: 'hi' },
      ts: ts + 3,
    }));
    await runStore.appendRuntimeEvent(sessionId, runId, makeRuntimeEvent({
      id: 'rt-complete',
      role: 'system',
      author: 'system',
      status: 'completed',
      actions: { endInvocation: true },
      ts: ts + 10,
    }));

    const inspected = await inspectAgentRunReadModel(runStore, { sessionId, runId });

    expect(inspected.sourceHealth).toEqual({
      runtimeLedger: 'present',
      runtimeTerminalPresent: true,
      operationalTerminalPresent: true,
      statusConsistency: 'consistent',
    });
    expect(inspected.terminalRuntimeFact?.runStatus).toBe('completed');
    expect(inspected.operationalTerminalEvent?.type).toBe('run_completed');
    expect(inspected.runtimeEvents.map((event) => event.id)).toEqual(['rt-user', 'rt-assistant', 'rt-complete']);
    expect(inspected.projection?.messages.map((message) => message.type)).toEqual(['user', 'assistant', 'turn_state']);
    expect(inspected.diagnostics.some((diagnostic) => diagnostic.code === 'status_consistency_mismatch')).toBe(false);
  });

  test('reports missing and corrupt runtime-events without discarding operational facts', async () => {
    const missingRuntimeStore = new MemoryAgentRunStore();
    await missingRuntimeStore.createRun(makeHeader({ status: 'completed' }));
    await missingRuntimeStore.appendEvent(sessionId, runId, makeRunEvent({ type: 'run_completed' }));

    const missing = await inspectAgentRunReadModel(missingRuntimeStore, { sessionId, runId });

    expect(missing.events.map((event) => event.type)).toEqual(['run_completed']);
    expect(missing.sourceHealth.runtimeLedger).toBe('missing');
    expect(missing.sourceHealth.operationalTerminalPresent).toBe(true);
    expect(missing.sourceHealth.runtimeTerminalPresent).toBe(false);
    expect(missing.diagnostics.some((diagnostic) => diagnostic.code === 'missing_runtime_ledger')).toBe(true);

    const corruptRuntimeStore = new MemoryAgentRunStore({ failRuntimeEventReads: true });
    await corruptRuntimeStore.createRun(makeHeader({ status: 'completed' }));
    await corruptRuntimeStore.appendEvent(sessionId, runId, makeRunEvent({ type: 'run_completed' }));

    const corrupt = await inspectAgentRunReadModel(corruptRuntimeStore, { sessionId, runId });

    expect(corrupt.events.map((event) => event.type)).toEqual(['run_completed']);
    expect(corrupt.sourceHealth.runtimeLedger).toBe('read_failed');
    expect(corrupt.sourceHealth.operationalTerminalPresent).toBe(true);
    expect(corrupt.diagnostics.some((diagnostic) => diagnostic.code === 'runtime_ledger_read_failed')).toBe(true);
  });

  test('diagnoses status disagreement between header operational and RuntimeEvent facts', async () => {
    const runStore = new MemoryAgentRunStore();
    await runStore.createRun(makeHeader({ status: 'failed', failureClass: 'tool_failed' }));
    await runStore.appendEvent(sessionId, runId, makeRunEvent({ type: 'run_failed' }));
    await runStore.appendRuntimeEvent(sessionId, runId, makeRuntimeEvent({
      id: 'rt-complete',
      role: 'system',
      author: 'system',
      status: 'completed',
      actions: { endInvocation: true },
    }));

    const inspected = await inspectAgentRunReadModel(runStore, { sessionId, runId });

    expect(inspected.sourceHealth.statusConsistency).toBe('inconsistent');
    expect(inspected.terminalRuntimeFact?.runStatus).toBe('completed');
    expect(inspected.diagnostics.some((diagnostic) => diagnostic.code === 'status_consistency_mismatch')).toBe(true);
  });
});

class MemoryAgentRunStore implements AgentRunStore {
  private headers = new Map<string, AgentRunHeader>();
  private events = new Map<string, AgentRunEvent[]>();
  private runtimeEvents = new Map<string, RuntimeEvent[]>();

  constructor(private readonly options: { failRuntimeEventReads?: boolean } = {}) {}

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
    this.events.set(eventKey, [...(this.events.get(eventKey) ?? []), { ...event }]);
  }

  async readEvents(sessionId: string, runId: string): Promise<AgentRunEvent[]> {
    return (this.events.get(key(sessionId, runId)) ?? []).map((event) => ({ ...event }));
  }

  async appendRuntimeEvent(sessionId: string, runId: string, event: RuntimeEvent): Promise<void> {
    const eventKey = key(sessionId, runId);
    this.runtimeEvents.set(eventKey, [...(this.runtimeEvents.get(eventKey) ?? []), copyRuntimeEvent(event)]);
  }

  async readRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]> {
    if (this.options.failRuntimeEventReads) throw new Error('runtime ledger is corrupt');
    return (this.runtimeEvents.get(key(sessionId, runId)) ?? []).map(copyRuntimeEvent);
  }
}

function makeHeader(overrides: Partial<AgentRunHeader> = {}): AgentRunHeader {
  return {
    runId,
    sessionId,
    turnId,
    status: 'running',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/tmp/cwd',
    permissionMode: 'ask',
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

function makeRunEvent(overrides: Partial<AgentRunEvent> = {}): AgentRunEvent {
  return {
    type: 'run_started',
    id: `op-${overrides.type ?? 'run_started'}`,
    runId,
    sessionId,
    turnId,
    ts,
    ...overrides,
  };
}

function makeRuntimeEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    id: 'rt-1',
    invocationId: 'inv-1',
    runId,
    sessionId,
    turnId,
    ts,
    partial: false,
    role: 'system',
    author: 'system',
    ...overrides,
  };
}

function copyRuntimeEvent(event: RuntimeEvent): RuntimeEvent {
  return JSON.parse(JSON.stringify(event)) as RuntimeEvent;
}

function key(sessionId: string, runId: string): string {
  return `${sessionId}:${runId}`;
}
