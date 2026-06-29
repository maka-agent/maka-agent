import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, test } from 'node:test';
import { hashSystemPrompt, readFixedPromptWal, type HarborTaskRunInput, type HarborTaskRunOutput } from '../fixed-prompt-controller.js';
import { createCliPromptCandidateGit, type MetaAgent, type MetaAgentPromptInput } from '../prompt-candidate-loop.js';
import { runPromptOptimizationLoop, type PromptOptimizationLoopInput } from '../prompt-optimization-loop.js';
import type { Config } from '../contracts.js';
import { tokenSummary } from './helpers/cell-output-fixtures.js';

const execFileAsync = promisify(execFile);

const CONFIG: Config = { id: 'cfg', backend: 'fake', llmConnectionSlug: 'deepseek' };
const COST_PER_TASK = 0.02;

describe('runPromptOptimizationLoop', () => {
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
      assert.deepEqual(first.decisions.map((decision) => decision.decision), ['keep']);

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
      assert.deepEqual(resumed.decisions.map((decision) => decision.decision), ['keep', 'discard']);
      assert.equal(resumed.keptCount, 1);
      assert.equal(resumed.stopReason, 'rounds_complete');
      assert.equal(resumed.smoke.status, 'pass');
      assert.ok(Math.abs(resumed.totalCostUsd - resumed.smoke.totalCostUsd) < 1e-9);
      assert.ok(
        resumedTaskRuns.every((call) => call.startsWith('round-1:')),
        `unexpected resumed task runs: ${JSON.stringify(resumedTaskRuns)}`,
      );

      const events = await readFixedPromptWal(harness.resultsJsonlPath);
      assert.equal(events.filter((event) => event.type === 'prompt_candidate_decided' && event.roundId === 'round-0').length, 1);
      assert.equal(events.filter((event) => event.type === 'prompt_candidate_decided' && event.roundId === 'round-1').length, 1);
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
      const commitIndex = events.findIndex((event) => event.type === 'prompt_candidate_committed' && event.roundId === 'round-0');
      assert.ok(commitIndex > -1);
      await writeFile(
        harness.resultsJsonlPath,
        `${events.slice(0, commitIndex + 1).map((event) => JSON.stringify(event)).join('\n')}\n`,
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
      assert.deepEqual(resumed.decisions.map((decision) => decision.decision), ['keep']);
      assert.equal(resumed.smoke.status, 'pass');
      const resumedEvents = await readFixedPromptWal(harness.resultsJsonlPath);
      assert.equal(resumedEvents.filter((event) => event.type === 'prompt_candidate_committed' && event.roundId === 'round-0').length, 1);
      assert.equal(resumedEvents.filter((event) => event.type === 'prompt_candidate_decided' && event.roundId === 'round-0').length, 1);
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
      const committed = events.find((event): event is Extract<typeof event, { type: 'prompt_candidate_committed' }> =>
        event.type === 'prompt_candidate_committed' && event.roundId === 'round-0');
      assert.ok(committed);
      const commitIndex = events.indexOf(committed);
      await writeFile(
        harness.resultsJsonlPath,
        `${events.slice(0, commitIndex + 1).map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );
      await execFileAsync('git', ['reset', '--hard', committed.commitSha], { cwd: harness.repoDir });

      const resumed = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 1,
      });

      assert.deepEqual(resumed.decisions.map((decision) => decision.decision), ['discard']);
      assert.equal(resumed.decisions[0]?.previousLastKeptCommitSha, harness.originalCommitSha);
      assert.equal(resumed.lastKeptCommitSha, harness.originalCommitSha);
      const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: harness.repoDir })).stdout.trim();
      assert.equal(head, harness.originalCommitSha);
      const resumedEvents = await readFixedPromptWal(harness.resultsJsonlPath);
      const decision = resumedEvents.find((event): event is Extract<typeof event, { type: 'prompt_candidate_decided' }> =>
        event.type === 'prompt_candidate_decided' && event.roundId === 'round-0');
      assert.equal(decision?.lastKeptCommitSha, harness.originalCommitSha);
    });
  });

  test('fails closed when replayed prompt decisions belong to a different resume fingerprint', async () => {
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
        resumeFingerprint: 'fingerprint-old',
      });

      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 2,
          baselineRuns: 1,
          resumeFingerprint: 'fingerprint-new',
        }),
        /RSI WAL replay identity mismatch/,
      );
    });
  });

  test('fails closed when replayed candidate task evidence has a stale prompt hash', async () => {
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
      const staleEvents = events.map((event) => (
        event.type === 'task_completed' && event.roundId === 'round-0' && event.taskId === 'hin-0'
          ? { ...event, promptHash: 'sha256:stale' }
          : event
      ));
      await writeFile(
        harness.resultsJsonlPath,
        `${staleEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );

      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 2,
          baselineRuns: 1,
        }),
        /RSI WAL replay prompt hash mismatch/,
      );
    });
  });

  test('fails closed when replayed baseline task evidence has a stale prompt hash', async () => {
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
      const staleEvents = events.map((event) => (
        event.type === 'task_completed' && event.roundId === 'baseline-0' && event.taskId === 'hin-0'
          ? { ...event, promptHash: 'sha256:stale' }
          : event
      ));
      await writeFile(
        harness.resultsJsonlPath,
        `${staleEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );

      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 2,
          baselineRuns: 1,
        }),
        /RSI WAL replay prompt hash mismatch/,
      );
    });
  });

  test('fails closed when replayed baseline task evidence has duplicate task ids', async () => {
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
      const duplicate = events.find((event) =>
        event.type === 'task_completed' && event.roundId === 'baseline-0' && event.taskId === 'hin-0');
      assert.ok(duplicate);
      await writeFile(
        harness.resultsJsonlPath,
        `${[...events, duplicate].map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );

      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 2,
          baselineRuns: 1,
        }),
        /RSI WAL replay duplicate task event/,
      );
    });
  });

  test('fails closed when replaying task evidence without a resume fingerprint', async () => {
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
        resumeFingerprint: null,
      });

      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 2,
          baselineRuns: 1,
          resumeFingerprint: null,
        }),
        /RSI WAL replay requires a resume fingerprint/,
      );
    });
  });

  test('fails closed when task source changes under the same task ids', async () => {
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
        resumeFingerprint: 'task-source-v1',
      });

      await assert.rejects(
        runLoop(harness, {
          heldInTasks: heldInTasks.map((task) => ({ ...task, path: `${task.path}-changed` })),
          heldOutTasks: heldOutTasks.map((task) => ({ ...task, path: `${task.path}-changed` })),
          rewardFor,
          rounds: 2,
          baselineRuns: 1,
          resumeFingerprint: 'task-source-v2',
        }),
        /RSI WAL replay identity mismatch/,
      );
    });
  });

  test('fails closed instead of rerunning baseline when later WAL history exists', async () => {
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
      const missingBaseline = events.filter((event) =>
        !(event.type === 'task_completed' && event.roundId === 'baseline-0' && event.taskId === 'hin-0'));
      await writeFile(
        harness.resultsJsonlPath,
        `${missingBaseline.map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );

      const rerunAttempts: string[] = [];
      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 2,
          baselineRuns: 1,
          onTaskRun: (roundId, taskId) => rerunAttempts.push(`${roundId}:${taskId}`),
        }),
        /RSI WAL replay missing required baseline held-in evidence for baseline-0/,
      );
      assert.deepEqual(rerunAttempts, []);
    });
  });

  test('fails closed when a kept decision is missing held-out task evidence', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return index < 4 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        return taskId.startsWith('hin-') ? 1 : (index < 4 ? 1 : 0);
      };

      await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 1,
      });
      const events = await readFixedPromptWal(harness.resultsJsonlPath);
      const missingHeldOut = events.filter((event) =>
        !(event.type === 'task_completed' && event.roundId === 'round-0' && event.taskId.startsWith('hout-')));
      await writeFile(
        harness.resultsJsonlPath,
        `${missingHeldOut.map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );

      let nextRoundPrompted = false;
      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 2,
          baselineRuns: 1,
          metaAgent: async (promptInput) => {
            if (promptInput.roundId === 'round-1') nextRoundPrompted = true;
            return fakeMetaAgent()(promptInput);
          },
        }),
        /RSI WAL replay missing required held-out task evidence for round-0/,
      );
      assert.equal(nextRoundPrompted, false);
    });
  });

  test('fails closed when a held-out regression decision is missing held-out task evidence', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return roundId.startsWith('baseline-') && index < 4 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        return 1;
      };

      const first = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 1,
        baselineRuns: 1,
      });
      assert.equal(first.decisions[0]?.reason, 'held_out_regressed');
      const events = await readFixedPromptWal(harness.resultsJsonlPath);
      const missingHeldOut = events.filter((event) =>
        !(event.type === 'task_completed' && event.roundId === 'round-0' && event.taskId.startsWith('hout-')));
      await writeFile(
        harness.resultsJsonlPath,
        `${missingHeldOut.map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );

      let nextRoundPrompted = false;
      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 2,
          baselineRuns: 1,
          metaAgent: async (promptInput) => {
            if (promptInput.roundId === 'round-1') nextRoundPrompted = true;
            return fakeMetaAgent()(promptInput);
          },
        }),
        /RSI WAL replay missing required held-out task evidence for round-0/,
      );
      assert.equal(nextRoundPrompted, false);
    });
  });

  test('fails closed when a replayed decision is missing reward-hack scan evidence', async () => {
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
      const withoutScan = events.map((event) => {
        if (event.type !== 'prompt_candidate_decided' || event.roundId !== 'round-0') return event;
        const { rewardHackScan: _rewardHackScan, ...withoutRewardHackScan } = event;
        return withoutRewardHackScan;
      });
      await writeFile(
        harness.resultsJsonlPath,
        `${withoutScan.map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );

      let nextRoundPrompted = false;
      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 2,
          baselineRuns: 1,
          metaAgent: async (promptInput) => {
            if (promptInput.roundId === 'round-1') nextRoundPrompted = true;
            return fakeMetaAgent()(promptInput);
          },
        }),
        /RSI WAL replay missing reward-hack scan evidence for round-0/,
      );
      assert.equal(nextRoundPrompted, false);
    });
  });

  test('fails closed when a replayed decision disagrees with task evidence', async () => {
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
      const tamperedDecision = events.map((event) => (
        event.type === 'prompt_candidate_decided' && event.roundId === 'round-0'
          ? { ...event, metrics: { tampered: true } }
          : event
      ));
      await writeFile(
        harness.resultsJsonlPath,
        `${tamperedDecision.map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );

      let nextRoundPrompted = false;
      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 2,
          baselineRuns: 1,
          metaAgent: async (promptInput) => {
            if (promptInput.roundId === 'round-1') nextRoundPrompted = true;
            return fakeMetaAgent()(promptInput);
          },
        }),
        /RSI WAL replay decision mismatch for round-0/,
      );
      assert.equal(nextRoundPrompted, false);
    });
  });

  test('fails closed when a replayed decision is missing RSI attribution evidence', async () => {
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
      const withoutAttribution = events.filter((event) =>
        !(event.type === 'rsi_controller_attribution' && event.roundId === 'round-0'));
      await writeFile(
        harness.resultsJsonlPath,
        `${withoutAttribution.map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );

      let nextRoundPrompted = false;
      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 2,
          baselineRuns: 1,
          metaAgent: async (promptInput) => {
            if (promptInput.roundId === 'round-1') nextRoundPrompted = true;
            return fakeMetaAgent()(promptInput);
          },
        }),
        /RSI WAL replay missing post-decision RSI attribution evidence for round-0/,
      );
      assert.equal(nextRoundPrompted, false);
    });
  });

  test('fails closed when RSI attribution appears before its decision', async () => {
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
      const attributionIndex = events.findIndex((event) =>
        event.type === 'rsi_controller_attribution' && event.roundId === 'round-0');
      const decisionIndex = events.findIndex((event) =>
        event.type === 'prompt_candidate_decided' && event.roundId === 'round-0');
      assert.ok(attributionIndex > decisionIndex);
      const attribution = events[attributionIndex]!;
      const withoutAttribution = events.filter((_event, index) => index !== attributionIndex);
      const decisionIndexAfterRemoval = withoutAttribution.findIndex((event) =>
        event.type === 'prompt_candidate_decided' && event.roundId === 'round-0');
      const attributionBeforeDecision = [
        ...withoutAttribution.slice(0, decisionIndexAfterRemoval),
        attribution,
        ...withoutAttribution.slice(decisionIndexAfterRemoval),
      ];
      await writeFile(
        harness.resultsJsonlPath,
        `${attributionBeforeDecision.map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );

      let nextRoundPrompted = false;
      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 2,
          baselineRuns: 1,
          metaAgent: async (promptInput) => {
            if (promptInput.roundId === 'round-1') nextRoundPrompted = true;
            return fakeMetaAgent()(promptInput);
          },
        }),
        /RSI WAL replay found RSI attribution before decision for round-0/,
      );
      assert.equal(nextRoundPrompted, false);
    });
  });

  test('fails closed when RSI attribution appears after the next candidate', async () => {
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
        rounds: 2,
        baselineRuns: 1,
      });
      const events = await readFixedPromptWal(harness.resultsJsonlPath);
      const attributionIndex = events.findIndex((event) =>
        event.type === 'rsi_controller_attribution' && event.roundId === 'round-0');
      const nextCandidateIndex = events.findIndex((event) =>
        event.type === 'prompt_candidate_committed' && event.roundId === 'round-1');
      assert.ok(attributionIndex > -1);
      assert.ok(nextCandidateIndex > attributionIndex);
      const attribution = events[attributionIndex]!;
      const withoutAttribution = events.filter((_event, index) => index !== attributionIndex);
      const nextCandidateIndexAfterRemoval = withoutAttribution.findIndex((event) =>
        event.type === 'prompt_candidate_committed' && event.roundId === 'round-1');
      const attributionAfterNextCandidate = [
        ...withoutAttribution.slice(0, nextCandidateIndexAfterRemoval + 1),
        attribution,
        ...withoutAttribution.slice(nextCandidateIndexAfterRemoval + 1),
      ];
      await writeFile(
        harness.resultsJsonlPath,
        `${attributionAfterNextCandidate.map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );
      const candidateCommitCountBefore = attributionAfterNextCandidate.filter((event) =>
        event.type === 'prompt_candidate_committed').length;

      let laterRoundPrompted = false;
      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 3,
          baselineRuns: 1,
          metaAgent: async (promptInput) => {
            if (promptInput.roundId === 'round-2') laterRoundPrompted = true;
            return fakeMetaAgent()(promptInput);
          },
        }),
        /RSI WAL replay missing post-decision RSI attribution evidence for round-0/,
      );
      assert.equal(laterRoundPrompted, false);
      const eventsAfterResume = await readFixedPromptWal(harness.resultsJsonlPath);
      assert.equal(
        eventsAfterResume.filter((event) => event.type === 'prompt_candidate_committed').length,
        candidateCommitCountBefore,
      );
      assert.equal(eventsAfterResume.some((event) =>
        event.type === 'prompt_candidate_committed' && event.roundId === 'round-2'), false);
    });
  });

  test('fails closed before prompting when replayed RSI attribution leaks held-out scope', async () => {
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
      const tamperedAttribution = events.map((event) => (
        event.type === 'rsi_controller_attribution' && event.roundId === 'round-0'
          ? { ...event, predictedFixes: [{ taskId: 'hout-0', outcome: 'improved' }] }
          : event
      ));
      await writeFile(
        harness.resultsJsonlPath,
        `${tamperedAttribution.map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );

      let nextRoundPrompted = false;
      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 2,
          baselineRuns: 1,
          metaAgent: async (promptInput) => {
            if (promptInput.roundId === 'round-1') nextRoundPrompted = true;
            return fakeMetaAgent()(promptInput);
          },
        }),
        /RSI WAL replay invalid RSI attribution evidence for round-0/,
      );
      assert.equal(nextRoundPrompted, false);
    });
  });

  test('fails closed when prompt repo HEAD disagrees with WAL replay state', async () => {
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
      const commitIndex = events.findIndex((event) =>
        event.type === 'prompt_candidate_committed' && event.roundId === 'round-0');
      assert.ok(commitIndex > -1);
      await writeFile(
        harness.resultsJsonlPath,
        `${events.slice(0, commitIndex + 1).map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );
      await execFileAsync('git', ['reset', '--hard', harness.originalCommitSha], { cwd: harness.repoDir });

      const taskRuns: string[] = [];
      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 1,
          baselineRuns: 1,
          onTaskRun: (roundId, taskId) => taskRuns.push(`${roundId}:${taskId}`),
        }),
        /prompt repo HEAD does not match resumed RSI WAL state/,
      );
      assert.deepEqual(taskRuns, []);
    });
  });

  test('fails closed before baseline when prompt files are dirty', async () => {
    await withHarness(async (harness) => {
      const taskRuns: string[] = [];
      await writeFile(harness.systemPromptPath, 'dirty prompt\n', 'utf8');

      await assert.rejects(
        runLoop(harness, {
          heldInTasks: makeTasks('hin', 2),
          heldOutTasks: makeTasks('hout', 1),
          rewardFor: () => 1,
          rounds: 1,
          baselineRuns: 1,
          onTaskRun: (roundId, taskId) => taskRuns.push(`${roundId}:${taskId}`),
        }),
        /prompt repo has uncommitted prompt file changes/,
      );
      assert.deepEqual(taskRuns, []);
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

      assert.deepEqual(resumed.decisions.map((decision) => decision.decision), ['keep', 'discard']);
      assert.match(roundOneResultsTsv, /^task_id\tstatus\tpassed\t/);
      assert.match(roundOneResultsTsv, /hin-0\t/);
      assert.doesNotMatch(roundOneResultsTsv, /hout-0\t/);
      assert.match(diskHeldInTsvDuringPrompt, /hin-0\t/);
      assert.doesNotMatch(diskHeldInTsvDuringPrompt, /hout-0\t/);
    });
  });

  test('keeps an improving candidate, discards a regressing one, and reports a passing smoke', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      // baseline held-in 0.5; round-0 jumps to 1.0 (KEEP); round-1 collapses to
      // 0.0 (DISCARD). Held-out stays flat at 0.5 so it never gates.
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return index < 4 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        return roundId === 'round-0' ? 1 : 0;
      };

      const result = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 2,
        baselineRuns: 2,
      });

      assert.equal(result.decisions.length, 2);
      assert.equal(result.decisions[0]?.decision, 'keep');
      assert.equal(result.decisions[0]?.reason, 'held_in_improved');
      assert.equal(result.decisions[1]?.decision, 'discard');
      assert.equal(result.decisions[1]?.reason, 'held_in_regressed');
      assert.equal(result.keptCount, 1);
      assert.equal(result.stopReason, 'rounds_complete');

      // The kept lineage is round-0's candidate; round-1 was rolled back so HEAD
      // and the prompt return to the kept state.
      assert.equal(result.lastKeptCommitSha, result.decisions[0]?.candidateCommitSha);
      const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: harness.repoDir })).stdout.trim();
      assert.equal(head, result.lastKeptCommitSha);
      assert.equal(await readFile(harness.systemPromptPath, 'utf8'), 'candidate prompt round-0\n');

      assert.equal(result.smoke.status, 'pass');
      assert.deepEqual(result.smoke.decisions, { keep: 1, discard: 1 });
      assert.equal(result.smoke.observedRounds, 2);
      assert.equal(result.smoke.quarantineCount, 0);
      assert.equal(result.smoke.taskEvents.infraFailed, 0);
      assert.equal(result.smoke.taskEvents.plumbingFailed, 0);
    });
  });

  test('persists attribution and feeds held-in-only R2 feedback into the next prompt', async () => {
    await withHarness(async (harness) => {
      const promptInputs: MetaAgentPromptInput[] = [];
      const heldInTasks = makeTasks('hin', 2);
      const heldOutTasks = makeTasks('hout', 1);
      const rewardFor = (roundId: string, taskId: string): number => {
        if (taskId.startsWith('hout-')) return 1;
        if (roundId.startsWith('baseline-')) return taskIndex(taskId) === 0 ? 1 : 0;
        return roundId === 'round-0' ? 0 : taskIndex(taskId) === 0 ? 1 : 0;
      };

      await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 2,
        baselineRuns: 2,
        metaAgent: async (promptInput) => {
          promptInputs.push(promptInput);
          return {
            systemPrompt: `candidate prompt ${promptInput.roundId}\n`,
            summary: `tuned for ${promptInput.roundId}`,
            candidateRationale: {
              failurePattern: 'coverage_regression',
              evidenceRefs: evidenceRefsFor(promptInput),
              hypothesis: 'avoid losing held-in scored artifacts',
              targetedFix: 'state artifact completion constraints plainly',
              predictedFixes: ['hin-1'],
              riskTasks: ['hin-0'],
            },
          };
        },
      });

      assert.equal(promptInputs.length, 2);
      assert.ok(promptInputs[0]?.rsiAnalysis);
      assert.equal(promptInputs[0]?.promptAttribution, undefined);
      assert.ok(promptInputs[1]?.rsiAnalysis);
      assert.deepEqual(promptInputs[1]?.promptAttribution?.predictedFixes, [
        { taskId: 'hin-1', outcome: 'unchanged' },
      ]);
      assert.deepEqual(promptInputs[1]?.promptAttribution?.riskTasks, [
        { taskId: 'hin-0', outcome: 'regressed' },
      ]);
      assert.equal('decisionReason' in (promptInputs[1]?.promptAttribution ?? {}), false);
      assert.equal(JSON.stringify(promptInputs[1]?.promptAttribution).includes('hout-'), false);
      assert.equal(JSON.stringify(promptInputs[1]?.promptAttribution).includes('held_out'), false);

      const events = await readFixedPromptWal(harness.resultsJsonlPath);
      assert.equal(events.filter((event) => event.type === 'rsi_controller_attribution').length, 2);
      for (const decision of events.filter((event) => event.type === 'prompt_candidate_decided')) {
        const decisionIndex = events.indexOf(decision);
        const attributionIndex = events.findIndex((event) => (
          event.type === 'rsi_controller_attribution'
          && event.runId === decision.runId
          && event.roundId === decision.roundId
          && event.candidateCommitSha === decision.candidateCommitSha
        ));
        assert.ok(attributionIndex > decisionIndex);
      }
    });
  });

  test('matches attribution root cause against prompt-time analysis after coverage signal is fixed', async () => {
    await withHarness(async (harness) => {
      const promptInputs: MetaAgentPromptInput[] = [];
      const heldInTasks = makeTasks('hin', 2);
      const heldOutTasks = makeTasks('hout', 1);
      const rewardFor = (roundId: string, taskId: string): number => {
        if (taskId.startsWith('hout-')) return 1;
        if (roundId.startsWith('baseline-')) return 1;
        return roundId === 'round-0' && taskId === 'hin-0' ? 0 : 1;
      };

      await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 2,
        baselineRuns: 2,
        shouldFail: (roundId, taskId) => roundId === 'round-0' && taskId === 'hin-0',
        metaAgent: async (promptInput) => {
          promptInputs.push(promptInput);
          return {
            systemPrompt: `candidate prompt ${promptInput.roundId}\n`,
            summary: `tuned for ${promptInput.roundId}`,
            candidateRationale: {
              failurePattern: 'coverage_regression',
              evidenceRefs: evidenceRefsFor(promptInput),
              hypothesis: 'restore coverage for held-in tasks',
              targetedFix: 'make artifact completion constraints explicit',
              predictedFixes: ['hin-0'],
              riskTasks: [],
            },
          };
        },
      });

      const promptTimeCoverageSignal = promptInputs[1]?.rsiAnalysis?.signals.find((signal) => signal.kind === 'coverage_regression');
      assert.ok(promptTimeCoverageSignal);
      const events = await readFixedPromptWal(harness.resultsJsonlPath);
      const secondAttribution = events.find((event) => event.type === 'rsi_controller_attribution' && event.roundId === 'round-1');
      assert.equal(secondAttribution?.type, 'rsi_controller_attribution');
      if (secondAttribution?.type === 'rsi_controller_attribution') {
        assert.deepEqual(secondAttribution.evidenceRefs, [promptTimeCoverageSignal.id]);
        assert.deepEqual(secondAttribution.predictedFixes, [{ taskId: 'hin-0', outcome: 'unchanged' }]);
        assert.equal(secondAttribution.rootCauseSignalMatch, 'matched');
      }
    });
  });

  test('does not teach held-out coverage discard reasons to the next prompt', async () => {
    await withHarness(async (harness) => {
      const promptInputs: MetaAgentPromptInput[] = [];
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 2);
      const rewardFor = (roundId: string, taskId: string): number => {
        if (taskId.startsWith('hout-')) return 1;
        if (roundId.startsWith('baseline-')) return taskIndex(taskId) < 10 ? 1 : 0;
        return 1;
      };

      await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 2,
        baselineRuns: 2,
        shouldFail: (roundId, taskId) => roundId === 'round-0' && taskId === 'hout-1',
        metaAgent: async (promptInput) => {
          promptInputs.push(promptInput);
          return {
            systemPrompt: `candidate prompt ${promptInput.roundId}\n`,
            summary: `tuned for ${promptInput.roundId}`,
            candidateRationale: {
              failurePattern: 'coverage_regression',
              evidenceRefs: evidenceRefsFor(promptInput),
              hypothesis: 'avoid losing held-in scored artifacts',
              targetedFix: 'state artifact completion constraints plainly',
              predictedFixes: ['hin-19'],
              riskTasks: [],
            },
          };
        },
      });

      assert.equal(promptInputs.length, 2);
      const visible = JSON.stringify(promptInputs[1]?.promptAttribution);
      assert.equal('decisionReason' in (promptInputs[1]?.promptAttribution ?? {}), false);
      assert.equal(visible.includes('coverage_regressed'), false);
      assert.equal(visible.includes('held_out'), false);
      assert.equal(visible.includes('hout-'), false);
    });
  });

  test('discards every candidate when no change beats the noise band, leaving the original prompt', async () => {
    await withHarness(async (harness) => {
      const originalHead = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: harness.repoDir })).stdout.trim();
      const heldInTasks = makeTasks('hin', 2);
      const heldOutTasks = makeTasks('hout', 1);
      // Flat pass rates every round: held-in stays at 0.5, well within the wide
      // noise band of a two-task partition, so no candidate is ever kept.
      const rewardFor = (_roundId: string, taskId: string): number => {
        if (taskId.startsWith('hout-')) return 1;
        return taskIndex(taskId) === 0 ? 1 : 0;
      };

      const result = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 2,
        baselineRuns: 2,
      });

      assert.equal(result.keptCount, 0);
      assert.deepEqual(result.decisions.map((decision) => decision.decision), ['discard', 'discard']);
      assert.equal(result.lastKeptCommitSha, originalHead);
      const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: harness.repoDir })).stdout.trim();
      assert.equal(head, originalHead);
      assert.equal(await readFile(harness.systemPromptPath, 'utf8'), 'original prompt\n');
      // Zero keeps is a passing structural smoke for v1.
      assert.equal(result.smoke.status, 'pass');
      assert.deepEqual(result.smoke.decisions, { keep: 0, discard: 2 });
    });
  });

  test('skips the held-out sweep for a candidate that does not clear the held-in gate', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 2);
      const heldOutTasks = makeTasks('hout', 2);
      // Held-in flat at 0.5 (within the wide two-task noise band) every candidate
      // round, so no candidate clears the held-in gate.
      const rewardFor = (_roundId: string, taskId: string): number => {
        if (taskId.startsWith('hout-')) return 1;
        return taskIndex(taskId) === 0 ? 1 : 0;
      };

      const result = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 2,
        baselineRuns: 2,
      });

      assert.deepEqual(result.decisions.map((decision) => decision.decision), ['discard', 'discard']);
      assert.equal(result.decisions[0]?.reason, 'held_in_within_noise');

      // #64 two-stage gate: a candidate that cannot KEEP on held-in must never
      // spend the held-out sweep — no held-out task event under any candidate round.
      const events = (await readFile(harness.resultsJsonlPath, 'utf8'))
        .split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const isHeldOut = (e: { taskId?: unknown }) => typeof e.taskId === 'string' && e.taskId.startsWith('hout-');
      const candidateHeldOut = events.filter((e) =>
        typeof e.roundId === 'string' && e.roundId.startsWith('round-') && isHeldOut(e));
      assert.equal(candidateHeldOut.length, 0);
      // Held-out baseline events still exist (calibration runs held-out), proving
      // the check above is about candidate rounds, not broken held-out wiring.
      const baselineHeldOut = events.filter((e) =>
        typeof e.roundId === 'string' && e.roundId.startsWith('baseline-') && isHeldOut(e));
      assert.ok(baselineHeldOut.length > 0);
    });
  });

  test('stops before the held-out sweep when the budget is hit after held-in', async () => {
    await withHarness(async (harness) => {
      const originalHead = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: harness.repoDir })).stdout.trim();
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      // Held-in jumps 0.5 -> 1.0 in round-0, so it clears the gate and held-out
      // WOULD run; held-out stays flat at 0.5.
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return index < 4 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        return 1;
      };

      // baseline (2 sweeps) = 2*(20+8)*0.02 = 1.12; round-0 held-in adds 20*0.02 =
      // 0.40 -> 1.52, tripping a 1.5 ceiling BETWEEN held-in and held-out.
      const result = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 2,
        baselineRuns: 2,
        costCeilingUsd: 1.5,
      });

      assert.equal(result.stopReason, 'cost_ceiling_exceeded');
      assert.equal(result.decisions.length, 0); // round-0 broke before a decision
      assert.equal(result.keptCount, 0);
      assert.ok(result.totalCostUsd >= 1.5);

      // Held-out never ran for round-0, and the candidate commit was reverted.
      const events = (await readFile(harness.resultsJsonlPath, 'utf8'))
        .split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const candidateHeldOut = events.filter((e) =>
        typeof e.roundId === 'string' && e.roundId.startsWith('round-')
        && typeof e.taskId === 'string' && e.taskId.startsWith('hout-'));
      assert.equal(candidateHeldOut.length, 0);
      const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: harness.repoDir })).stdout.trim();
      assert.equal(head, originalHead);
      assert.equal(await readFile(harness.systemPromptPath, 'utf8'), 'original prompt\n');
    });
  });

  test('aborts baseline before held-out when the budget is exhausted after held-in', async () => {
    await withHarness(async (harness) => {
      const calls: string[] = [];
      await assert.rejects(
        runLoop(harness, {
          heldInTasks: makeTasks('hin', 2),
          heldOutTasks: makeTasks('hout', 2),
          rewardFor: () => 1,
          rounds: 1,
          baselineRuns: 1,
          costCeilingUsd: 0.03,
          onTaskRun: (roundId, taskId) => calls.push(`${roundId}:${taskId}`),
        }),
        /cost_ceiling_exceeded during baseline calibration \(completed 0 of 1 sweeps\); raise the budget or lower baselineRuns/,
      );
      assert.deepEqual(calls, ['baseline-0:hin-0', 'baseline-0:hin-1']);
    });
  });

  test('refuses to run when the held-out TSV would be visible inside the agent cwd', async () => {
    await withHarness(async (harness) => {
      await assert.rejects(
        runLoop(harness, {
          heldInTasks: makeTasks('hin', 2),
          heldOutTasks: makeTasks('hout', 1),
          rewardFor: () => 1,
          rounds: 1,
          baselineRuns: 1,
          // Place the held-out TSV inside the agent cwd; the driver must auto-isolate
          // it and the candidate round must reject before exposing held-out results.
          heldOutResultsTsvPath: join(harness.agentCwdPath, 'held-out.tsv'),
        }),
        /controller-only artifacts must stay outside agent cwd/,
      );
    });
  });

  test('rejects out-of-contract numeric inputs at the public API boundary', async () => {
    await withHarness(async (harness) => {
      const base = {
        heldInTasks: makeTasks('hin', 2),
        heldOutTasks: makeTasks('hout', 1),
        rewardFor: () => 1,
        rounds: 1,
        baselineRuns: 1,
      };
      // rounds 0 is baseline-only (trivially passes the smoke); 1.5 would run two
      // rounds; a NaN ceiling/ratio never trips its guard; minStable 0 disables
      // the stable-task protection. All must fail loud, not silently degrade.
      await assert.rejects(runLoop(harness, { ...base, rounds: 0 }), /rounds must be a positive integer/);
      await assert.rejects(runLoop(harness, { ...base, rounds: 1.5 }), /rounds must be a positive integer/);
      await assert.rejects(runLoop(harness, { ...base, costCeilingUsd: NaN }), /costCeilingUsd must be a finite positive number/);
      await assert.rejects(runLoop(harness, { ...base, minStableHeldInTasks: 0 }), /minStableHeldInTasks must be a positive integer/);
      await assert.rejects(runLoop(harness, { ...base, maxInfraFailureRate: 1.5 }), /maxInfraFailureRate must be a number in \(0, 1\]/);
    });
  });

  test('rejects duplicate held-in task ids at the public API boundary', async () => {
    await withHarness(async (harness) => {
      await assert.rejects(
        runLoop(harness, {
          heldInTasks: [
            { id: 'dup-task', path: '/tasks/a' },
            { id: 'dup-task', path: '/tasks/b' },
          ],
          heldOutTasks: makeTasks('hout', 1),
          rewardFor: () => {
            throw new Error('harbor must not run when task ids are invalid');
          },
          rounds: 1,
          baselineRuns: 1,
        }),
        /held-in tasks contain duplicate id\(s\): dup-task/,
      );
    });
  });

  test('rejects held-in and held-out task id overlap at the public API boundary', async () => {
    await withHarness(async (harness) => {
      await assert.rejects(
        runLoop(harness, {
          heldInTasks: [{ id: 'shared-task', path: '/tasks/train' }],
          heldOutTasks: [{ id: 'shared-task', path: '/tasks/exam' }],
          rewardFor: () => {
            throw new Error('harbor must not run when task partitions overlap');
          },
          rounds: 1,
          baselineRuns: 1,
        }),
        /held-in and held-out tasks overlap: shared-task/,
      );
    });
  });

  test('stops the loop once the cumulative cost ceiling is reached', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      const rewardFor = (_roundId: string, taskId: string): number => (
        taskIndex(taskId) < (taskId.startsWith('hout-') ? 4 : 10) ? 1 : 0
      );
      // baseline (2 sweeps) costs 2 * 28 * 0.02 = 1.12; round-0 adds 0.56 -> 1.68,
      // tripping a 1.5 ceiling before round-1 runs.
      const result = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 3,
        baselineRuns: 2,
        costCeilingUsd: 1.5,
      });

      assert.equal(result.stopReason, 'cost_ceiling_exceeded');
      assert.equal(result.decisions.length, 1);
      assert.ok(result.totalCostUsd >= 1.5);
    });
  });

  test('reports a cost-ceiling smoke failure when the loop stops exactly at budget', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return index < 4 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        return 1;
      };

      const result = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 3,
        baselineRuns: 2,
        costCeilingUsd: 1.68,
      });

      assert.equal(result.stopReason, 'cost_ceiling_exceeded');
      assert.equal(result.decisions.length, 1);
      assert.equal(result.smoke.totalCostUsd, 1.68);
      assert.ok(result.smoke.failures.includes('cost_ceiling_exceeded'));
    });
  });

  test('drops a held-in task that never completes in baseline and calibrates on the rest', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 3);
      const heldOutTasks = makeTasks('hout', 2);
      // hin-2 never completes in any sweep; every other task always does.
      const shouldFail = (_roundId: string, taskId: string): boolean => taskId === 'hin-2';
      const rewardFor = (_roundId: string, taskId: string): number => {
        if (taskId.startsWith('hout-')) return 1;
        return taskIndex(taskId) === 0 ? 1 : 0;
      };

      const result = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        shouldFail,
        rounds: 1,
        baselineRuns: 2,
      });

      // The unstable task is dropped; the run still calibrates and finishes.
      assert.deepEqual(result.droppedHeldInTaskIds, ['hin-2']);
      assert.deepEqual(result.droppedHeldOutTaskIds, []);
      assert.equal(result.baseline.heldIn.taskCount, 2);
      assert.equal(result.stopReason, 'rounds_complete');
      assert.equal(result.decisions.length, 1);
      assert.equal(result.smoke.status, 'pass');

      // The dropped task is never swept in the candidate round: only the two
      // stable held-in tasks appear under round-0.
      const wal = await readFile(harness.resultsJsonlPath, 'utf8');
      const roundHeldInTaskIds = wal.trim().split('\n')
        .map((line) => JSON.parse(line) as { roundId?: string; type?: string; taskId?: string })
        .filter((event) => event.roundId === 'round-0' && event.type === 'task_completed' && (event.taskId ?? '').startsWith('hin-'))
        .map((event) => event.taskId);
      assert.deepEqual([...new Set(roundHeldInTaskIds)].sort(), ['hin-0', 'hin-1']);
    });
  });

  test('aborts when no held-in task completes across baseline sweeps', async () => {
    await withHarness(async (harness) => {
      await assert.rejects(
        runLoop(harness, {
          heldInTasks: makeTasks('hin', 2),
          heldOutTasks: makeTasks('hout', 1),
          rewardFor: () => 1,
          shouldFail: (_roundId, taskId) => taskId.startsWith('hin-'),
          rounds: 1,
          baselineRuns: 1,
        }),
        /held-in stable task count 0 is below the minimum 1/,
      );
    });
  });

  test('drops a held-in task slower than the duration cap from calibration and rounds', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 3);
      const heldOutTasks = makeTasks('hout', 2);
      // hin-1 is pathologically slow in baseline; the cap drops it.
      const durationMsFor = (_roundId: string, taskId: string): number => (taskId === 'hin-1' ? 9_000 : 10);
      const rewardFor = (_roundId: string, taskId: string): number => (taskId.startsWith('hout-') ? 1 : taskIndex(taskId) === 0 ? 1 : 0);

      const result = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        durationMsFor,
        maxStableTaskDurationMs: 1_000,
        rounds: 1,
        baselineRuns: 2,
      });

      assert.deepEqual(result.droppedHeldInTaskIds, ['hin-1']);
      assert.equal(result.baseline.heldIn.taskCount, 2);
      assert.equal(result.stopReason, 'rounds_complete');
      assert.equal(result.smoke.status, 'pass');
    });
  });

  test('aborts when too few held-in tasks survive the minimum-stable floor', async () => {
    await withHarness(async (harness) => {
      await assert.rejects(
        runLoop(harness, {
          heldInTasks: makeTasks('hin', 4),
          heldOutTasks: makeTasks('hout', 2),
          rewardFor: () => 1,
          // Only hin-0 survives; the floor of 3 is not met, so the run fails loud
          // rather than calibrating on an unrepresentative single task.
          shouldFail: (_roundId, taskId) => taskId.startsWith('hin-') && taskId !== 'hin-0',
          minStableHeldInTasks: 3,
          rounds: 1,
          baselineRuns: 1,
        }),
        /held-in stable task count 1 is below the minimum 3 \(4 configured, 3 dropped/,
      );
    });
  });
});

