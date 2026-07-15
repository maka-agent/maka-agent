import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { hashHarborSystemPrompt, type HarborCellOutput } from '../cell-output.js';
import type { HarborTaskRunner } from '../fixed-prompt-controller.js';
import { runHarnessAbComparison } from '../harness-ab-run.js';
import { tokenSummary } from './helpers/cell-output-fixtures.js';

describe('runHarnessAbComparison', () => {
  test('extends a completed prefix without rerunning valid cells', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-'));
    try {
      const promptPath = join(dir, 'empty-system-prompt.txt');
      const resultsPath = join(dir, 'results.jsonl');
      await writeFile(promptPath, '', 'utf8');
      const calls: string[] = [];
      const arms = [
        harnessArm('maka', calls),
        harnessArm('opencode', calls),
      ] as const;
      const tasks = ['a', 'b', 'c'].map((id) => ({ id, path: `/tasks/${id}` }));
      const common = {
        runId: 'glm-harness-ab',
        runRoot: dir,
        resultsJsonlPath: resultsPath,
        systemPromptPath: promptPath,
        resumeFingerprint: 'sha256:manifest',
        arms,
      };

      const pilot = await runHarnessAbComparison({ ...common, evaluationTasks: tasks.slice(0, 2) });
      assert.equal(pilot.baseline.observed, 2);
      assert.equal(pilot.candidate.observed, 2);
      assert.deepEqual(calls, ['a:maka', 'a:opencode', 'b:opencode', 'b:maka']);

      const full = await runHarnessAbComparison({ ...common, evaluationTasks: tasks });
      assert.equal(full.baseline.observed, 3);
      assert.equal(full.candidate.observed, 3);
      assert.deepEqual(calls, [
        'a:maka', 'a:opencode', 'b:opencode', 'b:maka',
        'c:maka', 'c:opencode',
      ]);
      assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.tsv')), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects a concurrent writer for the same run root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-lock-'));
    try {
      const promptPath = join(dir, 'empty-system-prompt.txt');
      await writeFile(promptPath, '', 'utf8');
      let release!: () => void;
      let started!: () => void;
      const startedPromise = new Promise<void>((resolve) => { started = resolve; });
      const releasePromise = new Promise<void>((resolve) => { release = resolve; });
      const calls: string[] = [];
      const input = {
        runId: 'glm-harness-ab',
        runRoot: dir,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        systemPromptPath: promptPath,
        resumeFingerprint: 'sha256:manifest',
        evaluationTasks: [{ id: 'a', path: '/tasks/a' }],
        arms: [
          harnessArm('maka', calls, async () => {
            started();
            await releasePromise;
          }),
          harnessArm('opencode', calls),
        ] as const,
      };

      const active = runHarnessAbComparison(input);
      await startedPromise;
      await assert.rejects(runHarnessAbComparison(input), /A\/B run is already active/);
      release();
      await active;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('treats infrastructure failure as the single terminal harness attempt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-harness-ab-single-attempt-'));
    try {
      const promptPath = join(dir, 'empty-system-prompt.txt');
      await writeFile(promptPath, '', 'utf8');
      let failingAttempts = 0;
      const calls: string[] = [];
      const failingArm = harnessArm('maka', calls);
      failingArm.harborRunner = async () => {
        failingAttempts += 1;
        throw new Error('container failed after launch');
      };
      const input = {
        runId: 'glm-harness-ab',
        runRoot: dir,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        systemPromptPath: promptPath,
        resumeFingerprint: 'sha256:manifest',
        evaluationTasks: [{ id: 'a', path: '/tasks/a' }],
        arms: [failingArm, harnessArm('opencode', calls)] as const,
      };

      const first = await runHarnessAbComparison(input);
      assert.equal(failingAttempts, 1);
      assert.equal(first.baseline.infraFailed, 1);

      await runHarnessAbComparison(input);
      assert.equal(failingAttempts, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function harnessArm(id: 'maka' | 'opencode', calls: string[], beforeRun?: () => Promise<void>) {
  const config = {
    id: `harness-${id}`,
    backend: 'ai-sdk' as const,
    llmConnectionSlug: 'zai-coding-plan',
    model: 'glm-5.2',
  };
  const harborRunner: HarborTaskRunner = async ({ task, systemPrompt }) => {
    await beforeRun?.();
    calls.push(`${task.id}:${id}`);
    const promptHash = hashHarborSystemPrompt(systemPrompt);
    const cell: HarborCellOutput = {
      schemaVersion: 1,
      status: 'completed',
      runtimeEventsPath: `/artifacts/${id}/${task.id}.jsonl`,
      promptHash,
      executionIdentity: {
        llmConnectionSlug: config.llmConnectionSlug,
        model: config.model,
        systemPromptHash: promptHash,
        pricingProfile: 'glm-5.2-public-2026-07-13',
      },
      tokenSummary: tokenSummary({ input: 100, output: 10, reasoning: 0, total: 110, costUsd: 0.000184 }),
      toolSummary: {
        providerVisibleToolCount: 1,
        actualToolCalls: 1,
        actualToolNames: ['bash'],
        actualToolCallCounts: { bash: 1 },
      },
      steps: 1,
      durationMs: 10,
      startedAt: 0,
      finishedAt: 10,
      runtimeRefs: {
        invocationId: `${id}-${task.id}`,
        sessionId: `${id}-${task.id}`,
        runId: `${id}-${task.id}`,
        turnId: `${id}-${task.id}`,
      },
    };
    return { harbor: { reward: id === 'maka' ? 1 : 0 }, cell };
  };
  return {
    id,
    config,
    expectedPricingProfile: 'glm-5.2-public-2026-07-13',
    harborRunner,
  };
}
