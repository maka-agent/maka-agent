import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  ensureHarnessOracleQualification,
  qualifyHarnessTasks,
} from '../harness-qualification.js';

describe('harness Oracle qualification', () => {
  test('selects the first healthy tasks in frozen order and records every inspected candidate', async () => {
    const calls: string[] = [];
    const evidence = await qualifyHarnessTasks({
      candidateTasks: ['a', 'b', 'c', 'd'].map((id) => ({ id, path: `/tasks/${id}` })),
      targetCount: 2,
      taskSourceFingerprint: 'sha256:tasks',
      verifierPolicyFingerprint: 'sha256:verifier',
      runOracle: async (task) => {
        calls.push(task.id);
        return task.id === 'b'
          ? { outcome: 'failed', reward: 0, attempts: 1 }
          : { outcome: 'passed', reward: 1, attempts: 1 };
      },
    });

    assert.deepEqual(calls, ['a', 'b', 'c']);
    assert.deepEqual(evidence.selectedTaskIds, ['a', 'c']);
    assert.deepEqual(evidence.candidates.map(({ taskId, outcome }) => ({ taskId, outcome })), [
      { taskId: 'a', outcome: 'passed' },
      { taskId: 'b', outcome: 'failed' },
      { taskId: 'c', outcome: 'passed' },
    ]);
    assert.match(evidence.fingerprint, /^sha256:[a-f0-9]{64}$/);
  });

  test('fails before sampling when the frozen pool cannot supply enough healthy tasks', async () => {
    await assert.rejects(
      qualifyHarnessTasks({
        candidateTasks: [{ id: 'a', path: '/tasks/a' }],
        targetCount: 2,
        taskSourceFingerprint: 'sha256:tasks',
        verifierPolicyFingerprint: 'sha256:verifier',
        runOracle: async () => ({ outcome: 'failed', reward: 0, attempts: 2 }),
      }),
      /only 0 of 2 tasks passed Oracle qualification/,
    );
  });

  test('resumes from immutable qualification evidence without rerunning Oracle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-qualification-'));
    const path = join(root, 'qualification.json');
    let calls = 0;
    try {
      const input = {
        candidateTasks: [{ id: 'a', path: '/tasks/a' }],
        targetCount: 1,
        taskSourceFingerprint: 'sha256:tasks',
        verifierPolicyFingerprint: 'sha256:verifier',
        runOracle: async () => {
          calls += 1;
          return { outcome: 'passed' as const, reward: 1, attempts: 1 };
        },
      };
      const first = await ensureHarnessOracleQualification(path, input);
      const resumed = await ensureHarnessOracleQualification(path, input);

      assert.equal(calls, 1);
      assert.deepEqual(resumed, first);
      assert.equal(JSON.parse(await readFile(path, 'utf8')).fingerprint, first.fingerprint);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
