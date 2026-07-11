import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Config } from '../contracts.js';
import {
  FixedPromptBudgetExhaustedError,
  hashSystemPrompt,
  type HarborTaskRunInput,
  type HarborTaskRunOutput,
} from '../fixed-prompt-controller.js';
import { runRuntimePolicyAbLifecycle } from '../runtime-policy-ab-lifecycle.js';
import { contextBudgetSummary } from './helpers/ab-summary-fixtures.js';
import { tokenSummary } from './helpers/cell-output-fixtures.js';
import type { RuntimePolicyAbExecutionProfile } from '../runtime-policy-ab-profile.js';

const config: Config = {
  id: 'runtime-ab',
  backend: 'fake',
  llmConnectionSlug: 'deepseek',
  model: 'deepseek/deepseek-v4-flash',
};

const executionProfile: RuntimePolicyAbExecutionProfile = {
  schemaVersion: 1,
  id: 'test-profile',
  llmConnectionSlug: 'deepseek',
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek/deepseek-v4-flash',
  pricing: { inputUsdPer1M: 1, outputUsdPer1M: 1, cacheReadUsdPer1M: 0, cacheWriteUsdPer1M: 0, source: 'test-profile' },
  taskBudgetSec: 1800,
  harborTimeoutMs: 2_100_000,
  observedCostStopUsd: 20,
  maxConcurrentAttempts: 2,
};

