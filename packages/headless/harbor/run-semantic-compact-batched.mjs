#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureAbRunManifest } from '#ab-manifest';
import {
  discoverCachedHarborTasks,
  fingerprintFixedPromptTaskTree,
  resolveFixedPromptRunRoot,
} from '#fixed-prompt-task-source';
import { createHarborTaskRunner } from '#harbor-task-runner';
import {
  buildHarnessOracleExecutionPolicyFingerprint,
} from '#harness-oracle-policy';
import {
  assertTerminalBench21TaskSet,
  assertTerminalBench21TaskTreeFingerprint,
  buildHarnessAbResumeFingerprint,
  buildHarnessAbRunManifest,
  TERMINAL_BENCH_2_1_REVISION,
} from '#harness-ab-manifest';
import {
  runHarnessAbComparisonUnlocked,
  withHarnessAbRunLock,
} from '#harness-ab-run';
import {
  assertHarnessAbReportCompleted,
  buildHarnessAbReport,
  renderHarnessAbReportCsv,
  renderHarnessAbReportMarkdown,
} from '#harness-ab-report';
import {
  resolveAdvisoryOracleEvidence,
} from './run-harness-ab.mjs';
import {
  buildSubjectFingerprint,
  buildToolchainFingerprint,
} from './run-prompt-ab.mjs';

const ISSUE_TASK_IDS = [
  'sanitize-git-repo',
  'prove-plus-comm',
  'merge-diff-arc-agi-task',
  'fix-git',
  'log-summary-date-ranges',
  'hf-model-inference',
  'reshard-c4-data',
  'polyglot-rust-c',
  'custom-memory-heap-crash',
  'polyglot-c-py',
  'password-recovery',
  'configure-git-webserver',
  'pytorch-model-cli',
  'crack-7z-hash',
  'mteb-leaderboard',
];

const REMAINING_TASK_IDS = [
  'gpt2-codegolf',
  'make-doom-for-mips',
  'chess-best-move',
  'write-compressor',
  'tune-mjcf',
  'raman-fitting',
  'mcmc-sampling-stan',
  'train-fasttext',
  'extract-elf',
  'financial-document-processor',
  'sqlite-with-gcov',
  'sqlite-db-truncate',
  'large-scale-text-editing',
  'fix-code-vulnerability',
  'pytorch-model-recovery',
];

const HISTORICAL_V1_TASK_IDS = [
  'crack-7z-hash',
  'sanitize-git-repo',
  'prove-plus-comm',
  'gpt2-codegolf',
  'password-recovery',
  'merge-diff-arc-agi-task',
  'fix-git',
  'log-summary-date-ranges',
  'make-doom-for-mips',
  'hf-model-inference',
  'chess-best-move',
  'write-compressor',
  'tune-mjcf',
  'configure-git-webserver',
  'raman-fitting',
  'reshard-c4-data',
  'polyglot-rust-c',
  'mcmc-sampling-stan',
  'custom-memory-heap-crash',
  'polyglot-c-py',
  'train-fasttext',
  'extract-elf',
  'financial-document-processor',
  'pytorch-model-cli',
  'sqlite-with-gcov',
  'sqlite-db-truncate',
  'large-scale-text-editing',
  'fix-code-vulnerability',
  'pytorch-model-recovery',
  'mteb-leaderboard',
];

