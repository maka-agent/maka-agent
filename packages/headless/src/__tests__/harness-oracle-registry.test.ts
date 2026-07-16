import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  auditHarnessOracleRegistry,
  HarnessOracleAuditExecutionError,
  resolveHarnessOracleAnnotations,
} from '../harness-oracle-registry.js';

describe('harness Oracle evidence registry', () => {
  test('audits the complete corpus once and reuses every unchanged per-task result', async () => {
    const calls: string[] = [];
    const tasks = ['a', 'b', 'c'].map((taskId) => ({
      task: { id: taskId, path: `/tasks/${taskId}` },
      identity: {
        taskFingerprint: `sha256:task-${taskId}`,
        verifierPolicyFingerprint: 'sha256:verifier',
        environmentFingerprint: 'sha256:environment',
        runtimeFingerprint: 'sha256:runtime',
      },
    }));
    const input = {
      tasks,
      provenance: { issuer: 'github-actions' as const, repository: 'maka-agent/maka-agent', runId: '123' },
      runOracle: async (task: { id: string }) => {
        calls.push(task.id);
        return task.id === 'b'
          ? { outcome: 'failed' as const, reward: 0, attempts: 1 }
          : { outcome: 'passed' as const, reward: 1, attempts: 1 };
      },
    };

    const baseline = await auditHarnessOracleRegistry(input);
    assert.deepEqual(calls, ['a', 'b', 'c']);
    assert.deepEqual(baseline.executedTaskIds, ['a', 'b', 'c']);
    assert.deepEqual(
      baseline.snapshot.entries.map(({ taskId, oracle }) => ({ taskId, outcome: oracle?.outcome })),
      [
        { taskId: 'a', outcome: 'passed' },
        { taskId: 'b', outcome: 'failed' },
        { taskId: 'c', outcome: 'passed' },
      ],
    );

    calls.length = 0;
    const repeated = await auditHarnessOracleRegistry({ ...input, existingSnapshot: baseline.snapshot });
    assert.deepEqual(calls, []);
    assert.deepEqual(repeated.executedTaskIds, []);
    assert.deepEqual(repeated.snapshot.entries, baseline.snapshot.entries);
  });

  test('reruns only the task whose qualification identity changed', async () => {
    const calls: string[] = [];
    const tasks = ['a', 'b'].map((taskId) => ({
      task: { id: taskId, path: `/tasks/${taskId}` },
      identity: {
        taskFingerprint: `sha256:task-${taskId}`,
        verifierPolicyFingerprint: 'sha256:verifier',
        environmentFingerprint: 'sha256:environment',
        runtimeFingerprint: 'sha256:runtime',
      },
    }));
    const runOracle = async (task: { id: string }) => {
      calls.push(task.id);
      return { outcome: 'passed' as const, reward: 1, attempts: 1 };
    };
    const provenance = { issuer: 'github-actions' as const, repository: 'maka-agent/maka-agent', runId: '123' };
    const baseline = await auditHarnessOracleRegistry({ tasks, provenance, runOracle });

    calls.length = 0;
    const changedTasks = tasks.map((item) => item.task.id === 'b'
      ? { ...item, identity: { ...item.identity, environmentFingerprint: 'sha256:environment-v2' } }
      : item);
    const incremental = await auditHarnessOracleRegistry({
      tasks: changedTasks,
      existingSnapshot: baseline.snapshot,
      provenance: { ...provenance, runId: '124' },
      runOracle,
    });

    assert.deepEqual(calls, ['b']);
    assert.deepEqual(incremental.executedTaskIds, ['b']);
    assert.equal(incremental.snapshot.entries[0]?.fingerprint, baseline.snapshot.entries[0]?.fingerprint);
    assert.notEqual(incremental.snapshot.entries[1]?.fingerprint, baseline.snapshot.entries[1]?.fingerprint);
  });

  test('rejects a tampered snapshot before reusing its entries', async () => {
    const tasks = [{
      task: { id: 'a', path: '/tasks/a' },
      identity: {
        taskFingerprint: 'sha256:task-a',
        verifierPolicyFingerprint: 'sha256:verifier',
        environmentFingerprint: 'sha256:environment',
        runtimeFingerprint: 'sha256:runtime',
      },
    }];
    const provenance = { issuer: 'github-actions' as const, repository: 'maka-agent/maka-agent', runId: '123' };
    const baseline = await auditHarnessOracleRegistry({
      tasks,
      provenance,
      runOracle: async () => ({ outcome: 'passed', reward: 1, attempts: 1 }),
    });
    const tampered = structuredClone(baseline.snapshot);
    tampered.entries[0]!.oracle!.reward = 0;

    await assert.rejects(
      auditHarnessOracleRegistry({
        tasks,
        existingSnapshot: tampered,
        provenance,
        runOracle: async () => ({ outcome: 'passed', reward: 1, attempts: 1 }),
      }),
      /registry snapshot fingerprint is invalid/,
    );
  });

  test('records infrastructure failure separately and continues auditing later tasks', async () => {
    const calls: string[] = [];
    const tasks = ['a', 'b', 'c'].map((taskId) => ({
      task: { id: taskId, path: `/tasks/${taskId}` },
      identity: {
        taskFingerprint: `sha256:task-${taskId}`,
        verifierPolicyFingerprint: 'sha256:verifier',
        environmentFingerprint: 'sha256:environment',
        runtimeFingerprint: 'sha256:runtime',
      },
    }));

    const audit = await auditHarnessOracleRegistry({
      tasks,
      provenance: { issuer: 'github-actions', repository: 'maka-agent/maka-agent', runId: '123' },
      runOracle: async (task) => {
        calls.push(task.id);
        if (task.id === 'b') throw new Error('docker daemon stopped');
        return { outcome: 'passed', reward: 1, attempts: 1 };
      },
    });

    assert.deepEqual(calls, ['a', 'b', 'c']);
    assert.deepEqual(audit.snapshot.entries.map(({ taskId, execution }) => ({ taskId, execution })), [
      { taskId: 'a', execution: { status: 'completed' } },
      { taskId: 'b', execution: { status: 'infra_failed' } },
      { taskId: 'c', execution: { status: 'completed' } },
    ]);
    assert.equal(audit.snapshot.entries[1]?.oracle, null);
  });

  test('records a typed execution timeout without treating it as an Oracle failure', async () => {
    const audit = await auditHarnessOracleRegistry({
      tasks: [{
        task: { id: 'a', path: '/tasks/a' },
        identity: {
          taskFingerprint: 'sha256:task-a',
          verifierPolicyFingerprint: 'sha256:verifier',
          environmentFingerprint: 'sha256:environment',
          runtimeFingerprint: 'sha256:runtime',
        },
      }],
      provenance: { issuer: 'github-actions', repository: 'maka-agent/maka-agent', runId: '123' },
      runOracle: async () => { throw new HarnessOracleAuditExecutionError('timed_out'); },
    });

    assert.deepEqual(audit.snapshot.entries[0]?.execution, { status: 'timed_out' });
    assert.equal(audit.snapshot.entries[0]?.oracle, null);
  });

  test('rejects self-checksummed entries with impossible Oracle result semantics', async () => {
    const tasks = [{
      task: { id: 'a', path: '/tasks/a' },
      identity: {
        taskFingerprint: 'sha256:task-a',
        verifierPolicyFingerprint: 'sha256:verifier',
        environmentFingerprint: 'sha256:environment',
        runtimeFingerprint: 'sha256:runtime',
      },
    }];
    const provenance = { issuer: 'github-actions' as const, repository: 'maka-agent/maka-agent', runId: '123' };
    const baseline = await auditHarnessOracleRegistry({
      tasks,
      provenance,
      runOracle: async () => ({ outcome: 'passed', reward: 1, attempts: 1 }),
    });
    const invalid = structuredClone(baseline.snapshot);
    invalid.entries[0]!.oracle!.reward = 0;
    invalid.entries[0]!.fingerprint = fingerprintFixture(withoutFingerprint(invalid.entries[0]!));
    invalid.fingerprint = fingerprintFixture(withoutFingerprint(invalid));

    await assert.rejects(
      auditHarnessOracleRegistry({
        tasks,
        existingSnapshot: invalid,
        provenance,
        runOracle: async () => ({ outcome: 'passed', reward: 1, attempts: 1 }),
      }),
      /registry entry is malformed/,
    );
  });

  test('resolves advisory states without returning a task-selection decision', async () => {
    const tasks = ['passed', 'failed', 'timed', 'infra', 'stale', 'missing'].map((taskId) => ({
      task: { id: taskId, path: `/tasks/${taskId}` },
      identity: {
        taskFingerprint: `sha256:task-${taskId}`,
        verifierPolicyFingerprint: 'sha256:verifier',
        environmentFingerprint: 'sha256:environment',
        runtimeFingerprint: 'sha256:runtime',
      },
    }));
    const baseline = await auditHarnessOracleRegistry({
      tasks: tasks.slice(0, 5),
      provenance: { issuer: 'github-actions', repository: 'maka-agent/maka-agent', runId: '123' },
      runOracle: async (task) => {
        if (task.id === 'failed') return { outcome: 'failed', reward: 0, attempts: 1 };
        if (task.id === 'timed') return { outcome: 'candidate_timeout', reward: 0, attempts: 1 };
        if (task.id === 'infra') throw new Error('docker failed');
        return { outcome: 'passed', reward: 1, attempts: 1 };
      },
    });
    const currentTasks = tasks.map((item) => item.task.id === 'stale'
      ? { ...item, identity: { ...item.identity, runtimeFingerprint: 'sha256:runtime-v2' } }
      : item);

    const annotations = resolveHarnessOracleAnnotations(currentTasks, baseline.snapshot);

    assert.deepEqual(annotations.map(({ taskId, state }) => ({ taskId, state })), [
      { taskId: 'passed', state: 'passed' },
      { taskId: 'failed', state: 'failed' },
      { taskId: 'timed', state: 'timed_out' },
      { taskId: 'infra', state: 'infra_failed' },
      { taskId: 'stale', state: 'stale' },
      { taskId: 'missing', state: 'missing' },
    ]);
    assert.equal('selectedTaskIds' in annotations, false);
  });
});

function withoutFingerprint<T extends { fingerprint: string }>(value: T): Omit<T, 'fingerprint'> {
  const { fingerprint: _fingerprint, ...body } = value;
  return body;
}

function fingerprintFixture(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJsonFixture(value)).digest('hex')}`;
}

function canonicalJsonFixture(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonFixture).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJsonFixture(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
