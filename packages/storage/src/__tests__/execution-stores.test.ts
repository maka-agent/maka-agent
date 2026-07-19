import assert from 'node:assert/strict';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { AgentRunEvent, AgentRunHeader, RuntimeEvent } from '@maka/core';
import { createAgentRunStore } from '../agent-run-store.js';
import {
  openInteractiveExecutionStoresForRead,
  openInteractiveExecutionStoresForWrite,
} from '../execution-stores.js';
import {
  resolveStorageRoot,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
  tryAcquireInteractiveRootReader,
} from '../root-authority.js';
import { createSessionStore } from '../session-store.js';

describe('interactive execution stores', () => {
  test('commits root-turn admission before Run creation and retains its original identity', async () => {
    await withRoot(async ({ root }) => {
      const capability = await resolveStorageRoot({
        path: root,
        kind: 'interactive',
      });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
        const session = await stores.sessionStore.create(sessionInput(root));
        const first = await stores.agentRunStore.admitRootTurn({
          sessionId: session.id,
          turnId: 'turn-1',
          proposedRunId: 'run-1',
          proposedUserMessageId: 'message-1',
          normalizedInput: { text: 'hello' },
          admittedAt: 10,
        });
        assert.equal(first.kind, 'admitted');
        assert.deepEqual(await stores.agentRunStore.listSessionRuns(session.id), []);

        const retry = await stores.agentRunStore.admitRootTurn({
          sessionId: session.id,
          turnId: 'turn-1',
          proposedRunId: 'run-never-used',
          proposedUserMessageId: 'message-never-used',
          normalizedInput: { text: 'hello' },
          admittedAt: 20,
        });
        assert.equal(retry.kind, 'existing');
        assert.equal(retry.admission.runId, 'run-1');
        assert.equal(retry.admission.userMessageId, 'message-1');
        assert.equal(retry.admission.admittedAt, 10);
        assert.deepEqual(retry.admission.normalizedInput, { text: 'hello' });

        const conflict = await stores.agentRunStore.admitRootTurn({
          sessionId: session.id,
          turnId: 'turn-1',
          proposedRunId: 'run-never-used',
          proposedUserMessageId: 'message-never-used',
          normalizedInput: { text: 'changed' },
          admittedAt: 30,
        });
        assert.equal(conflict.kind, 'conflict');
        assert.equal(conflict.admission.runId, 'run-1');

        const header = runHeader(session.id, first.admission.runId);
        await stores.agentRunStore.createRun(header);
        const bytes = await readFile(
          join(root, 'sessions', session.id, 'runs', first.admission.runId, 'run.json'),
          'utf8',
        );
        await assert.rejects(
          () => stores.agentRunStore.createRun({ ...header, updatedAt: 99 }),
          /Agent run already exists/,
        );
        assert.equal(
          await readFile(
            join(root, 'sessions', session.id, 'runs', first.admission.runId, 'run.json'),
            'utf8',
          ),
          bytes,
        );
      } finally {
        await owner.close();
      }
    });
  });

  test('keeps shared execution reads observational', async () => {
    await withRoot(async ({ root }) => {
      const capability = await resolveStorageRoot({
        path: root,
        kind: 'interactive',
      });
      const rawSessionStore = createSessionStore(root);
      const session = await rawSessionStore.create(sessionInput(root));
      await rawSessionStore.appendMessage(session.id, {
        type: 'user',
        id: 'message-1',
        turnId: 'turn-1',
        ts: 10,
        text: 'hello',
      });
      const rawAgentRunStore = createAgentRunStore(root);
      await rawAgentRunStore.admitRootTurn({
        sessionId: session.id,
        turnId: 'turn-1',
        proposedRunId: 'run-1',
        proposedUserMessageId: 'message-1',
        normalizedInput: { text: 'hello' },
        admittedAt: 9,
      });
      await rawAgentRunStore.createRun(runHeader(session.id, 'run-1'));
      const sessionPath = join(root, 'sessions', session.id, 'session.jsonl');
      const before = await readFile(sessionPath, 'utf8');

      const reader = await tryAcquireInteractiveRootReader(capability);
      assert.ok(reader);
      if (!reader) return;
      try {
        const stores = await openInteractiveExecutionStoresForRead(reader.lease);
        assert.equal((await stores.sessionStore.list()).length, 1);
        assert.equal((await stores.sessionStore.readHeader(session.id)).connectionLocked, false);
        assert.equal((await stores.sessionStore.readMessages(session.id)).length, 1);
        assert.equal((await stores.sessionStore.listTurns(session.id)).length, 1);
        assert.equal((await stores.agentRunStore.listSessionRuns(session.id)).length, 1);
        assert.equal((await stores.agentRunStore.readRun(session.id, 'run-1')).turnId, 'turn-1');
        assert.equal((await stores.agentRunStore.readEvents(session.id, 'run-1')).length, 0);
        assert.equal(
          (await stores.agentRunStore.readRootTurnAdmission(session.id, 'turn-1'))?.runId,
          'run-1',
        );
        assert.equal(
          (await stores.runtimeEventStore.readRuntimeEvents(session.id, 'run-1')).length,
          0,
        );
        assert.equal(
          (await stores.runtimeEventStore.readImmutableRuntimeEvents(session.id, 'run-1')).length,
          0,
        );
        assert.equal(
          (await stores.runtimeEventStore.readSessionRuntimeEvents(session.id)).length,
          0,
        );
      } finally {
        await reader.close();
      }

      assert.equal(await readFile(sessionPath, 'utf8'), before);
      assert.equal((await rawSessionStore.readHeaderSnapshot(session.id)).connectionLocked, false);
    });
  });

  test('repairs only an unterminated JSONL tail before the next durable append', async () => {
    await withRoot(async ({ root }) => {
      const capability = await resolveStorageRoot({
        path: root,
        kind: 'interactive',
      });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
        const session = await stores.sessionStore.create(sessionInput(root));
        const header = runHeader(session.id, 'run-1');
        await stores.agentRunStore.createRun(header);

        const sessionPath = join(root, 'sessions', session.id, 'session.jsonl');
        await appendFile(sessionPath, '{"type":"user"', 'utf8');
        await stores.sessionStore.appendMessage(session.id, {
          type: 'user',
          id: 'message-1',
          turnId: 'turn-1',
          ts: 11,
          text: 'hello',
        });
        assert.deepEqual(
          (await stores.sessionStore.readMessages(session.id)).map((message) => message.id),
          ['message-1'],
        );

        const eventsPath = join(root, 'sessions', session.id, 'runs', header.runId, 'events.jsonl');
        await writeFile(
          eventsPath,
          JSON.stringify(runEvent(session.id, header.runId, 'event-1', 12)),
          'utf8',
        );
        await stores.agentRunStore.appendEvent(
          session.id,
          header.runId,
          runEvent(session.id, header.runId, 'event-2', 13),
        );
        await appendFile(eventsPath, '{"type":"run_started"', 'utf8');
        await stores.agentRunStore.appendEvent(
          session.id,
          header.runId,
          runEvent(session.id, header.runId, 'event-3', 14),
        );
        assert.deepEqual(
          (await stores.agentRunStore.readEvents(session.id, header.runId)).map(
            (event) => event.id,
          ),
          ['event-1', 'event-2', 'event-3'],
        );

        const runtimeEventsPath = join(
          root,
          'sessions',
          session.id,
          'runs',
          header.runId,
          'runtime-events.jsonl',
        );
        await writeFile(runtimeEventsPath, '{"id":"truncated"', 'utf8');
        await stores.runtimeEventStore.appendRuntimeEvent(
          session.id,
          header.runId,
          runtimeEvent(session.id, header.runId, 'runtime-1', 15),
        );
        assert.deepEqual(
          (await stores.runtimeEventStore.readImmutableRuntimeEvents(session.id, header.runId)).map(
            (event) => event.id,
          ),
          ['runtime-1'],
        );

        for (const path of [sessionPath, eventsPath, runtimeEventsPath]) {
          const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
          for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
        }
      } finally {
        await owner.close();
      }
    });
  });

  test('refuses to truncate a syntactically invalid JSONL tail', async () => {
    await withRoot(async ({ root }) => {
      const capability = await resolveStorageRoot({
        path: root,
        kind: 'interactive',
      });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
        const session = await stores.sessionStore.create(sessionInput(root));
        const sessionPath = join(root, 'sessions', session.id, 'session.jsonl');
        await appendFile(sessionPath, '{"type":]', 'utf8');
        const before = await readFile(sessionPath, 'utf8');

        await assert.rejects(
          () =>
            stores.sessionStore.appendMessage(session.id, {
              type: 'user',
              id: 'message-1',
              turnId: 'turn-1',
              ts: 1,
              text: 'must not overwrite corruption',
            }),
          /Cannot append after an invalid JSONL tail record/,
        );
        assert.equal(await readFile(sessionPath, 'utf8'), before);
      } finally {
        await owner.close();
      }
    });
  });

  test('rejects stale writers before a replacement root is mutated', async () => {
    await withRoot(async ({ base, root }) => {
      const capability = await resolveStorageRoot({
        path: root,
        kind: 'interactive',
      });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const moved = join(base, 'moved-root');
      await rename(root, moved);
      await mkdir(root);
      try {
        await assert.rejects(
          () => stores.sessionStore.create(sessionInput(root)),
          (error: unknown) =>
            error instanceof StorageRootAuthorityError && error.code === 'root_identity_changed',
        );
        await assert.rejects(() => stat(join(root, 'sessions')), {
          code: 'ENOENT',
        });
      } finally {
        await owner.close();
      }
    });
  });

  test('strict recovery removes recognizable uncommitted exclusive-create staging', async () => {
    await withRoot(async ({ root }) => {
      const capability = await resolveStorageRoot({
        path: root,
        kind: 'interactive',
      });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
        const session = await stores.sessionStore.create(sessionInput(root));
        await stores.agentRunStore.admitRootTurn({
          sessionId: session.id,
          turnId: 'turn-1',
          proposedRunId: 'run-1',
          proposedUserMessageId: 'message-1',
          normalizedInput: { text: 'hello' },
          admittedAt: 10,
        });

        const suffix = '123.00000000-0000-4000-8000-000000000000.tmp';
        const admissionsRoot = join(root, 'sessions', session.id, 'turn-admissions');
        const admissionTemp = join(admissionsRoot, `turn-1.json.${suffix}`);
        await writeFile(admissionTemp, 'staging', 'utf8');
        const runDirectory = join(root, 'sessions', session.id, 'runs', 'run-staging');
        await mkdir(runDirectory, { recursive: true });
        await writeFile(join(runDirectory, `run.json.${suffix}`), 'staging', 'utf8');

        const admissions = await stores.agentRunStore.listRootTurnAdmissionsForRecovery(session.id);
        assert.deepEqual(
          admissions.map((admission) => admission.turnId),
          ['turn-1'],
        );
        assert.deepEqual(await stores.agentRunStore.listSessionRunsForRecovery(session.id), []);
        await assert.rejects(() => stat(admissionTemp), { code: 'ENOENT' });
        await assert.rejects(() => stat(runDirectory), { code: 'ENOENT' });
      } finally {
        await owner.close();
      }
    });
  });

  test('strict recovery enumeration fails on malformed durable entities', async () => {
    await withRoot(async ({ root }) => {
      const capability = await resolveStorageRoot({
        path: root,
        kind: 'interactive',
      });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
        const session = await stores.sessionStore.create(sessionInput(root));
        await stores.agentRunStore.admitRootTurn({
          sessionId: session.id,
          turnId: 'turn-1',
          proposedRunId: 'run-1',
          proposedUserMessageId: 'message-1',
          normalizedInput: { text: 'hello' },
          admittedAt: 10,
        });
        await writeFile(
          join(root, 'sessions', session.id, 'turn-admissions', 'turn-1.json'),
          '{"turnId":"wrong"}\n',
          'utf8',
        );
        await assert.rejects(() =>
          stores.agentRunStore.listRootTurnAdmissionsForRecovery(session.id),
        );

        await stores.agentRunStore.createRun(runHeader(session.id, 'run-1'));
        await writeFile(
          join(root, 'sessions', session.id, 'runs', 'run-1', 'run.json'),
          '{"runId":"wrong"}\n',
          'utf8',
        );
        await assert.rejects(() => stores.agentRunStore.listSessionRunsForRecovery(session.id));

        await writeFile(
          join(root, 'sessions', session.id, 'session.jsonl'),
          '{"id":"wrong"}\n',
          'utf8',
        );
        await assert.rejects(() => stores.sessionStore.listForRecovery());
      } finally {
        await owner.close();
      }
    });
  });
});

async function withRoot(
  run: (paths: { base: string; root: string }) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-execution-stores-'));
  const root = join(base, 'root');
  try {
    await run({ base, root });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function sessionInput(root: string) {
  return {
    cwd: root,
    backend: 'fake' as const,
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask' as const,
  };
}

function runHeader(sessionId: string, runId: string): AgentRunHeader {
  return {
    runId,
    invocationId: runId,
    sessionId,
    turnId: 'turn-1',
    status: 'created',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/tmp/cwd',
    permissionMode: 'ask',
    createdAt: 10,
    updatedAt: 10,
  };
}

function runEvent(sessionId: string, runId: string, id: string, ts: number): AgentRunEvent {
  return {
    type: 'run_started',
    id,
    runId,
    sessionId,
    turnId: 'turn-1',
    ts,
  };
}

function runtimeEvent(sessionId: string, runId: string, id: string, ts: number): RuntimeEvent {
  return {
    id,
    invocationId: runId,
    runId,
    sessionId,
    turnId: 'turn-1',
    ts,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text: 'hello' },
  };
}
