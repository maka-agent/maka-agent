import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRunStore, createRuntimeEventStore } from '../agent-run-store.js';
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

  it('rejects malformed run headers instead of returning partial records', async () => {
    await withStore(async (store, root) => {
      await store.createRun(makeHeader());
      const runPath = join(root, 'sessions', 'session-1', 'runs', 'run-1', 'run.json');
      await writeFile(runPath, JSON.stringify({ runId: 'run-1', sessionId: 'session-1' }) + '\n', 'utf8');

      await assert.rejects(
        () => store.readRun('session-1', 'run-1'),
        /Invalid AgentRun header for run run-1: malformed fields/,
      );
      assert.deepEqual(await store.listSessionRuns('session-1'), []);
    });
  });

  it('rejects malformed run headers on update without overwriting bytes', async () => {
    await withStore(async (store, root) => {
      await store.createRun(makeHeader());
      const runPath = join(root, 'sessions', 'session-1', 'runs', 'run-1', 'run.json');
      const invalid = JSON.stringify({
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
        updatedAt: 'soon',
      }, null, 2) + '\n';
      await writeFile(runPath, invalid, 'utf8');

      await assert.rejects(
        () => store.updateRun('session-1', 'run-1', {
          status: 'completed',
          completedAt: 10,
          updatedAt: 10,
        }),
        /Invalid AgentRun header for run run-1: malformed fields/,
      );
      assert.equal(await readFile(runPath, 'utf8'), invalid);
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

  it('writes a bounded projection for accepted history compact checkpoints', async () => {
    await withStore(async (store) => {
      const projectionStore = store as typeof store & {
        readEventProjection(
          sessionId: string,
          type: AgentRunEvent['type'],
        ): Promise<AgentRunEvent | null | undefined>;
      };
      await store.createRun(makeHeader({ runId: 'run-accepted' }));
      const checkpointEvent = (runId: string, eventCount: number): AgentRunEvent => makeEvent({
        type: 'history_compact_checkpoint_recorded',
        id: `checkpoint-${runId}`,
        runId,
        turnId: `turn-${runId}`,
        data: {
          checkpoint: {
            kind: 'maka.history_compact_checkpoint',
            version: 2,
            checkpointId: `hcheckpoint-${runId}`,
            sessionId: 'session-1',
            coverage: { eventCount },
          },
        },
      });

      await store.appendEvent('session-1', 'run-accepted', checkpointEvent('run-accepted', 3));

      const projected = await projectionStore.readEventProjection(
        'session-1',
        'history_compact_checkpoint_recorded',
      );
      assert.equal(
        projected?.data?.checkpoint
          && (projected.data.checkpoint as { checkpointId?: string }).checkpointId,
        'hcheckpoint-run-accepted',
      );
    });
  });

  it('initializes an empty checkpoint projection for a new session', async () => {
    await withStore(async (store) => {
      const projectionStore = store as typeof store & {
        readEventProjection(
          sessionId: string,
          type: AgentRunEvent['type'],
        ): Promise<AgentRunEvent | null | undefined>;
      };

      await store.createRun(makeHeader());

      assert.equal(
        await projectionStore.readEventProjection('session-1', 'history_compact_checkpoint_recorded'),
        null,
      );
    });
  });

  it('preserves a missing checkpoint projection when prior runs require recovery', async () => {
    await withStore(async (store, root) => {
      const projectionStore = store as typeof store & {
        readEventProjection(
          sessionId: string,
          type: AgentRunEvent['type'],
        ): Promise<AgentRunEvent | null | undefined>;
      };
      await store.createRun(makeHeader({ runId: 'run-before-crash' }));
      await rm(join(
        root,
        'sessions',
        'session-1',
        'projections',
        'history_compact_checkpoint_recorded.json',
      ));

      await store.createRun(makeHeader({ runId: 'run-after-restart' }));

      assert.equal(
        await projectionStore.readEventProjection('session-1', 'history_compact_checkpoint_recorded'),
        undefined,
      );
    });
  });

  it('does not let a stale repair overwrite a further checkpoint projection', async () => {
    await withStore(async (store, root) => {
      const projectionStore = store as typeof store & {
        readEventProjection(
          sessionId: string,
          type: AgentRunEvent['type'],
        ): Promise<AgentRunEvent | null | undefined>;
        repairEventProjection(
          sessionId: string,
          type: AgentRunEvent['type'],
          event: AgentRunEvent | null,
        ): Promise<void>;
      };
      const checkpointEvent = (runId: string, eventCount: number): AgentRunEvent => makeEvent({
        type: 'history_compact_checkpoint_recorded',
        id: `checkpoint-${runId}`,
        runId,
        turnId: `turn-${runId}`,
        data: {
          checkpoint: {
            kind: 'maka.history_compact_checkpoint',
            version: 2,
            checkpointId: `hcheckpoint-${runId}`,
            sessionId: 'session-1',
            coverage: { eventCount },
          },
        },
      });
      const stale = checkpointEvent('run-stale-repair', 1);
      const further = checkpointEvent('run-further-write', 2);
      await store.createRun(makeHeader({ runId: stale.runId }));
      await store.createRun(makeHeader({ runId: further.runId }));
      await store.appendEvent('session-1', stale.runId, stale);
      await rm(join(
        root,
        'sessions',
        'session-1',
        'projections',
        'history_compact_checkpoint_recorded.json',
      ));

      await store.appendEvent('session-1', further.runId, further);
      await projectionStore.repairEventProjection(
        'session-1',
        'history_compact_checkpoint_recorded',
        stale,
      );

      const projected = await projectionStore.readEventProjection(
        'session-1',
        'history_compact_checkpoint_recorded',
      );
      assert.equal(projected?.id, further.id);
    });
  });

  it('replaces the same parseable but semantically invalid projection during repair', async () => {
    await withStore(async (store, root) => {
      const projectionStore = store as typeof store & {
        readEventProjection(
          sessionId: string,
          type: AgentRunEvent['type'],
        ): Promise<AgentRunEvent | null | undefined>;
        repairEventProjection(
          sessionId: string,
          type: AgentRunEvent['type'],
          event: AgentRunEvent | null,
          options?: { replaceEventId?: string },
        ): Promise<void>;
      };
      await store.createRun(makeHeader());
      const invalidProjection = makeEvent({
        type: 'history_compact_checkpoint_recorded',
        id: 'invalid-projection-event',
        data: { checkpoint: { coverage: { eventCount: 999 } } },
      });
      const canonicalEvent = makeEvent({
        type: 'history_compact_checkpoint_recorded',
        id: 'canonical-projection-event',
        data: {
          checkpoint: {
            kind: 'maka.history_compact_checkpoint',
            version: 2,
            checkpointId: 'hcheckpoint-canonical',
            sessionId: 'session-1',
            coverage: { eventCount: 1 },
          },
        },
      });
      await writeFile(
        join(
          root,
          'sessions',
          'session-1',
          'projections',
          'history_compact_checkpoint_recorded.json',
        ),
        JSON.stringify({ version: 1, event: invalidProjection }) + '\n',
      );

      await projectionStore.repairEventProjection(
        'session-1',
        'history_compact_checkpoint_recorded',
        canonicalEvent,
        { replaceEventId: invalidProjection.id },
      );

      const projected = await projectionStore.readEventProjection(
        'session-1',
        'history_compact_checkpoint_recorded',
      );
      assert.equal(projected?.id, canonicalEvent.id);
    });
  });

  it('does not retain a checkpoint projection when the canonical ledger append fails', async () => {
    await withStore(async (store, root) => {
      const projectionStore = store as typeof store & {
        readEventProjection(
          sessionId: string,
          type: AgentRunEvent['type'],
        ): Promise<AgentRunEvent | null | undefined>;
      };
      await store.createRun(makeHeader());
      const checkpointEvent = (checkpointId: string, eventCount: number): AgentRunEvent => makeEvent({
        type: 'history_compact_checkpoint_recorded',
        data: {
          checkpoint: {
            kind: 'maka.history_compact_checkpoint',
            version: 2,
            checkpointId,
            sessionId: 'session-1',
            coverage: { eventCount },
          },
        },
      });
      await store.appendEvent('session-1', 'run-1', checkpointEvent('hcheckpoint-previous', 1));
      const eventsPath = join(root, 'sessions', 'session-1', 'runs', 'run-1', 'events.jsonl');
      await rm(eventsPath);
      await mkdir(eventsPath);

      await assert.rejects(() => store.appendEvent(
        'session-1',
        'run-1',
        checkpointEvent('hcheckpoint-orphan', 2),
      ));

      assert.equal(
        await projectionStore.readEventProjection('session-1', 'history_compact_checkpoint_recorded'),
        undefined,
      );
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
    await withStores(async (runStore, runtimeEventStore, root) => {
      await runStore.createRun(makeHeader());
      await runStore.appendEvent('session-1', 'run-1', makeEvent({ id: 'operational-event' }));
      await runtimeEventStore.appendRuntimeEvent('session-1', 'run-1', makeRuntimeEvent({ id: 'runtime-1', role: 'user' }));
      await runtimeEventStore.appendRuntimeEvent('session-1', 'run-1', makeRuntimeEvent({ id: 'runtime-2', role: 'model' }));

      const runtimeEvents = await runtimeEventStore.readRuntimeEvents('session-1', 'run-1');
      assert.deepEqual(runtimeEvents.map((event) => event.id), ['runtime-1', 'runtime-2']);
      assert.deepEqual(runtimeEvents.map((event) => event.role), ['user', 'model']);
      assert.deepEqual((await runStore.readEvents('session-1', 'run-1')).map((event) => event.id), ['operational-event']);

      const runtimeEventsPath = join(root, 'sessions', 'session-1', 'runs', 'run-1', 'runtime-events.jsonl');
      const operationalEventsPath = join(root, 'sessions', 'session-1', 'runs', 'run-1', 'events.jsonl');
      assert.match(await readFile(runtimeEventsPath, 'utf8'), /"id":"runtime-1"/);
      assert.match(await readFile(operationalEventsPath, 'utf8'), /"id":"operational-event"/);
    });
  });

  it('returns an empty runtime event list when the runtime ledger is missing', async () => {
    await withStores(async (runStore, runtimeEventStore) => {
      await runStore.createRun(makeHeader());

      assert.deepEqual(await runtimeEventStore.readRuntimeEvents('session-1', 'run-1'), []);
    });
  });

  it('rejects durable corrupt runtime event lines instead of shortening the canonical ledger', async () => {
    await withStores(async (runStore, runtimeEventStore, root) => {
      await runStore.createRun(makeHeader());
      const runtimeEventsPath = join(root, 'sessions', 'session-1', 'runs', 'run-1', 'runtime-events.jsonl');
      await writeFile(
        runtimeEventsPath,
        JSON.stringify(makeRuntimeEvent({ id: 'runtime-1' })) +
          '\n{"id":"corrupt"\n' +
          JSON.stringify(makeRuntimeEvent({ id: 'runtime-2' })) +
          '\n',
      );

      await assert.rejects(
        () => runtimeEventStore.readRuntimeEvents('session-1', 'run-1'),
        /Invalid RuntimeEvent JSONL line 2 for run run-1/,
      );
    });
  });

  it('ignores an unterminated partial runtime event tail', async () => {
    await withStores(async (runStore, runtimeEventStore, root) => {
      await runStore.createRun(makeHeader());
      const runtimeEventsPath = join(root, 'sessions', 'session-1', 'runs', 'run-1', 'runtime-events.jsonl');
      await writeFile(
        runtimeEventsPath,
        JSON.stringify(makeRuntimeEvent({ id: 'runtime-1' })) +
          '\n{"id":"partial"',
      );

      const events = await runtimeEventStore.readRuntimeEvents('session-1', 'run-1');
      assert.deepEqual(events.map((event) => event.id), ['runtime-1']);
    });
  });

  it('reads session runtime events through RuntimeEventStore in stable chronology', async () => {
    await withStores(async (runStore, runtimeEventStore) => {
      await runStore.createRun(makeHeader({ runId: 'run-2', turnId: 'turn-2' }));
      await runStore.createRun(makeHeader({ runId: 'run-1', turnId: 'turn-1' }));
      await runtimeEventStore.appendRuntimeEvent('session-1', 'run-2', makeRuntimeEvent({ id: 'runtime-2', runId: 'run-2', turnId: 'turn-2', ts: 20 }));
      await runtimeEventStore.appendRuntimeEvent('session-1', 'run-1', makeRuntimeEvent({ id: 'runtime-1', runId: 'run-1', turnId: 'turn-1', ts: 10 }));

      const events = await runtimeEventStore.readSessionRuntimeEvents('session-1');

      assert.deepEqual(events.map((event) => event.id), ['runtime-1', 'runtime-2']);
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

async function withStores(
  fn: (
    runStore: ReturnType<typeof createAgentRunStore>,
    runtimeEventStore: ReturnType<typeof createRuntimeEventStore>,
    root: string,
  ) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-agent-run-store-'));
  try {
    await fn(createAgentRunStore(root), createRuntimeEventStore(root), root);
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
