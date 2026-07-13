import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { TERMINAL_BENCH_2_1_TASK_IDS } from '../harness-ab-manifest.js';

const execFileAsync = promisify(execFile);

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
        MAKA_HARNESS_AB_LIMIT: '40',
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