const PROVIDER = 'zai-coding-plan';
const MODEL = 'glm-5.2';
const MODEL_SPEC = `${PROVIDER}/${MODEL}`;
const REASONING_EFFORT = 'max';
const BASE_URL = 'https://api.z.ai/api/coding/paas/v4';
const PRICING = {
  currency: 'USD',
  unit: 'per_1m_tokens',
  input: 1.4,
  cachedInput: 0.26,
  output: 4.4,
  source: 'z.ai-public-2026-07-13',
};
const OUTER_TIMEOUT_GRACE_SEC = 15 * 60;
const OFF_PROFILE = {
  activeToolResultPrune: { enabled: true, maxCurrentResultEstimatedTokens: 2048, minStepNumber: 1 },
  staleToolResultPrune: { enabled: true, maxResultEstimatedTokens: 2048, minRecentTurnsFull: 0 },
  semanticCompact: { enabled: false },
};
const COMPACT_PROFILE = {
  activeToolResultPrune: { enabled: true, maxCurrentResultEstimatedTokens: 2048, minStepNumber: 1 },
  staleToolResultPrune: { enabled: true, maxResultEstimatedTokens: 2048, minRecentTurnsFull: 0 },
  semanticCompact: {
    enabled: true,
    mode: 'replace',
    minStepNumber: 2,
    highWaterRatio: 0.5,
    maxActiveEstimatedTokens: 16384,
    minRecentMessages: 4,
    minRecentToolPairs: 1,
    maxSummaryEstimatedTokens: 768,
    minSavingsTokens: 256,
    minSavingsRatio: 0.05,
    minNetSavingsTokens: 256,
    compactCallTokenCostWeight: 1,
    maxCompactCallTokens: 4096,
    maxConsecutiveInvalidSummaries: 2,
    invalidSummaryCooldownSteps: 8,
    archiveRequired: false,
    promptVersion: 'maka-semantic-compact-json-v2',
    highWaterName: 'harbor-cell-semantic-compact',
  },
};

function envPath(name, fallback) {
  const raw = process.env[name] || fallback;
  if (!raw) throw new Error(`${name} is required`);
  return raw.startsWith('~') ? join(homedir(), raw.slice(1)) : resolve(raw);
}

function assertTaskPartition() {
  const combined = [...ISSUE_TASK_IDS, ...REMAINING_TASK_IDS];
  const combinedSet = new Set(combined);
  const historicalSet = new Set(HISTORICAL_V1_TASK_IDS);
  if (ISSUE_TASK_IDS.length !== 15 || REMAINING_TASK_IDS.length !== 15 || combinedSet.size !== 30) {
    throw new Error('semantic compact task batches must contain 15 + 15 unique tasks');
  }
  const missing = HISTORICAL_V1_TASK_IDS.filter((id) => !combinedSet.has(id));
  const extra = combined.filter((id) => !historicalSet.has(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`task batches differ from historical v1; missing=${missing.join(',')}; extra=${extra.join(',')}`);
  }
}

export function contextBudgetEnv(profile) {
  const common = {
    MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE: 'on',
    MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MAX_ESTIMATED_TOKENS: '2048',
    MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MIN_STEP_NUMBER: '1',
    MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on',
    MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_ESTIMATED_TOKENS: '2048',
    MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS_FULL: '0',
  };
  if (!profile.semanticCompact.enabled) return { ...common, MAKA_CONTEXT_SEMANTIC_COMPACT: 'off' };
  const semantic = profile.semanticCompact;
  return {
    ...common,
    MAKA_CONTEXT_SEMANTIC_COMPACT: 'on',
    MAKA_CONTEXT_SEMANTIC_COMPACT_MODE: semantic.mode,
    MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_STEP_NUMBER: String(semantic.minStepNumber),
    MAKA_CONTEXT_SEMANTIC_COMPACT_HIGH_WATER_RATIO: String(semantic.highWaterRatio),
    MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_ACTIVE_ESTIMATED_TOKENS: String(semantic.maxActiveEstimatedTokens),
    MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_RECENT_MESSAGES: String(semantic.minRecentMessages),
    MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_RECENT_TOOL_PAIRS: String(semantic.minRecentToolPairs),
    MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_SUMMARY_ESTIMATED_TOKENS: String(semantic.maxSummaryEstimatedTokens),
    MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_SAVINGS_TOKENS: String(semantic.minSavingsTokens),
    MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_SAVINGS_RATIO: String(semantic.minSavingsRatio),
    MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_NET_SAVINGS_TOKENS: String(semantic.minNetSavingsTokens),
    MAKA_CONTEXT_SEMANTIC_COMPACT_CALL_TOKEN_COST_WEIGHT: String(semantic.compactCallTokenCostWeight),
    MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_CALL_TOKENS: String(semantic.maxCompactCallTokens),
    MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_CONSECUTIVE_INVALID_SUMMARIES: String(semantic.maxConsecutiveInvalidSummaries),
    MAKA_CONTEXT_SEMANTIC_COMPACT_INVALID_SUMMARY_COOLDOWN_STEPS: String(semantic.invalidSummaryCooldownSteps),
    MAKA_CONTEXT_SEMANTIC_COMPACT_ARCHIVE_REQUIRED: String(semantic.archiveRequired),
    MAKA_CONTEXT_SEMANTIC_COMPACT_PROMPT_VERSION: semantic.promptVersion,
    MAKA_CONTEXT_SEMANTIC_COMPACT_HIGH_WATER_NAME: semantic.highWaterName,
  };
}