interface Harness {
  repoDir: string;
  controllerDir: string;
  agentCwdPath: string;
  programPath: string;
  systemPromptPath: string;
  resultsJsonlPath: string;
  heldInResultsTsvPath: string;
  heldOutResultsTsvPath: string;
  eventsDir: string;
  originalCommitSha: string;
}

interface RunLoopOptions {
  heldInTasks: readonly { id: string; path: string }[];
  heldOutTasks: readonly { id: string; path: string }[];
  rewardFor: (roundId: string, taskId: string) => number;
  rounds: number;
  baselineRuns: number;
  costCeilingUsd?: number;
  maxInfraFailureRate?: number;
  heldOutResultsTsvPath?: string;
  minStableHeldInTasks?: number;
  maxStableTaskDurationMs?: number;
  /** When it returns true, the runner emits a non-completed (unscored) cell for
   * that task — used to exercise the baseline stability filter. */
  shouldFail?: (roundId: string, taskId: string) => boolean;
  /** Per-task baseline duration (ms); defaults to 10. Exercises the too-slow cap. */
  durationMsFor?: (roundId: string, taskId: string) => number;
  onTaskRun?: (roundId: string, taskId: string) => void;
  metaAgent?: MetaAgent;
  resumeFingerprint?: string | null;
}

