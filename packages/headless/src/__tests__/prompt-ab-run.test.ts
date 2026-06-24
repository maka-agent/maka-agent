import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  planPromptAbConcurrencyCalibration,
  renderPromptAbComparisonMarkdown,
  runPromptAbComparison,
  runPromptAbConcurrencyCalibration,
  runPromptAbTaskQualification,
  summarizePromptAbComparison,
} from '../prompt-ab-run.js';
import type { Config } from '../contracts.js';
import {
  FIXED_PROMPT_WAL_SCHEMA_VERSION,
  FixedPromptBudgetExhaustedError,
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

describe('planPromptAbConcurrencyCalibration', () => {
  test('builds deterministic calibration trials from duration buckets', () => {
    const tasks: FixedPromptTask[] = [
      { id: 'slow-b', path: '/tasks/slow-b' },
      { id: 'fast-a', path: '/tasks/fast-a' },
      { id: 'mid-a', path: '/tasks/mid-a' },
      { id: 'slow-a', path: '/tasks/slow-a' },
      { id: 'fast-b', path: '/tasks/fast-b' },
      { id: 'mid-b', path: '/tasks/mid-b' },
    ];

    const plan = planPromptAbConcurrencyCalibration({
      tasks,
      taskDurationsMs: {
        'fast-a': 10,
        'fast-b': 20,
        'mid-a': 100,
        'mid-b': 120,
        'slow-a': 1_000,
        'slow-b': 1_200,
      },
      samplesPerBucket: 1,
      concurrencyLevels: [1, 2, 4],
      repsPerLevel: 2,
    });

    assert.deepEqual(plan.sampleTasks.map((task) => task.id), ['fast-a', 'mid-a', 'slow-a']);
    assert.deepEqual(plan.concurrencyLevels, [1, 2, 4]);
    assert.deepEqual(
      plan.trials.map((trial) => `${trial.concurrency}:${trial.rep}:${trial.task.id}`),
      [
        '1:0:fast-a',
        '1:0:mid-a',
        '1:0:slow-a',
        '1:1:fast-a',
        '1:1:mid-a',
        '1:1:slow-a',
        '2:0:fast-a',
        '2:0:mid-a',
        '2:0:slow-a',
        '2:1:fast-a',
        '2:1:mid-a',
        '2:1:slow-a',
        '4:0:fast-a',
        '4:0:mid-a',
        '4:0:slow-a',
        '4:1:fast-a',
        '4:1:mid-a',
        '4:1:slow-a',
      ],
    );
  });
});

describe('runPromptAbConcurrencyCalibration', () => {
  test('runs planned levels and recommends the highest level within the infra threshold', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'baseline prompt\n', 'utf8');

      const calls: string[] = [];
      const result = await runPromptAbConcurrencyCalibration({
        runId: 'ab-run',
        config,
        systemPromptPath,
        resultsJsonlPath,
        tasks: [
          { id: 'fast', path: '/tasks/fast' },
          { id: 'mid', path: '/tasks/mid' },
          { id: 'slow', path: '/tasks/slow' },
        ],
        taskDurationsMs: { fast: 10, mid: 100, slow: 1_000 },
        samplesPerBucket: 1,
        concurrencyLevels: [1, 2, 4],
        maxInfraFailureRate: 0,
        harborRunner: async ({ roundId, task, systemPrompt }) => {
          calls.push(`${roundId}:${task.id}`);
          if (roundId.startsWith('calibration-c4-') && task.id === 'slow') {
            throw new Error('docker exhausted');
          }
          return harborOutput({
            taskId: task.id,
            durationMs: task.id === 'slow' ? 1_000 : 100,
            promptHash: hashSystemPrompt(systemPrompt),
          });
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.recommendedConcurrency, 2);
      assert.deepEqual(result.sampleTaskIds, ['fast', 'mid', 'slow']);
      assert.deepEqual(
        result.levels.map((level) => ({
          concurrency: level.concurrency,
          attempts: level.attempts,
          infraFailed: level.infraFailed,
          completed: level.completed,
        })),
        [
          { concurrency: 1, attempts: 3, infraFailed: 0, completed: 3 },
          { concurrency: 2, attempts: 3, infraFailed: 0, completed: 3 },
          { concurrency: 4, attempts: 3, infraFailed: 1, completed: 2 },
        ],
      );
      assert.deepEqual(calls, [
        'calibration-c1-r0:fast',
        'calibration-c1-r0:mid',
        'calibration-c1-r0:slow',
        'calibration-c2-r0:fast',
        'calibration-c2-r0:mid',
        'calibration-c2-r0:slow',
        'calibration-c4-r0:fast',
        'calibration-c4-r0:mid',
        'calibration-c4-r0:slow',
        'calibration-c4-r0:slow',
      ]);

      const walLines = (await readFile(resultsJsonlPath, 'utf8')).trimEnd().split('\n');
      assert.equal(walLines.length, 9);
      assert.match(walLines.at(-1) ?? '', /"type":"task_infra_failed"/);
    });
  });
});

