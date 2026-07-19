import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Task } from '../contracts.js';
import { normalizeVerifier, runVerifier } from '../verifier.js';

describe('command verifiers', () => {
  test('rejects cwd values outside the workspace', () => {
    for (const cwd of ['../outside', '/tmp/outside', 'C:\\outside']) {
      assert.throws(
        () =>
          normalizeVerifier({
            id: 'command-task',
            instruction: 'solve',
            workspaceDir: '/tmp/example',
            verifier: {
              kind: 'command',
              command: 'true',
              cwd,
              protectedPaths: [],
            },
          }),
        /command verifier cwd must be a workspace-relative path/,
      );
    }
  });

  test('rejects protectedPaths with Windows drive paths on POSIX hosts', () => {
    assert.throws(
      () =>
        normalizeVerifier({
          id: 'command-task',
          instruction: 'solve',
          workspaceDir: '/tmp/example',
          verifier: {
            kind: 'command',
            command: 'true',
            protectedPaths: ['C:\\outside'],
          },
        }),
      /protectedPaths entry must be a workspace-relative path/,
    );
  });

  test('runs command verifier from a legal workspace-relative cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-command-verifier-'));
    try {
      await mkdir(join(dir, 'subdir'));
      await writeFile(join(dir, 'subdir', 'marker.txt'), 'ok', 'utf8');
      const verifier = normalizeVerifier({
        id: 'command-task',
        instruction: 'solve',
        workspaceDir: dir,
        verifier: {
          kind: 'command',
          command: 'test -f marker.txt',
          cwd: 'subdir',
          protectedPaths: [],
        },
      });

      const result = await runVerifier({
        verifier,
        taskRunId: 'run-1',
        ts: 100,
        id: 'verifier-1',
        workspaceDir: dir,
      });

      assert.equal(result.passed, true);
      assert.equal(result.exitCode, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('benchmark verifiers', () => {
  test('normalizes enriched Terminal-Bench verifier specs', () => {
    const task: Task = {
      id: 'tb-task',
      instruction: 'solve',
      workspaceDir: '/tmp/example',
      verifier: {
        kind: 'terminal_bench',
        adapter: 'terminal-bench',
        instanceId: 'hello-world',
        dataset: 'terminal-bench-core',
        taskDir: '/tmp/tb/hello-world',
        taskDescriptionKey: 'base',
        testCommand: 'true',
        maxAgentTimeoutSec: 10,
        maxTestTimeoutSec: 20,
        protectedPaths: ['tests'],
      },
    };

    const verifier = normalizeVerifier(task);
    assert.equal(verifier.kind, 'terminal_bench');
    assert.equal(verifier.dataset, 'terminal-bench-core');
    assert.equal(verifier.testCommand, 'true');
    assert.deepEqual(verifier.protectedPaths, ['tests']);
  });

  test('runs Terminal-Bench testCommand mode without Docker or Harbor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-tbench-verifier-'));
    try {
      await writeFile(join(dir, 'marker.txt'), 'ok', 'utf8');
      const result = await runVerifier({
        verifier: {
          kind: 'terminal_bench',
          adapter: 'terminal-bench',
          instanceId: 'local-task',
          testCommand: 'test -f marker.txt',
          protectedPaths: [],
          datasetPath: '/datasets/local',
        },
        taskRunId: 'run-1',
        attemptId: 'attempt-1',
        ts: 100,
        id: 'verifier-1',
        workspaceDir: dir,
        submittedSnapshotId: 'snapshot-1',
        scoringWorkspaceId: 'scoring-1',
      });

      assert.equal(result.kind, 'terminal_bench');
      assert.equal(result.passed, true);
      assert.equal(result.exitCode, 0);
      assert.equal(result.score, 1);
      assert.equal(result.maxScore, 1);
      assert.equal(result.authority?.source, 'self_check');
      assert.equal(result.authority?.authoritative, false);
      assert.equal(result.submittedSnapshotId, 'snapshot-1');
      assert.deepEqual(result.details, {
        adapter: 'terminal-bench',
        instanceId: 'local-task',
        datasetPath: '/datasets/local',
        testCommand: 'test -f marker.txt',
        timedOut: false,
        verificationPlaceholder: true,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('requires protectedPaths for local Terminal-Bench testCommand mode', () => {
    assert.throws(
      () =>
        normalizeVerifier({
          id: 'tb-task',
          instruction: 'solve',
          workspaceDir: '/tmp/example',
          verifier: {
            kind: 'terminal_bench',
            adapter: 'terminal-bench',
            instanceId: 'local-task',
            testCommand: 'true',
          },
        }),
      /protectedPaths/,
    );
  });

  test('keeps missing non-command adapters explicit and unsupported', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-tbench-verifier-'));
    try {
      const result = await runVerifier({
        verifier: {
          kind: 'terminal_bench',
          adapter: 'terminal-bench',
          instanceId: 'needs-real-adapter',
        },
        taskRunId: 'run-1',
        ts: 100,
        id: 'verifier-unsupported',
        workspaceDir: dir,
      });

      assert.equal(result.passed, false);
      assert.equal(result.exitCode, null);
      assert.equal(result.errorClass, 'unsupported_adapter');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects benchmark artifacts for a different task run or attempt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-tbench-verifier-'));
    try {
      await assert.rejects(
        runVerifier({
          verifier: { kind: 'terminal_bench', adapter: 'terminal-bench', instanceId: 'official' },
          taskRunId: 'run-current',
          attemptId: 'attempt-current',
          ts: 100,
          id: 'verifier-official',
          workspaceDir: dir,
          benchmarkAdapters: {
            'terminal-bench': {
              name: 'terminal-bench',
              runVerifier: () => ({
                kind: 'terminal_bench',
                passed: true,
                exitCode: 0,
                authority: { source: 'official_harbor_verifier', authoritative: true },
                artifacts: [
                  {
                    taskRunId: 'run-other',
                    kind: 'container_workspace',
                    workspacePath: '/app',
                    authority: { source: 'container_capture', authoritative: true },
                  },
                ],
              }),
            },
          },
        }),
        /taskRunId mismatch/,
      );

      await assert.rejects(
        runVerifier({
          verifier: { kind: 'terminal_bench', adapter: 'terminal-bench', instanceId: 'official' },
          taskRunId: 'run-current',
          attemptId: 'attempt-current',
          ts: 100,
          id: 'verifier-official',
          workspaceDir: dir,
          benchmarkAdapters: {
            'terminal-bench': {
              name: 'terminal-bench',
              runVerifier: () => ({
                kind: 'terminal_bench',
                passed: true,
                exitCode: 0,
                authority: { source: 'official_harbor_verifier', authoritative: true },
                artifacts: [
                  {
                    attemptId: 'attempt-other',
                    kind: 'container_workspace',
                    workspacePath: '/app',
                    authority: { source: 'container_capture', authoritative: true },
                  },
                ],
              }),
            },
          },
        }),
        /attemptId mismatch/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
