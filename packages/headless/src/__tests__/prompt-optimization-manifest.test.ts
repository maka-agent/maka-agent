import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { promisify } from 'node:util';
import type { FixedPromptTask } from '../fixed-prompt-controller.js';
import {
  buildPromptOptimizationRunManifest,
  buildPromptOptimizationSubjectFingerprint,
  buildPromptOptimizationTaskSourceFingerprint,
  buildPromptOptimizationToolchainFingerprint,
} from '../prompt-optimization-manifest.js';

const execFileAsync = promisify(execFile);

describe('prompt optimization run manifest', () => {
  test('changes fingerprint when task source content changes under the same task id', async () => {
    await withDir(async (dir) => {
      const taskPath = join(dir, 'tasks', 'hash-a', 'task-a');
      await mkdir(join(taskPath, 'tests'), { recursive: true });
      await writeFile(join(taskPath, 'task.toml'), 'agent_timeout_sec = 900\n', 'utf8');
      await writeFile(join(taskPath, 'tests', 'test_outputs.py'), 'expected = 1\n', 'utf8');
      const task: FixedPromptTask = { id: 'task-a', path: taskPath, metadata: { agentTimeoutSec: 900 } };

      const firstTaskSourceFingerprint = await buildPromptOptimizationTaskSourceFingerprint(
        join(dir, 'tasks'),
        [task],
        [],
      );
      const first = buildManifest(firstTaskSourceFingerprint, [task]).fingerprint;

      await writeFile(join(taskPath, 'tests', 'test_outputs.py'), 'expected = 2\n', 'utf8');

      const secondTaskSourceFingerprint = await buildPromptOptimizationTaskSourceFingerprint(
        join(dir, 'tasks'),
        [task],
        [],
      );
      const second = buildManifest(secondTaskSourceFingerprint, [task]).fingerprint;

      assert.notEqual(secondTaskSourceFingerprint, firstTaskSourceFingerprint);
      assert.notEqual(second, first);
    });
  });

  test('rejects dirty subject checkouts before building a resume fingerprint', async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, 'tracked.txt'), 'clean\n', 'utf8');
      await git(dir, 'init', '-q');
      await git(dir, 'config', 'user.email', 'test@example.com');
      await git(dir, 'config', 'user.name', 'Test User');
      await git(dir, 'add', 'tracked.txt');
      await git(dir, 'commit', '-q', '-m', 'initial');

      await writeFile(join(dir, 'tracked.txt'), 'dirty\n', 'utf8');

      await assert.rejects(
        buildPromptOptimizationSubjectFingerprint(dir),
        /must be clean for resume-safe prompt optimization runs/,
      );
    });
  });

  test('changes toolchain fingerprint when execution headless source changes', async () => {
    await withDir(async (dir) => {
      await makeExecutionRepo(dir);
      const first = await buildPromptOptimizationToolchainFingerprint(dir);

      await writeFile(join(dir, 'packages', 'headless', 'src', 'runner.ts'), 'export const value = 2;\n', 'utf8');
      await git(dir, 'add', 'packages/headless/src/runner.ts');
      await git(dir, 'commit', '-q', '-m', 'change headless source');

      const second = await buildPromptOptimizationToolchainFingerprint(dir);
      assert.notEqual(second, first);
    });
  });

  test('rejects dirty execution checkouts before building a toolchain fingerprint', async () => {
    await withDir(async (dir) => {
      await makeExecutionRepo(dir);
      await writeFile(join(dir, 'packages', 'headless', 'src', 'runner.ts'), 'export const value = 2;\n', 'utf8');

      await assert.rejects(
        buildPromptOptimizationToolchainFingerprint(dir),
        /execution checkout must be clean for resume-safe prompt optimization runs/,
      );
    });
  });
});

function buildManifest(taskSourceFingerprint: string, heldInTasks: FixedPromptTask[]) {
  return buildPromptOptimizationRunManifest({
    runId: 'rsi-test',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek/deepseek-v4-flash',
    rounds: 1,
    baselineRuns: 1,
    costCeilingUsd: 1,
    maxConcurrency: 1,
    maxInfraFailureRate: null,
    maxStableTaskDurationMs: null,
    minStableRatio: 0.5,
    minStableHeldInTasks: 1,
    minStableHeldOutTasks: 1,
    runtimeProfile: { taskBudgetSec: 1800 },
    subjectFingerprint: 'sha256:subject',
    taskSourceFingerprint,
    toolchainFingerprint: 'sha256:toolchain',
    heldInTasks,
    heldOutTasks: [],
    heldInNoPattern: [],
    heldOutNoPattern: [],
  });
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function makeExecutionRepo(dir: string): Promise<void> {
  await mkdir(join(dir, 'packages', 'headless', 'src'), { recursive: true });
  await mkdir(join(dir, 'packages', 'headless', 'harbor'), { recursive: true });
  await mkdir(join(dir, 'packages', 'headless', 'dist'), { recursive: true });
  await writeFile(join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n', 'utf8');
  await writeFile(join(dir, 'packages', 'headless', 'package.json'), '{"name":"@maka/headless"}\n', 'utf8');
  await writeFile(join(dir, 'packages', 'headless', 'src', 'runner.ts'), 'export const value = 1;\n', 'utf8');
  await writeFile(join(dir, 'packages', 'headless', 'harbor', 'run-prompt-optimization.mjs'), 'console.log("runner");\n', 'utf8');
  await writeFile(join(dir, 'packages', 'headless', 'dist', 'runner.js'), 'export const value = 1;\n', 'utf8');
  await git(dir, 'init', '-q');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'config', 'user.name', 'Test User');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-q', '-m', 'initial');
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'maka-prompt-opt-manifest-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
