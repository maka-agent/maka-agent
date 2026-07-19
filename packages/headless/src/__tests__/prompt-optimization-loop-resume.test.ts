import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { readFixedPromptWal } from '../fixed-prompt-controller.js';
import {
  execFileAsync,
  fakeMetaAgent,
  makeTasks,
  runLoop,
  taskIndex,
  withHarness,
} from './helpers/prompt-optimization-loop-harness.js';

describe('runPromptOptimizationLoop resume replay', () => {
  test('resumes after a decided candidate and continues with the next round', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return index < 4 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        return roundId === 'round-0' ? 1 : 0;
      };

      const first = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 1,
      });
      assert.deepEqual(
        first.decisions.map((decision) => decision.decision),
        ['keep'],
      );

      const resumedMetaAgentRounds: string[] = [];
      const resumedTaskRuns: string[] = [];
      const resumed = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 2,
        baselineRuns: 1,
        onTaskRun: (roundId, taskId) => resumedTaskRuns.push(`${roundId}:${taskId}`),
        metaAgent: async (promptInput) => {
          resumedMetaAgentRounds.push(promptInput.roundId);
          return fakeMetaAgent()(promptInput);
        },
      });

      assert.deepEqual(resumedMetaAgentRounds, ['round-1']);
      assert.deepEqual(
        resumed.decisions.map((decision) => decision.decision),
        ['keep', 'discard'],
      );
      assert.equal(resumed.keptCount, 1);
      assert.equal(resumed.stopReason, 'rounds_complete');
      assert.equal(resumed.smoke.status, 'pass');
      assert.ok(Math.abs(resumed.totalCostUsd - resumed.smoke.totalCostUsd) < 1e-9);
      assert.ok(
        resumedTaskRuns.every((call) => call.startsWith('round-1:')),
        `unexpected resumed task runs: ${JSON.stringify(resumedTaskRuns)}`,
      );

      const events = await readFixedPromptWal(harness.resultsJsonlPath);
      assert.equal(
        events.filter(
          (event) => event.type === 'prompt_candidate_decided' && event.roundId === 'round-0',
        ).length,
        1,
      );
      assert.equal(
        events.filter(
          (event) => event.type === 'prompt_candidate_decided' && event.roundId === 'round-1',
        ).length,
        1,
      );
    });
  });

  test('resumes after a committed candidate and finishes that round', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return index < 4 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        return 1;
      };

      await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 1,
      });
      const events = await readFixedPromptWal(harness.resultsJsonlPath);
      const commitIndex = events.findIndex(
        (event) => event.type === 'prompt_candidate_committed' && event.roundId === 'round-0',
      );
      assert.ok(commitIndex > -1);
      await writeFile(
        harness.resultsJsonlPath,
        `${events
          .slice(0, commitIndex + 1)
          .map((event) => JSON.stringify(event))
          .join('\n')}\n`,
        'utf8',
      );

      const resumedMetaAgentRounds: string[] = [];
      const resumed = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 1,
        metaAgent: async (promptInput) => {
          resumedMetaAgentRounds.push(promptInput.roundId);
          return fakeMetaAgent()(promptInput);
        },
      });

      assert.deepEqual(resumedMetaAgentRounds, []);
      assert.deepEqual(
        resumed.decisions.map((decision) => decision.decision),
        ['keep'],
      );
      assert.equal(resumed.smoke.status, 'pass');
      const resumedEvents = await readFixedPromptWal(harness.resultsJsonlPath);
      assert.equal(
        resumedEvents.filter(
          (event) => event.type === 'prompt_candidate_committed' && event.roundId === 'round-0',
        ).length,
        1,
      );
      assert.equal(
        resumedEvents.filter(
          (event) => event.type === 'prompt_candidate_decided' && event.roundId === 'round-0',
        ).length,
        1,
      );
    });
  });

  test('resumes after a committed candidate and discards back to the seed commit', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return index < 4 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        return 0;
      };

      await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 1,
      });
      const events = await readFixedPromptWal(harness.resultsJsonlPath);
      const committed = events.find(
        (event): event is Extract<typeof event, { type: 'prompt_candidate_committed' }> =>
          event.type === 'prompt_candidate_committed' && event.roundId === 'round-0',
      );
      assert.ok(committed);
      const commitIndex = events.indexOf(committed);
      await writeFile(
        harness.resultsJsonlPath,
        `${events
          .slice(0, commitIndex + 1)
          .map((event) => JSON.stringify(event))
          .join('\n')}\n`,
        'utf8',
      );
      await execFileAsync('git', ['reset', '--hard', committed.commitSha], {
        cwd: harness.repoDir,
      });

      const resumed = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 1,
      });

      assert.deepEqual(
        resumed.decisions.map((decision) => decision.decision),
        ['discard'],
      );
      assert.equal(resumed.decisions[0]?.previousLastKeptCommitSha, harness.originalCommitSha);
      assert.equal(resumed.lastKeptCommitSha, harness.originalCommitSha);
      const head = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: harness.repoDir })
      ).stdout.trim();
      assert.equal(head, harness.originalCommitSha);
      const resumedEvents = await readFixedPromptWal(harness.resultsJsonlPath);
      const decision = resumedEvents.find(
        (event): event is Extract<typeof event, { type: 'prompt_candidate_decided' }> =>
          event.type === 'prompt_candidate_decided' && event.roundId === 'round-0',
      );
      assert.equal(decision?.lastKeptCommitSha, harness.originalCommitSha);
    });
  });

  test('resumes after discard rollback happened before the decision was written', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return index < 4 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        return 0;
      };

      await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 1,
      });
      const events = await readFixedPromptWal(harness.resultsJsonlPath);
      const tornEvents = events.filter(
        (event) =>
          !(event.type === 'prompt_candidate_decided' && event.roundId === 'round-0') &&
          !(event.type === 'rsi_controller_attribution' && event.roundId === 'round-0'),
      );
      await writeFile(
        harness.resultsJsonlPath,
        `${tornEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );
      const rolledBackHead = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: harness.repoDir })
      ).stdout.trim();
      assert.equal(rolledBackHead, harness.originalCommitSha);

      const resumedMetaAgentRounds: string[] = [];
      const resumed = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 1,
        metaAgent: async (promptInput) => {
          resumedMetaAgentRounds.push(promptInput.roundId);
          return fakeMetaAgent()(promptInput);
        },
      });

      assert.deepEqual(resumedMetaAgentRounds, []);
      assert.deepEqual(
        resumed.decisions.map((decision) => decision.decision),
        ['discard'],
      );
      assert.equal(resumed.lastKeptCommitSha, harness.originalCommitSha);
      const head = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: harness.repoDir })
      ).stdout.trim();
      assert.equal(head, harness.originalCommitSha);
    });
  });

  test('resumes a pre-held-out budget stop after candidate rollback', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return index < 4 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        return 1;
      };

      const stopped = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 2,
        costCeilingUsd: 1.5,
      });
      assert.equal(stopped.stopReason, 'cost_ceiling_exceeded');
      assert.deepEqual(stopped.decisions, []);
      const rolledBackHead = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: harness.repoDir })
      ).stdout.trim();
      assert.equal(rolledBackHead, harness.originalCommitSha);

      const resumedMetaAgentRounds: string[] = [];
      const resumedTaskRuns: string[] = [];
      const resumed = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 2,
        costCeilingUsd: 10,
        onTaskRun: (roundId, taskId) => resumedTaskRuns.push(`${roundId}:${taskId}`),
        metaAgent: async (promptInput) => {
          resumedMetaAgentRounds.push(promptInput.roundId);
          return fakeMetaAgent()(promptInput);
        },
      });

      assert.deepEqual(resumedMetaAgentRounds, []);
      assert.deepEqual(
        resumed.decisions.map((decision) => decision.decision),
        ['keep'],
      );
      assert.equal(resumed.stopReason, 'rounds_complete');
      assert.ok(
        resumedTaskRuns.every((call) => call.startsWith('round-0:hout-')),
        `unexpected resumed task runs: ${JSON.stringify(resumedTaskRuns)}`,
      );
    });
  });

  test('rebuilds held-in TSV from WAL before prompting the next resumed round', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return index < 4 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        return roundId === 'round-0' ? 1 : 0;
      };

      await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 1,
      });
      await rm(harness.heldInResultsTsvPath, { force: true });

      let roundOneResultsTsv = '';
      let diskHeldInTsvDuringPrompt = '';
      const resumed = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 2,
        baselineRuns: 1,
        metaAgent: async (promptInput) => {
          if (promptInput.roundId === 'round-1') {
            roundOneResultsTsv = promptInput.resultsTsv;
            diskHeldInTsvDuringPrompt = await readFile(harness.heldInResultsTsvPath, 'utf8');
          }
          return fakeMetaAgent()(promptInput);
        },
      });

      assert.deepEqual(
        resumed.decisions.map((decision) => decision.decision),
        ['keep', 'discard'],
      );
      assert.match(roundOneResultsTsv, /^task_id\tstatus\tpassed\t/);
      assert.match(roundOneResultsTsv, /hin-0\t/);
      assert.doesNotMatch(roundOneResultsTsv, /hout-0\t/);
      assert.match(diskHeldInTsvDuringPrompt, /hin-0\t/);
      assert.doesNotMatch(diskHeldInTsvDuringPrompt, /hout-0\t/);
    });
  });
});