test('same-run pilot checkpoint gates full execution and resumes completed state', async () => {
  await withDir(async (dir) => {
    const promptPath = join(dir, 'prompt.md');
    await writeFile(promptPath, 'shared prompt\n', 'utf8');
    const calls: string[] = [];
    const input = {
      runId: 'run-1',
      runRoot: dir,
      manifestFingerprint: 'sha256:manifest',
      config,
      systemPromptPath: promptPath,
      resultsJsonlPath: join(dir, 'results.jsonl'),
      pilotTasks: [{ id: 'pilot', path: '/tasks/pilot' }],
      evaluationTasks: [{ id: 'full', path: '/tasks/full' }],
      fullReps: 2,
      arms: [
        { id: 'prune-off', contextEnv: { MAKA_CONTEXT_BUDGET: 'off' } },
        { id: 'prune-on', contextEnv: { MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on' } },
      ] as const,
      executionProfile,
      harborRunner: async (runInput: HarborTaskRunInput) => {
        calls.push(runInput.roundId);
        return output(runInput, runInput.agentEnv?.MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE === 'on');
      },
    };

    const first = await runRuntimePolicyAbLifecycle(input);
    assert.equal(first.status, 'full_completed');
    assert.equal(first.pilot?.candidate.contextBudget?.activatedAttempts, 1);
    assert.equal(calls.length, 6);
    assert.equal(calls.every((roundId) => roundId.startsWith('pilot-') || roundId.startsWith('full-')), true);

    const resumed = await runRuntimePolicyAbLifecycle(input);
    assert.equal(resumed.status, 'full_completed');
    assert.equal(calls.length, 6);
  });
});

test('pilot without candidate activation does not launch full execution', async () => {
  await withDir(async (dir) => {
    const promptPath = join(dir, 'prompt.md');
    await writeFile(promptPath, 'shared prompt\n', 'utf8');
    const calls: string[] = [];
    const state = await runRuntimePolicyAbLifecycle({
      runId: 'run-1',
      runRoot: dir,
      manifestFingerprint: 'sha256:manifest',
      config,
      systemPromptPath: promptPath,
      resultsJsonlPath: join(dir, 'results.jsonl'),
      pilotTasks: [{ id: 'pilot', path: '/tasks/pilot' }],
      evaluationTasks: [{ id: 'full', path: '/tasks/full' }],
      fullReps: 2,
      arms: [
        { id: 'prune-off', contextEnv: { MAKA_CONTEXT_BUDGET: 'off' } },
        { id: 'prune-on', contextEnv: { MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on' } },
      ],
      executionProfile,
      harborRunner: async (runInput) => {
        calls.push(runInput.roundId);
        return output(runInput, false);
      },
    });

    assert.equal(state.status, 'pilot_not_cleared');
    assert.equal(state.reason, 'pilot_candidate_not_activated');
    assert.equal(calls.length, 2);
  });
});

test('pilot candidate pass against an attested baseline timeout can launch full execution', async () => {
  await withDir(async (dir) => {
    const promptPath = join(dir, 'prompt.md');
    await writeFile(promptPath, 'shared prompt\n', 'utf8');
    const calls: string[] = [];
    const state = await runRuntimePolicyAbLifecycle({
      runId: 'run-1',
      runRoot: dir,
      manifestFingerprint: 'sha256:manifest',
      config,
      systemPromptPath: promptPath,
      resultsJsonlPath: join(dir, 'results.jsonl'),
      pilotTasks: [{ id: 'pilot', path: '/tasks/pilot' }],
      evaluationTasks: [{ id: 'full', path: '/tasks/full' }],
      fullReps: 2,
      arms: [
        { id: 'prune-off', contextEnv: { MAKA_CONTEXT_BUDGET: 'off' } },
        { id: 'prune-on', contextEnv: { MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on' } },
      ],
      executionProfile,
      harborRunner: async (runInput) => {
        calls.push(runInput.roundId);
        const candidate = runInput.agentEnv?.MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE === 'on';
        if (runInput.roundId.startsWith('pilot-') && !candidate) {
          throw new FixedPromptBudgetExhaustedError('pilot budget exhausted', undefined, {
            executionIdentity: {
              llmConnectionSlug: 'deepseek',
              model: 'deepseek-v4-flash',
              systemPromptHash: hashSystemPrompt(runInput.systemPrompt),
              pricingProfile: 'test-profile',
            },
          });
        }
        return output(runInput, candidate);
      },
    });

    assert.equal(state.status, 'full_completed');
    assert.equal(state.pilot?.baseline.budgetExhausted, 1);
    assert.equal(state.pilot?.candidate.passed, 1);
    assert.equal(calls.length, 6);
  });
});

test('pilot does not launch full execution after an unattested baseline timeout', async () => {
  await withDir(async (dir) => {
    const promptPath = join(dir, 'prompt.md');
    await writeFile(promptPath, 'shared prompt\n', 'utf8');
    const calls: string[] = [];
    const state = await runRuntimePolicyAbLifecycle({
      runId: 'run-1',
      runRoot: dir,
      manifestFingerprint: 'sha256:manifest',
      config,
      systemPromptPath: promptPath,
      resultsJsonlPath: join(dir, 'results.jsonl'),
      pilotTasks: [{ id: 'pilot', path: '/tasks/pilot' }],
      evaluationTasks: [{ id: 'full', path: '/tasks/full' }],
      fullReps: 2,
      arms: [
        { id: 'prune-off', contextEnv: { MAKA_CONTEXT_BUDGET: 'off' } },
        { id: 'prune-on', contextEnv: { MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on' } },
      ],
      executionProfile,
      harborRunner: async (runInput) => {
        calls.push(runInput.roundId);
        const candidate = runInput.agentEnv?.MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE === 'on';
        if (!candidate) throw new FixedPromptBudgetExhaustedError('pilot budget exhausted');
        return output(runInput, true);
      },
    });

    assert.equal(state.status, 'pilot_not_cleared');
    assert.equal(state.reason, 'pilot_plumbing_failure');
    assert.equal(calls.length, 2);
  });
});

test('maps an invalid full summary to invalid lifecycle status', async () => {
  await withDir(async (dir) => {
    const promptPath = join(dir, 'prompt.md');
    await writeFile(promptPath, 'shared prompt\n', 'utf8');
    const state = await runRuntimePolicyAbLifecycle({
      runId: 'run-1',
      runRoot: dir,
      manifestFingerprint: 'sha256:manifest',
      config,
      systemPromptPath: promptPath,
      resultsJsonlPath: join(dir, 'results.jsonl'),
      pilotTasks: [{ id: 'pilot', path: '/tasks/pilot' }],
      evaluationTasks: [{ id: 'full', path: '/tasks/full' }],
      fullReps: 2,
      arms: [
        { id: 'prune-off', contextEnv: { MAKA_CONTEXT_BUDGET: 'off' } },
        { id: 'prune-on', contextEnv: { MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on' } },
      ],
      executionProfile,
      harborRunner: async (runInput) => {
        const result = output(runInput, runInput.agentEnv?.MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE === 'on');
        if (runInput.roundId.startsWith('full-')) {
          return {
            ...result,
            cell: {
              ...result.cell,
              executionIdentity: { ...result.cell.executionIdentity!, model: 'wrong-model' },
            },
          };
        }
        return result;
      },
    });

    assert.equal(state.full?.decision, 'invalid');
    assert.equal(state.status, 'invalid');
    assert.equal(state.reason, 'plumbing_failure_observed');
  });
});

function output(input: HarborTaskRunInput, activated: boolean): HarborTaskRunOutput {
  return {
    harbor: { reward: 1 },
    cell: {
      schemaVersion: 1,
      status: 'completed',
      promptHash: hashSystemPrompt(input.systemPrompt),
      executionIdentity: {
        llmConnectionSlug: 'deepseek',
        model: 'deepseek-v4-flash',
        systemPromptHash: hashSystemPrompt(input.systemPrompt),
        pricingProfile: 'test-profile',
      },
      tokenSummary: tokenSummary({ input: 4, output: 6, reasoning: 0, total: 10, costUsd: 0.01 }),
      ...(activated ? { contextBudgetSummary: contextBudgetSummary({ activePrunedToolResults: 1 }) } : {}),
      toolSummary: { providerVisibleToolCount: 0, actualToolCalls: 0, actualToolNames: [], actualToolCallCounts: {} },
      steps: 1,
      durationMs: 100,
      startedAt: 0,
      finishedAt: 100,
      runtimeEventsPath: `/logs/${input.task.id}/runtime-events.jsonl`,
      runtimeRefs: { invocationId: 'inv', sessionId: 'session', runId: 'run', turnId: 'turn' },
    },
  };
}

async function withDir(action: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'maka-runtime-ab-lifecycle-'));
  try {
    await mkdir(dir, { recursive: true });
    await action(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
