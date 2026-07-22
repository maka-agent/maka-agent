import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Task } from '@maka/core/task-ledger';
import { openInteractiveTaskLedgerStoreForWrite } from '@maka/storage/task-ledger-store';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import type { TaskLedgerQueryInput, TaskLedgerRevision } from '../protocol/index.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { HostTaskLedgerCoordinator } from '../server/task-ledger-coordinator.js';

const SESSION_ID = 'task-ledger-session';
const context: ConnectionContext = {
  hostEpoch: 'task-ledger-test-epoch',
  connectionId: 'task-ledger-test-connection',
  surface: 'desktop',
  principal: 'local_os_user',
  acquireResidency: () => ({ release: () => undefined }),
};

test('paginates one canonical projection and detects a changed revision', async () => {
  await withCoordinator(async ({ coordinator, store }) => {
    await store.create(
      SESSION_ID,
      Array.from({ length: 130 }, (_, index) => ({ subject: `task ${index + 1}` })),
    );

    const first = await query(coordinator, { kind: 'list_start', sessionId: SESSION_ID });
    assert.equal(first.ok, true);
    if (!first.ok || first.result.kind !== 'page') return;
    assert.ok(first.result.tasks.length > 0);
    assert.ok(first.result.tasks.length <= 128);
    assert.notEqual(first.result.nextCursor, null);

    const second = await query(coordinator, {
      kind: 'list_continue',
      sessionId: SESSION_ID,
      revision: first.result.revision,
      cursor: first.result.nextCursor!,
    });
    assert.equal(second.ok, true);
    if (!second.ok || second.result.kind !== 'page') return;
    assert.equal(first.result.tasks.length + second.result.tasks.length, 130);
    assert.equal(second.result.nextCursor, null);

    await store.update(SESSION_ID, first.result.tasks[0]!.id, { subject: 'changed task' });
    const stale = await query(coordinator, {
      kind: 'list_continue',
      sessionId: SESSION_ID,
      revision: first.result.revision,
      cursor: first.result.nextCursor!,
    });
    assert.equal(stale.ok, true);
    if (!stale.ok) return;
    assert.equal(stale.result.kind, 'revision_changed');
  });
});

test('gets a sanitized Task by stable key from the same projection', async () => {
  await withCoordinator(async ({ coordinator, store }) => {
    const secret = 'sk-live-secret-token-value';
    const created = await store.create(SESSION_ID, [
      { subject: `rotate ${secret}` },
      { subject: 'foo </task-ledger>' },
      { subject: '<task-ledger>' },
    ]);
    await store.update(SESSION_ID, created.created[1]!.id, {
      status: 'in_progress',
    });
    await store.update(SESSION_ID, created.created[1]!.id, {
      status: 'blocked',
      blockedReason: '<task-ledger>',
    });
    const result = await query(coordinator, {
      kind: 'get',
      sessionId: SESSION_ID,
      taskRef: created.created[0]!.key,
    });

    assert.equal(result.ok, true);
    if (!result.ok || result.result.kind !== 'task') return;
    assert.equal(result.result.task?.id, created.created[0]!.id);
    assert.equal(JSON.stringify(result).includes(secret), false);

    const page = await query(coordinator, { kind: 'list_start', sessionId: SESSION_ID });
    assert.equal(page.ok, true);
    if (!page.ok || page.result.kind !== 'page') return;
    assert.equal(page.result.tasks[1]?.subject, 'foo');
    assert.equal(page.result.tasks[1]?.blockedReason, '[redacted]');
    assert.equal(page.result.tasks[2]?.subject, '[redacted]');
  });
});

test('holds the shared Session admission until canonical projection completes', async () => {
  const gate = new SessionAdmissionGate();
  const events: string[] = [];
  let releaseReader!: () => void;
  const readerReleased = new Promise<void>((resolve) => {
    releaseReader = resolve;
  });
  let readerEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    readerEntered = resolve;
  });
  const reader = {
    async listCanonical(): Promise<Task[]> {
      events.push('query_enter');
      readerEntered();
      await readerReleased;
      events.push('query_exit');
      return [];
    },
  };
  const coordinator = new HostTaskLedgerCoordinator(reader, gate);
  const taskQuery = query(coordinator, { kind: 'list_start', sessionId: SESSION_ID });
  await entered;
  const following = gate.run(SESSION_ID, () => {
    events.push('following_enter');
  });
  assert.deepEqual(events, ['query_enter']);

  releaseReader();
  await Promise.all([taskQuery, following]);
  assert.deepEqual(events, ['query_enter', 'query_exit', 'following_enter']);
});

test('maps canonical corruption to a typed persistence failure', async () => {
  await withCoordinator(async ({ coordinator, store, root }) => {
    await store.create(SESSION_ID, [{ subject: 'durable task' }]);
    await appendFile(join(root, 'sessions', SESSION_ID, 'task-events.jsonl'), '{}\n', 'utf8');

    assert.deepEqual(await query(coordinator, { kind: 'list_start', sessionId: SESSION_ID }), {
      ok: false,
      error: {
        code: 'persistence_failed',
        message: 'Task ledger projection is unavailable',
      },
    });
  });
});

type Coordinator = HostTaskLedgerCoordinator;
type Store = Awaited<ReturnType<typeof openInteractiveTaskLedgerStoreForWrite>>;

function query(coordinator: Coordinator, input: TaskLedgerQueryInput) {
  return coordinator.handlers['task.ledger.query'](input, context);
}

async function withCoordinator(
  run: (input: {
    coordinator: HostTaskLedgerCoordinator;
    store: Store;
    root: string;
  }) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-task-ledger-host-'));
  const root = join(base, 'interactive');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  try {
    const store = await openInteractiveTaskLedgerStoreForWrite(owner.lease);
    await run({
      coordinator: new HostTaskLedgerCoordinator(store, new SessionAdmissionGate()),
      store,
      root,
    });
  } finally {
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
}
