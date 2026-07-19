import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);

test('runtime policy A/B CLI dry-run builds one executable Flash manifest without reading a key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-runtime-ab-cli-'));
  try {
    const tasksRoot = join(dir, 'tasks');
    for (const id of ['pilot-task', 'full-task']) {
      const taskDir = join(tasksRoot, `hash-${id}`, id);
      await mkdir(taskDir, { recursive: true });
      await writeFile(join(taskDir, 'task.toml'), '[metadata]\ndifficulty = "medium"\n', 'utf8');
    }
    const specPath = join(dir, 'spec.json');
    await writeFile(
      specPath,
      JSON.stringify({
        schemaVersion: 1,
        id: 'stale-prune',
        arms: [
          { id: 'prune-off', contextEnv: { MAKA_CONTEXT_BUDGET: 'off' } },
          { id: 'prune-on', contextEnv: { MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on' } },
        ],
        sharedAgentEnv: {},
        pilotTaskIds: ['pilot-task'],
        evaluationTaskIds: ['full-task'],
        fullReps: 2,
        nonInferiorityMargin: 0.1,
      }),
      'utf8',
    );
    const profilePath = new URL(
      '../../harbor/runtime-policy-ab-profiles/deepseek-v4-flash.json',
      import.meta.url,
    );
    const scriptPath = new URL('../../harbor/run-runtime-policy-ab.mjs', import.meta.url);
    const outDir = join(dir, 'out');
    const { stdout } = await execFileAsync(process.execPath, [scriptPath.pathname], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MAKA_RUNTIME_AB_OUT_DIR: outDir,
        MAKA_RUNTIME_AB_TASKS_ROOT: tasksRoot,
        MAKA_RUNTIME_AB_SPEC_PATH: specPath,
        MAKA_RUNTIME_AB_PROFILE_PATH: profilePath.pathname,
        MAKA_RUNTIME_AB_RUN_ID: 'dry-run',
        MAKA_RUNTIME_AB_DRY_RUN: '1',
        MAKA_RUNTIME_AB_EXPLICIT_SUBJECT_FINGERPRINT: `sha256:${'a'.repeat(64)}`,
        MAKA_RUNTIME_AB_TOOLCHAIN_FINGERPRINT: `sha256:${'b'.repeat(64)}`,
      },
    });

    assert.match(stdout, /dry-run: executable manifest validated/);
    const manifest = JSON.parse(
      await readFile(join(outDir, 'dry-run', 'runtime-policy-ab-manifest.json'), 'utf8'),
    );
    assert.equal(manifest.arms[0].metadata.executionProfile.model, 'deepseek/deepseek-v4-flash');
    assert.equal(manifest.maxConcurrentAttempts, 2);
    assert.deepEqual(manifest.pilotTaskIds, ['pilot-task']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
