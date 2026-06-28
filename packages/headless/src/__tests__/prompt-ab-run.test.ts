import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  buildAbRunManifest,
  runAbComparison,
  buildPromptAbRunManifest,
  ensurePromptAbRunManifest,
  limitPromptAbCandidateTasks,
  renderPromptAbComparisonMarkdown,
  runPromptAbComparison,
  summarizePromptAbComparison,
} from '../prompt-ab-run.js';
import type { Config } from '../contracts.js';
import {
  FIXED_PROMPT_WAL_SCHEMA_VERSION,
  hashSystemPrompt,
  type FixedPromptTask,
  type FixedPromptTaskBudgetExhaustedEvent,
  type FixedPromptTaskCompletedEvent,
  type HarborTaskRunOutput,
} from '../fixed-prompt-controller.js';
import type { PromptAbRunManifestInput } from '../prompt-ab-types.js';
import { tokenSummary } from './helpers/cell-output-fixtures.js';

const config: Config = {
  id: 'cfg-ab',
  backend: 'fake',
  llmConnectionSlug: 'fake',
  model: 'fake-model',
};

describe('filterPromptAbCandidateTasksByMetadata', () => {
  test('keeps only tasks whose expert estimate fits the short-horizon slice', async () => {
    const { filterPromptAbCandidateTasksByMetadata } = await import('../prompt-ab-run.js');
    const result = filterPromptAbCandidateTasksByMetadata({
      tasks: [
        { id: 'short', path: '/tasks/short', metadata: { expertTimeEstimateMin: 20 } },
        { id: 'long', path: '/tasks/long', metadata: { expertTimeEstimateMin: 60 } },
        { id: 'unknown', path: '/tasks/unknown' },
      ],
      maxExpertTimeEstimateMin: 30,
    });

    assert.deepEqual(result.selectedTaskIds, ['short']);
    assert.deepEqual(result.rejected.longExpertEstimateTaskIds, ['long']);
    assert.deepEqual(result.rejected.missingExpertEstimateTaskIds, ['unknown']);
  });
});

describe('limitPromptAbCandidateTasks', () => {
  test('keeps every metadata-filtered task unless a limit is explicit', () => {
    const tasks: FixedPromptTask[] = Array.from({ length: 61 }, (_, index) => ({
      id: `task-${index}`,
      path: `/tasks/task-${index}`,
    }));

    const unlimited = limitPromptAbCandidateTasks(tasks, undefined);
    assert.equal(unlimited.limit, null);
    assert.equal(unlimited.inputTaskCount, 61);
    assert.equal(unlimited.selectedTasks.length, 61);
    assert.deepEqual(unlimited.truncatedTaskIds, []);

    const limited = limitPromptAbCandidateTasks(tasks, 60);
    assert.equal(limited.limit, 60);
    assert.equal(limited.selectedTasks.length, 60);
    assert.deepEqual(limited.truncatedTaskIds, ['task-60']);
  });
});

