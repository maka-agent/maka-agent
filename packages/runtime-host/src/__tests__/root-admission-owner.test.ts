import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAgentRunStore, type RootTurnAdmissionStore } from '@maka/storage';
import { RootAdmissionOwner } from '../server/root-admission-owner.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

test('poisons a Session after an ambiguous durable admission failure', async () => {
  await withStore(async (durableStore) => {
    let failAfterCommit = true;
    const store: RootTurnAdmissionStore = {
      admitRootTurn: async (input) => {
        const result = await durableStore.admitRootTurn(input);
        if (failAfterCommit) {
          failAfterCommit = false;
          throw new Error('post-commit durability failure');
        }
        return result;
      },
      readRootTurnAdmission: (sessionId, turnId) =>
        durableStore.readRootTurnAdmission(sessionId, turnId),
      listRootTurnAdmissionsForRecovery: (sessionId) =>
        durableStore.listRootTurnAdmissionsForRecovery(sessionId),
    };
    const owner = new RootAdmissionOwner(store);
    await owner.recoverSession('session');
    const gate = new SessionAdmissionGate();

    const outcomes = await Promise.allSettled([
      gate.run('session', () => owner.admitRootTurn(admitInput('session', 'turn-1', 10))),
      gate.run('session', () => owner.admitRootTurn(admitInput('session', 'turn-2', 20))),
    ]);
    assert.equal(outcomes[0]?.status, 'rejected');
    assert.equal(outcomes[1]?.status, 'rejected');
    if (outcomes[0]?.status === 'rejected') {
      assert.match(String(outcomes[0].reason), /post-commit durability failure/);
    }
    if (outcomes[1]?.status === 'rejected') {
      assert.match(String(outcomes[1].reason), /admission state is uncertain/);
    }

    const chain = await durableStore.listRootTurnAdmissionsForRecovery('session');
    assert.deepEqual(
      chain.map((admission) => admission.turnId),
      ['turn-1'],
    );
  });
});

test('recovery installs the validated tip and the successor extends it', async () => {
  await withStore(async (store) => {
    await store.admitRootTurn({
      ...admitInput('session', 'turn-1', 100),
      previousRootTurnId: null,
    });
    await store.admitRootTurn({
      ...admitInput('session', 'turn-2', 100),
      previousRootTurnId: 'turn-1',
    });
    const owner = new RootAdmissionOwner(store);
    const chain = await owner.recoverSession('session');
    assert.deepEqual(
      chain.map((admission) => admission.turnId),
      ['turn-1', 'turn-2'],
    );

    const successor = await owner.admitRootTurn(admitInput('session', 'turn-3', 100));
    assert.equal(successor.admission.previousRootTurnId, 'turn-2');
    assert.doesNotThrow(() => owner.assertKnownAdmission(successor.admission));
  });
});

test('fails closed when a known durable admission identity drifts', async () => {
  await withStore(async (store) => {
    const first = await store.admitRootTurn({
      ...admitInput('session', 'turn-1', 10),
      previousRootTurnId: null,
    });
    const owner = new RootAdmissionOwner(store);
    await owner.recoverSession('session');
    owner.assertKnownAdmission(first.admission);
    assert.throws(
      () => owner.assertKnownAdmission({ ...first.admission, runId: 'run-drifted' }),
      /identity changed/,
    );
    await assert.rejects(() => owner.recoverSession('session'), /already installed/);
  });
});

function admitInput(sessionId: string, turnId: string, admittedAt: number) {
  return {
    sessionId,
    turnId,
    proposedRunId: `run-${turnId}`,
    proposedUserMessageId: `message-${turnId}`,
    normalizedInput: { text: `text-${turnId}` },
    admittedAt,
  };
}

async function withStore(
  run: (store: ReturnType<typeof createAgentRunStore>) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-root-admission-owner-'));
  try {
    await run(createAgentRunStore(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
