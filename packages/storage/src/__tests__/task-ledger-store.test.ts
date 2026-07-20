import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { TASK_LEDGER_MAX_TASKS, type TaskLedgerRecord } from '@maka/core/task-ledger';
import { createTaskLedgerStore } from '../task-ledger-store.js';

const SESSION_ID = 'sess-abc';

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'maka-task-ledger-'));
}

function eventsPath(root: string): string {
  return join(root, 'sessions', SESSION_ID, 'task-events.jsonl');
}

async function records(root: string): Promise<TaskLedgerRecord[]> {
  return (await readFile(eventsPath(root), 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as TaskLedgerRecord);
}

describe('TaskLedgerStore', () => {
  it('commits a batch create as one complete version 1 record', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    const result = await store.create(SESSION_ID, [{ subject: ' first ' }, { subject: 'second' }]);

    assert.equal(result.total, 2);
    assert.deepEqual(
      result.created.map((task) => task.key),
      ['T1', 'T2'],
    );
    const text = await readFile(eventsPath(root), 'utf8');
    assert.equal(text.endsWith('\n'), true);
    assert.equal(text.trimEnd().split('\n').length, 1);
    const [record] = await records(root);
    assert.equal(record?.version, 1);
    assert.equal(record?.sessionId, SESSION_ID);
    assert.equal(record?.events.length, 2);
    assert.deepEqual(
      record?.events.map((event) => event.type),
      ['task_created', 'task_created'],
    );
    assert.deepEqual(
      (await createTaskLedgerStore(root).listCanonical(SESSION_ID)).map((task) => task.subject),
      ['first', 'second'],
    );
  });

  it('ignores only an incomplete crash tail and repairs it on the next append', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    const first = await store.create(SESSION_ID, [{ subject: 'before crash' }]);
    await appendFile(eventsPath(root), '{"version":1,"recordId":"truncated', 'utf8');

    assert.deepEqual(
      (await store.listCanonical(SESSION_ID)).map((task) => task.id),
      first.created.map((task) => task.id),
    );
    await store.create(SESSION_ID, [{ subject: 'after crash' }]);

    const text = await readFile(eventsPath(root), 'utf8');
    assert.equal(text.includes('truncated'), false);
    assert.equal(text.endsWith('\n'), true);
    assert.equal((await records(root)).length, 2);
    assert.equal((await createTaskLedgerStore(root).listCanonical(SESSION_ID)).length, 2);
  });

  it('fails closed on a complete corrupt line while render list stays fail-soft', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    await store.create(SESSION_ID, [{ subject: 'preserve' }]);
    await appendFile(eventsPath(root), '{}\n', 'utf8');
    const before = await readFile(eventsPath(root), 'utf8');

    assert.deepEqual(await store.list(SESSION_ID), []);
    await assert.rejects(() => store.listCanonical(SESSION_ID), /unexpected record shape/);
    await assert.rejects(
      () => store.create(SESSION_ID, [{ subject: 'must not append' }]),
      /unexpected record shape/,
    );
    assert.equal(await readFile(eventsPath(root), 'utf8'), before);
  });

  it('fails closed on record and event session namespace mismatches', async () => {
    for (const mismatch of ['record', 'event'] as const) {
      const root = await tempRoot();
      const store = createTaskLedgerStore(root);
      await store.create(SESSION_ID, [{ subject: mismatch }]);
      const [record] = await records(root);
      assert.ok(record);
      if (mismatch === 'record') record.sessionId = 'other-session';
      else record.events[0]!.sessionId = 'other-session';
      await writeFile(eventsPath(root), `${JSON.stringify(record)}\n`, 'utf8');

      assert.deepEqual(await store.list(SESSION_ID), []);
      await assert.rejects(() => store.listCanonical(SESSION_ID), /belongs to session/);
      await assert.rejects(
        () => store.update(SESSION_ID, 'T1', { status: 'in_progress' }),
        /belongs to session/,
      );
    }
  });

  it('fails closed when valid records produce projection diagnostics', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    await store.create(SESSION_ID, [{ subject: 'once' }]);
    const [record] = await records(root);
    assert.ok(record);
    const duplicate: TaskLedgerRecord = {
      ...record,
      recordId: 'duplicate-record',
      events: record.events.map((event) => ({ ...event, eventId: 'duplicate-event' })),
    };
    await appendFile(eventsPath(root), `${JSON.stringify(duplicate)}\n`, 'utf8');

    assert.deepEqual(await store.list(SESSION_ID), []);
    await assert.rejects(() => store.listCanonical(SESSION_ID), /projection diagnostics|duplicate/);
    await assert.rejects(
      () => store.create(SESSION_ID, [{ subject: 'blocked write' }]),
      /projection diagnostics|duplicate/,
    );
  });

  it('fails closed on non-canonical task strings and unknown persisted fields', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    await store.create(SESSION_ID, [{ subject: 'canonical' }]);
    const [original] = await records(root);
    assert.ok(original);

    const padded = structuredClone(original);
    padded.events[0]!.task.subject = ' canonical ';
    const unknown = structuredClone(original);
    Object.assign(unknown.events[0]!.task, { injected: 'must not project' });
    for (const corrupt of [padded, unknown]) {
      await writeFile(eventsPath(root), `${JSON.stringify(corrupt)}\n`, 'utf8');
      assert.deepEqual(await store.list(SESSION_ID), []);
      await assert.rejects(() => store.listCanonical(SESSION_ID), /unexpected record shape/);
    }
  });

  it('does not read or create the removed tasks.json cache', async () => {
    const root = await tempRoot();
    const sessionRoot = join(root, 'sessions', SESSION_ID);
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(
      join(sessionRoot, 'tasks.json'),
      JSON.stringify([
        {
          id: 'legacy',
          key: 'T1',
          subject: 'legacy',
          status: 'pending',
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
      'utf8',
    );
    const store = createTaskLedgerStore(root);
    assert.deepEqual(await store.listCanonical(SESSION_ID), []);
    await store.create(SESSION_ID, [{ subject: 'current' }]);
    assert.deepEqual(
      (await store.listCanonical(SESSION_ID)).map((task) => task.subject),
      ['current'],
    );
  });

  it('preserves hierarchy, claim and settle state-machine behavior', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    const {
      created: [parent],
    } = await store.create(SESSION_ID, [{ subject: 'parent' }], {
      actor: 'main_agent',
      runId: 'lead-run',
      turnId: 'lead-turn',
    });
    assert.ok(parent);
    const {
      created: [child],
    } = await store.create(SESSION_ID, [{ subject: 'child', parentId: parent.key }]);
    assert.ok(child);
    await store.update(SESSION_ID, parent.id, { status: 'in_progress' });
    await assert.rejects(
      () =>
        store.update(SESSION_ID, parent.id, { status: 'completed', completionEvidence: 'done' }),
      /descendant T1\.1 is pending/,
    );
    const owner = { actor: 'child_agent' as const, agentId: 'worker', turnId: 'child-turn' };
    await store.claim(SESSION_ID, child.key, owner);
    await store.settleAgentOutcome(SESSION_ID, child.id, {
      status: 'failed',
      owner: { ...owner, runId: 'child-run' },
      reason: 'tests failed',
    });
    const settled = await store.get(SESSION_ID, child.id);
    assert.equal(settled?.status, 'failed');
    assert.equal(settled?.failureReason, 'tests failed');
    assert.equal(settled?.owner?.runId, 'child-run');
  });

  it('serializes concurrent creates without losing tasks or reassigning keys', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    const batches = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        store.create(SESSION_ID, [{ subject: `concurrent ${index + 1}` }]),
      ),
    );
    const created = batches.flatMap((batch) => batch.created);
    assert.equal(created.length, 24);
    assert.equal(new Set(created.map((task) => task.id)).size, 24);
    assert.deepEqual(
      created.map((task) => task.key),
      Array.from({ length: 24 }, (_, index) => `T${index + 1}`),
    );

    const reloaded = await createTaskLedgerStore(root).listCanonical(SESSION_ID);
    assert.deepEqual(
      reloaded.map((task) => [task.id, task.key, task.subject]),
      created.map((task) => [task.id, task.key, task.subject]),
    );
  });

  it('enforces available-claim authority and races while preserving settlement outcomes', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    const { created: shared } = await store.create(
      SESSION_ID,
      [
        { subject: 'successful child report' },
        { subject: 'failed child report' },
        { subject: 'permission wait' },
        { subject: 'cancelled child' },
      ],
      { actor: 'main_agent', runId: 'lead-run', turnId: 'lead-turn' },
    );
    const {
      created: [unowned],
    } = await store.create(SESSION_ID, [{ subject: 'unowned' }]);
    assert.equal(shared.length, 4);
    assert.ok(unowned);

    const ownerA = { actor: 'child_agent' as const, agentId: 'worker-a', turnId: 'turn-a' };
    const ownerB = { actor: 'child_agent' as const, agentId: 'worker-b', turnId: 'turn-b' };
    await assert.rejects(
      () => store.claimAvailable(SESSION_ID, shared[0]!.id, ownerA, { parentRunId: 'wrong-run' }),
      /not shared by parent run/,
    );
    await assert.rejects(
      () => store.claimAvailable(SESSION_ID, unowned.id, ownerA, { parentRunId: 'lead-run' }),
      /not shared by parent run/,
    );

    const claimNotifications: Array<{ sessionId: string; taskIds: string[] }> = [];
    const unsubscribeClaims = store.subscribe((event) => claimNotifications.push(event));
    const recordsBeforeRace = (await records(root)).length;
    const race = await Promise.allSettled([
      store.claimAvailable(SESSION_ID, shared[0]!.id, ownerA, { parentRunId: 'lead-run' }),
      store.claimAvailable(SESSION_ID, shared[0]!.id, ownerB, { parentRunId: 'lead-run' }),
    ]);
    assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(race.filter((result) => result.status === 'rejected').length, 1);
    const winner = race[0]?.status === 'fulfilled' ? ownerA : ownerB;
    const winningClaimResult = race[0]?.status === 'fulfilled' ? race[0] : race[1];
    if (!winningClaimResult || winningClaimResult.status !== 'fulfilled') {
      assert.fail('claim race must produce one winning result');
    }
    const winningClaim = winningClaimResult.value;
    const recordsBeforeRepeat = (await records(root)).length;
    const notificationsBeforeRepeat = claimNotifications.length;
    assert.equal(recordsBeforeRepeat, recordsBeforeRace + 1);
    assert.equal(notificationsBeforeRepeat, 1);
    assert.deepEqual(claimNotifications[0]?.taskIds, [shared[0]!.id]);
    const repeatedClaim = await store.claimAvailable(SESSION_ID, shared[0]!.id, winner, {
      parentRunId: 'lead-run',
    });
    assert.deepEqual(repeatedClaim, winningClaim);
    assert.equal((await records(root)).length, recordsBeforeRepeat);
    assert.equal(claimNotifications.length, notificationsBeforeRepeat);
    unsubscribeClaims();

    await assert.rejects(
      () => store.claimAvailable(SESSION_ID, shared[1]!.id, winner, { parentRunId: 'lead-run' }),
      /already owns task/,
    );
    await store.settleAgentOutcome(SESSION_ID, shared[0]!.id, {
      status: 'completed',
      owner: { ...winner, runId: 'success-run' },
      reason: 'child reported success',
    });

    const failedOwner = {
      actor: 'child_agent' as const,
      agentId: 'worker-failed',
      turnId: 'turn-failed',
    };
    await store.claimAvailable(SESSION_ID, shared[1]!.id, failedOwner, {
      parentRunId: 'lead-run',
    });
    await store.settleAgentOutcome(SESSION_ID, shared[1]!.id, {
      status: 'failed',
      owner: { ...failedOwner, runId: 'failed-run' },
      reason: 'tests failed',
    });

    const blockedOwner = {
      actor: 'child_agent' as const,
      agentId: 'worker-blocked',
      turnId: 'turn-blocked',
    };
    await store.claimAvailable(SESSION_ID, shared[2]!.id, blockedOwner, {
      parentRunId: 'lead-run',
    });
    await store.settleAgentOutcome(SESSION_ID, shared[2]!.id, {
      status: 'waiting_permission',
      owner: { ...blockedOwner, runId: 'blocked-run' },
      reason: 'approval required',
    });

    const cancelledOwner = {
      actor: 'child_agent' as const,
      agentId: 'worker-cancelled',
      turnId: 'turn-cancelled',
    };
    await store.claimAvailable(SESSION_ID, shared[3]!.id, cancelledOwner, {
      parentRunId: 'lead-run',
    });
    await store.settleAgentOutcome(SESSION_ID, shared[3]!.id, {
      status: 'cancelled',
      owner: { ...cancelledOwner, runId: 'cancelled-run' },
      reason: 'parent stopped',
    });

    const settled = await createTaskLedgerStore(root).listCanonical(SESSION_ID);
    assert.equal(settled.find((task) => task.id === shared[0]!.id)?.status, 'in_progress');
    assert.equal(settled.find((task) => task.id === shared[1]!.id)?.status, 'failed');
    assert.equal(settled.find((task) => task.id === shared[1]!.id)?.failureReason, 'tests failed');
    assert.equal(settled.find((task) => task.id === shared[2]!.id)?.status, 'blocked');
    assert.equal(
      settled.find((task) => task.id === shared[2]!.id)?.blockedReason,
      'approval required',
    );
    assert.equal(settled.find((task) => task.id === shared[3]!.id)?.status, 'cancelled');
  });

  it('publishes changes only after the durable record exists and never for rejected mutations', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    const observations: Array<{
      event: { sessionId: string; taskIds: string[] };
      records: TaskLedgerRecord[];
    }> = [];
    let listenerError: unknown;
    const unsubscribe = store.subscribe((event) => {
      try {
        const persisted = readFileSync(eventsPath(root), 'utf8');
        assert.equal(persisted.endsWith('\n'), true);
        observations.push({
          event,
          records: persisted
            .trimEnd()
            .split('\n')
            .map((line) => JSON.parse(line) as TaskLedgerRecord),
        });
      } catch (error) {
        listenerError = error;
      }
    });

    const {
      created: [created],
    } = await store.create(SESSION_ID, [{ subject: 'observable' }]);
    assert.ok(created);
    assert.equal(listenerError, undefined);
    assert.equal(observations.length, 1);
    assert.equal(observations[0]?.records.length, 1);
    assert.equal(observations[0]?.records[0]?.events[0]?.taskId, created.id);
    assert.deepEqual(observations[0]?.event.taskIds, [created.id]);

    const beforeRejected = await readFile(eventsPath(root), 'utf8');
    await assert.rejects(
      () => store.update(SESSION_ID, 'missing-task', { status: 'in_progress' }),
      /No such task/,
    );
    assert.equal(observations.length, 1);
    assert.equal(await readFile(eventsPath(root), 'utf8'), beforeRejected);
    unsubscribe();
  });

  it('enforces the 200-task total cap without appending a partial batch', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    await store.create(
      SESSION_ID,
      Array.from({ length: TASK_LEDGER_MAX_TASKS }, (_, index) => ({ subject: `task ${index}` })),
    );
    const before = await readFile(eventsPath(root), 'utf8');
    await assert.rejects(
      () => store.create(SESSION_ID, [{ subject: 'overflow' }]),
      /limited to 200 tasks/,
    );
    assert.equal(await readFile(eventsPath(root), 'utf8'), before);
  });
});
