import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { TERMINAL_BENCH_2_1_TASK_IDS } from '../harness-ab-manifest.js';

const execFileAsync = promisify(execFile);

test('harness A/B CLI accepts a 5-task operational canary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-cli-'));
  try {
    const scriptPath = new URL('../../harbor/run-harness-ab.mjs', import.meta.url);
    await assert.rejects(
      execFileAsync(process.execPath, [scriptPath.pathname], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAKA_HARNESS_AB_OUT_DIR: join(dir, 'out'),
          MAKA_HARNESS_AB_TASKS_ROOT: join(dir, 'missing-tasks'),
          MAKA_HARNESS_AB_LIMIT: '5',
          MAKA_HARNESS_AB_DRY_RUN: '1',
        },
      }),
      /Terminal-Bench 2\.1 task set mismatch/,
    );
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

test('harness A/B selects one named task only with an explicit run identity', async () => {
  const {
    buildHarnessAbManifest,
    resolveHarnessAbRunId,
    resolveHarnessAbTaskSelection,
    resolveHarnessCompetitorProfile,
  } = await import(new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href);
  const taskId = 'extract-moves-from-video';
  const selection = resolveHarnessAbTaskSelection(taskId, undefined, undefined);

  assert.deepEqual(selection, { taskIds: [taskId], limit: 1, pairConcurrency: 1 });
  assert.throws(
    () => resolveHarnessAbTaskSelection('not-a-terminal-bench-task', undefined, undefined),
    /MAKA_HARNESS_AB_TASK_ID must name a Terminal-Bench 2\.1 task/,
  );
  assert.throws(
    () => resolveHarnessAbRunId(resolveHarnessCompetitorProfile(), undefined, taskId),
    /MAKA_HARNESS_AB_RUN_ID is required with MAKA_HARNESS_AB_TASK_ID/,
  );

  const manifest = buildHarnessAbManifest({
    subjectFingerprint: 'subject',
    taskSourceFingerprint: 'tasks',
    toolchainFingerprint: 'tools',
    taskIds: selection.taskIds,
    pairConcurrency: selection.pairConcurrency,
  });
  assert.deepEqual(manifest.evaluationTaskIds, [taskId]);
  assert.equal(manifest.metadata.order.pilotTaskCount, 1);
  assert.equal(manifest.maxConcurrency, 1);
  assert.equal(manifest.maxConcurrentAttempts, 2);
});

test('harness A/B records its configured rolling pair concurrency in the manifest', async () => {
  const { buildHarnessAbManifest, resolveHarnessAbTaskSelection } = await import(
    new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href
  );
  const selection = resolveHarnessAbTaskSelection(undefined, '89', '2');
  const manifest = buildHarnessAbManifest({
    subjectFingerprint: 'subject',
    taskSourceFingerprint: 'tasks',
    toolchainFingerprint: 'tools',
    taskIds: selection.taskIds,
    pairConcurrency: selection.pairConcurrency,
  });

  assert.equal(selection.limit, 89);
  assert.equal(manifest.maxConcurrency, 2);
  assert.equal(manifest.maxConcurrentAttempts, 4);
  assert.throws(
    () => resolveHarnessAbTaskSelection(undefined, '89', '5'),
    /MAKA_HARNESS_AB_PAIR_CONCURRENCY must be an integer between 1 and 4/,
  );
});

test('harness Oracle environment selects the linux/amd64 image manifest digest', async () => {
  const { resolvedImageDigestFromInspect } = await import(
    new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href
  );
  const digest = resolvedImageDigestFromInspect(
    JSON.stringify({
      digest: `sha256:${'0'.repeat(64)}`,
      manifests: [
        { digest: `sha256:${'a'.repeat(64)}`, platform: { os: 'linux', architecture: 'arm64' } },
        { digest: `sha256:${'b'.repeat(64)}`, platform: { os: 'linux', architecture: 'amd64' } },
      ],
    }),
    'linux/amd64',
  );

  assert.equal(digest, `sha256:${'b'.repeat(64)}`);
});

