import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Config } from '../contracts.js';
import { hashSystemPrompt } from '../fixed-prompt-controller.js';
import { runPromptAbComparison } from '../prompt-ab-run.js';
import { harborOutput, idFactory } from './helpers/ab-run-fixtures.js';
import { withDir } from './helpers/temp-dir.js';

const config: Config = {
  id: 'cfg-ab',
  backend: 'fake',
  llmConnectionSlug: 'fake',
  model: 'fake-model',
};

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
      assert.equal(calls.length, 8);
      assert.deepEqual(calls.slice(0, 2).sort(), ['ab-baseline-r0-t1:t1', 'ab-candidate-r0-t1:t1']);
      assert.deepEqual(calls.slice(2, 4).sort(), ['ab-baseline-r0-t2:t2', 'ab-candidate-r0-t2:t2']);
      assert.deepEqual(calls.slice(4, 6).sort(), ['ab-baseline-r1-t1:t1', 'ab-candidate-r1-t1:t1']);
      assert.deepEqual(calls.slice(6, 8).sort(), ['ab-baseline-r1-t2:t2', 'ab-candidate-r1-t2:t2']);
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
      assert.deepEqual(firstCalls.sort(), ['ab-baseline-r0-t1:t1', 'ab-candidate-r0-t1:t1']);

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
      assert.deepEqual(changedCalls.sort(), ['ab-baseline-r0-t1:t1', 'ab-candidate-r0-t1:t1']);
    });
  });
});
