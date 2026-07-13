import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);

test('harness A/B CLI dry-run freezes all 89 tasks without reading credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-cli-'));
  try {
    const tasksRoot = join(dir, 'tasks');
    for (let index = 1; index <= 89; index += 1) {
      const id = `task-${String(index).padStart(2, '0')}`;
      const taskDir = join(tasksRoot, `hash-${id}`, id);
      await mkdir(taskDir, { recursive: true });
      await writeFile(join(taskDir, 'task.toml'), '[agent]\ntimeout_sec = 900\n', 'utf8');
    }
    const outDir = join(dir, 'out');
    const scriptPath = new URL('../../harbor/run-harness-ab.mjs', import.meta.url);
    const { stdout } = await execFileAsync(process.execPath, [scriptPath.pathname], {
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
    });

    assert.match(stdout, /dry-run: 40\/89 paired Pass@1 cells planned/);
    const manifest = JSON.parse(await readFile(join(outDir, 'dry-run', 'harness-ab-manifest.json'), 'utf8'));
    assert.equal(manifest.experimentKind, 'harness');
    assert.equal(manifest.evaluationTaskIds.length, 89);
    assert.deepEqual(manifest.pilotTaskIds, manifest.evaluationTaskIds.slice(0, 40));
    assert.equal(manifest.metadata.benchmark.version, '2.1');
    assert.equal(manifest.metadata.benchmark.timeoutPolicy, 'task-native');
    assert.equal(manifest.metadata.model.reasoningEffort, 'max');
    assert.equal(manifest.metadata.metric, 'pass@1');
    assert.equal(manifest.arms[1].metadata.version, '1.17.18');
    await assert.rejects(readFile(join(outDir, 'dry-run', 'controller', 'results.jsonl')), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