test('harness A/B degrades identity resolution failures to missing advisory evidence', async () => {
  const { resolveAdvisoryOracleEvidence } = await import(
    new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href
  );
  const evidence = await resolveAdvisoryOracleEvidence({
    allTasks: [{ id: 'task-a', path: '/tasks/task-a' }],
    executionPolicyFingerprint: `sha256:${'a'.repeat(64)}`,
    registryUrl: 'https://example.invalid/oracle-registry.json',
    expectedSnapshotFingerprint: `sha256:${'b'.repeat(64)}`,
    loadSnapshot: async () => ({ fingerprint: `sha256:${'b'.repeat(64)}` }),
    buildAuditTasks: async () => {
      throw new Error('registry unavailable');
    },
  });

  assert.deepEqual(evidence.annotations, [{ taskId: 'task-a', state: 'missing' }]);
  assert.deepEqual(evidence.warnings, [
    'Oracle registry could not be resolved; A/B continues without it',
  ]);
});

test('harness A/B keeps advisory task states structured instead of duplicating corpus warnings', async () => {
  const { resolveAdvisoryOracleEvidence } = await import(
    new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href
  );
  const evidence = await resolveAdvisoryOracleEvidence({
    allTasks: [
      { id: 'task-a', path: '/tasks/task-a' },
      { id: 'task-b', path: '/tasks/task-b' },
    ],
    executionPolicyFingerprint: `sha256:${'a'.repeat(64)}`,
    registryUrl: undefined,
    expectedSnapshotFingerprint: undefined,
  });

  assert.deepEqual(evidence.annotations, [
    { taskId: 'task-a', state: 'missing' },
    { taskId: 'task-b', state: 'missing' },
  ]);
  assert.deepEqual(evidence.warnings, [
    'Oracle registry URL and fingerprint are not both configured; A/B continues without it',
  ]);
});

test('harness A/B bounds a stalled advisory evidence lookup', async () => {
  const { resolveAdvisoryOracleEvidence } = await import(
    new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href
  );
  const resolution = resolveAdvisoryOracleEvidence({
    allTasks: [{ id: 'task-a', path: '/tasks/task-a' }],
    executionPolicyFingerprint: `sha256:${'a'.repeat(64)}`,
    registryUrl: 'https://example.invalid/oracle-registry.json',
    expectedSnapshotFingerprint: `sha256:${'b'.repeat(64)}`,
    resolutionTimeoutMs: 10,
    loadSnapshot: async () => new Promise(() => {}),
  });

  const evidence = await Promise.race([
    resolution,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('advisory lookup remained pending')), 100),
    ),
  ]);

  assert.deepEqual(evidence.annotations, [{ taskId: 'task-a', state: 'missing' }]);
});

