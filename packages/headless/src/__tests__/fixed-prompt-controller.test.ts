import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Config } from '../contracts.js';
import { tokenSummary } from './helpers/cell-output-fixtures.js';
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

  test('retries a thrown infra error once and records the successful retry', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      let attempts = 0;
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        harborRunner: async ({ task }) => {
          attempts += 1;
          if (attempts === 1) throw new Error('transient container build hiccup');
          return harborOutput({ taskId: task.id });
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(attempts, 2); // failed once, retried once
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0]?.type, 'task_completed');
      const wal = await readFile(resultsJsonlPath, 'utf8');
      assert.match(wal, /"type":"task_completed"/);
      assert.doesNotMatch(wal, /"type":"task_infra_failed"/);
    });
  });

  test('records task_infra_failed only after the retry also throws', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      let attempts = 0;
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath,
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        harborRunner: async () => {
          attempts += 1;
          throw new Error('container crashed both times');
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(attempts, 2);
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0]?.type, 'task_infra_failed');
    });
  });

  test('stops when infra failures exceed the configured rate', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

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
          { id: 'task-c', path: '/bench/task-c' },
          { id: 'task-d', path: '/bench/task-d' },
          { id: 'task-e', path: '/bench/task-e' },
        ],
        maxInfraFailureRate: 0.2,
        harborRunner: async ({ task }) => {
          calls.push(task.id);
          throw new Error(`container crashed for ${task.id}`);
        },
        now: () => 100,
        newId: idFactory(),
      });

      // Each failing task is retried once before being recorded, so it is
      // attempted twice; we still stop after task-b and never reach c/d/e.
      assert.deepEqual([...new Set(calls)], ['task-a', 'task-b']);
      assert.equal(result.stopReason, 'infra_failure_rate_exceeded');
      assert.deepEqual(result.taskIds, ['task-a', 'task-b']);
      assert.equal((await readFile(resultsJsonlPath, 'utf8')).trimEnd().split('\n').length, 2);
    });
  });

  test('checks infra failure rate between tasks even when concurrency is configured', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      let inFlight = 0;
      let maxInFlight = 0;
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
          { id: 'task-c', path: '/bench/task-c' },
          { id: 'task-d', path: '/bench/task-d' },
          { id: 'task-e', path: '/bench/task-e' },
        ],
        maxConcurrency: 3,
        maxInfraFailureRate: 0.2,
        harborRunner: async ({ task }) => {
          calls.push(task.id);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await delay(1);
          inFlight -= 1;
          throw new Error(`container crashed for ${task.id}`);
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(maxInFlight, 1);
      assert.deepEqual([...new Set(calls)], ['task-a', 'task-b']);
      assert.equal(result.stopReason, 'infra_failure_rate_exceeded');
      assert.deepEqual(result.taskIds, ['task-a', 'task-b']);
    });
  });

  test('rejects out-of-contract guard knobs instead of silently disabling them', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const base = {
        runId: 'run-1',
        roundId: 'round-1',
        config,
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        resultsTsvPath: join(dir, 'results.tsv'),
        tasks: [{ id: 'task-a', path: '/bench/task-a' }],
        harborRunner: async () => { throw new Error('should not run'); },
        now: () => 100,
        newId: idFactory(),
      };
      await assert.rejects(
        runFixedPromptController({ ...base, maxConcurrency: 1.5 }),
        /maxConcurrency must be a positive integer/,
      );
      // Caught even when a stop guard would force the effective concurrency to 1.
      await assert.rejects(
        runFixedPromptController({ ...base, maxConcurrency: 1.5, costCeilingUsd: 10 }),
        /maxConcurrency must be a positive integer/,
      );
      await assert.rejects(
        runFixedPromptController({ ...base, costCeilingUsd: NaN }),
        /costCeilingUsd must be a finite positive number/,
      );
      await assert.rejects(
        runFixedPromptController({ ...base, maxInfraFailureRate: 0 }),
        /maxInfraFailureRate must be a number in \(0, 1\]/,
      );
    });
  });

  test('rejects duplicate task ids before running Harbor', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const calls: string[] = [];

      await assert.rejects(
        runFixedPromptController({
          runId: 'run-1',
          roundId: 'round-1',
          config,
          systemPromptPath,
          resultsJsonlPath: join(dir, 'results.jsonl'),
          resultsTsvPath: join(dir, 'results.tsv'),
          tasks: [
            { id: 'task-a', path: '/bench/task-a' },
            { id: 'task-a', path: '/bench/task-a-copy' },
          ],
          harborRunner: async ({ task }) => {
            calls.push(task.id);
            return harborOutput({ taskId: task.id });
          },
          now: () => 100,
          newId: idFactory(),
        }),
        /tasks contain duplicate id\(s\): task-a/,
      );
      assert.deepEqual(calls, []);
    });
  });

  test('preserves infra stop after WAL resume', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      await appendFile(resultsJsonlPath, `${JSON.stringify(taskInfraFailedEvent({ taskId: 'task-a' }))}\n`, 'utf8');
      await appendFile(resultsJsonlPath, `${JSON.stringify(taskInfraFailedEvent({ taskId: 'task-b' }))}\n`, 'utf8');

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
          { id: 'task-c', path: '/bench/task-c' },
          { id: 'task-d', path: '/bench/task-d' },
          { id: 'task-e', path: '/bench/task-e' },
        ],
        maxInfraFailureRate: 0.2,
        harborRunner: async ({ task }) => {
          calls.push(task.id);
          return harborOutput({ taskId: task.id });
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.deepEqual(calls, []);
      assert.equal(result.stopReason, 'infra_failure_rate_exceeded');
      assert.deepEqual(result.taskIds, ['task-a', 'task-b']);
    });
  });

  test('stops when cost exceeds the configured ceiling', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

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
          { id: 'task-c', path: '/bench/task-c' },
        ],
        costCeilingUsd: 0.03,
        harborRunner: async ({ task }) => {
          calls.push(task.id);
          return harborOutput({
            taskId: task.id,
            tokenSummary: tokenSummary({ input: 1, output: 2, reasoning: 0, total: 3, costUsd: 0.02 }),
          });
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.deepEqual(calls, ['task-a', 'task-b']);
      assert.equal(result.stopReason, 'cost_ceiling_exceeded');
      assert.equal(result.totalCostUsd, 0.04);
      assert.deepEqual(result.taskIds, ['task-a', 'task-b']);
    });
  });

  test('checks the cost ceiling between tasks even when concurrency is configured', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      let inFlight = 0;
      let maxInFlight = 0;
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
          { id: 'task-c', path: '/bench/task-c' },
        ],
        maxConcurrency: 3,
        costCeilingUsd: 0.03,
        harborRunner: async ({ task }) => {
          calls.push(task.id);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await delay(1);
          inFlight -= 1;
          return harborOutput({
            taskId: task.id,
            tokenSummary: tokenSummary({ input: 1, output: 2, reasoning: 0, total: 3, costUsd: 0.02 }),
          });
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(maxInFlight, 1);
      assert.deepEqual(calls, ['task-a', 'task-b']);
      assert.equal(result.stopReason, 'cost_ceiling_exceeded');
      assert.equal(result.totalCostUsd, 0.04);
      assert.deepEqual(result.taskIds, ['task-a', 'task-b']);
    });
  });

  test('preserves cost stop after WAL resume at the configured ceiling', async () => {
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
        costCeilingUsd: 0.01,
        harborRunner: async ({ task }) => {
          calls.push(task.id);
          return harborOutput({ taskId: task.id });
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.deepEqual(calls, []);
      assert.equal(result.stopReason, 'cost_ceiling_exceeded');
      assert.equal(result.totalCostUsd, 0.01);
      assert.deepEqual(result.taskIds, ['task-a']);
    });
  });

  test('runs concurrent tasks while recording deterministic task order', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');

      let inFlight = 0;
      let maxInFlight = 0;
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
          { id: 'task-c', path: '/bench/task-c' },
        ],
        maxConcurrency: 2,
        harborRunner: async ({ task }) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await delay(task.id === 'task-a' ? 20 : 0);
          inFlight -= 1;
          return harborOutput({ taskId: task.id });
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(maxInFlight, 2);
      assert.deepEqual(result.taskIds, ['task-a', 'task-b', 'task-c']);
      const events = (await readFile(resultsJsonlPath, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(events.map((event) => event.taskId), ['task-a', 'task-b', 'task-c']);
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
            tokenSummary: tokenSummary({ input: 2, output: 1, reasoning: 0, total: 3, costUsd: 0 }),
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
            tokenSummary: tokenSummary({ input: 0, output: 0, reasoning: 0, total: 0, costUsd: 0 }),
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
    tokenSummary: tokenSummary({ input: 2, output: 3, reasoning: 0, total: 5, costUsd: 0.01 }),
    steps: 4,
    durationMs: 50,
    runtimeEventsPath: `/logs/${input.taskId}/runtime-events.jsonl`,
    traceEventsPath: `/logs/${input.taskId}/events.jsonl`,
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
      traceEventsPath: `/logs/${input.taskId}/events.jsonl`,
      ...(input.omitPromptHash ? {} : { promptHash: input.promptHash ?? hashSystemPrompt('fixed prompt\n') }),
      tokenSummary: input.tokenSummary ?? tokenSummary({ input: 1, output: 2, reasoning: 0, total: 3, costUsd: 0.02 }),
      toolSummary: {
        providerVisibleToolCount: 0,
        actualToolCalls: 0,
        actualToolNames: [],
        actualToolCallCounts: {},
      },
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

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'maka-fixed-prompt-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
