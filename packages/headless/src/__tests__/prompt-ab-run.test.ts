import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
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

    assert.equal(result.decision, 'inconclusive');
    assert.equal(result.reason, 'sign_test_not_significant');
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
    assert.match(markdown, /Decision: inconclusive \(sign_test_not_significant\)/);
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

    assert.equal(result.decision, 'inconclusive');
    assert.equal(result.reason, 'asymmetric_budget_exhaustion');
    assert.equal(result.candidate.passRate, 0);
    assert.equal(result.candidate.budgetExhausted, 1);
    assert.equal(result.candidate.infraFailed, 0);
    assert.equal(result.taskLevel.losses, 1);
    assert.match(renderPromptAbComparisonMarkdown(result), /Budget outcomes: A timed_out=0, B timed_out=1/);
  });

  test('does not call a small task majority statistically significant', () => {
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
    assert.equal(result.decision, 'inconclusive');
    assert.equal(result.reason, 'sign_test_not_significant');
  });

  test('uses an exact task-level sign test for a directional decision', () => {
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
    assert.equal(result.decision, 'candidate_better');
    assert.equal(result.reason, 'task_level_sign_test_p<=0.05');
  });

  test('treats pair-level timeout asymmetry as inconclusive even when total timeouts match', () => {
    const result = summarizePromptAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselinePromptId: 'maka-baseline',
      candidatePromptId: 'candidate',
      evaluationTaskIds: ['t1', 't2'],
      baselineRuns: [[budgetExhausted('t1'), completed('t2', true)]],
      candidateRuns: [[completed('t1', true), budgetExhausted('t2')]],
    });

    assert.equal(result.baseline.budgetExhausted, 1);
    assert.equal(result.candidate.budgetExhausted, 1);
    assert.deepEqual(result.pairedAttempts.budgetDiscordantPairIds, ['t1#r0', 't2#r0']);
    assert.equal(result.decision, 'inconclusive');
    assert.equal(result.reason, 'asymmetric_budget_exhaustion');
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
      assert.equal(result.decision, 'inconclusive');
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
