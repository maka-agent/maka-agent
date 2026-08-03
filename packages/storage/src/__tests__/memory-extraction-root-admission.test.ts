import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RootExecutionDescriptor } from '@maka/core/agent-run';
import { createSqliteAgentRunStore, type AdmitRootTurnInput } from '../agent-run-store.js';

test('memory extraction root admission durably binds operation and attempt identity', async () => {
  await withTempRoot(async (root) => {
    const store = createSqliteAgentRunStore(root);
    const admitted = await store.admitRootTurn(admissionInput());

    assert.equal(admitted.kind, 'admitted');
    assert.deepEqual(admitted.admission.execution, admissionInput().execution);
    assert.equal(Object.isFrozen(admitted.admission.execution), true);

    const reopened = createSqliteAgentRunStore(root);
    assert.deepEqual(
      await reopened.readRootTurnAdmission('memory-session', 'memory-turn'),
      admitted.admission,
    );
  });
});

test('memory extraction root admission rejects malformed or expanded descriptors', async () => {
  await withTempRoot(async (root) => {
    const store = createSqliteAgentRunStore(root);
    for (const execution of [
      { ...admissionInput().execution, operationId: ' invalid ' },
      { ...admissionInput().execution, attemptId: '' },
      { ...admissionInput().execution, unexpected: true },
    ]) {
      await assert.rejects(
        () =>
          store.admitRootTurn(
            admissionInput({ execution: execution as unknown as RootExecutionDescriptor }),
          ),
        /Invalid root execution descriptor/,
      );
    }
  });
});

function admissionInput(overrides: Partial<AdmitRootTurnInput> = {}): AdmitRootTurnInput {
  return {
    sessionId: 'memory-session',
    turnId: 'memory-turn',
    proposedRunId: 'memory-run',
    proposedUserMessageId: 'memory-control-message',
    execution: {
      kind: 'memory_extraction_child',
      operationId: 'memory-operation-1',
      attemptId: 'memory-attempt-1',
    },
    previousRootTurnId: null,
    normalizedInput: { text: '<runtime_memory_extraction />' },
    sourceMessages: [],
    admittedAt: 50,
    ...overrides,
  };
}

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-memory-extraction-admission-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
