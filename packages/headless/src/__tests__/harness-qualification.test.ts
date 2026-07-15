import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

  test('rejects checksummed evidence whose selected tasks disagree with Oracle outcomes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-qualification-'));
    const path = join(root, 'qualification.json');
    const input = {
      candidateTasks: [{ id: 'a', path: '/tasks/a' }, { id: 'b', path: '/tasks/b' }],
      targetCount: 1,
      taskSourceFingerprint: 'sha256:tasks',
      verifierPolicyFingerprint: 'sha256:verifier',
      runOracle: async () => ({ outcome: 'passed' as const, reward: 1, attempts: 1 }),
    };
    try {
      const valid = await ensureHarnessOracleQualification(path, input);
      const { fingerprint: _fingerprint, ...tamperedBody } = {
        ...valid,
        selectedTaskIds: ['b'],
      };
      const fingerprint = `sha256:${createHash('sha256').update(canonicalJsonFixture(tamperedBody)).digest('hex')}`;
      await writeFile(path, `${JSON.stringify({ ...tamperedBody, fingerprint }, null, 2)}\n`, 'utf8');

      await assert.rejects(
        ensureHarnessOracleQualification(path, input),
        /stored Oracle qualification evidence is malformed/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function canonicalJsonFixture(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonFixture).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJsonFixture(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