function buildManifest({ taskIds, batchId, subjectFingerprint, taskSourceFingerprint, toolchainFingerprint, oracleEvidence }) {
  return buildHarnessAbRunManifest({
    benchmark: {
      dataset: 'terminal-bench',
      version: '2.1',
      revision: TERMINAL_BENCH_2_1_REVISION,
      timeoutPolicy: 'task-native',
      timeoutMultiplier: 1,
      outerTimeoutGraceSec: OUTER_TIMEOUT_GRACE_SEC,
    },
    taskIds,
    orderSeed: `terminal-bench-2.1:glm-5.2:semantic-compact:${batchId}:v1`,
    pilotTaskCount: taskIds.length,
    model: { provider: PROVIDER, id: MODEL, reasoningEffort: REASONING_EFFORT },
    pricing: PRICING,
    arms: [
      {
        id: 'maka-semantic-off',
        version: subjectFingerprint,
        config: {
          adapter: 'maka_agent:MakaAgent', externalSystemPrompt: 'empty', reasoningEffort: REASONING_EFFORT,
          continuation: false, attemptPolicy: 'single', contextBudget: OFF_PROFILE,
        },
      },
      {
        id: 'maka-semantic-compact-replace',
        version: subjectFingerprint,
        config: {
          adapter: 'maka_agent:MakaAgent', externalSystemPrompt: 'empty', reasoningEffort: REASONING_EFFORT,
          continuation: false, attemptPolicy: 'single', contextBudget: COMPACT_PROFILE,
        },
      },
    ],
    taskBudgetSec: null,
    harborTimeoutMs: null,
    subjectFingerprint,
    taskSourceFingerprint,
    toolchainFingerprint,
    oracleEvidence,
  });
}