describe('prompt A/B run manifest', () => {
  test('records generic A/B arm identities for non-prompt experiments', () => {
    const manifest = buildAbRunManifest({
      experimentKind: 'tools',
      arms: [
        {
          id: 'tools-off',
          kind: 'tools',
          fingerprint: sha256('tools-off'),
          metadata: { toolProfile: 'standard' },
        },
        {
          id: 'tools-on',
          kind: 'tools',
          fingerprint: sha256('tools-on'),
          metadata: { toolProfile: 'standard-plus-new-tool' },
        },
      ],
      taskBudgetSec: 30 * 60,
      harborTimeoutMs: 35 * 60 * 1000,
      subjectFingerprint: 'subject:path=/repo;maka-head=abc123;dirty=false',
      taskSourceFingerprint: 'tasks:path=/cache/tasks;selected=task-a:/cache/tasks/a',
      toolchainFingerprint: sha256('c'),
      evaluationTaskIds: ['task-a'],
      reps: 3,
      candidateLimit: null,
      maxConcurrency: 16,
    });

    assert.equal(manifest.experimentKind, 'tools');
    assert.deepEqual(manifest.arms.map((arm) => `${arm.kind}:${arm.id}`), [
      'tools:tools-off',
      'tools:tools-on',
    ]);
    assert.match(manifest.fingerprint, /^sha256:[a-f0-9]{64}$/);
  });

  test('rejects a reused run id when resume-critical config changes', async () => {
    await withDir(async (dir) => {
      const manifestPath = join(dir, 'prompt-ab-manifest.json');
      const original = buildPromptAbRunManifest({
        baselinePromptHash: 'sha256:baseline',
        candidatePromptHash: 'sha256:candidate',
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek/deepseek-v4-flash',
        taskBudgetSec: 30 * 60,
        harborTimeoutMs: 35 * 60 * 1000,
        subjectFingerprint: 'subject:path=/repo;maka-head=abc123;dirty=false',
        taskSourceFingerprint: 'tasks:path=/cache/tasks;selected=task-a:/cache/tasks/a,task-b:/cache/tasks/b',
        toolchainFingerprint: sha256('c'),
        evaluationTaskIds: ['task-a', 'task-b'],
        reps: 3,
        candidateLimit: null,
        maxConcurrency: 16,
      });
      await ensurePromptAbRunManifest(manifestPath, original);
      assert.equal((await ensurePromptAbRunManifest(manifestPath, original)).fingerprint, original.fingerprint);

      await assert.rejects(
        ensurePromptAbRunManifest(manifestPath, buildPromptAbRunManifest({
          ...original,
          taskBudgetSec: 60 * 60,
        })),
        /prompt A\/B run manifest does not match existing run id/,
      );
      await assert.rejects(
        ensurePromptAbRunManifest(manifestPath, buildPromptAbRunManifest({
          ...original,
          subjectFingerprint: 'subject:path=/repo;maka-head=def456;dirty=false',
        })),
        /prompt A\/B run manifest does not match existing run id/,
      );
      await assert.rejects(
        ensurePromptAbRunManifest(manifestPath, buildPromptAbRunManifest({
          ...original,
          taskSourceFingerprint: 'tasks:path=/other-cache/tasks;selected=task-a:/other-cache/tasks/a,task-b:/other-cache/tasks/b',
        })),
        /prompt A\/B run manifest does not match existing run id/,
      );
      await assert.rejects(
        ensurePromptAbRunManifest(manifestPath, buildPromptAbRunManifest({
          ...original,
          provider: 'openai',
          baseUrl: 'https://api.openai.com',
        })),
        /prompt A\/B run manifest does not match existing run id/,
      );
      await assert.rejects(
        ensurePromptAbRunManifest(manifestPath, buildPromptAbRunManifest({
          ...original,
          evaluationTaskIds: ['task-a', 'task-c'],
        })),
        /prompt A\/B run manifest does not match existing run id/,
      );
      await assert.rejects(
        ensurePromptAbRunManifest(manifestPath, buildPromptAbRunManifest({
          ...original,
          toolchainFingerprint: sha256('d'),
        })),
        /prompt A\/B run manifest does not match existing run id/,
      );
    });
  });

  test('resumes a prompt manifest written before the generic A/B core split', async () => {
    await withDir(async (dir) => {
      const manifestPath = join(dir, 'prompt-ab-manifest.json');
      const input = promptManifestInput();
      const legacyManifest = buildLegacyPromptAbRunManifest(input);
      await writeFile(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`, 'utf8');

      const current = buildPromptAbRunManifest(input);
      const resumed = await ensurePromptAbRunManifest(manifestPath, current);

      assert.equal(resumed.fingerprint, legacyManifest.fingerprint);
      assert.equal(resumed.experimentKind, 'prompt');
      assert.deepEqual(resumed.arms, current.arms);
      await assert.rejects(
        ensurePromptAbRunManifest(manifestPath, buildPromptAbRunManifest({
          ...input,
          taskBudgetSec: input.taskBudgetSec + 1,
        })),
        /prompt A\/B run manifest does not match existing run id/,
      );
      await assert.rejects(
        ensurePromptAbRunManifest(manifestPath, buildPromptAbRunManifest({
          ...input,
          subjectFingerprint: 'subject:path=/repo;maka-head=def456;dirty=false',
        })),
        /prompt A\/B run manifest does not match existing run id/,
      );
      await assert.rejects(
        ensurePromptAbRunManifest(manifestPath, buildPromptAbRunManifest({
          ...input,
          taskSourceFingerprint: 'tasks:path=/other-cache/tasks;selected=task-a:/other-cache/tasks/a,task-b:/other-cache/tasks/b',
        })),
        /prompt A\/B run manifest does not match existing run id/,
      );
    });
  });
});

describe('runAbComparison', () => {
  test('rejects arm ids that collapse to the same round id suffix', async () => {
    await assert.rejects(
      runAbComparison({
        runId: 'ab-run',
        arms: [
          { id: 'tools.off', kind: 'tools', fingerprint: sha256('tools-off') },
          { id: 'tools/off', kind: 'tools', fingerprint: sha256('tools-on') },
        ],
        evaluationTasks: [
          { id: 't1', path: '/tasks/t1' },
        ],
        reps: 1,
        runArm: async ({ task }) => completed(task.id, true),
      }),
      /A\/B arm ids must produce unique round id suffixes/,
    );
  });

  test('runs generic arms adjacent for each task-rep pair', async () => {
    const calls: string[] = [];
    const result = await runAbComparison({
      runId: 'ab-run',
      arms: [
        { id: 'tools-off', kind: 'tools', fingerprint: sha256('tools-off') },
        { id: 'tools-on', kind: 'tools', fingerprint: sha256('tools-on') },
      ],
      evaluationTasks: [
        { id: 't1', path: '/tasks/t1' },
        { id: 't2', path: '/tasks/t2' },
      ],
      reps: 2,
      maxConcurrency: 1,
      runArm: async ({ roundId, task, arm }) => {
        calls.push(`${roundId}:${arm.id}:${task.id}`);
        return arm.id === 'tools-on'
          ? completed(task.id, true)
          : completed(task.id, false);
      },
    });

    assert.equal(result.baselineArmId, 'tools-off');
    assert.equal(result.candidateArmId, 'tools-on');
    assert.equal(result.taskLevel.wins, 2);
    assert.deepEqual(calls, [
      'ab-tools-off-r0-t1:tools-off:t1',
      'ab-tools-on-r0-t1:tools-on:t1',
      'ab-tools-on-r0-t2:tools-on:t2',
      'ab-tools-off-r0-t2:tools-off:t2',
      'ab-tools-on-r1-t1:tools-on:t1',
      'ab-tools-off-r1-t1:tools-off:t1',
      'ab-tools-off-r1-t2:tools-off:t2',
      'ab-tools-on-r1-t2:tools-on:t2',
    ]);
  });

  test('starts both arms for the same task-rep pair before waiting for either arm to finish', async () => {
    const calls: string[] = [];
    const waiters: Array<() => void> = [];
    let released = false;
    const releaseAll = () => {
      released = true;
      for (const resolve of waiters.splice(0)) resolve();
    };

    const runPromise = runAbComparison({
      runId: 'ab-run',
      arms: [
        { id: 'tools-off', kind: 'tools', fingerprint: sha256('tools-off') },
        { id: 'tools-on', kind: 'tools', fingerprint: sha256('tools-on') },
      ],
      evaluationTasks: [{ id: 't1', path: '/tasks/t1' }],
      reps: 1,
      maxConcurrency: 1,
      runArm: async ({ roundId, task }) => {
        calls.push(roundId);
        if (!released) {
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
        return completed(task.id, true);
      },
    });

    while (calls.length === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    const callsStartedBeforeFirstFinish = calls.length;
    releaseAll();
    await runPromise;

    assert.equal(callsStartedBeforeFirstFinish, 2);
    assert.deepEqual(calls, [
      'ab-tools-off-r0-t1',
      'ab-tools-on-r0-t1',
    ]);
  });
});

describe('prompt A/B source fingerprints', () => {
  test('rejects dirty subject repos unless an explicit subject fingerprint is provided', async () => {
    const { buildSubjectFingerprint } = await import(promptAbScriptUrl);
    const gitWithStatus = (status: string) => async (_repoPath: string, args: readonly string[]): Promise<string> => {
      const command = args.join(' ');
      if (command === 'rev-parse --show-toplevel') return '/repo';
      if (command === 'rev-parse HEAD') return 'abc123';
      if (command === 'status --porcelain=v1 --untracked-files=normal') return status;
      throw new Error(`unexpected git command: ${command}`);
    };
    const trackedDirtyGit = gitWithStatus(' M src/runtime.ts');
    const untrackedDirtyGit = gitWithStatus('?? scratch.txt');

    await assert.rejects(
      buildSubjectFingerprint('/repo', undefined, trackedDirtyGit),
      /must be clean/,
    );
    await assert.rejects(
      buildSubjectFingerprint('/repo', undefined, untrackedDirtyGit),
      /must be clean/,
    );
    await assert.rejects(
      buildSubjectFingerprint('/repo', 'dirty-subject-snapshot-1', untrackedDirtyGit),
      /EXPLICIT_SUBJECT_FINGERPRINT must be a sha256/,
    );
    await assert.doesNotReject(
      buildSubjectFingerprint('/repo', sha256('a'), untrackedDirtyGit),
    );
  });

  test('builds a toolchain fingerprint from Node and Harbor identity unless explicit', async () => {
    const { buildToolchainFingerprint } = await import(promptAbScriptUrl);

    await withDir(async (dir) => {
      await writeFile(join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n', 'utf8');
      await mkdir(join(dir, 'node_modules'), { recursive: true });
      await writeFile(join(dir, 'node_modules/.package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/ai":{"version":"6.0.185"}}}\n', 'utf8');

      const first = await buildToolchainFingerprint(undefined, async () => 'harbor 1.0.0', dir);
      const second = await buildToolchainFingerprint(undefined, async () => 'harbor 2.0.0', dir);
      assert.notEqual(first, second);

      await writeFile(join(dir, 'node_modules/.package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/ai":{"version":"6.0.186"}}}\n', 'utf8');
      const dependencyChanged = await buildToolchainFingerprint(undefined, async () => 'harbor 1.0.0', dir);
      assert.notEqual(first, dependencyChanged);
    });

    await assert.rejects(
      buildToolchainFingerprint('toolchain-v1', async () => 'harbor 1.0.0'),
      /TOOLCHAIN_FINGERPRINT must be a sha256/,
    );
    assert.equal(await buildToolchainFingerprint(sha256('b'), async () => 'harbor 1.0.0'), sha256('b'));
  });

  test('requires an installed dependency lock unless the toolchain fingerprint is explicit', async () => {
    const { buildToolchainFingerprint } = await import(promptAbScriptUrl);
    await withDir(async (dir) => {
      await writeFile(join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n', 'utf8');

      await assert.rejects(
        buildToolchainFingerprint(undefined, async () => 'harbor 1.0.0', dir),
        /node_modules\/\.package-lock\.json/,
      );
      assert.equal(await buildToolchainFingerprint(sha256('b'), async () => 'harbor 1.0.0', dir), sha256('b'));
    });
  });

  test('includes runtime dist artifacts in the subject fingerprint', async () => {
    const { buildSubjectFingerprint } = await import(promptAbScriptUrl);
    await withDir(async (dir) => {
      const repo = join(dir, 'repo');
      const distFile = join(repo, 'packages/headless/dist/harbor-cell.js');
      await mkdir(join(repo, 'packages/headless/dist'), { recursive: true });
      await writeFile(distFile, 'export const version = 1;\n', 'utf8');
      const git = async (_repoPath: string, args: readonly string[]): Promise<string> => {
        const command = args.join(' ');
        if (command === 'rev-parse --show-toplevel') return repo;
        if (command === 'rev-parse HEAD') return 'abc123';
        if (command === 'status --porcelain=v1 --untracked-files=normal') return '';
        throw new Error(`unexpected git command: ${command}`);
      };

      const first = await buildSubjectFingerprint(repo, undefined, git);
      await writeFile(distFile, 'export const version = 2;\n', 'utf8');
      const second = await buildSubjectFingerprint(repo, undefined, git);

      assert.notEqual(first, second);
    });
  });

  test('hashes non-task.toml files inside selected task directories', async () => {
    const { buildTaskSourceFingerprint } = await import(promptAbScriptUrl);
    await withDir(async (dir) => {
      const tasksRoot = join(dir, 'tasks');
      const taskPath = join(tasksRoot, 'task-a');
      await mkdir(taskPath, { recursive: true });
      await writeFile(join(taskPath, 'task.toml'), 'id = "task-a"\n', 'utf8');
      await writeFile(join(taskPath, 'Dockerfile'), 'FROM ubuntu:24.04\n', 'utf8');

      const first = await buildTaskSourceFingerprint(tasksRoot, [{ id: 'task-a', path: taskPath }]);
      await writeFile(join(taskPath, 'Dockerfile'), 'FROM ubuntu:26.04\n', 'utf8');
      const second = await buildTaskSourceFingerprint(tasksRoot, [{ id: 'task-a', path: taskPath }]);

      assert.notEqual(first, second);
    });
  });

  test('rejects symlinks inside selected task directories', async () => {
    const { buildTaskSourceFingerprint } = await import(promptAbScriptUrl);
    await withDir(async (dir) => {
      const tasksRoot = join(dir, 'tasks');
      const taskPath = join(tasksRoot, 'task-a');
      const externalFile = join(dir, 'external-fixture.txt');
      await mkdir(taskPath, { recursive: true });
      await writeFile(join(taskPath, 'task.toml'), 'id = "task-a"\n', 'utf8');
      await writeFile(externalFile, 'fixture v1\n', 'utf8');
      await symlink(externalFile, join(taskPath, 'fixture.txt'));

      await assert.rejects(
        buildTaskSourceFingerprint(tasksRoot, [{ id: 'task-a', path: taskPath }]),
        /task source symlink is not supported/,
      );
    });
  });
});

const promptAbScriptUrl = new URL('../../harbor/run-prompt-ab.mjs', import.meta.url).href;

function promptManifestInput(): PromptAbRunManifestInput {
  return {
    baselinePromptHash: 'sha256:baseline',
    candidatePromptHash: 'sha256:candidate',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek/deepseek-v4-flash',
    taskBudgetSec: 30 * 60,
    harborTimeoutMs: 35 * 60 * 1000,
    subjectFingerprint: 'subject:path=/repo;maka-head=abc123;dirty=false',
    taskSourceFingerprint: 'tasks:path=/cache/tasks;selected=task-a:/cache/tasks/a,task-b:/cache/tasks/b',
    toolchainFingerprint: sha256('c'),
    evaluationTaskIds: ['task-a', 'task-b'],
    reps: 3,
    candidateLimit: null,
    maxConcurrency: 16,
  };
}

type LegacyPromptAbRunManifest = PromptAbRunManifestInput & {
  schemaVersion: 'maka.prompt_ab.run_manifest.v1';
  fingerprint: string;
  evaluationTaskIds: string[];
  candidateTaskIds?: string[];
};

function buildLegacyPromptAbRunManifest(input: PromptAbRunManifestInput): LegacyPromptAbRunManifest {
  const manifestWithoutFingerprint = withoutUndefined({
    schemaVersion: 'maka.prompt_ab.run_manifest.v1' as const,
    baselinePromptHash: input.baselinePromptHash,
    candidatePromptHash: input.candidatePromptHash,
    provider: input.provider,
    baseUrl: input.baseUrl,
    model: input.model,
    taskBudgetSec: input.taskBudgetSec,
    harborTimeoutMs: input.harborTimeoutMs,
    subjectFingerprint: input.subjectFingerprint,
    taskSourceFingerprint: input.taskSourceFingerprint,
    toolchainFingerprint: input.toolchainFingerprint,
    evaluationTaskIds: [...input.evaluationTaskIds],
    reps: input.reps,
    candidateLimit: input.candidateLimit,
    maxConcurrency: input.maxConcurrency,
    selectionMode: input.selectionMode,
    candidateTaskIds: input.candidateTaskIds ? [...input.candidateTaskIds] : undefined,
    maxExpertTimeEstimateMin: input.maxExpertTimeEstimateMin,
    targetEvaluationTaskCount: input.targetEvaluationTaskCount,
  });
  return {
    ...manifestWithoutFingerprint,
    fingerprint: `sha256:${createHash('sha256').update(canonicalJson(manifestWithoutFingerprint)).digest('hex')}`,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as T;
}

describe('summarizePromptAbComparison', () => {
  test('summarizes fixed A/B as task-level deltas without RSI acceptance semantics', () => {
    const result = summarizePromptAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselinePromptId: 'maka-baseline',
      candidatePromptId: 'candidate',
      evaluationTaskIds: ['t1', 't2'],
      baselineRuns: [
        [completed('t1', false), completed('t2', false)],
        [completed('t1', false), completed('t2', true)],
      ],
      candidateRuns: [
        [completed('t1', true), completed('t2', true)],
        [completed('t1', true), completed('t2', true)],
      ],
      budgetMs: 600_000,
    });

    assert.equal(result.decision, 'non_inferior');
    assert.equal(result.reason, 'non_inferiority_lower_bound_within_margin');
    assert.equal(result.taskCount, 2);
    assert.equal(result.reps, 2);
    assert.equal(result.baseline.passRate, 0.25);
    assert.equal(result.candidate.passRate, 1);
    assert.equal(result.taskLevel.wins, 2);
    assert.equal(result.taskLevel.losses, 0);
    assert.equal(result.taskLevel.ties, 0);
    assert.deepEqual(result.taskLevel.missingTaskIds, []);
    assert.equal(result.taskLevel.meanPassRateDelta, 0.75);
    assert.equal(result.baseline.budgetExhausted, 0);
    assert.equal(result.candidate.budgetExhausted, 0);

    const markdown = renderPromptAbComparisonMarkdown(result);
    assert.match(markdown, /Decision: B non-inferior \(non_inferiority_lower_bound_within_margin\)/);
    assert.match(markdown, /Budget: 600s task budget/);
    assert.match(markdown, /Evaluation pass rate: A=1\/4 = 0.25, B=4\/4 = 1/);
    assert.match(markdown, /Task-level delta: mean=0.75/);
    assert.doesNotMatch(markdown, /held-in|held-out|keep|discard|acceptance/i);
  });

  test('counts task budget exhaustion separately from infra while treating it as a budgeted non-pass', () => {
    const result = summarizePromptAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselinePromptId: 'maka-baseline',
      candidatePromptId: 'candidate',
      evaluationTaskIds: ['long-task'],
      baselineRuns: [[completed('long-task', true)]],
      candidateRuns: [[budgetExhausted('long-task')]],
      budgetMs: 600_000,
    });

    assert.equal(result.decision, 'inferior');
    assert.equal(result.reason, 'pass_rate_delta_below_non_inferiority_margin');
    assert.equal(result.candidate.passRate, 0);
    assert.equal(result.candidate.budgetExhausted, 1);
    assert.equal(result.candidate.infraFailed, 0);
    assert.equal(result.taskLevel.losses, 1);
    assert.match(renderPromptAbComparisonMarkdown(result), /Budget outcomes: A timed_out=0, B timed_out=1/);
  });

  test('summarizes context budget activation in the A/B report', () => {
    const baselineInactive = contextBudgetSummary({ prunedToolResults: 0 });
    const candidateActive = contextBudgetSummary({
      prunedToolResults: 2,
      activePrunedToolResults: 3,
      activeEstimatedTokensSaved: 450,
      activeArchiveFailures: 1,
      archivePlaceholders: 2,
      archivePlaceholderReasonCounts: { active_prune: 2 },
      retrievedArchiveToolResults: 1,
      retrievedArchiveEstimatedTokens: 120,
      archiveRetrievalSkipped: 3,
      archiveRetrievalSkippedReasonCounts: { max_bytes: 2, max_results: 1 },
      archiveRetrievalFailures: 1,
      archiveRetrievalFailureReasonCounts: { not_found: 1 },
    });
    const candidateInactive = contextBudgetSummary({ prunedToolResults: 0 });
    const result = summarizePromptAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselinePromptId: 'prune-off',
      candidatePromptId: 'prune-on',
      evaluationTaskIds: ['t1', 't2'],
      baselineRuns: [[
        { ...completed('t1', true), contextBudgetPolicy: { enabled: false }, contextBudgetSummary: baselineInactive },
        { ...completed('t2', true), contextBudgetPolicy: { enabled: false }, contextBudgetSummary: baselineInactive },
      ]],
      candidateRuns: [[
        {
          ...completed('t1', true),
          contextBudgetPolicy: {
            enabled: true,
            name: 'harbor-cell-context-budget',
            staleToolResultPrune: { enabled: true, maxResultEstimatedTokens: 2048, minRecentTurnsFull: 2 },
            minRecentTurns: 2,
          },
          contextBudgetSummary: candidateActive,
        },
        {
          ...completed('t2', true),
          contextBudgetPolicy: {
            enabled: true,
            name: 'harbor-cell-context-budget',
            staleToolResultPrune: { enabled: true, maxResultEstimatedTokens: 2048, minRecentTurnsFull: 2 },
            minRecentTurns: 2,
          },
          contextBudgetSummary: candidateInactive,
        },
      ]],
    });

    assert.equal(result.baseline.contextBudgetPolicy?.enabledAttempts, 0);
    assert.equal(result.candidate.contextBudgetPolicy?.enabledAttempts, 2);
    assert.deepEqual(result.candidate.contextBudget, {
      diagnosticAttempts: 2,
      activatedAttempts: 1,
      activatedAttemptIds: ['event-t1-pass'],
      diagnosticEvents: 2,
      prunedToolResults: 2,
      activePrunedToolResults: 3,
      activeEstimatedTokensSaved: 450,
      activeArchiveFailures: 1,
      archivePlaceholders: 2,
      archivePlaceholderReasonCounts: { active_prune: 2 },
      archiveWriteFailures: 0,
      retrievedArchiveToolResults: 1,
      retrievedArchiveEstimatedTokens: 120,
      archiveRetrievalSkipped: 3,
      archiveRetrievalSkippedReasonCounts: { max_bytes: 2, max_results: 1 },
      archiveRetrievalFailures: 1,
      archiveRetrievalFailureReasonCounts: { not_found: 1 },
    });
    assert.deepEqual(result.candidate.activePruneSubset, {
      taskCount: 1,
      attempts: 1,
      observed: 1,
      valid: 1,
      passed: 1,
      passRate: 1,
      completed: 1,
      budgetExhausted: 0,
      infraFailed: 0,
      plumbingFailed: 0,
      missing: 0,
      coverageRate: 1,
      totalCostUsd: 0.01,
      meanDurationMs: 100,
      tokenCostSummary: {
        input: 1,
        cachedInput: 0,
        cacheHitInput: 0,
        cacheMissInput: 1,
        cacheWriteInput: 0,
        output: 1,
        reasoning: 0,
        total: 2,
        costUsd: 0.01,
        meanDurationMs: 100,
      },
      contextBudget: {
        diagnosticAttempts: 1,
        activatedAttempts: 1,
        activatedAttemptIds: ['event-t1-pass'],
        diagnosticEvents: 1,
        prunedToolResults: 2,
        activePrunedToolResults: 3,
        activeEstimatedTokensSaved: 450,
        activeArchiveFailures: 1,
        archivePlaceholders: 2,
        archivePlaceholderReasonCounts: { active_prune: 2 },
        archiveWriteFailures: 0,
        retrievedArchiveToolResults: 1,
        retrievedArchiveEstimatedTokens: 120,
        archiveRetrievalSkipped: 3,
        archiveRetrievalSkippedReasonCounts: { max_bytes: 2, max_results: 1 },
        archiveRetrievalFailures: 1,
        archiveRetrievalFailureReasonCounts: { not_found: 1 },
      },
    });
    assert.deepEqual(result.baseline.activePruneSubset, {
      taskCount: 1,
      attempts: 1,
      observed: 1,
      valid: 1,
      passed: 1,
      passRate: 1,
      completed: 1,
      budgetExhausted: 0,
      infraFailed: 0,
      plumbingFailed: 0,
      missing: 0,
      coverageRate: 1,
      totalCostUsd: 0.01,
      meanDurationMs: 100,
      tokenCostSummary: {
        input: 1,
        cachedInput: 0,
        cacheHitInput: 0,
        cacheMissInput: 1,
        cacheWriteInput: 0,
        output: 1,
        reasoning: 0,
        total: 2,
        costUsd: 0.01,
        meanDurationMs: 100,
      },
      contextBudget: {
        diagnosticAttempts: 1,
        activatedAttempts: 0,
        activatedAttemptIds: [],
        diagnosticEvents: 1,
        prunedToolResults: 0,
        activePrunedToolResults: 0,
        activeEstimatedTokensSaved: 0,
        activeArchiveFailures: 0,
        archivePlaceholders: 0,
        archivePlaceholderReasonCounts: {},
        archiveWriteFailures: 0,
        retrievedArchiveToolResults: 0,
        retrievedArchiveEstimatedTokens: 0,
        archiveRetrievalSkipped: 0,
        archiveRetrievalSkippedReasonCounts: {},
        archiveRetrievalFailures: 0,
        archiveRetrievalFailureReasonCounts: {},
      },
    });
    assert.match(
      renderPromptAbComparisonMarkdown(result),
      /Context budget: A activated=0\/2 stale_pruned=0 active_pruned=0 active_tokens_saved=0 active_archive_failures=0 archive_placeholders=0 archive_placeholder_reasons=\{\} archive_write_failures=0 retrieved=0 retrieved_tokens=0 retrieval_skipped=0 retrieval_skipped_reasons=\{\} retrieval_failures=0 retrieval_failure_reasons=\{\}, B activated=1\/2 stale_pruned=2 active_pruned=3 active_tokens_saved=450 active_archive_failures=1 archive_placeholders=2 archive_placeholder_reasons=\{"active_prune":2\} archive_write_failures=0 retrieved=1 retrieved_tokens=120 retrieval_skipped=3 retrieval_skipped_reasons=\{"max_bytes":2,"max_results":1\} retrieval_failures=1 retrieval_failure_reasons=\{"not_found":1\}/,
    );
    assert.match(
      renderPromptAbComparisonMarkdown(result),
      /Active prune subset: A tasks=1 attempts=1 observed=1 missing=0 coverage=1 pass_rate=1 passed=1\/1 completed=1 timed_out=0 infra_failed=0 plumbing_failed=0 input=1 cache_hit=0 cache_miss=1 cache_write=0 output=1 total=2 cost_usd=0\.01 mean_duration_ms=100 activated=0\/1 stale_pruned=0 active_pruned=0 active_tokens_saved=0 active_archive_failures=0 archive_placeholders=0 archive_placeholder_reasons=\{\} archive_write_failures=0 retrieved=0 retrieved_tokens=0 retrieval_skipped=0 retrieval_skipped_reasons=\{\} retrieval_failures=0 retrieval_failure_reasons=\{\}, B tasks=1 attempts=1 observed=1 missing=0 coverage=1 pass_rate=1 passed=1\/1 completed=1 timed_out=0 infra_failed=0 plumbing_failed=0 input=1 cache_hit=0 cache_miss=1 cache_write=0 output=1 total=2 cost_usd=0\.01 mean_duration_ms=100 activated=1\/1 stale_pruned=2 active_pruned=3 active_tokens_saved=450 active_archive_failures=1 archive_placeholders=2 archive_placeholder_reasons=\{"active_prune":2\} archive_write_failures=0 retrieved=1 retrieved_tokens=120 retrieval_skipped=3 retrieval_skipped_reasons=\{"max_bytes":2,"max_results":1\} retrieval_failures=1 retrieval_failure_reasons=\{"not_found":1\}/,
    );
    assert.match(
      renderPromptAbComparisonMarkdown(result),
      /Context budget policy: A enabled=0\/2 snapshots=\[{"enabled":false}\], B enabled=2\/2 snapshots=/,
    );
  });

  test('renders active prune subset pair coverage and full token cost', () => {
    const result = summarizePromptAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselinePromptId: 'prune-off',
      candidatePromptId: 'prune-on',
      evaluationTaskIds: ['t1'],
      baselineRuns: [[]],
      candidateRuns: [[
        {
          ...withUsage(completed('t1', true), {
            input: 10,
            cacheHitInput: 3,
            cacheMissInput: 4,
            cacheWriteInput: 2,
            output: 5,
            reasoning: 1,
            total: 16,
            costUsd: 0.02,
            durationMs: 250,
          }),
          contextBudgetSummary: contextBudgetSummary({ activePrunedToolResults: 1 }),
        },
      ]],
    });

    assert.match(
      renderPromptAbComparisonMarkdown(result),
      /Active prune subset: A tasks=1 attempts=1 observed=0 missing=1 coverage=0 pass_rate=null passed=0\/0 completed=0 timed_out=0 infra_failed=0 plumbing_failed=0 input=0 cache_hit=0 cache_miss=0 cache_write=0 output=0 total=0 cost_usd=0 mean_duration_ms=null activated=0\/0 stale_pruned=0 active_pruned=0 active_tokens_saved=0 active_archive_failures=0 archive_placeholders=0 archive_placeholder_reasons=\{\} archive_write_failures=0 retrieved=0 retrieved_tokens=0 retrieval_skipped=0 retrieval_skipped_reasons=\{\} retrieval_failures=0 retrieval_failure_reasons=\{\}, B tasks=1 attempts=1 observed=1 missing=0 coverage=1 pass_rate=1 passed=1\/1 completed=1 timed_out=0 infra_failed=0 plumbing_failed=0 input=10 cache_hit=3 cache_miss=4 cache_write=2 output=5 total=16 cost_usd=0\.02 mean_duration_ms=250 activated=1\/1 stale_pruned=0 active_pruned=1 active_tokens_saved=0 active_archive_failures=0 archive_placeholders=0 archive_placeholder_reasons=\{\} archive_write_failures=0 retrieved=0 retrieved_tokens=0 retrieval_skipped=0 retrieval_skipped_reasons=\{\} retrieval_failures=0 retrieval_failure_reasons=\{\}/,
    );
  });

  test('summarizes A/B token cost usage for prune benefit review', () => {
    const taskIds = Array.from({ length: 1000 }, (_, index) => `t${index}`);
    const result = summarizePromptAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselinePromptId: 'prune-off',
      candidatePromptId: 'prune-on',
      evaluationTaskIds: taskIds,
      baselineRuns: [taskIds.map((taskId) => withUsage(
        completed(taskId, true),
        { input: 100, cacheHitInput: 20, cacheMissInput: 70, cacheWriteInput: 10, output: 30, reasoning: 5, total: 135, costUsd: 3, durationMs: 1000 },
      ))],
      candidateRuns: [taskIds.map((taskId) => withUsage(
        completed(taskId, true),
        { input: 60, cacheHitInput: 15, cacheMissInput: 40, cacheWriteInput: 5, output: 25, reasoning: 5, total: 90, costUsd: 2, durationMs: 800 },
      ))],
    });

    assert.equal(result.decision, 'non_inferior');
    assert.deepEqual(result.baseline.tokenCostSummary, {
      input: 100_000,
      cachedInput: 20_000,
      cacheHitInput: 20_000,
      cacheMissInput: 70_000,
      cacheWriteInput: 10_000,
      output: 30_000,
      reasoning: 5000,
      total: 135_000,
      costUsd: 3000,
      meanDurationMs: 1000,
    });
    assert.deepEqual(result.candidate.tokenCostSummary, {
      input: 60_000,
      cachedInput: 15_000,
      cacheHitInput: 15_000,
      cacheMissInput: 40_000,
      cacheWriteInput: 5000,
      output: 25_000,
      reasoning: 5000,
      total: 90_000,
      costUsd: 2000,
      meanDurationMs: 800,
    });

    const markdown = renderPromptAbComparisonMarkdown(result);
    assert.match(markdown, /Token\/cost: A input=100000 cache_hit=20000 cache_miss=70000 cache_write=10000 output=30000 total=135000 cost_usd=3000 mean_duration_ms=1000/);
    assert.match(markdown, /B input=60000 cache_hit=15000 cache_miss=40000 cache_write=5000 output=25000 total=90000 cost_usd=2000 mean_duration_ms=800/);
  });

  test('summarizes continuation cap diagnostics for A/B validity review', () => {
    const result = summarizePromptAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselinePromptId: 'prune-off',
      candidatePromptId: 'prune-on',
      evaluationTaskIds: ['t1', 't2'],
      baselineRuns: [[
        { ...completed('t1', true), continuationSummary: continuationSummary({ turnsUsed: 2, continuedTurns: 1, stepCapHits: 1, totalRuntimeSteps: 42 }) },
        { ...completed('t2', false), continuationSummary: continuationSummary({ capExhausted: true, turnsUsed: 3, continuedTurns: 2, stepCapHits: 3, totalRuntimeSteps: 60 }) },
      ]],
      candidateRuns: [[
        { ...completed('t1', true), continuationSummary: continuationSummary({ turnsUsed: 1, totalRuntimeSteps: 20 }) },
        { ...completed('t2', true), continuationSummary: continuationSummary({ turnsUsed: 2, continuedTurns: 1, stepCapHits: 1, totalRuntimeSteps: 44 }) },
      ]],
    });

    assert.deepEqual(result.baseline.continuation, {
      attempts: 2,
      enabledAttempts: 2,
      turnsUsed: 5,
      continuedTurns: 3,
      stepCapHits: 4,
      capExhaustedAttempts: 1,
      totalRuntimeSteps: 102,
      maxTurns: 3,
    });
    assert.deepEqual(result.candidate.continuation, {
      attempts: 2,
      enabledAttempts: 2,
      turnsUsed: 3,
      continuedTurns: 1,
      stepCapHits: 1,
      capExhaustedAttempts: 0,
      totalRuntimeSteps: 64,
      maxTurns: 3,
    });

    const markdown = renderPromptAbComparisonMarkdown(result);
    assert.match(markdown, /Continuation: A enabled=2\/2 turns=5 continued=3 step_cap_hits=4 cap_exhausted=1 runtime_steps=102 max_turns=3, B enabled=2\/2 turns=3 continued=1 step_cap_hits=1 cap_exhausted=0 runtime_steps=64 max_turns=3/);
  });

  test('records activated attempts and investigation refs for follow-up', () => {
    const activatedSummary = contextBudgetSummary({ activePrunedToolResults: 1, activeEstimatedTokensSaved: 50 });
    const staleOnlySummary = contextBudgetSummary({ prunedToolResults: 1, archivePlaceholders: 1 });
    const result = summarizePromptAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselinePromptId: 'prune-off',
      candidatePromptId: 'active-prune-on',
      evaluationTaskIds: ['b-loss', 'activated', 'stale-only', 'budget'],
      baselineRuns: [[
        withTrace(completed('b-loss', true), 'A', 'b-loss'),
        withTrace(completed('activated', true), 'A', 'activated'),
        withTrace(completed('stale-only', true), 'A', 'stale-only'),
        withTrace(completed('budget', true), 'A', 'budget'),
      ]],
      candidateRuns: [[
        withTrace(completed('b-loss', false), 'B', 'b-loss'),
        {
          ...withTrace(completed('activated', true), 'B', 'activated'),
          id: 'event-B-activated-r0',
          contextBudgetSummary: activatedSummary,
        },
        {
          ...withTrace(completed('stale-only', true), 'B', 'stale-only'),
          id: 'event-B-stale-only-r0',
          contextBudgetSummary: staleOnlySummary,
        },
        { ...budgetExhausted('budget'), id: 'event-B-budget-r0', roundId: 'ab-prune-on-r0-budget' },
      ]],
    });

    assert.deepEqual(result.candidate.contextBudget?.activatedAttemptIds, ['event-B-activated-r0']);
    assert.deepEqual(result.candidate.activePruneSubset?.contextBudget?.activatedAttemptIds, ['event-B-activated-r0']);
    assert.equal(result.investigationRefs.activatedAttempts[0]?.taskId, 'activated');
    assert.equal(result.investigationRefs.activatedAttempts.some((ref) => ref.taskId === 'stale-only'), false);
    assert.equal(result.investigationRefs.activatedAttempts[0]?.rep, 0);
    assert.equal(result.investigationRefs.activatedAttempts[0]?.runtimeEventsPath, '/logs/B/activated/runtime-events.jsonl');
    assert.equal(result.investigationRefs.activatedAttempts[0]?.traceEventsPath, '/traces/B/activated/events.jsonl');
    assert.equal(result.investigationRefs.candidateLosses[0]?.pairId, 'b-loss#r0');
    assert.equal(result.investigationRefs.candidateLosses[0]?.candidate?.runtimeEventsPath, '/logs/B/b-loss/runtime-events.jsonl');
    assert.equal(result.investigationRefs.budgetDiscordantPairs[0]?.pairId, 'budget#r0');
    assert.equal(result.investigationRefs.budgetDiscordantPairs[0]?.candidate?.runtimeEventsUnavailableReason, 'budget_exhausted_before_cell_output');

    const markdown = renderPromptAbComparisonMarkdown(result);
    assert.match(markdown, /Activated Attempts/);
    assert.match(markdown, /event-B-activated-r0.*\/traces\/B\/activated\/events\.jsonl/);
    assert.match(markdown, /B Loss Refs/);
    assert.match(markdown, /b-loss#r0.*\/logs\/B\/b-loss\/runtime-events\.jsonl/);
    assert.match(markdown, /Budget Discordant Refs/);
    assert.match(markdown, /budget#r0.*runtime_unavailable=budget_exhausted_before_cell_output/);
  });

  test('keeps sign test auxiliary while using non-inferiority as the decision', () => {
    const taskIds = Array.from({ length: 16 }, (_, index) => `t${index}`);
    const result = summarizePromptAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselinePromptId: 'maka-baseline',
      candidatePromptId: 'candidate',
      evaluationTaskIds: taskIds,
      baselineRuns: [
        taskIds.map((taskId, index) => completed(taskId, index >= 9)),
      ],
      candidateRuns: [
        taskIds.map((taskId, index) => completed(taskId, index < 9)),
      ],
    });

    assert.equal(result.taskLevel.wins, 9);
    assert.equal(result.taskLevel.losses, 7);
    assert.equal(result.taskLevel.signTestPValue !== null && result.taskLevel.signTestPValue > 0.05, true);
    assert.equal(result.decision, 'inconclusive');
    assert.equal(result.reason, 'non_inferiority_confidence_interval_crosses_margin');
    assert.equal(result.nonInferiority.lowerBound !== null && result.nonInferiority.lowerBound < -0.1, true);
  });

  test('keeps an exact task-level sign test as an auxiliary metric', () => {
    const taskIds = Array.from({ length: 16 }, (_, index) => `t${index}`);
    const result = summarizePromptAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselinePromptId: 'maka-baseline',
      candidatePromptId: 'candidate',
      evaluationTaskIds: taskIds,
      baselineRuns: [
        taskIds.map((taskId, index) => completed(taskId, index >= 13)),
      ],
      candidateRuns: [
        taskIds.map((taskId, index) => completed(taskId, index < 13)),
      ],
    });

    assert.equal(result.taskLevel.wins, 13);
    assert.equal(result.taskLevel.losses, 3);
    assert.equal(result.taskLevel.signTestPValue !== null && result.taskLevel.signTestPValue <= 0.05, true);
    assert.equal(result.decision, 'non_inferior');
    assert.equal(result.reason, 'non_inferiority_lower_bound_within_margin');
  });

  test('requires a 10pp non-inferiority confidence bound for prune comparisons', () => {
    const underpoweredNinePointLoss = summarizePromptAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselinePromptId: 'prune-off',
      candidatePromptId: 'prune-on',
      evaluationTaskIds: Array.from({ length: 100 }, (_, index) => `t${index}`),
      baselineRuns: [Array.from({ length: 100 }, (_, index) => completed(`t${index}`, index < 100))],
      candidateRuns: [Array.from({ length: 100 }, (_, index) => completed(`t${index}`, index < 91))],
    });
    assert.equal(underpoweredNinePointLoss.nonInferiorityMargin, 0.1);
    assert.equal(underpoweredNinePointLoss.passRateDelta, -0.09);
    assert.equal(underpoweredNinePointLoss.decision, 'inconclusive');
    assert.equal(underpoweredNinePointLoss.reason, 'non_inferiority_confidence_interval_crosses_margin');
    assert.equal(underpoweredNinePointLoss.nonInferiority.lowerBound !== null && underpoweredNinePointLoss.nonInferiority.lowerBound < -0.1, true);
    assert.match(renderPromptAbComparisonMarkdown(underpoweredNinePointLoss), /Non-inferiority lower bound:/);

    const poweredFivePointLoss = summarizePromptAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselinePromptId: 'prune-off',
      candidatePromptId: 'prune-on',
      evaluationTaskIds: Array.from({ length: 1000 }, (_, index) => `t${index}`),
      baselineRuns: [Array.from({ length: 1000 }, (_, index) => completed(`t${index}`, index < 1000))],
      candidateRuns: [Array.from({ length: 1000 }, (_, index) => completed(`t${index}`, index < 950))],
    });
    assert.equal(poweredFivePointLoss.passRateDelta, -0.05);
    assert.equal(poweredFivePointLoss.nonInferiority.lowerBound !== null && poweredFivePointLoss.nonInferiority.lowerBound >= -0.1, true);
    assert.equal(poweredFivePointLoss.decision, 'non_inferior');
    assert.equal(poweredFivePointLoss.reason, 'non_inferiority_lower_bound_within_margin');

    const elevenPointLoss = summarizePromptAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselinePromptId: 'prune-off',
      candidatePromptId: 'prune-on',
      evaluationTaskIds: Array.from({ length: 100 }, (_, index) => `t${index}`),
      baselineRuns: [Array.from({ length: 100 }, (_, index) => completed(`t${index}`, index < 100))],
      candidateRuns: [Array.from({ length: 100 }, (_, index) => completed(`t${index}`, index < 89))],
    });
    assert.equal(elevenPointLoss.passRateDelta, -0.11);
    assert.equal(elevenPointLoss.decision, 'inferior');
    assert.equal(elevenPointLoss.reason, 'pass_rate_delta_below_non_inferiority_margin');
  });

  test('uses Wilson/Newcombe lower bound for non-inferiority boundary cases', () => {
    const onePairTie = summarizePromptAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselinePromptId: 'prune-off',
      candidatePromptId: 'prune-on',
      evaluationTaskIds: ['single'],
      baselineRuns: [[completed('single', true)]],
      candidateRuns: [[completed('single', true)]],
    });
    assert.equal(onePairTie.passRateDelta, 0);
    assert.equal(onePairTie.nonInferiority.method, 'newcombe_wilson');
    assert.equal(onePairTie.nonInferiority.lowerBound !== null && onePairTie.nonInferiority.lowerBound < -0.1, true);
    assert.equal(onePairTie.decision, 'inconclusive');
    assert.equal(onePairTie.reason, 'non_inferiority_confidence_interval_crosses_margin');

    const tieTaskIds = Array.from({ length: 10 }, (_, index) => `tie-${index}`);
    const allTieSmallSample = summarizePromptAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselinePromptId: 'prune-off',
      candidatePromptId: 'prune-on',
      evaluationTaskIds: tieTaskIds,
      baselineRuns: [tieTaskIds.map((taskId) => completed(taskId, true))],
      candidateRuns: [tieTaskIds.map((taskId) => completed(taskId, true))],
    });
    assert.equal(allTieSmallSample.passRateDelta, 0);
    assert.equal(allTieSmallSample.nonInferiority.method, 'newcombe_wilson');
    assert.equal(allTieSmallSample.nonInferiority.lowerBound !== null && allTieSmallSample.nonInferiority.lowerBound < -0.1, true);
    assert.equal(allTieSmallSample.decision, 'inconclusive');

    const poweredTaskIds = Array.from({ length: 1000 }, (_, index) => `powered-${index}`);
    const powered = summarizePromptAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselinePromptId: 'prune-off',
      candidatePromptId: 'prune-on',
      evaluationTaskIds: poweredTaskIds,
      baselineRuns: [poweredTaskIds.map((taskId) => completed(taskId, true))],
      candidateRuns: [poweredTaskIds.map((taskId, index) => completed(taskId, index < 950))],
    });

    assert.equal(powered.passRateDelta, -0.05);
    assert.equal(powered.pairedAttempts.losses, 50);
    assert.equal(powered.pairedAttempts.ties, 950);
    assert.equal(powered.nonInferiority.method, 'newcombe_wilson');
    assert.equal(powered.nonInferiority.lowerBound !== null && powered.nonInferiority.lowerBound >= -0.1, true);
    assert.equal(powered.decision, 'non_inferior');
    assert.equal(powered.reason, 'non_inferiority_lower_bound_within_margin');

    const smallTaskIds = Array.from({ length: 20 }, (_, index) => `small-${index}`);
    const underpowered = summarizePromptAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselinePromptId: 'prune-off',
      candidatePromptId: 'prune-on',
      evaluationTaskIds: smallTaskIds,
      baselineRuns: [smallTaskIds.map((taskId, index) => completed(taskId, index >= 9))],
      candidateRuns: [smallTaskIds.map((taskId, index) => completed(taskId, index >= 9 && index < 19))],
    });
    assert.equal(underpowered.passRateDelta, -0.05);
    assert.equal(underpowered.nonInferiority.method, 'newcombe_wilson');
    assert.equal(underpowered.nonInferiority.lowerBound !== null && underpowered.nonInferiority.lowerBound < -0.1, true);
    assert.equal(underpowered.decision, 'inconclusive');
    assert.equal(underpowered.reason, 'non_inferiority_confidence_interval_crosses_margin');

    const inferiorTaskIds = Array.from({ length: 100 }, (_, index) => `inferior-${index}`);
    const inferior = summarizePromptAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselinePromptId: 'prune-off',
      candidatePromptId: 'prune-on',
      evaluationTaskIds: inferiorTaskIds,
      baselineRuns: [inferiorTaskIds.map((taskId, index) => completed(taskId, index >= 44))],
      candidateRuns: [inferiorTaskIds.map((taskId, index) => completed(taskId, index >= 44 && index < 89))],
    });
    assert.equal(inferior.passRateDelta, -0.11);
    assert.equal(inferior.nonInferiority.method, 'newcombe_wilson');
    assert.equal(inferior.decision, 'inferior');
    assert.equal(inferior.reason, 'pass_rate_delta_below_non_inferiority_margin');
  });

  test('counts baseline timeout and candidate pass as an effective B advantage', () => {
    const result = summarizePromptAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselinePromptId: 'maka-baseline',
      candidatePromptId: 'candidate',
      evaluationTaskIds: ['t1'],
      baselineRuns: [[budgetExhausted('t1')]],
      candidateRuns: [[completed('t1', true)]],
    });

    assert.equal(result.baseline.budgetExhausted, 1);
    assert.equal(result.candidate.passed, 1);
    assert.equal(result.pairedAttempts.wins, 1);
    assert.deepEqual(result.pairedAttempts.budgetDiscordantPairIds, ['t1#r0']);
    assert.equal(result.decision, 'inconclusive');
    assert.equal(result.reason, 'non_inferiority_confidence_interval_crosses_margin');
  });

  test('counts baseline pass and candidate timeout as an effective B loss', () => {
    const result = summarizePromptAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselinePromptId: 'maka-baseline',
      candidatePromptId: 'candidate',
      evaluationTaskIds: ['t1'],
      baselineRuns: [[completed('t1', true)]],
      candidateRuns: [[budgetExhausted('t1')]],
    });

    assert.equal(result.baseline.passed, 1);
    assert.equal(result.candidate.budgetExhausted, 1);
    assert.equal(result.pairedAttempts.losses, 1);
    assert.deepEqual(result.pairedAttempts.budgetDiscordantPairIds, ['t1#r0']);
    assert.equal(result.decision, 'inferior');
    assert.equal(result.reason, 'pass_rate_delta_below_non_inferiority_margin');
  });

  test('reports budget-discordant refs without blocking a powered non-inferiority decision', () => {
    const taskIds = Array.from({ length: 100 }, (_, index) => `t${index}`);
    const result = summarizePromptAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselinePromptId: 'prune-off',
      candidatePromptId: 'prune-on',
      evaluationTaskIds: taskIds,
      baselineRuns: [[budgetExhausted('t0'), ...taskIds.slice(1).map((taskId) => completed(taskId, true))]],
      candidateRuns: [taskIds.map((taskId) => completed(taskId, true))],
    });

    assert.deepEqual(result.pairedAttempts.budgetDiscordantPairIds, ['t0#r0']);
    assert.equal(result.investigationRefs.budgetDiscordantPairs[0]?.pairId, 't0#r0');
    assert.equal(result.decision, 'non_inferior');
    assert.equal(result.reason, 'non_inferiority_lower_bound_within_margin');
    const markdown = renderPromptAbComparisonMarkdown(result);
    assert.match(markdown, /Budget Discordant Refs/);
    assert.match(markdown, /t0#r0/);
  });
});

describe('runPromptAbComparison', () => {
  test('runs baseline and candidate prompts adjacent for each task-rep pair', async () => {
    await withDir(async (dir) => {
      const baselinePromptPath = join(dir, 'baseline.md');
      const candidatePromptPath = join(dir, 'candidate.md');
      await writeFile(baselinePromptPath, 'A prompt\n', 'utf8');
      await writeFile(candidatePromptPath, 'B prompt\n', 'utf8');
      const calls: string[] = [];

      const result = await runPromptAbComparison({
        runId: 'ab-run',
        config,
        baselinePromptPath,
        candidatePromptPath,
        candidatePromptId: 'maka-improved-v1',
        resultsJsonlPath: join(dir, 'results.jsonl'),
        evaluationTasks: [
          { id: 't1', path: '/tasks/t1' },
          { id: 't2', path: '/tasks/t2' },
        ],
        reps: 2,
        maxConcurrency: 1,
        harborRunner: async ({ roundId, task, systemPrompt }) => {
          calls.push(`${roundId}:${task.id}`);
          const isCandidate = systemPrompt.startsWith('B prompt');
          return harborOutput({
            taskId: task.id,
            promptHash: hashSystemPrompt(systemPrompt),
            reward: isCandidate ? 1 : 0,
          });
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.candidatePromptId, 'maka-improved-v1');
      assert.equal(result.decision, 'non_inferior');
      assert.equal(result.taskLevel.wins, 2);
      assert.deepEqual(calls, [
        'ab-baseline-r0-t1:t1',
        'ab-candidate-r0-t1:t1',
        'ab-candidate-r0-t2:t2',
        'ab-baseline-r0-t2:t2',
        'ab-candidate-r1-t1:t1',
        'ab-baseline-r1-t1:t1',
        'ab-baseline-r1-t2:t2',
        'ab-candidate-r1-t2:t2',
      ]);
    });
  });

  test('passes resume fingerprints through to each A/B arm', async () => {
    await withDir(async (dir) => {
      const baselinePromptPath = join(dir, 'baseline.md');
      const candidatePromptPath = join(dir, 'candidate.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(baselinePromptPath, 'A prompt\n', 'utf8');
      await writeFile(candidatePromptPath, 'B prompt\n', 'utf8');
      const evaluationTasks = [{ id: 't1', path: '/tasks/t1' }];

      const firstCalls: string[] = [];
      await runPromptAbComparison({
        runId: 'ab-run',
        config,
        baselinePromptPath,
        candidatePromptPath,
        resultsJsonlPath,
        evaluationTasks,
        reps: 1,
        resumeFingerprint: 'fingerprint-old',
        harborRunner: async ({ roundId, task, systemPrompt }) => {
          firstCalls.push(`${roundId}:${task.id}`);
          return harborOutput({ taskId: task.id, promptHash: hashSystemPrompt(systemPrompt) });
        },
        now: () => 100,
        newId: idFactory(),
      });
      assert.deepEqual(firstCalls, ['ab-baseline-r0-t1:t1', 'ab-candidate-r0-t1:t1']);

      const sameCalls: string[] = [];
      await runPromptAbComparison({
        runId: 'ab-run',
        config,
        baselinePromptPath,
        candidatePromptPath,
        resultsJsonlPath,
        evaluationTasks,
        reps: 1,
        resumeFingerprint: 'fingerprint-old',
        harborRunner: async ({ roundId, task, systemPrompt }) => {
          sameCalls.push(`${roundId}:${task.id}`);
          return harborOutput({ taskId: task.id, promptHash: hashSystemPrompt(systemPrompt) });
        },
        now: () => 200,
        newId: idFactory(),
      });
      assert.deepEqual(sameCalls, []);

      const changedCalls: string[] = [];
      await runPromptAbComparison({
        runId: 'ab-run',
        config,
        baselinePromptPath,
        candidatePromptPath,
        resultsJsonlPath,
        evaluationTasks,
        reps: 1,
        resumeFingerprint: 'fingerprint-new',
        harborRunner: async ({ roundId, task, systemPrompt }) => {
          changedCalls.push(`${roundId}:${task.id}`);
          return harborOutput({ taskId: task.id, promptHash: hashSystemPrompt(systemPrompt) });
        },
        now: () => 300,
        newId: idFactory(),
      });
      assert.deepEqual(changedCalls, ['ab-baseline-r0-t1:t1', 'ab-candidate-r0-t1:t1']);
    });
  });
});

function harborOutput(input: {
  taskId: string;
  durationMs?: number;
  promptHash: string;
  reward?: number;
}): HarborTaskRunOutput {
  return {
    harbor: { reward: input.reward ?? 1 },
    cell: {
      schemaVersion: 1,
      status: 'completed',
      promptHash: input.promptHash,
      tokenSummary: tokenSummary({ input: 4, output: 6, reasoning: 0, total: 10, costUsd: 0.01 }),
      toolSummary: {
        providerVisibleToolCount: 1,
        actualToolCalls: 1,
        actualToolNames: ['Bash'],
        actualToolCallCounts: { Bash: 1 },
      },
      steps: 1,
      durationMs: input.durationMs ?? 100,
      startedAt: 0,
      finishedAt: input.durationMs ?? 100,
      runtimeEventsPath: `/logs/${input.taskId}/runtime-events.jsonl`,
      runtimeRefs: {
        invocationId: `inv-${input.taskId}`,
        sessionId: `session-${input.taskId}`,
        runId: `run-${input.taskId}`,
        turnId: `turn-${input.taskId}`,
      },
    },
  };
}

function completed(taskId: string, passed: boolean): FixedPromptTaskCompletedEvent {
  return {
    schemaVersion: FIXED_PROMPT_WAL_SCHEMA_VERSION,
    type: 'task_completed',
    id: `event-${taskId}-${passed ? 'pass' : 'fail'}`,
    ts: 0,
    runId: 'run',
    roundId: 'round',
    taskId,
    status: 'completed',
    passed,
    scored: true,
    eligible: true,
    errorClass: passed ? undefined : 'verification_failed',
    promptHash: 'hash',
    tokenSummary: tokenSummary({ input: 1, output: 1, reasoning: 0, total: 2, costUsd: 0.01 }),
    steps: 1,
    durationMs: 100,
    runtimeEventsPath: `/logs/${taskId}/runtime-events.jsonl`,
    harbor: { reward: passed ? 1 : 0 },
  };
}

function withUsage(
  event: FixedPromptTaskCompletedEvent,
  usage: {
    input: number;
    cacheHitInput: number;
    cacheMissInput: number;
    cacheWriteInput: number;
    output: number;
    reasoning: number;
    total: number;
    costUsd: number;
    durationMs: number;
  },
): FixedPromptTaskCompletedEvent {
  return {
    ...event,
    tokenSummary: {
      input: usage.input,
      cachedInput: usage.cacheHitInput,
      cacheHitInput: usage.cacheHitInput,
      cacheMissInput: usage.cacheMissInput,
      cacheWriteInput: usage.cacheWriteInput,
      cacheMissInputSource: 'explicit',
      output: usage.output,
      reasoning: usage.reasoning,
      total: usage.total,
      costUsd: usage.costUsd,
      pricingSource: 'runtime',
    },
    durationMs: usage.durationMs,
  };
}

function withTrace<T extends FixedPromptTaskCompletedEvent>(event: T, arm: 'A' | 'B', taskId: string): T {
  return {
    ...event,
    id: `event-${arm}-${taskId}-r0`,
    roundId: `ab-${arm === 'A' ? 'prune-off' : 'prune-on'}-r0-${taskId}`,
    runtimeEventsPath: `/logs/${arm}/${taskId}/runtime-events.jsonl`,
    traceEventsPath: `/traces/${arm}/${taskId}/events.jsonl`,
  };
}

function budgetExhausted(taskId: string): FixedPromptTaskBudgetExhaustedEvent {
  return {
    schemaVersion: FIXED_PROMPT_WAL_SCHEMA_VERSION,
    type: 'task_budget_exhausted',
    id: `event-${taskId}-budget`,
    ts: 0,
    runId: 'run',
    roundId: 'round',
    taskId,
    status: 'budget_exhausted',
    passed: false,
    scored: false,
    eligible: true,
    errorClass: 'budget_exhausted',
    error: 'harbor run timed out after 600s',
    expectedPromptHash: 'hash',
  };
}

function contextBudgetSummary(
  input: Partial<NonNullable<FixedPromptTaskCompletedEvent['contextBudgetSummary']>>,
): NonNullable<FixedPromptTaskCompletedEvent['contextBudgetSummary']> {
  return {
    diagnosticEvents: 1,
    enabledEvents: 1,
    estimatedTokensBefore: 1000,
    estimatedTokensAfter: 800,
    keptTurns: 3,
    droppedTurns: 1,
    keptEvents: 8,
    droppedEvents: 2,
    prunedToolResults: 0,
    activePrunedToolResults: 0,
    activeEstimatedTokensSaved: 0,
    activeArchiveFailures: 0,
    archivePlaceholders: 0,
    archivePlaceholderReasonCounts: {},
    archiveWriteFailures: 0,
    retrievedArchiveToolResults: 0,
    retrievedArchiveEstimatedTokens: 0,
    archiveRetrievalSkipped: 0,
    archiveRetrievalSkippedReasonCounts: {},
    archiveRetrievalFailures: 0,
    archiveRetrievalFailureReasonCounts: {},
    ...input,
  };
}

function continuationSummary(
  input: Partial<NonNullable<FixedPromptTaskCompletedEvent['continuationSummary']>>,
): NonNullable<FixedPromptTaskCompletedEvent['continuationSummary']> {
  return {
    enabled: true,
    maxTurns: 3,
    turnsUsed: 1,
    continuedTurns: 0,
    stepCapHits: 0,
    capExhausted: false,
    totalRuntimeSteps: 1,
    ...input,
  };
}

function idFactory(): () => string {
  let next = 0;
  return () => `id-${next++}`;
}

function sha256(char: string): string {
  return `sha256:${char.repeat(64)}`;
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'maka-prompt-ab-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