test('harness A/B freezes the stored advisory evidence when resuming a run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-evidence-resume-'));
  try {
    const { buildHarnessAbManifest, resolveHarnessOracleEvidenceForRun } = await import(
      new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href
    );
    const oracleEvidence = {
      annotations: [{ taskId: 'task-a', state: 'missing' }],
      warnings: ['frozen warning'],
    };
    const manifest = buildHarnessAbManifest({
      subjectFingerprint: 'subject',
      taskSourceFingerprint: 'tasks',
      toolchainFingerprint: 'tools',
      oracleEvidence,
    });
    const path = join(dir, 'harness-ab-manifest.json');
    await writeFile(path, `${JSON.stringify(manifest)}\n`, 'utf8');
    let resolved = false;

    const evidence = await resolveHarnessOracleEvidenceForRun(path, async () => {
      resolved = true;
      return { annotations: [], warnings: [] };
    });

    assert.deepEqual(evidence, oracleEvidence);
    assert.equal(resolved, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('harness A/B defaults to pinned Kimi Code and keeps OpenCode selectable', async () => {
  const {
    buildHarnessAbManifest,
    resolveHarnessAbRunId,
    resolveHarnessCompetitorProfile,
    resolveHarnessCompetitorToolchainPath,
  } = await import(new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href);

  const manifest = buildHarnessAbManifest({
    subjectFingerprint: 'subject',
    taskSourceFingerprint: 'tasks',
    toolchainFingerprint: 'tools',
  });

  const competitor = manifest.arms.find((arm: { id: string }) => arm.id === 'kimi-code');
  assert.equal(competitor?.metadata.version, '0.26.0');
  assert.equal(competitor?.metadata.config.profile, 'kimi-code');
  assert.equal(competitor?.metadata.config.permissions, 'prompt-auto');
  assert.equal(resolveHarnessCompetitorProfile('opencode').version, '1.17.18');
  assert.throws(() => resolveHarnessCompetitorProfile('unknown'), /MAKA_HARNESS_AB_COMPETITOR/);
  assert.deepEqual(manifest.metadata.model, {
    provider: 'kimi-coding-plan',
    id: 'k3',
    reasoningEffort: 'max',
  });
  assert.deepEqual(manifest.metadata.pricing, {
    currency: 'USD',
    unit: 'per_1m_tokens',
    input: 0,
    cachedInput: 0,
    output: 0,
    source: 'kimi-coding-plan-account-plan',
  });
  assert.equal(manifest.metadata.order.pilotTaskCount, 5);
  assert.equal(manifest.maxConcurrency, 4);
  assert.equal(manifest.maxConcurrentAttempts, 8);
  const kimiProfile = resolveHarnessCompetitorProfile('kimi-code');
  assert.equal(resolveHarnessAbRunId(kimiProfile), 'k3-maka-vs-kimi-code-tbench-2.1-full-v2');
  assert.match(
    resolveHarnessCompetitorToolchainPath('/run', kimiProfile),
    new RegExp(`kimi-code-0\\.26\\.0-${kimiProfile.toolchainFingerprint.slice(7, 19)}-linux-x64$`),
  );
  for (const arm of manifest.arms) {
    assert.equal(arm.metadata.config.billingMode, 'account-plan');
  }
});

test('harness A/B completion log preserves the report status', async () => {
  const scriptPath = new URL('../../harbor/run-harness-ab.mjs', import.meta.url);
  const source = await readFile(scriptPath, 'utf8');

  assert.match(source, /console\.log\(`\$\{report\.runStatus\}:/);
});

test('detached named-task launcher requires a run id before creating artifacts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-detached-identity-'));
  try {
    const outDir = join(dir, 'out');
    const scriptPath = new URL('../../harbor/run-harness-ab-detached.mjs', import.meta.url);
    await assert.rejects(
      execFileAsync(process.execPath, [scriptPath.pathname], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAKA_HARNESS_AB_OUT_DIR: outDir,
          MAKA_HARNESS_AB_RUN_ID: '',
          MAKA_HARNESS_AB_TASK_ID: 'extract-moves-from-video',
          MAKA_HARNESS_AB_TASKS_ROOT: join(dir, 'missing-tasks'),
          MAKA_HARNESS_AB_DRY_RUN: '1',
        },
      }),
      /MAKA_HARNESS_AB_RUN_ID is required with MAKA_HARNESS_AB_TASK_ID/,
    );
    await assert.rejects(
      readFile(join(outDir, 'k3-maka-vs-kimi-code-tbench-2.1-full-v2', 'background-run.log')),
      { code: 'ENOENT' },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
        MAKA_HARNESS_AB_LIMIT: '5',
        MAKA_HARNESS_AB_DRY_RUN: '1',
      },
    });

    const journalPath = join(outDir, runId, 'background-run.json');
    const journal = await waitForJournal(journalPath, (value) => value.status === 'failed');
    assert.equal(journal.exitCode, 1);
    assert.equal(typeof journal.pid, 'number');
    assert.equal(typeof journal.startedAt, 'string');
    assert.equal(typeof journal.finishedAt, 'string');
    await waitForFileMatch(
      join(outDir, runId, 'background-run.log'),
      /Terminal-Bench 2\.1 task set mismatch/,
    );
    assert.match(
      await readFile(join(outDir, runId, 'background-run.log'), 'utf8'),
      /Terminal-Bench 2\.1 task set mismatch/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detached OpenCode launcher and worker share the competitor default run id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-detached-opencode-'));
  try {
    const outDir = join(dir, 'out');
    const runId = 'k3-maka-vs-opencode-tbench-2.1-full-v1';
    const scriptPath = new URL('../../harbor/run-harness-ab-detached.mjs', import.meta.url);
    await execFileAsync(process.execPath, [scriptPath.pathname], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MAKA_HARNESS_AB_OUT_DIR: outDir,
        MAKA_HARNESS_AB_COMPETITOR: 'opencode',
        MAKA_HARNESS_AB_TASKS_ROOT: join(dir, 'missing-tasks'),
        MAKA_HARNESS_AB_LIMIT: '5',
        MAKA_HARNESS_AB_DRY_RUN: '1',
      },
    });

    const journal = await waitForJournal(
      join(outDir, runId, 'background-run.json'),
      (value) => value.status === 'failed',
    );
    assert.equal(journal.exitCode, 1);
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
    await writeFile(
      join(lockDir, 'owner.json'),
      `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`,
      'utf8',
    );
    const journal = {
      schemaVersion: 1,
      pid: process.pid,
      startedAt: '2026-07-14T00:00:00.000Z',
      logPath: join(runRoot, 'background-run.log'),
      status: 'running',
    };
    await writeFile(
      join(runRoot, 'background-run.json'),
      `${JSON.stringify(journal, null, 2)}\n`,
      'utf8',
    );

    const scriptPath = new URL('../../harbor/run-harness-ab-detached.mjs', import.meta.url);
    await assert.rejects(
      execFileAsync(process.execPath, [scriptPath.pathname], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAKA_HARNESS_AB_OUT_DIR: outDir,
          MAKA_HARNESS_AB_RUN_ID: runId,
          MAKA_HARNESS_AB_TASKS_ROOT: join(dir, 'missing-tasks'),
          MAKA_HARNESS_AB_LIMIT: '5',
          MAKA_HARNESS_AB_DRY_RUN: '1',
        },
      }),
      /before acquiring the run lock/,
    );

    await waitForFileMatch(
      join(runRoot, 'background-run.log'),
      /Terminal-Bench 2\.1 task set mismatch|A\/B run is already active/,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(runRoot, 'background-run.json'), 'utf8')),
      journal,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('harness A/B CLI rejects the superseded 30-task pilot checkpoint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-cli-'));
  try {
    const scriptPath = new URL('../../harbor/run-harness-ab.mjs', import.meta.url);
    await assert.rejects(
      execFileAsync(process.execPath, [scriptPath.pathname], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAKA_HARNESS_AB_OUT_DIR: join(dir, 'out'),
          MAKA_HARNESS_AB_TASKS_ROOT: join(dir, 'missing-tasks'),
          MAKA_HARNESS_AB_LIMIT: '30',
          MAKA_HARNESS_AB_DRY_RUN: '1',
        },
      }),
      /MAKA_HARNESS_AB_LIMIT must be 5 or 89/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('harness A/B CLI accepts the complete 89-task profile limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-cli-'));
  try {
    const scriptPath = new URL('../../harbor/run-harness-ab.mjs', import.meta.url);
    await assert.rejects(
      execFileAsync(process.execPath, [scriptPath.pathname], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAKA_HARNESS_AB_OUT_DIR: join(dir, 'out'),
          MAKA_HARNESS_AB_TASKS_ROOT: join(dir, 'missing-tasks'),
          MAKA_HARNESS_AB_LIMIT: '89',
          MAKA_HARNESS_AB_DRY_RUN: '1',
        },
      }),
      /Terminal-Bench 2\.1 task set mismatch/,
    );
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
    await assert.rejects(
      execFileAsync(process.execPath, [scriptPath.pathname], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAKA_HARNESS_AB_OUT_DIR: outDir,
          MAKA_HARNESS_AB_TASKS_ROOT: tasksRoot,
          MAKA_HARNESS_AB_RUN_ID: 'dry-run',
          MAKA_HARNESS_AB_LIMIT: '5',
          MAKA_HARNESS_AB_DRY_RUN: '1',
          MAKA_HARNESS_AB_KEY_FILE: join(dir, 'must-not-be-read'),
          MAKA_HARNESS_AB_EXPLICIT_SUBJECT_FINGERPRINT: `sha256:${'a'.repeat(64)}`,
          MAKA_HARNESS_AB_TOOLCHAIN_FINGERPRINT: `sha256:${'b'.repeat(64)}`,
        },
      }),
      /Terminal-Bench 2\.1 task tree fingerprint mismatch/,
    );
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
