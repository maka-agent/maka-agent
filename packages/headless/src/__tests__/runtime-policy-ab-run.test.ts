import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Config } from '../contracts.js';
import {
  hashSystemPrompt,
  type HarborTaskRunInput,
  type HarborTaskRunOutput,
} from '../fixed-prompt-controller.js';
import { buildRuntimePolicyAbRunManifest, runRuntimePolicyAbComparison } from '../runtime-policy-ab-run.js';
import { tokenSummary } from './helpers/cell-output-fixtures.js';

const config: Config = {
  id: 'cfg-runtime-policy-ab',
  backend: 'fake',
  llmConnectionSlug: 'deepseek',
  model: 'deepseek/deepseek-v4-flash',
};

describe('runRuntimePolicyAbComparison', () => {
  test('builds a runtime-policy manifest with shared prompt model task and toolchain identity', () => {
    const manifest = buildRuntimePolicyAbRunManifest({
      arms: [
        { id: 'prune-off', contextEnv: { MAKA_CONTEXT_BUDGET: 'off' } },
        { id: 'prune-on', contextEnv: { MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on' } },
      ],
      promptHash: sha256('p'),
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek/deepseek-v4-flash',
      taskBudgetSec: 1800,
      harborTimeoutMs: 2_100_000,
      subjectFingerprint: sha256('s'),
      taskSourceFingerprint: sha256('t'),
      toolchainFingerprint: sha256('c'),
      evaluationTaskIds: ['t1', 't2'],
      reps: 3,
      candidateLimit: null,
      maxConcurrency: 4,
      nonInferiorityMargin: 0.1,
      sharedAgentEnv: {
        MAKA_HARBOR_CONTINUATION: 'on',
        MAKA_HARBOR_CONTINUATION_MAX_TURNS: '3',
        MAKA_HARBOR_CONTINUATION_MAX_TOTAL_RUNTIME_STEPS: '150',
      },
    });

    assert.equal(manifest.experimentKind, 'runtime');
    assert.equal(manifest.toolchainFingerprint, sha256('c'));
    assert.deepEqual(manifest.evaluationTaskIds, ['t1', 't2']);
    assert.deepEqual(manifest.arms.map((arm) => arm.metadata?.promptHash), [sha256('p'), sha256('p')]);
    assert.deepEqual(manifest.arms.map((arm) => arm.metadata?.model), [
      'deepseek/deepseek-v4-flash',
      'deepseek/deepseek-v4-flash',
    ]);
    assert.deepEqual(manifest.arms.map((arm) => arm.metadata?.sharedAgentEnv), [
      { MAKA_HARBOR_CONTINUATION: 'on', MAKA_HARBOR_CONTINUATION_MAX_TURNS: '3', MAKA_HARBOR_CONTINUATION_MAX_TOTAL_RUNTIME_STEPS: '150' },
      { MAKA_HARBOR_CONTINUATION: 'on', MAKA_HARBOR_CONTINUATION_MAX_TURNS: '3', MAKA_HARBOR_CONTINUATION_MAX_TOTAL_RUNTIME_STEPS: '150' },
    ]);
    assert.notEqual(manifest.arms[0].fingerprint, manifest.arms[1].fingerprint);
    assert.deepEqual(manifest.arms.map((arm) => arm.metadata?.contextEnv), [
      { MAKA_CONTEXT_BUDGET: 'off' },
      { MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on' },
    ]);
  });

  test('builds and runs task-tool runtime-policy arms with arm-local context env', async () => {
    await withDir(async (dir) => {
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
      const taskToolsOff = { id: 'task-tools-off', contextEnv: {} } as const;
      const taskToolsOn = {
        id: 'task-tools-on',
        contextEnv: {
          MAKA_CONTEXT_TASK_TOOLS: 'on',
          MAKA_CONTEXT_TASK_REPLAY_MAX_CHARS: '700',
        },
      } as const;
      const manifest = buildRuntimePolicyAbRunManifest({
        arms: [taskToolsOff, taskToolsOn],
        promptHash: sha256('p'),
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek/deepseek-v4-flash',
        taskBudgetSec: 1800,
        harborTimeoutMs: 2_100_000,
        subjectFingerprint: sha256('s'),
        taskSourceFingerprint: sha256('t'),
        toolchainFingerprint: sha256('c'),
        evaluationTaskIds: ['t1'],
        reps: 1,
        candidateLimit: null,
        maxConcurrency: 1,
      });
      const calls: string[] = [];

      await runRuntimePolicyAbComparison({
        runId: 'runtime-ab-run',
        config,
        systemPromptPath,
        resultsJsonlPath,
        evaluationTasks: [{ id: 't1', path: '/bench/t1' }],
        reps: 1,
        arms: [taskToolsOff, taskToolsOn],
        resumeFingerprint: 'caller-salt',
        harborRunner: async (input) => {
          calls.push(`${input.roundId}:${JSON.stringify(input.agentEnv ?? {})}`);
          return harborOutput(input);
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.notEqual(manifest.arms[0].fingerprint, manifest.arms[1].fingerprint);
      assert.deepEqual(manifest.arms[1].metadata?.contextEnv, {
        MAKA_CONTEXT_TASK_REPLAY_MAX_CHARS: '700',
        MAKA_CONTEXT_TASK_TOOLS: 'on',
      });
      assert.deepEqual(calls.sort(), [
        'ab-task-tools-off-r0-t1:{}',
        'ab-task-tools-on-r0-t1:{"MAKA_CONTEXT_TASK_TOOLS":"on","MAKA_CONTEXT_TASK_REPLAY_MAX_CHARS":"700"}',
      ]);
    });
  });

  test('rejects unsupported context env keys before fingerprinting runtime-policy arms', () => {
    assert.throws(
      () => buildRuntimePolicyAbRunManifest({
        arms: [
          { id: 'prune-off', contextEnv: { MAKA_CONTEXT_BUDGET: 'off' } },
          { id: 'prune-on', contextEnv: { MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on', MAKA_CONTEXT_FOO: '1' } as never },
        ],
        promptHash: sha256('p'),
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek/deepseek-v4-flash',
        taskBudgetSec: 1800,
        harborTimeoutMs: 2_100_000,
        subjectFingerprint: sha256('s'),
        taskSourceFingerprint: sha256('t'),
        toolchainFingerprint: sha256('c'),
        evaluationTaskIds: ['t1'],
        reps: 1,
        candidateLimit: null,
        maxConcurrency: 1,
      }),
      /unsupported Harbor context env key: MAKA_CONTEXT_FOO/,
    );
  });

  test('rejects unsupported shared agent env keys before fingerprinting runtime-policy arms', () => {
    assert.throws(
      () => buildRuntimePolicyAbRunManifest({
        arms: [
          { id: 'prune-off', contextEnv: { MAKA_CONTEXT_BUDGET: 'off' } },
          { id: 'prune-on', contextEnv: { MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on' } },
        ],
        sharedAgentEnv: { MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on' } as never,
        promptHash: sha256('p'),
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek/deepseek-v4-flash',
        taskBudgetSec: 1800,
        harborTimeoutMs: 2_100_000,
        subjectFingerprint: sha256('s'),
        taskSourceFingerprint: sha256('t'),
        toolchainFingerprint: sha256('c'),
        evaluationTaskIds: ['t1'],
        reps: 1,
        candidateLimit: null,
        maxConcurrency: 1,
      }),
      /unsupported runtime policy shared agent env key: MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE/,
    );
  });

  test('runs prune off against prune on with only arm-local context env changed', async () => {
    await withDir(async (dir) => {
      const promptPath = join(dir, 'system-prompt.md');
      await writeFile(promptPath, 'shared prompt\n', 'utf8');
      const calls: HarborTaskRunInput[] = [];

      const result = await runRuntimePolicyAbComparison({
        runId: 'runtime-ab-run',
        config,
        systemPromptPath: promptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        evaluationTasks: [{ id: 't1', path: '/tasks/t1' }],
        reps: 1,
        arms: [
          { id: 'prune-off', contextEnv: { MAKA_CONTEXT_BUDGET: 'off' } },
          {
            id: 'prune-on',
            contextEnv: {
              MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on',
              MAKA_CONTEXT_ARCHIVE_RETRIEVAL: 'on',
            },
          },
        ],
        harborRunner: async (input) => {
          calls.push(input);
          return harborOutput(input);
        },
        sharedAgentEnv: {
          MAKA_HARBOR_CONTINUATION: 'on',
          MAKA_HARBOR_CONTINUATION_MAX_TURNS: '3',
          MAKA_HARBOR_CONTINUATION_MAX_TOTAL_RUNTIME_STEPS: '150',
        },
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.baselineArmId, 'prune-off');
      assert.equal(result.candidateArmId, 'prune-on');
      assert.deepEqual(result.baseline.contextBudgetPolicy?.snapshots, [{ enabled: false }]);
      assert.deepEqual(result.candidate.contextBudgetPolicy?.snapshots, [{
        enabled: true,
        name: 'harbor-cell-context-budget',
        staleToolResultPrune: { enabled: true, maxResultEstimatedTokens: 2048, minRecentTurnsFull: 2 },
        archiveRetrieval: {
          enabled: true,
          maxResults: 3,
          maxEstimatedTokens: 8192,
          maxBytes: 1024 * 1024,
          order: 'newest_first',
        },
        minRecentTurns: 2,
      }]);
      assert.equal(calls.length, 2);
      assert.deepEqual(calls.map((call) => call.systemPrompt), ['shared prompt\n', 'shared prompt\n']);
      assert.deepEqual(calls.map((call) => call.config.model), [config.model, config.model]);
      assert.deepEqual(calls.map((call) => call.task.id), ['t1', 't1']);
      const agentEnvByRoundId = new Map(calls.map((call) => [call.roundId, call.agentEnv]));
      assert.deepEqual(agentEnvByRoundId.get('ab-prune-off-r0-t1'), {
        MAKA_HARBOR_CONTINUATION: 'on',
        MAKA_HARBOR_CONTINUATION_MAX_TURNS: '3',
        MAKA_HARBOR_CONTINUATION_MAX_TOTAL_RUNTIME_STEPS: '150',
        MAKA_CONTEXT_BUDGET: 'off',
      });
      assert.deepEqual(agentEnvByRoundId.get('ab-prune-on-r0-t1'), {
        MAKA_HARBOR_CONTINUATION: 'on',
        MAKA_HARBOR_CONTINUATION_MAX_TURNS: '3',
        MAKA_HARBOR_CONTINUATION_MAX_TOTAL_RUNTIME_STEPS: '150',
        MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on',
        MAKA_CONTEXT_ARCHIVE_RETRIEVAL: 'on',
      });
    });
  });

  test('resumes runtime-policy arms only when their context env identity is unchanged', async () => {
    await withDir(async (dir) => {
      const promptPath = join(dir, 'system-prompt.md');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(promptPath, 'shared prompt\n', 'utf8');
      const task = { id: 't1', path: '/tasks/t1' };
      const pruneOff = { id: 'prune-off', contextEnv: { MAKA_CONTEXT_BUDGET: 'off' } } as const;
      const pruneOn = {
        id: 'prune-on',
        contextEnv: { MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on' },
      } as const;
      const pruneOnChanged = {
        id: 'prune-on',
        contextEnv: {
          MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on',
          MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_TOKENS: '4096',
        },
      } as const;
      let calls: string[] = [];
      const run = async (arms: Parameters<typeof runRuntimePolicyAbComparison>[0]['arms']) => {
        await runRuntimePolicyAbComparison({
          runId: 'runtime-ab-run',
          config,
          systemPromptPath: promptPath,
          resultsJsonlPath,
          evaluationTasks: [task],
          reps: 1,
          arms,
          sharedAgentEnv: { MAKA_HARBOR_CONTINUATION: 'on' },
          resumeFingerprint: 'caller-salt',
          harborRunner: async (input) => {
            calls.push(`${input.roundId}:${JSON.stringify(input.agentEnv ?? {})}`);
            return harborOutput(input);
          },
          now: () => 100,
          newId: idFactory(),
        });
      };

      await run([pruneOff, pruneOn]);
      assert.equal(calls.length, 2);

      calls = [];
      await run([pruneOff, pruneOnChanged]);
      assert.deepEqual(calls, [
        'ab-prune-on-r0-t1:{"MAKA_HARBOR_CONTINUATION":"on","MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE":"on","MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_TOKENS":"4096"}',
      ]);

      calls = [];
      await run([pruneOff, pruneOnChanged]);
      assert.deepEqual(calls, []);

      calls = [];
      await runRuntimePolicyAbComparison({
        runId: 'runtime-ab-run',
        config,
        systemPromptPath: promptPath,
        resultsJsonlPath,
        evaluationTasks: [task],
        reps: 1,
        arms: [pruneOff, pruneOnChanged],
        sharedAgentEnv: {
          MAKA_HARBOR_CONTINUATION: 'on',
          MAKA_HARBOR_CONTINUATION_MAX_TURNS: '3',
          MAKA_HARBOR_CONTINUATION_MAX_TOTAL_RUNTIME_STEPS: '150',
        },
        resumeFingerprint: 'caller-salt',
        harborRunner: async (input) => {
          calls.push(`${input.roundId}:${JSON.stringify(input.agentEnv ?? {})}`);
          return harborOutput(input);
        },
        now: () => 100,
        newId: idFactory(),
      });
      assert.deepEqual(calls.sort(), [
        'ab-prune-off-r0-t1:{"MAKA_HARBOR_CONTINUATION":"on","MAKA_HARBOR_CONTINUATION_MAX_TURNS":"3","MAKA_HARBOR_CONTINUATION_MAX_TOTAL_RUNTIME_STEPS":"150","MAKA_CONTEXT_BUDGET":"off"}',
        'ab-prune-on-r0-t1:{"MAKA_HARBOR_CONTINUATION":"on","MAKA_HARBOR_CONTINUATION_MAX_TURNS":"3","MAKA_HARBOR_CONTINUATION_MAX_TOTAL_RUNTIME_STEPS":"150","MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE":"on","MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_TOKENS":"4096"}',
      ]);
    });
  });
});

function harborOutput(input: HarborTaskRunInput): HarborTaskRunOutput {
  const pruneOn = input.agentEnv?.MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE === 'on';
  return {
    harbor: { reward: 1 },
    cell: {
      schemaVersion: 1,
      status: 'completed',
      promptHash: hashSystemPrompt(input.systemPrompt),
      tokenSummary: tokenSummary({ input: 4, output: 6, reasoning: 0, total: 10, costUsd: 0.01 }),
      contextBudgetPolicy: pruneOn
        ? {
          enabled: true,
          name: 'harbor-cell-context-budget',
          staleToolResultPrune: { enabled: true, maxResultEstimatedTokens: 2048, minRecentTurnsFull: 2 },
          archiveRetrieval: {
            enabled: true,
            maxResults: 3,
            maxEstimatedTokens: 8192,
            maxBytes: 1024 * 1024,
            order: 'newest_first',
          },
          minRecentTurns: 2,
        }
        : { enabled: false },
      toolSummary: {
        providerVisibleToolCount: 1,
        actualToolCalls: 1,
        actualToolNames: ['Bash'],
        actualToolCallCounts: { Bash: 1 },
      },
      steps: 1,
      durationMs: 100,
      startedAt: 0,
      finishedAt: 100,
      runtimeEventsPath: `/logs/${input.task.id}/runtime-events.jsonl`,
      runtimeRefs: {
        invocationId: `inv-${input.task.id}`,
        sessionId: `session-${input.task.id}`,
        runId: `run-${input.task.id}`,
        turnId: `turn-${input.task.id}`,
      },
    },
  };
}

function idFactory(): () => string {
  let next = 0;
  return () => `id-${next++}`;
}

function sha256(char: string): string {
  return `sha256:${char.repeat(64)}`;
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'maka-runtime-policy-ab-'));
  try {
    await mkdir(dir, { recursive: true });
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