async function runLoop(harness: Harness, options: RunLoopOptions) {
  const nextId = idFactory();
  let clock = 0;
  const rewardHackVerifierPatternsByTaskId = Object.fromEntries(
    options.heldInTasks.map((task) => [task.id, ['ZZZ_NO_VERIFIER_MATCH']]),
  );
  const input: PromptOptimizationLoopInput = {
    runId: 'run-1',
    rounds: options.rounds,
    baselineRuns: options.baselineRuns,
    agentCwdPath: harness.agentCwdPath,
    programPath: harness.programPath,
    systemPromptPath: harness.systemPromptPath,
    resultsJsonlPath: harness.resultsJsonlPath,
    heldInResultsTsvPath: harness.heldInResultsTsvPath,
    heldOutResultsTsvPath: options.heldOutResultsTsvPath ?? harness.heldOutResultsTsvPath,
    heldInTasks: options.heldInTasks,
    heldOutTasks: options.heldOutTasks,
    config: CONFIG,
    harborRunner: fakeHarborRunner(harness.eventsDir, options.rewardFor, options.shouldFail, options.durationMsFor, options.onTaskRun),
    metaAgent: options.metaAgent ?? fakeMetaAgent(),
    git: createCliPromptCandidateGit({ cwd: harness.repoDir, systemPromptPath: harness.systemPromptPath }),
    rewardHackVerifierPatternsByTaskId,
    ...(options.resumeFingerprint !== null ? { resumeFingerprint: options.resumeFingerprint ?? 'fingerprint-test' } : {}),
    ...(options.costCeilingUsd !== undefined ? { costCeilingUsd: options.costCeilingUsd } : {}),
    ...(options.maxInfraFailureRate !== undefined ? { maxInfraFailureRate: options.maxInfraFailureRate } : {}),
    ...(options.minStableHeldInTasks !== undefined ? { minStableHeldInTasks: options.minStableHeldInTasks } : {}),
    ...(options.maxStableTaskDurationMs !== undefined ? { maxStableTaskDurationMs: options.maxStableTaskDurationMs } : {}),
    now: () => (clock += 1),
    newId: nextId,
  };
  return runPromptOptimizationLoop(input);
}

