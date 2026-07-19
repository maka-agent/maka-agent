import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { hashSystemPrompt, readFixedPromptWal } from '../fixed-prompt-controller.js';
import {
  execFileAsync,
  fakeMetaAgent,
  makeTasks,
  runLoop,
  taskIndex,
  withHarness,
} from './helpers/prompt-optimization-loop-harness.js';

describe('runPromptOptimizationLoop replay baseline guards', () => {
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
      const missingBaseline = events.filter(
        (event) =>
          !(
            event.type === 'task_completed' &&
            event.roundId === 'baseline-0' &&
            event.taskId === 'hin-0'
          ),
      );
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
      await execFileAsync('git', ['reset', '--hard', harness.originalCommitSha], {
        cwd: harness.repoDir,
      });

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

  test('fails closed before sweeping when a pending candidate task-set is stale', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return index < 4 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        return 1;
      };
      const durationMsFor = (_roundId: string, taskId: string): number =>
        taskId === 'hin-19' ? 200 : 10;

      await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        durationMsFor,
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

      const taskRuns: string[] = [];
      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          durationMsFor,
          rounds: 1,
          baselineRuns: 1,
          maxStableTaskDurationMs: 100,
          onTaskRun: (roundId, taskId) => taskRuns.push(`${roundId}:${taskId}`),
        }),
        /RSI WAL replay candidate task-set mismatch for round-0/,
      );
      assert.deepEqual(taskRuns, []);
    });
  });

  test('fails closed before baseline when a pending candidate round has a gap', async () => {
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
      const committed = events.find(
        (event): event is Extract<typeof event, { type: 'prompt_candidate_committed' }> =>
          event.type === 'prompt_candidate_committed' && event.roundId === 'round-0',
      );
      assert.ok(committed);
      const commitIndex = events.indexOf(committed);
      const gappedEvents = events
        .slice(0, commitIndex + 1)
        .map((event) =>
          event.type === 'prompt_candidate_committed' && event.roundId === 'round-0'
            ? { ...event, roundId: 'round-1' }
            : event,
        );
      await writeFile(
        harness.resultsJsonlPath,
        `${gappedEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );
      await execFileAsync('git', ['reset', '--hard', committed.commitSha], {
        cwd: harness.repoDir,
      });

      const taskRuns: string[] = [];
      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 2,
          baselineRuns: 1,
          onTaskRun: (roundId, taskId) => taskRuns.push(`${roundId}:${taskId}`),
        }),
        /RSI WAL replay found candidate round gap for round-1/,
      );
      assert.deepEqual(taskRuns, []);
    });
  });

  test('fails closed before baseline when a pending candidate has the wrong parent', async () => {
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
      const firstCandidate = events.find(
        (event): event is Extract<typeof event, { type: 'prompt_candidate_committed' }> =>
          event.type === 'prompt_candidate_committed' && event.roundId === 'round-0',
      );
      assert.ok(firstCandidate);

      const sidePrompt = 'side candidate prompt\n';
      await execFileAsync('git', ['reset', '--hard', harness.originalCommitSha], {
        cwd: harness.repoDir,
      });
      await writeFile(harness.systemPromptPath, sidePrompt, 'utf8');
      await execFileAsync('git', ['add', 'system_prompt.md'], { cwd: harness.repoDir });
      await execFileAsync('git', ['commit', '-m', 'side candidate'], { cwd: harness.repoDir });
      const sideCommit = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: harness.repoDir })
      ).stdout.trim();
      const wrongParentCandidate = {
        ...firstCandidate,
        id: 'wrong-parent-candidate',
        ts: firstCandidate.ts + 1,
        roundId: 'round-1',
        commitSha: sideCommit,
        promptHash: hashSystemPrompt(sidePrompt),
      };
      await writeFile(
        harness.resultsJsonlPath,
        `${[...events, wrongParentCandidate].map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );

      const taskRuns: string[] = [];
      await assert.rejects(
        runLoop(harness, {
          heldInTasks,
          heldOutTasks,
          rewardFor,
          rounds: 2,
          baselineRuns: 1,
          onTaskRun: (roundId, taskId) => taskRuns.push(`${roundId}:${taskId}`),
        }),
        /RSI WAL replay found candidate parent mismatch for round-1/,
      );
      assert.deepEqual(taskRuns, []);
    });
  });

  test('fails closed before baseline when a pending candidate changes non-prompt files', async () => {
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
      const committed = events.find(
        (event): event is Extract<typeof event, { type: 'prompt_candidate_committed' }> =>
          event.type === 'prompt_candidate_committed' && event.roundId === 'round-0',
      );
      assert.ok(committed);
      const candidatePrompt = (
        await execFileAsync('git', ['show', `${committed.commitSha}:system_prompt.md`], {
          cwd: harness.repoDir,
        })
      ).stdout;

      await execFileAsync('git', ['reset', '--hard', harness.originalCommitSha], {
        cwd: harness.repoDir,
      });
      await writeFile(harness.systemPromptPath, candidatePrompt, 'utf8');
      await writeFile(harness.programPath, 'mutated program\n', 'utf8');
      await execFileAsync('git', ['add', 'system_prompt.md', 'program.md'], {
        cwd: harness.repoDir,
      });
      await execFileAsync('git', ['commit', '-m', 'bad candidate'], { cwd: harness.repoDir });
      const badCommit = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: harness.repoDir })
      ).stdout.trim();
      const commitIndex = events.indexOf(committed);
      const badCandidateEvents = events.slice(0, commitIndex + 1).map((event) =>
        event.type === 'prompt_candidate_committed' && event.roundId === 'round-0'
          ? {
              ...event,
              commitSha: badCommit,
              promptHash: hashSystemPrompt(candidatePrompt),
            }
          : event,
      );
      await writeFile(
        harness.resultsJsonlPath,
        `${badCandidateEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );
      await execFileAsync('git', ['reset', '--hard', badCommit], { cwd: harness.repoDir });

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
        /RSI WAL replay candidate changed unexpected files for round-0/,
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
});
