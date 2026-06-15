import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRunStore } from '../agent-run-store.js';
import type { AgentRunEvent, AgentRunHeader, RuntimeEvent } from '@maka/core';

describe('AgentRunStore', () => {
  it('creates, reads, updates, and lists runs under a session', async () => {
    await withStore(async (store, root) => {
      const first = makeHeader({ runId: 'run-1', createdAt: 1, updatedAt: 1 });
      const second = makeHeader({ runId: 'run-2', turnId: 'turn-2', createdAt: 2, updatedAt: 2 });

      await store.createRun(second);
      await store.createRun(first);
      await store.updateRun('session-1', 'run-1', {
        status: 'completed',
        completedAt: 10,
        updatedAt: 10,
      });

      const read = await store.readRun('session-1', 'run-1');
      assert.equal(read.status, 'completed');
      assert.equal(read.completedAt, 10);
      assert.deepEqual((await store.listSessionRuns('session-1')).map((run) => run.runId), ['run-1', 'run-2']);
      assert.equal(
        JSON.parse(await readFile(join(root, 'sessions', 'session-1', 'runs', 'run-1', 'run.json'), 'utf8')).runId,
        'run-1',
      );
    });
  });

  it('serializes same-run event appends', async () => {
    await withStore(async (store) => {
      await store.createRun(makeHeader());

      await Promise.all(Array.from({ length: 20 }, (_, index) =>
        store.appendEvent('session-1', 'run-1', makeEvent({ id: `event-${index}`, ts: index })),
      ));

      const events = await store.readEvents('session-1', 'run-1');
      assert.equal(events.length, 20);
      assert.equal(new Set(events.map((event) => event.id)).size, 20);
    });
  });

  it('recovers corrupt event lines without hiding later events', async () => {
    await withStore(async (store, root) => {
      await store.createRun(makeHeader());
      await store.appendEvent('session-1', 'run-1', makeEvent({ id: 'good-1', ts: 1 }));
      const eventsPath = join(root, 'sessions', 'session-1', 'runs', 'run-1', 'events.jsonl');
      await writeFile(eventsPath, '{"type":"run_started"\n' + JSON.stringify(makeEvent({ id: 'good-2', ts: 2 })) + '\n', {
        flag: 'a',
      });

      const events = await store.readEvents('session-1', 'run-1');
      assert.equal(events[0]?.id, 'good-1');
      assert.equal(events[1]?.type, 'event_corrupt');
      assert.equal(events[2]?.id, 'good-2');
    });
  });

  it('drops an unterminated corrupt tail event', async () => {
    await withStore(async (store, root) => {
      await store.createRun(makeHeader());
      const eventsPath = join(root, 'sessions', 'session-1', 'runs', 'run-1', 'events.jsonl');
      await mkdir(join(root, 'sessions', 'session-1', 'runs', 'run-1'), { recursive: true });
      await writeFile(eventsPath, JSON.stringify(makeEvent({ id: 'good-1', ts: 1 })) + '\n{"type":"run_started"');

      const events = await store.readEvents('session-1', 'run-1');
      assert.deepEqual(events.map((event) => event.id), ['good-1']);
    });
  });

  it('keeps newline-terminated corrupt tail events as durable corruption notes', async () => {
    await withStore(async (store, root) => {
      await store.createRun(makeHeader());
      const eventsPath = join(root, 'sessions', 'session-1', 'runs', 'run-1', 'events.jsonl');
      await mkdir(join(root, 'sessions', 'session-1', 'runs', 'run-1'), { recursive: true });
      await writeFile(eventsPath, JSON.stringify(makeEvent({ id: 'good-1', ts: 1 })) + '\n{"type":"run_started"\n');

      const events = await store.readEvents('session-1', 'run-1');
      assert.deepEqual(events.map((event) => event.type), ['run_started', 'event_corrupt']);
      assert.equal(events[1]?.data?.lineNumber, 2);
    });
  });

  it('appends and reads runtime events from a separate per-run ledger', async () => {
    await withStore(async (store, root) => {
      await store.createRun(makeHeader());
      await store.appendEvent('session-1', 'run-1', makeEvent({ id: 'operational-event' }));
      await store.appendRuntimeEvent('session-1', 'run-1', makeRuntimeEvent({ id: 'runtime-1', role: 'user' }));
      await store.appendRuntimeEvent('session-1', 'run-1', makeRuntimeEvent({ id: 'runtime-2', role: 'model' }));

      const runtimeEvents = await store.readRuntimeEvents('session-1', 'run-1');
      assert.deepEqual(runtimeEvents.map((event) => event.id), ['runtime-1', 'runtime-2']);
      assert.deepEqual(runtimeEvents.map((event) => event.role), ['user', 'model']);
      assert.deepEqual((await store.readEvents('session-1', 'run-1')).map((event) => event.id), ['operational-event']);

      const runtimeEventsPath = join(root, 'sessions', 'session-1', 'runs', 'run-1', 'runtime-events.jsonl');
      const operationalEventsPath = join(root, 'sessions', 'session-1', 'runs', 'run-1', 'events.jsonl');
      assert.match(await readFile(runtimeEventsPath, 'utf8'), /"id":"runtime-1"/);
      assert.match(await readFile(operationalEventsPath, 'utf8'), /"id":"operational-event"/);
    });
  });

  it('returns an empty runtime event list when the runtime ledger is missing', async () => {
    await withStore(async (store) => {
      await store.createRun(makeHeader());

      assert.deepEqual(await store.readRuntimeEvents('session-1', 'run-1'), []);
    });
  });

  it('rejects durable corrupt runtime event lines instead of shortening the canonical ledger', async () => {
    await withStore(async (store, root) => {
      await store.createRun(makeHeader());
      const runtimeEventsPath = join(root, 'sessions', 'session-1', 'runs', 'run-1', 'runtime-events.jsonl');
      await writeFile(
        runtimeEventsPath,
        JSON.stringify(makeRuntimeEvent({ id: 'runtime-1' })) +
          '\n{"id":"corrupt"\n' +
          JSON.stringify(makeRuntimeEvent({ id: 'runtime-2' })) +
          '\n',
      );

      await assert.rejects(
        () => store.readRuntimeEvents('session-1', 'run-1'),
        /Invalid RuntimeEvent JSONL line 2 for run run-1/,
      );
    });
  });

  it('ignores an unterminated partial runtime event tail', async () => {
    await withStore(async (store, root) => {
      await store.createRun(makeHeader());
      const runtimeEventsPath = join(root, 'sessions', 'session-1', 'runs', 'run-1', 'runtime-events.jsonl');
      await writeFile(
        runtimeEventsPath,
        JSON.stringify(makeRuntimeEvent({ id: 'runtime-1' })) +
          '\n{"id":"partial"',
      );

      const events = await store.readRuntimeEvents('session-1', 'run-1');
      assert.deepEqual(events.map((event) => event.id), ['runtime-1']);
    });
  });
});

async function withStore(fn: (store: ReturnType<typeof createAgentRunStore>, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-agent-run-store-'));
  try {
    await fn(createAgentRunStore(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function makeHeader(overrides: Partial<AgentRunHeader> = {}): AgentRunHeader {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    status: 'created',
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

function makeEvent(overrides: Partial<AgentRunEvent> = {}): AgentRunEvent {
  return {
    type: 'run_started',
    id: 'event-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    ...overrides,
  };
}

function makeRuntimeEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    id: 'runtime-1',
    invocationId: 'turn-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text: 'hello' },
    ...overrides,
  };
}
