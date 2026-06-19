import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Config } from '../contracts.js';
import {
  hashSystemPrompt,
  readHarborTaskRunOutput,
  runFixedPromptController,
  type FixedPromptWalEvent,
  type HarborTaskRunOutput,
} from '../fixed-prompt-controller.js';

const config: Config = {
  id: 'cfg-fixed',
  backend: 'fake',
  llmConnectionSlug: 'fake',
  model: 'fake-model',
};

describe('fixed prompt controller', () => {
  test('resumes from completed task events in the WAL', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      await appendFile(resultsJsonlPath, `${JSON.stringify(taskCompletedEvent({ taskId: 'task-a' }))}\n`, 'utf8');

      const calls: string[] = [];
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [
          { id: 'task-a', path: '/bench/task-a' },
          { id: 'task-b', path: '/bench/task-b' },
        ],
        harborRunner: async ({ task }): Promise<HarborTaskRunOutput> => {
          calls.push(task.id);
          return harborOutput({ taskId: task.id });
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.deepEqual(calls, ['task-b']);
      assert.deepEqual(result.taskIds, ['task-a', 'task-b']);

      const lines = (await readFile(resultsJsonlPath, 'utf8')).trimEnd().split('\n');
      assert.equal(lines.length, 2);
      assert.equal(JSON.parse(lines[1]!).taskId, 'task-b');
    });
  });

  test('reruns completed WAL events whose prompt hash is stale', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      await appendFile(
        resultsJsonlPath,
        `${JSON.stringify(taskCompletedEvent({ taskId: 'task-a', promptHash: 'sha256:stale' }))}\n`,
        'utf8',
      );

      const calls: string[] = [];
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        harborRunner: async ({ task }) => {
          calls.push(task.id);
          return harborOutput({ taskId: task.id });
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.deepEqual(calls, ['task-a']);
      assert.equal(result.events[0]?.type, 'task_completed');
      assert.equal(result.events[0]?.promptHash, hashSystemPrompt('fixed prompt\n'));
      assert.equal((await readFile(resultsJsonlPath, 'utf8')).trimEnd().split('\n').length, 2);
    });
  });

  test('ignores a torn final WAL line when resuming', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      await appendFile(
        resultsJsonlPath,
        `${JSON.stringify(taskCompletedEvent({ taskId: 'task-a' }))}\n{"schemaVersion":`,
        'utf8',
      );

      const calls: string[] = [];
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [
          { id: 'task-a', path: '/bench/task-a' },
          { id: 'task-b', path: '/bench/task-b' },
        ],
        harborRunner: async ({ task }) => {
          calls.push(task.id);
          return harborOutput({ taskId: task.id });
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.deepEqual(calls, ['task-b']);
      assert.deepEqual(result.taskIds, ['task-a', 'task-b']);

      const secondCalls: string[] = [];
      const second = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [
          { id: 'task-a', path: '/bench/task-a' },
          { id: 'task-b', path: '/bench/task-b' },
        ],
        harborRunner: async ({ task }) => {
          secondCalls.push(task.id);
          return harborOutput({ taskId: task.id });
        },
        now: () => 101,
        newId: idFactory(),
      });

      assert.deepEqual(secondCalls, []);
      assert.deepEqual(second.taskIds, ['task-a', 'task-b']);
    });
  });

  test('retries infra-failed WAL events on resume', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      await appendFile(resultsJsonlPath, `${JSON.stringify(taskInfraFailedEvent({ taskId: 'task-a' }))}\n`, 'utf8');

      const calls: string[] = [];
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        harborRunner: async ({ task }) => {
          calls.push(task.id);
          return harborOutput({ taskId: task.id });
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.deepEqual(calls, ['task-a']);
      assert.equal(result.events[0]?.type, 'task_completed');
    });
  });

  test('derives results TSV from replayed task events', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      await appendFile(resultsJsonlPath, `${JSON.stringify(taskCompletedEvent({ taskId: 'task-a' }))}\n`, 'utf8');

      await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath,
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        harborRunner: async () => harborOutput({ taskId: 'unused' }),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(
        await readFile(resultsTsvPath, 'utf8'),
        [
          'task_id\tstatus\tpassed\tscored\teligible\terror_class\tprompt_hash\ttokens\tcost_usd\truntime_events_path',
          `task-a\tcompleted\ttrue\ttrue\ttrue\t\t${hashSystemPrompt('fixed prompt\n')}\t5\t0.01\t/logs/task-a/runtime-events.jsonl`,
          '',
        ].join('\n'),
      );
    });
  });

  test('records Harbor runner failures as infra events', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        harborRunner: async () => {
          throw new Error('container crashed before result.json');
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.events[0]?.type, 'task_infra_failed');
      assert.equal(result.events[0]?.taskId, 'task-a');
      assert.equal(result.events[0]?.eligible, false);
      assert.equal(result.events[0]?.scored, false);
      assert.equal(result.events[0]?.errorClass, 'infra_error');
      assert.match(await readFile(resultsJsonlPath, 'utf8'), /"type":"task_infra_failed"/);
    });
  });

  test('reads Harbor reward and Maka cell output artifacts', async () => {
    await withDir(async (dir) => {
      const harborResultPath = join(dir, 'result.json');
      const cellOutputPath = join(dir, 'maka-cell-output.json');
      await writeFile(harborResultPath, JSON.stringify({ verifier_result: { rewards: { reward: 0 } } }), 'utf8');
      await writeFile(cellOutputPath, JSON.stringify(harborOutput({ taskId: 'task-a' }).cell), 'utf8');

      const output = await readHarborTaskRunOutput({ harborResultPath, cellOutputPath });

      assert.equal(output.harbor.reward, 0);
      assert.equal(output.cell.status, 'completed');
      assert.equal(output.cell.runtimeRefs.sessionId, 'session-task-a');
    });
  });

  test('classifies completed Harbor reward failures as benchmark failures', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        harborRunner: async () => harborOutput({ taskId: 'task-a', reward: 0 }),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.events[0]?.type, 'task_completed');
      assert.equal(result.events[0]?.passed, false);
      assert.equal(result.events[0]?.scored, true);
      assert.equal(result.events[0]?.eligible, true);
      assert.equal(result.events[0]?.errorClass, 'verification_failed');
    });
  });

  test('records zero cost with tokens as a plumbing failure', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        harborRunner: async () =>
          harborOutput({
            taskId: 'task-a',
            tokenSummary: { input: 2, output: 1, reasoning: 0, total: 3, costUsd: 0 },
          }),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.events[0]?.type, 'task_plumbing_failed');
      assert.equal(result.events[0]?.passed, false);
      assert.equal(result.events[0]?.eligible, false);
      assert.equal(result.events[0]?.errorClass, 'zero_cost_with_tokens');
      assert.equal(result.totalTokens, 3);
      assert.equal(result.totalCostUsd, 0);
    });
  });

  test('records prompt hash mismatches as plumbing failures', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        harborRunner: async () => harborOutput({ taskId: 'task-a', promptHash: 'sha256:wrong' }),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.events[0]?.type, 'task_plumbing_failed');
      assert.equal(result.events[0]?.errorClass, 'prompt_hash_mismatch');
      assert.equal(result.events[0]?.promptHash, 'sha256:wrong');
      assert.equal(result.events[0]?.expectedPromptHash, hashSystemPrompt('fixed prompt\n'));
    });
  });

  test('records missing prompt hashes with tokens as plumbing failures', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        harborRunner: async () =>
          harborOutput({
            taskId: 'task-a',
            omitPromptHash: true,
            tokenSummary: { input: 0, output: 0, reasoning: 0, total: 0, costUsd: 0 },
          }),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.events[0]?.type, 'task_plumbing_failed');
      assert.equal(result.events[0]?.errorClass, 'missing_prompt_hash');
      assert.equal(result.events[0]?.expectedPromptHash, hashSystemPrompt('fixed prompt\n'));
    });
  });
});

