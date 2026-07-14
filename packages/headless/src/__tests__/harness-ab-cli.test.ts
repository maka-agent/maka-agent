import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { TERMINAL_BENCH_2_1_TASK_IDS } from '../harness-ab-manifest.js';

const execFileAsync = promisify(execFile);

test('harness A/B CLI accepts a 2-task operational canary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-cli-'));
  try {
    const scriptPath = new URL('../../harbor/run-harness-ab.mjs', import.meta.url);
    await assert.rejects(execFileAsync(process.execPath, [scriptPath.pathname], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MAKA_HARNESS_AB_OUT_DIR: join(dir, 'out'),
        MAKA_HARNESS_AB_TASKS_ROOT: join(dir, 'missing-tasks'),
        MAKA_HARNESS_AB_LIMIT: '2',
        MAKA_HARNESS_AB_DRY_RUN: '1',
      },
    }), /Terminal-Bench 2\.1 task set mismatch/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('harness A/B runtime keeps pruning enabled and semantic compact disabled', async () => {
  const { harnessMakaContextBudgetEnv } = await import(
    new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href
  );

  assert.deepEqual(harnessMakaContextBudgetEnv(), {
    MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE: 'on',
    MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MAX_ESTIMATED_TOKENS: '2048',
    MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MIN_STEP_NUMBER: '1',
    MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on',
    MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_ESTIMATED_TOKENS: '2048',
    MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS_FULL: '0',
    MAKA_CONTEXT_SEMANTIC_COMPACT: 'off',
  });
});

test('detached harness launcher persists a terminal failed journal after the worker exits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-detached-'));
  try {
    const outDir = join(dir, 'out');
    const runId = 'detached-smoke';
    const scriptPath = new URL('../../harbor/run-harness-ab-detached.mjs', import.meta.url);
    await execFileAsync(process.execPath, [scriptPath.pathname], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MAKA_HARNESS_AB_OUT_DIR: outDir,
        MAKA_HARNESS_AB_RUN_ID: runId,
        MAKA_HARNESS_AB_TASKS_ROOT: join(dir, 'missing-tasks'),
        MAKA_HARNESS_AB_LIMIT: '2',
        MAKA_HARNESS_AB_DRY_RUN: '1',
      },
    });

    const journalPath = join(outDir, runId, 'background-run.json');
    const journal = await waitForJournal(journalPath, (value) => value.status === 'failed');
    assert.equal(journal.exitCode, 1);
    assert.equal(typeof journal.pid, 'number');
    assert.equal(typeof journal.startedAt, 'string');
    assert.equal(typeof journal.finishedAt, 'string');
    assert.match(await readFile(join(outDir, runId, 'background-run.log'), 'utf8'), /Terminal-Bench 2\.1 task set mismatch/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('duplicate detached launch does not overwrite the active run journal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-detached-'));
  try {
    const outDir = join(dir, 'out');
    const runId = 'detached-active';
    const runRoot = join(outDir, runId);
    const lockDir = join(runRoot, '.ab-run.lock');
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, 'owner.json'), `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`, 'utf8');
    const journal = {
      schemaVersion: 1,
      pid: process.pid,
      startedAt: '2026-07-14T00:00:00.000Z',
      logPath: join(runRoot, 'background-run.log'),
      status: 'running',
    };
    await writeFile(join(runRoot, 'background-run.json'), `${JSON.stringify(journal, null, 2)}\n`, 'utf8');

    const scriptPath = new URL('../../harbor/run-harness-ab-detached.mjs', import.meta.url);
    await assert.rejects(execFileAsync(process.execPath, [scriptPath.pathname], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MAKA_HARNESS_AB_OUT_DIR: outDir,
        MAKA_HARNESS_AB_RUN_ID: runId,
        MAKA_HARNESS_AB_TASKS_ROOT: join(dir, 'missing-tasks'),
        MAKA_HARNESS_AB_LIMIT: '2',
        MAKA_HARNESS_AB_DRY_RUN: '1',
      },
    }), /before acquiring the run lock/);

    await waitForFileMatch(join(runRoot, 'background-run.log'), /Terminal-Bench 2\.1 task set mismatch|A\/B run is already active/);
    assert.deepEqual(
      JSON.parse(await readFile(join(runRoot, 'background-run.json'), 'utf8')),
      journal,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('harness A/B CLI accepts the fixed 30-task pilot limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-cli-'));
  try {
    const scriptPath = new URL('../../harbor/run-harness-ab.mjs', import.meta.url);
    await assert.rejects(execFileAsync(process.execPath, [scriptPath.pathname], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MAKA_HARNESS_AB_OUT_DIR: join(dir, 'out'),
        MAKA_HARNESS_AB_TASKS_ROOT: join(dir, 'missing-tasks'),
        MAKA_HARNESS_AB_LIMIT: '30',
        MAKA_HARNESS_AB_DRY_RUN: '1',
      },
    }), /Terminal-Bench 2\.1 task set mismatch/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('harness A/B CLI rejects modified task contents before reading credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-cli-'));
  try {
    const tasksRoot = join(dir, 'tasks');
    for (const id of TERMINAL_BENCH_2_1_TASK_IDS) {
      const taskDir = join(tasksRoot, `hash-${id}`, id);
      await mkdir(taskDir, { recursive: true });
      await writeFile(join(taskDir, 'task.toml'), '[agent]\ntimeout_sec = 900\n', 'utf8');
    }
    const outDir = join(dir, 'out');
    const scriptPath = new URL('../../harbor/run-harness-ab.mjs', import.meta.url);
    await assert.rejects(execFileAsync(process.execPath, [scriptPath.pathname], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MAKA_HARNESS_AB_OUT_DIR: outDir,
        MAKA_HARNESS_AB_TASKS_ROOT: tasksRoot,
        MAKA_HARNESS_AB_RUN_ID: 'dry-run',
        MAKA_HARNESS_AB_LIMIT: '30',
        MAKA_HARNESS_AB_DRY_RUN: '1',
        MAKA_HARNESS_AB_KEY_FILE: join(dir, 'must-not-be-read'),
        MAKA_HARNESS_AB_EXPLICIT_SUBJECT_FINGERPRINT: `sha256:${'a'.repeat(64)}`,
        MAKA_HARNESS_AB_TOOLCHAIN_FINGERPRINT: `sha256:${'b'.repeat(64)}`,
      },
    }), /Terminal-Bench 2\.1 task tree fingerprint mismatch/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function waitForJournal(
  path: string,
  predicate: (value: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      if (predicate(value)) return value;
    } catch {
      // The detached worker may not have created the journal yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for detached journal ${path}`);
}

async function waitForFileMatch(path: string, pattern: RegExp): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if (pattern.test(await readFile(path, 'utf8'))) return;
    } catch {
      // The detached worker may not have written its log yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${path} to match ${pattern}`);
}