describe('runPromptAbTaskQualification', () => {
  test('selects only A-medium tasks and reports the selection funnel', async () => {
    await withDir(async (dir) => {
      const baselinePromptPath = join(dir, 'baseline.md');
      await writeFile(baselinePromptPath, 'A prompt\n', 'utf8');
      const tasks: FixedPromptTask[] = [
        { id: 'medium-one', path: '/tasks/medium-one' },
        { id: 'medium-two', path: '/tasks/medium-two' },
        { id: 'easy', path: '/tasks/easy' },
        { id: 'hard', path: '/tasks/hard' },
        { id: 'timeout', path: '/tasks/timeout' },
      ];

      const result = await runPromptAbTaskQualification({
        runId: 'ab-run',
        config,
        baselinePromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        candidateTasks: tasks,
        reps: 3,
        targetTaskCount: 3,
        maxConcurrency: 2,
        harborRunner: async ({ roundId, task, systemPrompt }) => {
          const rep = Number(roundId.match(/r(\d+)$/)?.[1] ?? 0);
          if (task.id === 'timeout') throw new FixedPromptBudgetExhaustedError('Maka host cell exceeded 600s');
          const passCounts: Record<string, number> = {
            'medium-one': 1,
            'medium-two': 2,
            easy: 3,
            hard: 0,
          };
          return harborOutput({
            taskId: task.id,
            promptHash: hashSystemPrompt(systemPrompt),
            reward: rep < (passCounts[task.id] ?? 0) ? 1 : 0,
          });
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.deepEqual(result.selectedTaskIds, ['medium-one', 'medium-two']);
      assert.equal(result.shortage, 1);
      assert.deepEqual(result.rejected.easyTaskIds, ['easy']);
      assert.deepEqual(result.rejected.hardTaskIds, ['hard']);
      assert.deepEqual(result.rejected.infraOrInvalidTaskIds, ['timeout']);
      assert.equal(result.runs.length, 3);
    });
  });
});

describe('summarizePromptAbComparison', () => {
  test('summarizes fixed A/B as task-level deltas without RSI acceptance semantics', () => {
    const result = summarizePromptAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselinePromptId: 'maka-baseline',
      candidatePromptId: 'opencode-default',
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

    assert.equal(result.decision, 'candidate_better');
    assert.equal(result.taskCount, 2);
    assert.equal(result.reps, 2);
    assert.equal(result.baseline.passRate, 0.25);
    assert.equal(result.candidate.passRate, 1);
    assert.equal(result.taskLevel.wins, 2);
    assert.equal(result.taskLevel.losses, 0);
    assert.equal(result.taskLevel.ties, 0);
    assert.deepEqual(result.taskLevel.missingTaskIds, []);
    assert.equal(result.taskLevel.meanPassRateDelta, 0.75);
    assert.equal(result.outcomes.baseline.budgetExhausted, 0);
    assert.equal(result.outcomes.candidate.budgetExhausted, 0);

    const markdown = renderPromptAbComparisonMarkdown(result);
    assert.match(markdown, /Decision: B better \(task_level_delta_positive\)/);
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
      candidatePromptId: 'opencode-default',
      evaluationTaskIds: ['long-task'],
      baselineRuns: [[completed('long-task', true)]],
      candidateRuns: [[budgetExhausted('long-task')]],
      budgetMs: 600_000,
    });

    assert.equal(result.decision, 'inconclusive');
    assert.equal(result.reason, 'asymmetric_budget_exhaustion');
    assert.equal(result.candidate.passRate, 0);
    assert.equal(result.outcomes.candidate.budgetExhausted, 1);
    assert.equal(result.outcomes.candidate.infraFailed, 0);
    assert.equal(result.taskLevel.losses, 1);
    assert.match(renderPromptAbComparisonMarkdown(result), /Budget outcomes: A timed_out=0, B timed_out=1/);
  });
});

describe('runPromptAbComparison', () => {
  test('runs baseline and candidate prompts across reps with interleaved arm order', async () => {
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
        resultsJsonlPath: join(dir, 'results.jsonl'),
        evaluationTasks: [{ id: 't1', path: '/tasks/t1' }],
        reps: 2,
        maxConcurrency: 4,
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

      assert.equal(result.decision, 'candidate_better');
      assert.equal(result.taskLevel.wins, 1);
      assert.deepEqual(calls, [
        'ab-baseline-r0:t1',
        'ab-candidate-r0:t1',
        'ab-candidate-r1:t1',
        'ab-baseline-r1:t1',
      ]);
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
  };
}

function idFactory(): () => string {
  let next = 0;
  return () => `id-${next++}`;
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'maka-prompt-ab-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