/** A meta-agent that proposes a unique, valid prompt per round (no model). */
function fakeMetaAgent(): MetaAgent {
  return async (promptInput) => ({
    systemPrompt: `candidate prompt ${promptInput.roundId}\n`,
    summary: `tuned for ${promptInput.roundId}`,
    candidateRationale: {
      failurePattern: 'coverage_regression',
      evidenceRefs: evidenceRefsFor(promptInput),
      hypothesis: 'stable held-in coverage can improve with a clearer prompt',
      targetedFix: 'make the success criteria explicit without adding task-specific answers',
      predictedFixes: [],
      riskTasks: [],
    },
  });
}

function evidenceRefsFor(promptInput: MetaAgentPromptInput): string[] {
  const signal = promptInput.rsiAnalysis?.signals.find((item) => item.kind === 'coverage_regression')
    ?? promptInput.rsiAnalysis?.signals[0];
  return signal ? [signal.id] : [];
}

/** A Harbor runner that fabricates a completed, correctly-hashed cell per task
 * and writes a model-visible runtime-events file the digest/scan can read. */
function fakeHarborRunner(
  eventsDir: string,
  rewardFor: (roundId: string, taskId: string) => number,
  shouldFail?: (roundId: string, taskId: string) => boolean,
  durationMsFor?: (roundId: string, taskId: string) => number,
  onTaskRun?: (roundId: string, taskId: string) => void,
): (input: HarborTaskRunInput) => Promise<HarborTaskRunOutput> {
  return async ({ roundId, task, systemPrompt }) => {
    onTaskRun?.(roundId, task.id);
    const runtimeEventsPath = join(eventsDir, `${roundId}__${task.id}.jsonl`);
    await writeFile(runtimeEventsPath, `${JSON.stringify(modelVisibleEvent())}\n`, 'utf8');
    // A non-completed cell with a correct hash and real (non-zero) cost: scored
    // is false, so the controller records it as an unscored task_completed — not
    // a plumbing failure — which the stability filter drops.
    const failed = shouldFail?.(roundId, task.id) ?? false;
    return {
      harbor: { reward: failed ? 0 : rewardFor(roundId, task.id) },
      cell: {
        schemaVersion: 1,
        status: failed ? 'failed' : 'completed',
        runtimeEventsPath,
        promptHash: hashSystemPrompt(systemPrompt),
        tokenSummary: tokenSummary({ input: 1, output: 2, reasoning: 0, total: 3, costUsd: COST_PER_TASK }),
        toolSummary: {
          providerVisibleToolCount: 1,
          actualToolCalls: 1,
          actualToolNames: ['Bash'],
          actualToolCallCounts: { Bash: 1 },
        },
        steps: 1,
        durationMs: durationMsFor?.(roundId, task.id) ?? 10,
        startedAt: 0,
        finishedAt: 10,
        runtimeRefs: {
          invocationId: `inv-${roundId}-${task.id}`,
          sessionId: `session-${task.id}`,
          runId: 'run-1',
          turnId: `turn-${roundId}`,
        },
      },
    };
  };
}

