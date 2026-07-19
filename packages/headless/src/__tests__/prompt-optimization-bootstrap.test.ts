import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { promisify } from 'node:util';
import {
  preparePromptOptimizationResume,
  ensurePromptOptimizationPromptRepo,
} from '../prompt-optimization-bootstrap.js';

const execFileAsync = promisify(execFile);

describe('ensurePromptOptimizationPromptRepo', () => {
  test('initializes the seed prompt repo once and reuses it on resume', async () => {
    await withDir(async (dir) => {
      const promptRepoDir = join(dir, 'prompt-repo');
      const input = {
        promptRepoDir,
        program: 'program v1\n',
        systemPrompt: 'prompt v1\n',
      };

      const first = await ensurePromptOptimizationPromptRepo(input);
      const firstHead = await gitOutput(promptRepoDir, 'rev-parse', 'HEAD');
      const firstCommitCount = await gitOutput(promptRepoDir, 'rev-list', '--count', 'HEAD');

      const second = await ensurePromptOptimizationPromptRepo(input);
      const secondHead = await gitOutput(promptRepoDir, 'rev-parse', 'HEAD');
      const secondCommitCount = await gitOutput(promptRepoDir, 'rev-list', '--count', 'HEAD');

      assert.deepEqual(second, first);
      assert.equal(secondHead, firstHead);
      assert.equal(secondCommitCount, firstCommitCount);
      assert.equal(secondCommitCount, '1');
      assert.equal(await readFile(join(promptRepoDir, 'program.md'), 'utf8'), 'program v1\n');
      assert.equal(await readFile(join(promptRepoDir, 'system_prompt.md'), 'utf8'), 'prompt v1\n');
    });
  });

  test('writes the provided initial system prompt exactly', async () => {
    await withDir(async (dir) => {
      const promptRepoDir = join(dir, 'prompt-repo');

      await ensurePromptOptimizationPromptRepo({
        promptRepoDir,
        program: 'program v1\n',
        systemPrompt: 'custom initial prompt\nwith a second line\n',
      });

      assert.equal(
        await readFile(join(promptRepoDir, 'system_prompt.md'), 'utf8'),
        'custom initial prompt\nwith a second line\n',
      );
    });
  });

  test('rejects an existing seed repo with different seed files instead of rewriting it', async () => {
    await withDir(async (dir) => {
      const promptRepoDir = join(dir, 'prompt-repo');
      await ensurePromptOptimizationPromptRepo({
        promptRepoDir,
        program: 'program v1\n',
        systemPrompt: 'prompt v1\n',
      });

      await assert.rejects(
        ensurePromptOptimizationPromptRepo({
          promptRepoDir,
          program: 'program v2\n',
          systemPrompt: 'prompt v1\n',
        }),
        /existing prompt repo seed files do not match this run/,
      );

      assert.equal(await readFile(join(promptRepoDir, 'program.md'), 'utf8'), 'program v1\n');
    });
  });

  test('rejects post-candidate resume when the root seed prompt differs from input', async () => {
    await withDir(async (dir) => {
      const promptRepoDir = join(dir, 'prompt-repo');
      await ensurePromptOptimizationPromptRepo({
        promptRepoDir,
        program: 'program v1\n',
        systemPrompt: 'prompt v1\n',
      });
      await writeFile(join(promptRepoDir, 'system_prompt.md'), 'candidate prompt\n', 'utf8');
      await git(promptRepoDir, 'add', 'system_prompt.md');
      await git(promptRepoDir, 'commit', '-q', '-m', 'candidate prompt round-0');

      await assert.rejects(
        ensurePromptOptimizationPromptRepo({
          promptRepoDir,
          program: 'program v1\n',
          systemPrompt: 'prompt v2\n',
        }),
        /existing prompt repo seed files do not match this run: system_prompt\.md/,
      );
    });
  });

  test('allows post-candidate resume when the prompt repo matches the WAL state', async () => {
    await withDir(async (dir) => {
      const promptRepoDir = join(dir, 'prompt-repo');
      const resultsJsonlPath = join(dir, 'controller', 'results.jsonl');
      await mkdir(join(dir, 'controller'), { recursive: true });
      const input = {
        promptRepoDir,
        program: 'program v1\n',
        systemPrompt: 'prompt v1\n',
      };
      await ensurePromptOptimizationPromptRepo(input);
      await writeFile(join(promptRepoDir, 'system_prompt.md'), 'candidate prompt\n', 'utf8');
      await git(promptRepoDir, 'add', 'system_prompt.md');
      await git(promptRepoDir, 'commit', '-q', '-m', 'candidate prompt round-0');
      await appendFile(
        resultsJsonlPath,
        `${JSON.stringify({
          schemaVersion: 1,
          type: 'prompt_candidate_decided',
          id: 'decision-1',
          ts: 1,
          runId: 'run-1',
          roundId: 'round-0',
          decision: 'keep',
          reason: 'held_in_improved',
          candidateCommitSha: await gitOutput(promptRepoDir, 'rev-parse', 'HEAD'),
          previousLastKeptCommitSha: 'seed',
          lastKeptCommitSha: await gitOutput(promptRepoDir, 'rev-parse', 'HEAD'),
          previousHeldInReferencePassEligibleRate: 0,
          heldInReferencePassEligibleRate: 1,
          originalCommitSha: 'seed',
          originalHeldOutPassEligibleRate: 0,
          heldInPassRateNoiseBand: 0,
          heldOutPassRateNoiseBand: 0,
          metrics: {},
        })}\n`,
        'utf8',
      );

      await assert.doesNotReject(ensurePromptOptimizationPromptRepo(input));
      await assert.doesNotReject(
        preparePromptOptimizationResume({ promptRepoDir, resultsJsonlPath }),
      );
    });
  });

  test('rejects post-candidate resume when the prompt repo does not match the WAL state', async () => {
    await withDir(async (dir) => {
      const promptRepoDir = join(dir, 'prompt-repo');
      const resultsJsonlPath = join(dir, 'controller', 'results.jsonl');
      await mkdir(join(dir, 'controller'), { recursive: true });
      await ensurePromptOptimizationPromptRepo({
        promptRepoDir,
        program: 'program v1\n',
        systemPrompt: 'prompt v1\n',
      });
      const seedSha = await gitOutput(promptRepoDir, 'rev-parse', 'HEAD');
      await writeFile(join(promptRepoDir, 'system_prompt.md'), 'candidate prompt\n', 'utf8');
      await git(promptRepoDir, 'add', 'system_prompt.md');
      await git(promptRepoDir, 'commit', '-q', '-m', 'candidate prompt round-0');
      const candidateSha = await gitOutput(promptRepoDir, 'rev-parse', 'HEAD');
      await appendFile(
        resultsJsonlPath,
        `${JSON.stringify({
          schemaVersion: 1,
          type: 'prompt_candidate_decided',
          id: 'decision-1',
          ts: 1,
          runId: 'run-1',
          roundId: 'round-0',
          decision: 'discard',
          reason: 'held_in_within_noise',
          candidateCommitSha: candidateSha,
          previousLastKeptCommitSha: seedSha,
          lastKeptCommitSha: seedSha,
          previousHeldInReferencePassEligibleRate: 0,
          heldInReferencePassEligibleRate: 0,
          originalCommitSha: seedSha,
          originalHeldOutPassEligibleRate: 0,
          heldInPassRateNoiseBand: 0,
          heldOutPassRateNoiseBand: 0,
          metrics: {},
        })}\n`,
        'utf8',
      );

      await assert.rejects(
        preparePromptOptimizationResume({ promptRepoDir, resultsJsonlPath }),
        /prompt repo HEAD does not match resumed RSI WAL state/,
      );
    });
  });

  test('allows pending candidate resume when task evidence exists but HEAD was rolled back', async () => {
    await withDir(async (dir) => {
      const promptRepoDir = join(dir, 'prompt-repo');
      const resultsJsonlPath = join(dir, 'controller', 'results.jsonl');
      await mkdir(join(dir, 'controller'), { recursive: true });
      await ensurePromptOptimizationPromptRepo({
        promptRepoDir,
        program: 'program v1\n',
        systemPrompt: 'prompt v1\n',
      });
      const seedSha = await gitOutput(promptRepoDir, 'rev-parse', 'HEAD');
      await writeFile(join(promptRepoDir, 'system_prompt.md'), 'candidate prompt\n', 'utf8');
      await git(promptRepoDir, 'add', 'system_prompt.md');
      await git(promptRepoDir, 'commit', '-q', '-m', 'candidate prompt round-0');
      const candidateSha = await gitOutput(promptRepoDir, 'rev-parse', 'HEAD');
      const promptHash = 'sha256:candidate';
      await writeFile(
        resultsJsonlPath,
        [
          JSON.stringify({
            schemaVersion: 1,
            type: 'prompt_candidate_committed',
            id: 'candidate-1',
            ts: 1,
            runId: 'run-1',
            roundId: 'round-0',
            commitSha: candidateSha,
            promptHash,
            candidateRationale: {
              editedSurface: 'system_prompt',
              failurePattern: 'coverage_regression',
              evidenceRefs: [],
              hypothesis: 'hypothesis',
              targetedFix: 'fix',
              predictedFixes: [],
              riskTasks: [],
            },
            candidateRationaleHash:
              'sha256:55016d80cd4dac4d2bba351e5ee27dcc9ae24f44b93c71817650e6e7d5d7dc7a',
            heldInTaskIds: ['task-a'],
            heldInTaskSetHash:
              'sha256:e1fb89ce9b4d1a7bd327cc525627f5340ac54db8b005a6c5808298a77636599e',
          }),
          JSON.stringify({
            schemaVersion: 1,
            type: 'task_completed',
            id: 'task-1',
            ts: 2,
            runId: 'run-1',
            roundId: 'round-0',
            taskId: 'task-a',
            status: 'passed',
            passed: true,
            scored: true,
            eligible: true,
            promptHash,
            resumeFingerprint: 'fingerprint-test',
            tokenSummary: { input: 1, output: 1, total: 2, costUsd: 0.01 },
            steps: 1,
            durationMs: 1,
            runtimeEventsPath: '/tmp/runtime-events.jsonl',
            harbor: { reward: 1 },
          }),
        ].join('\n') + '\n',
        'utf8',
      );
      await git(promptRepoDir, 'reset', '--hard', seedSha);

      await assert.doesNotReject(
        preparePromptOptimizationResume({ promptRepoDir, resultsJsonlPath }),
      );
      assert.equal(await gitOutput(promptRepoDir, 'rev-parse', 'HEAD'), candidateSha);
    });
  });

  test('allows baseline resume when the WAL has a torn malformed final line', async () => {
    await withDir(async (dir) => {
      const promptRepoDir = join(dir, 'prompt-repo');
      const resultsJsonlPath = join(dir, 'controller', 'results.jsonl');
      await mkdir(join(dir, 'controller'), { recursive: true });
      await ensurePromptOptimizationPromptRepo({
        promptRepoDir,
        program: 'program v1\n',
        systemPrompt: 'prompt v1\n',
      });
      await appendFile(
        resultsJsonlPath,
        `${JSON.stringify({
          schemaVersion: 1,
          type: 'task_completed',
          id: 'event-1',
          ts: 1,
          runId: 'run-1',
          roundId: 'baseline-0',
          taskId: 'task-a',
          status: 'passed',
          passed: true,
          scored: true,
          eligible: true,
          promptHash: 'sha256:prompt',
          tokenSummary: { input: 1, output: 1, total: 2, costUsd: 0.01 },
          steps: 1,
          durationMs: 1,
          runtimeEventsPath: '/tmp/runtime-events.jsonl',
          harbor: { reward: 1 },
        })}\n{"schemaVersion":`,
        'utf8',
      );

      await assert.doesNotReject(
        preparePromptOptimizationResume({ promptRepoDir, resultsJsonlPath }),
      );
    });
  });

  test('finishes seed commit when git was initialized before the first commit', async () => {
    await withDir(async (dir) => {
      const promptRepoDir = join(dir, 'prompt-repo');
      await mkdir(promptRepoDir, { recursive: true });
      await git(promptRepoDir, 'init', '-q');
      await writeFile(join(promptRepoDir, 'program.md'), 'program v1\n', 'utf8');
      await writeFile(join(promptRepoDir, 'system_prompt.md'), 'prompt v1\n', 'utf8');

      await ensurePromptOptimizationPromptRepo({
        promptRepoDir,
        program: 'program v1\n',
        systemPrompt: 'prompt v1\n',
      });

      assert.equal(await gitOutput(promptRepoDir, 'rev-list', '--count', 'HEAD'), '1');
      assert.equal(await readFile(join(promptRepoDir, 'program.md'), 'utf8'), 'program v1\n');
      assert.equal(await readFile(join(promptRepoDir, 'system_prompt.md'), 'utf8'), 'prompt v1\n');
    });
  });
});

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'maka-prompt-opt-bootstrap-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