function taskCompletedEvent(input: { taskId: string; promptHash?: string }): FixedPromptWalEvent {
  return {
    schemaVersion: 1,
    type: 'task_completed',
    id: `event-${input.taskId}`,
    ts: 10,
    runId: 'run-1',
    roundId: 'round-1',
    taskId: input.taskId,
    status: 'completed',
    passed: true,
    scored: true,
    eligible: true,
    promptHash: input.promptHash ?? hashSystemPrompt('fixed prompt\n'),
    tokenSummary: { input: 2, output: 3, reasoning: 0, total: 5, costUsd: 0.01 },
    steps: 4,
    durationMs: 50,
    runtimeEventsPath: `/logs/${input.taskId}/runtime-events.jsonl`,
    harbor: { reward: 1 },
  };
}

function taskInfraFailedEvent(input: { taskId: string }): FixedPromptWalEvent {
  return {
    schemaVersion: 1,
    type: 'task_infra_failed',
    id: `event-${input.taskId}`,
    ts: 10,
    runId: 'run-1',
    roundId: 'round-1',
    taskId: input.taskId,
    status: 'infra_failed',
    passed: false,
    scored: false,
    eligible: false,
    errorClass: 'infra_error',
    error: 'container crashed',
  };
}

function harborOutput(input: {
  taskId: string;
  reward?: number;
  promptHash?: string;
  omitPromptHash?: boolean;
  tokenSummary?: HarborTaskRunOutput['cell']['tokenSummary'];
}): HarborTaskRunOutput {
  return {
    harbor: { reward: input.reward ?? 1 },
    cell: {
      schemaVersion: 1,
      status: 'completed',
      runtimeEventsPath: `/logs/${input.taskId}/runtime-events.jsonl`,
      ...(input.omitPromptHash ? {} : { promptHash: input.promptHash ?? hashSystemPrompt('fixed prompt\n') }),
      tokenSummary: input.tokenSummary ?? { input: 1, output: 2, reasoning: 0, total: 3, costUsd: 0.02 },
      steps: 2,
      durationMs: 40,
      startedAt: 20,
      finishedAt: 60,
      runtimeRefs: {
        invocationId: `inv-${input.taskId}`,
        sessionId: `session-${input.taskId}`,
        runId: `run-${input.taskId}`,
        turnId: `turn-${input.taskId}`,
      },
    },
  };
}

function idFactory(): () => string {
  let i = 0;
  return () => `id-${++i}`;
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'maka-fixed-prompt-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