function modelVisibleEvent(): unknown {
  return {
    id: 'call-1',
    invocationId: 'inv-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'model',
    author: 'agent',
    content: { kind: 'function_call', id: 'call-1', name: 'Bash', args: { command: 'echo done' } },
  };
}

function makeTasks(prefix: string, count: number): { id: string; path: string }[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `${prefix}-${index}`,
    path: `/tasks/${prefix}-${index}`,
  }));
}

function taskIndex(taskId: string): number {
  return Number(taskId.slice(taskId.lastIndexOf('-') + 1));
}

function idFactory(): () => string {
  let counter = 0;
  return () => `id-${(counter += 1)}`;
}

async function withHarness(fn: (harness: Harness) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-prompt-loop-'));
  try {
    const repoDir = join(root, 'repo');
    const controllerDir = join(root, 'controller');
    const agentCwdPath = join(repoDir, 'agent-cwd');
    const eventsDir = join(controllerDir, 'events');
    await mkdir(repoDir, { recursive: true });
    await mkdir(controllerDir, { recursive: true });
    await mkdir(agentCwdPath, { recursive: true });
    await mkdir(eventsDir, { recursive: true });

    const programPath = join(repoDir, 'program.md');
    const systemPromptPath = join(repoDir, 'system_prompt.md');
    await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
    await writeFile(systemPromptPath, 'original prompt\n', 'utf8');

    await execFileAsync('git', ['init'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
    await execFileAsync('git', ['add', 'program.md', 'system_prompt.md'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repoDir });
    const originalCommitSha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim();

    await fn({
      repoDir,
      controllerDir,
      agentCwdPath,
      programPath,
      systemPromptPath,
      resultsJsonlPath: join(controllerDir, 'results.jsonl'),
      heldInResultsTsvPath: join(controllerDir, 'held-in.tsv'),
      heldOutResultsTsvPath: join(controllerDir, 'held-out.tsv'),
      eventsDir,
      originalCommitSha,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