async function writeJsonAtomic(path, value) {
  const pending = `${path}.${process.pid}.tmp`;
  await writeFile(pending, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(pending, path);
}

async function runBatch({ parentRoot, batchId, taskIds, tasksById, common }) {
  const runId = `${common.parentRunId}-${batchId}`;
  const runRoot = resolveFixedPromptRunRoot(parentRoot, runId, 'MAKA_SEMANTIC_AB_RUN_ID');
  return withHarnessAbRunLock(runRoot, async () => {
    const manifest = buildManifest({ taskIds, batchId, ...common });
    await mkdir(runRoot, { recursive: true });
    await ensureAbRunManifest(join(runRoot, 'harness-ab-manifest.json'), manifest);
    const evaluationTasks = manifest.evaluationTaskIds.map((taskId) => tasksById.get(taskId));
    if (evaluationTasks.some((task) => !task)) throw new Error(`${batchId} contains a task absent from source`);

    const controllerDir = join(runRoot, 'controller');
    const promptsDir = join(runRoot, 'prompts');
    const jobsDir = join(runRoot, 'jobs');
    await Promise.all([
      mkdir(controllerDir, { recursive: true }),
      mkdir(promptsDir, { recursive: true }),
      mkdir(jobsDir, { recursive: true }),
    ]);
    const systemPromptPath = join(promptsDir, 'empty-system-prompt.txt');
    await writeFile(systemPromptPath, '', 'utf8');
    const runnerOptions = {
      makaRepoPath: common.makaRepoPath,
      jobsDir,
      model: MODEL_SPEC,
      provider: PROVIDER,
      reasoningEffort: REASONING_EFFORT,
      apiKeyFile: common.keyFile,
      apiKeyEnvName: 'ZAI_API_KEY',
      pricing: {
        inputUsdPer1M: PRICING.input,
        cacheReadUsdPer1M: PRICING.cachedInput,
        outputUsdPer1M: PRICING.output,
        source: PRICING.source,
      },
      agentEnv: { ZAI_BASE_URL: BASE_URL },
      timeoutMultiplier: 1,
      dockerPlatform: 'linux/amd64',
      agent: 'maka',
    };
    const config = (id) => ({
      id: `semantic-compact-ab-${id}`,
      backend: 'ai-sdk',
      llmConnectionSlug: PROVIDER,
      model: MODEL,
      thinkingLevel: REASONING_EFFORT,
    });
    const summary = await runHarnessAbComparisonUnlocked({
      runId,
      runRoot,
      resultsJsonlPath: join(controllerDir, 'results.jsonl'),
      systemPromptPath,
      resumeFingerprint: buildHarnessAbResumeFingerprint(manifest),
      evaluationTasks,
      arms: [
        {
          id: 'maka-semantic-off',
          config: config('off'),
          expectedPricingProfile: PRICING.source,
          harborRunner: createHarborTaskRunner({
            ...runnerOptions,
            agentEnv: { ...runnerOptions.agentEnv, ...contextBudgetEnv(OFF_PROFILE) },
          }),
        },
        {
          id: 'maka-semantic-compact-replace',
          config: config('replace'),
          expectedPricingProfile: PRICING.source,
          harborRunner: createHarborTaskRunner({
            ...runnerOptions,
            agentEnv: { ...runnerOptions.agentEnv, ...contextBudgetEnv(COMPACT_PROFILE) },
          }),
        },
      ],
    });
    const selected = new Set(taskIds);
    const report = buildHarnessAbReport(summary, {
      ...(common.oracleEvidence.resolvedSnapshotFingerprint
        ? { snapshotFingerprint: common.oracleEvidence.resolvedSnapshotFingerprint }
        : {}),
      annotations: common.oracleEvidence.annotations.filter((annotation) => selected.has(annotation.taskId)),
      warnings: common.oracleEvidence.warnings,
    });
    await Promise.all([
      writeFile(join(runRoot, 'harness-ab-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
      writeFile(join(runRoot, 'harness-ab-report.csv'), renderHarnessAbReportCsv(report), 'utf8'),
      writeFile(join(runRoot, 'harness-ab-report.md'), renderHarnessAbReportMarkdown(report), 'utf8'),
    ]);
    assertHarnessAbReportCompleted(report);
    console.log(`${batchId}: ${report.runStatus}; ${report.coverage.attemptedCells}/${report.coverage.scheduledCells} cells`);
    return { runId, runRoot, report };
  });
}

export async function main() {
  assertTaskPartition();
  const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const makaRepoPath = envPath('MAKA_SEMANTIC_AB_MAKA_REPO', repoRoot);
  const outDir = envPath('MAKA_SEMANTIC_AB_OUT_DIR', join(homedir(), '.maka/eval/runs/semantic-compact-on-off-20260717'));
  const parentRunId = process.env.MAKA_SEMANTIC_AB_RUN_ID || 'glm-5.2-semantic-compact-30-local-edit-fix-v1';
  const parentRoot = resolveFixedPromptRunRoot(outDir, parentRunId, 'MAKA_SEMANTIC_AB_RUN_ID');
  const tasksRoot = envPath('MAKA_SEMANTIC_AB_TASKS_ROOT', join(homedir(), '.cache/harbor/tasks'));
  const keyFile = envPath('MAKA_SEMANTIC_AB_KEY_FILE', join(repoRoot, '.local-secrets/zai-key'));
  await mkdir(parentRoot, { recursive: true });

  const allTasks = await discoverCachedHarborTasks(tasksRoot);
  assertTerminalBench21TaskSet(allTasks.map((task) => task.id));
  const taskSourceFingerprint = await fingerprintFixedPromptTaskTree(allTasks);
  assertTerminalBench21TaskTreeFingerprint(taskSourceFingerprint);
  const tasksById = new Map(allTasks.map((task) => [task.id, task]));
  for (const taskId of HISTORICAL_V1_TASK_IDS) {
    if (!tasksById.has(taskId)) throw new Error(`missing historical task: ${taskId}`);
  }

  if (process.env.MAKA_SEMANTIC_AB_DRY_RUN === '1') {
    console.log(`dry-run: 15 issue tasks + 15 remaining tasks = historical v1's 30 unique tasks; 60 total cells -> ${parentRoot}`);
    return;
  }

  if ((await readFile(keyFile, 'utf8')).trim().length === 0) throw new Error('MAKA_SEMANTIC_AB_KEY_FILE is empty');
  const [subjectFingerprint, toolchainFingerprint, verifierSource, composeSource] = await Promise.all([
    buildSubjectFingerprint(makaRepoPath, process.env.MAKA_SEMANTIC_AB_EXPLICIT_SUBJECT_FINGERPRINT),
    buildToolchainFingerprint(process.env.MAKA_SEMANTIC_AB_TOOLCHAIN_FINGERPRINT, undefined, makaRepoPath),
    readFile(join(makaRepoPath, 'packages/headless/harbor/maka_verifier.py')),
    readFile(join(makaRepoPath, 'packages/headless/harbor/docker-compose-linux-amd64.yaml')),
  ]);
  const executionPolicyFingerprint = buildHarnessOracleExecutionPolicyFingerprint({
    verifierImplementationSource: verifierSource,
    composeImplementationSource: composeSource,
  });
  const oracleEvidence = await resolveAdvisoryOracleEvidence({ allTasks, executionPolicyFingerprint });
  const common = {
    parentRunId,
    makaRepoPath,
    keyFile,
    subjectFingerprint,
    taskSourceFingerprint,
    toolchainFingerprint,
    oracleEvidence,
  };
  const journalPath = join(parentRoot, 'background-run.json');
  const startedAt = process.env.MAKA_SEMANTIC_AB_STARTED_AT || new Date().toISOString();
  const baseJournal = {
    schemaVersion: 1,
    pid: process.pid,
    startedAt,
    subjectFingerprint,
    taskSourceFingerprint,
    batches: [
      { id: 'issue15', taskCount: ISSUE_TASK_IDS.length },
      { id: 'remaining15', taskCount: REMAINING_TASK_IDS.length },
    ],
  };
  await writeJsonAtomic(join(parentRoot, 'experiment-manifest.json'), {
    schemaVersion: 1,
    parentRunId,
    historicalV1TaskIds: HISTORICAL_V1_TASK_IDS,
    batches: { issue15: ISSUE_TASK_IDS, remaining15: REMAINING_TASK_IDS },
    subjectFingerprint,
    taskSourceFingerprint,
    toolchainFingerprint,
  });
  try {
    await writeJsonAtomic(journalPath, { ...baseJournal, status: 'running', currentBatch: 'issue15' });
    const issue15 = await runBatch({ parentRoot, batchId: 'issue15', taskIds: ISSUE_TASK_IDS, tasksById, common });
    await writeJsonAtomic(journalPath, { ...baseJournal, status: 'running', currentBatch: 'remaining15', completedBatches: ['issue15'] });
    const remaining15 = await runBatch({ parentRoot, batchId: 'remaining15', taskIds: REMAINING_TASK_IDS, tasksById, common });
    await writeJsonAtomic(join(parentRoot, 'combined-report.json'), {
      schemaVersion: 1,
      runId: parentRunId,
      uniqueTaskCount: 30,
      scheduledCells: 60,
      batches: [issue15.report, remaining15.report],
    });
    await writeJsonAtomic(journalPath, {
      ...baseJournal,
      status: 'completed',
      completedBatches: ['issue15', 'remaining15'],
      finishedAt: new Date().toISOString(),
      exitCode: 0,
    });
  } catch (error) {
    await writeJsonAtomic(journalPath, {
      ...baseJournal,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      exitCode: 1,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
