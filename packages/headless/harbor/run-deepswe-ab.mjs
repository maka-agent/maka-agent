#!/usr/bin/env node

// DeepSWE (Datacurve, via Pier) harness A/B: Maka vs the pinned Codex CLI,
// both on openai-codex/gpt-5.6-sol through the host provider auth proxy
// (Codex OAuth; the real credential never reaches a task container).
// Issue #1343's Pier leg — the Terminal-Bench 2.1 sibling is run-harness-ab.mjs.

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureAbRunManifest } from '#ab-manifest';
import {
  discoverCachedHarborTasks,
  fingerprintFixedPromptTaskTree,
  resolveFixedPromptRunRoot,
  selectTasksByIds,
} from '#fixed-prompt-task-source';
import { createPierTaskRunner } from '#pier-task-runner';
import {
  CODEX_TOOLCHAIN_FINGERPRINT,
  CODEX_TOOLCHAIN_SPEC,
  prepareCodexToolchain,
} from '#codex-toolchain';
import { createCodexOAuthHarnessCredentialBinding } from '#codex-oauth-harness';
import {
  assertDeepSweSubset30TaskTreeFingerprint,
  buildHarnessAbResumeFingerprint,
  buildHarnessAbRunManifest,
  DEEP_SWE_REVISION,
  DEEP_SWE_SUBSET_30_TASK_IDS,
  HARNESS_MAKA_CONTEXT_BUDGET,
} from '#harness-ab-manifest';
import { runHarnessAbComparisonUnlocked, withHarnessAbRunLock } from '#harness-ab-run';
import { DEFAULT_HEADLESS_SYSTEM_PROMPT } from '@maka/headless';
import { thinkingVariantsForModel } from '@maka/core/model-thinking';
import {
  assertHarnessAbReportCompleted,
  buildHarnessAbReport,
  renderHarnessAbReportCsv,
  renderHarnessAbReportMarkdown,
} from '#harness-ab-report';
import { envPath as parseEnvPath } from '#headless-run-env';
import { buildSubjectFingerprint, buildToolchainFingerprint } from '#experiment-fingerprint';
import { runExperiment } from '#experiment-engine';
import {
  defaultMakaWorkspaceRoot,
  harnessMakaContextBudgetEnv,
  resolveHarnessCompetitorToolchainPath,
} from './run-harness-ab.mjs';

export const DEFAULT_DEEPSWE_AB_RUN_ID = 'gpt-5.6-sol-maka-vs-codex-oauth-deepswe-subset30-v1';
const PROVIDER = 'openai-codex';
const MODEL = 'gpt-5.6-sol';
const REASONING_EFFORT = 'xhigh';
const BASE_URL = 'https://chatgpt.com/backend-api/codex';
const ORDER_SEED = 'deep-swe-1.1:gpt-5.6-sol:harness-comparison:v1';
const BILLING_MODE = 'account-plan';
const PRICING = {
  currency: 'USD',
  unit: 'per_1m_tokens',
  input: 0,
  cachedInput: 0,
  output: 0,
  source: 'openai-codex-chatgpt-account-plan',
};
const MAX_PAIR_CONCURRENCY = 2;
const DEFAULT_PAIR_CONCURRENCY = 1;
const DEFAULT_ARM_EXECUTION = 'sequential';
// Pier's own trial lifecycle watchdog (build/setup/agent/verifier + retries)
// is derived per task inside the runner; this grace only feeds the manifest's
// benchmark record, mirroring the Terminal-Bench sibling.
const PIER_SETUP_TEARDOWN_GRACE_SEC = 15 * 60;

const CODEX_PROFILE = Object.freeze({
  id: 'codex',
  version: CODEX_TOOLCHAIN_SPEC.codex.version,
  toolchainFingerprint: CODEX_TOOLCHAIN_FINGERPRINT,
  config: Object.freeze({
    adapter: 'codex_agent:MakaCodexAgent',
    transport: 'responses-http',
    permissions: 'container-full-access',
    attemptPolicy: 'single',
    billingMode: BILLING_MODE,
  }),
});

const envPath = (name, fallback) => parseEnvPath(name, process.env[name], fallback);

export function resolveDeepSweAbTaskSelection(rawTaskId, rawLimit, rawTaskIds) {
  const taskId = rawTaskId?.trim();
  const explicitTaskIds = rawTaskIds
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (rawTaskIds !== undefined && explicitTaskIds?.length === 0) {
    throw new Error('MAKA_DEEPSWE_AB_TASK_IDS must contain at least one task id');
  }
  if (taskId && explicitTaskIds?.length) {
    throw new Error('MAKA_DEEPSWE_AB_TASK_ID and MAKA_DEEPSWE_AB_TASK_IDS are mutually exclusive');
  }
  const known = new Set(DEEP_SWE_SUBSET_30_TASK_IDS);
  if (explicitTaskIds?.length) {
    const unique = [...new Set(explicitTaskIds)];
    if (unique.length !== explicitTaskIds.length) {
      throw new Error('MAKA_DEEPSWE_AB_TASK_IDS must not contain duplicate task ids');
    }
    const unknown = unique.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new Error(
        `MAKA_DEEPSWE_AB_TASK_IDS contains tasks outside the DeepSWE subset-30: ${unknown.join(', ')}`,
      );
    }
    return { taskIds: unique, limit: unique.length };
  }
  if (taskId) {
    if (!known.has(taskId)) {
      throw new Error('MAKA_DEEPSWE_AB_TASK_ID must name a DeepSWE subset-30 task');
    }
    return { taskIds: [taskId], limit: 1 };
  }
  const limit = rawLimit === undefined ? DEEP_SWE_SUBSET_30_TASK_IDS.length : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DEEP_SWE_SUBSET_30_TASK_IDS.length) {
    throw new Error(
      `MAKA_DEEPSWE_AB_LIMIT must be an integer between 1 and ${DEEP_SWE_SUBSET_30_TASK_IDS.length}`,
    );
  }
  return { taskIds: DEEP_SWE_SUBSET_30_TASK_IDS, limit };
}

export function resolveDeepSweAbExecutionPolicy(rawPairConcurrency, rawArmExecution) {
  const pairConcurrency = Number(rawPairConcurrency ?? DEFAULT_PAIR_CONCURRENCY);
  if (
    !Number.isSafeInteger(pairConcurrency) ||
    pairConcurrency < 1 ||
    pairConcurrency > MAX_PAIR_CONCURRENCY
  ) {
    throw new Error(
      `MAKA_DEEPSWE_AB_PAIR_CONCURRENCY must be an integer between 1 and ${MAX_PAIR_CONCURRENCY}`,
    );
  }
  const armExecution = rawArmExecution?.trim() || DEFAULT_ARM_EXECUTION;
  if (armExecution !== 'sequential' && armExecution !== 'parallel') {
    throw new Error('MAKA_DEEPSWE_AB_ARM_EXECUTION must be sequential or parallel');
  }
  return { pairConcurrency, armExecution };
}

export async function main() {
  const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const makaRepoPath = process.env.MAKA_DEEPSWE_AB_MAKA_REPO
    ? resolve(process.env.MAKA_DEEPSWE_AB_MAKA_REPO)
    : repoRoot;
  const outDir = envPath('MAKA_DEEPSWE_AB_OUT_DIR');
  const tasksRoot = envPath(
    'MAKA_DEEPSWE_AB_TASKS_ROOT',
    join(homedir(), '.maka/eval/task-sources/deep-swe-6db64a40/tasks'),
  );
  const runId = process.env.MAKA_DEEPSWE_AB_RUN_ID || DEFAULT_DEEPSWE_AB_RUN_ID;
  const selection = resolveDeepSweAbTaskSelection(
    process.env.MAKA_DEEPSWE_AB_TASK_ID,
    process.env.MAKA_DEEPSWE_AB_LIMIT,
    process.env.MAKA_DEEPSWE_AB_TASK_IDS,
  );
  const executionPolicy = resolveDeepSweAbExecutionPolicy(
    process.env.MAKA_DEEPSWE_AB_PAIR_CONCURRENCY,
    process.env.MAKA_DEEPSWE_AB_ARM_EXECUTION,
  );
  const runRoot = resolveFixedPromptRunRoot(outDir, runId, 'MAKA_DEEPSWE_AB_RUN_ID');
  await withHarnessAbRunLock(runRoot, () =>
    runLocked({ repoRoot, makaRepoPath, tasksRoot, runId, selection, executionPolicy, runRoot }),
  );
}

async function runLocked({ makaRepoPath, tasksRoot, runId, selection, executionPolicy, runRoot }) {
  if (!thinkingVariantsForModel(PROVIDER, MODEL).includes(REASONING_EFFORT)) {
    throw new Error(`${PROVIDER}/${MODEL} does not support reasoning effort ${REASONING_EFFORT}`);
  }
  // The frozen source is always the full subset-30 tree: fingerprint identity
  // must not depend on which slice of it a canary run evaluates.
  const allTasks = await discoverCachedHarborTasks(tasksRoot);
  const subsetTasks = selectTasksByIds(allTasks, DEEP_SWE_SUBSET_30_TASK_IDS, 'DeepSWE subset-30');
  const taskSourceFingerprint = await fingerprintFixedPromptTaskTree(subsetTasks);
  assertDeepSweSubset30TaskTreeFingerprint(taskSourceFingerprint);

  if (process.env.MAKA_DEEPSWE_AB_DRY_RUN === '1') {
    console.log(
      `dry-run: frozen ${subsetTasks.length}-task DeepSWE subset will run ${selection.limit} paired Pass@1 cells via Pier`,
    );
    return;
  }

  const subjectFingerprint = await buildSubjectFingerprint(
    makaRepoPath,
    process.env.MAKA_DEEPSWE_AB_EXPLICIT_SUBJECT_FINGERPRINT,
    undefined,
    'MAKA_DEEPSWE_AB',
  );
  const hostToolchainFingerprint = await buildToolchainFingerprint(
    process.env.MAKA_DEEPSWE_AB_TOOLCHAIN_FINGERPRINT,
    undefined,
    makaRepoPath,
    'MAKA_DEEPSWE_AB',
  );
  const credentialsRoot = envPath('MAKA_DEEPSWE_AB_WORKSPACE_ROOT', defaultMakaWorkspaceRoot());
  const credentials = await createCodexOAuthHarnessCredentialBinding({
    credentialsRoot,
    connectionSlug: process.env.MAKA_DEEPSWE_AB_OAUTH_CONNECTION_SLUG || 'codex-subscription',
  });

  const toolchainFingerprint = `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        hostToolchainFingerprint,
        competitor: CODEX_PROFILE.id,
        competitorToolchainFingerprint: CODEX_PROFILE.toolchainFingerprint,
      }),
    )
    .digest('hex')}`;
  const manifest = buildHarnessAbRunManifest({
    benchmark: {
      dataset: 'deep-swe',
      version: '1.1',
      revision: DEEP_SWE_REVISION,
      timeoutPolicy: 'task-native',
      timeoutMultiplier: 1,
      outerTimeoutGraceSec: PIER_SETUP_TEARDOWN_GRACE_SEC,
    },
    taskIds: selection.taskIds,
    orderSeed: ORDER_SEED,
    pilotTaskCount: Math.min(2, selection.taskIds.length),
    model: {
      provider: PROVIDER,
      id: MODEL,
      reasoningEffort: REASONING_EFFORT,
      credentialIdentity: credentials.credentialIdentity,
    },
    pricing: PRICING,
    arms: [
      {
        id: 'maka',
        version: subjectFingerprint,
        config: {
          adapter: 'maka_agent:MakaAgent',
          externalSystemPrompt: 'empty',
          reasoningEffort: REASONING_EFFORT,
          continuation: false,
          attemptPolicy: 'single',
          billingMode: BILLING_MODE,
          contextBudget: HARNESS_MAKA_CONTEXT_BUDGET,
        },
      },
      {
        id: CODEX_PROFILE.id,
        version: CODEX_PROFILE.version,
        config: {
          ...CODEX_PROFILE.config,
          externalSystemPrompt: 'empty',
          profile: CODEX_PROFILE.id,
        },
      },
    ],
    taskBudgetSec: null,
    harborTimeoutMs: null,
    subjectFingerprint,
    taskSourceFingerprint,
    toolchainFingerprint,
    pairConcurrency: executionPolicy.pairConcurrency,
    armExecution: executionPolicy.armExecution,
  });
  const manifestPath = join(runRoot, 'harness-ab-manifest.json');
  await ensureAbRunManifest(manifestPath, manifest);

  const tasksById = new Map(subsetTasks.map((task) => [task.id, task]));
  const evaluationTasks = manifest.evaluationTaskIds
    .slice(0, selection.limit)
    .map((taskId) => tasksById.get(taskId));
  if (evaluationTasks.some((task) => !task))
    throw new Error('manifest contains a task absent from the frozen task source');

  const codexToolchainPath = process.env.MAKA_DEEPSWE_AB_CODEX_TOOLCHAIN
    ? resolve(process.env.MAKA_DEEPSWE_AB_CODEX_TOOLCHAIN)
    : resolveHarnessCompetitorToolchainPath(runRoot, CODEX_PROFILE);
  await prepareCodexToolchain(codexToolchainPath);

  const systemPromptPath = join(runRoot, 'prompts', 'default-system-prompt.txt');
  const report = await runExperiment({
    runRoot,
    prompts: () => [{ path: systemPromptPath, content: DEFAULT_HEADLESS_SYSTEM_PROMPT }],
    run: async ({ jobsDir, resultsJsonlPath }) => {
      const runnerOptions = {
        makaRepoPath,
        jobsDir,
        model: `${PROVIDER}/${MODEL}`,
        provider: PROVIDER,
        reasoningEffort: REASONING_EFFORT,
        baseUrl: BASE_URL,
        resolveProviderCredential: credentials.resolveProviderCredential,
        pricing: {
          inputUsdPer1M: PRICING.input,
          cacheReadUsdPer1M: PRICING.cachedInput,
          outputUsdPer1M: PRICING.output,
          source: PRICING.source,
        },
        timeoutMultiplier: 1,
      };
      const config = (id) => ({
        id: `deepswe-ab-${id}`,
        backend: 'ai-sdk',
        llmConnectionSlug: PROVIDER,
        model: MODEL,
        thinkingLevel: REASONING_EFFORT,
      });
      const summary = await runHarnessAbComparisonUnlocked({
        runId,
        runRoot,
        resultsJsonlPath,
        systemPromptPath,
        resumeFingerprint: buildHarnessAbResumeFingerprint(manifest),
        evaluationTasks,
        arms: [
          {
            id: 'maka',
            config: config('maka'),
            expectedPricingProfile: PRICING.source,
            billingMode: BILLING_MODE,
            harborRunner: createPierTaskRunner({
              ...runnerOptions,
              agent: 'maka',
              agentEnv: harnessMakaContextBudgetEnv(),
            }),
          },
          {
            id: CODEX_PROFILE.id,
            config: config(CODEX_PROFILE.id),
            expectedPricingProfile: PRICING.source,
            billingMode: BILLING_MODE,
            harborRunner: createPierTaskRunner({
              ...runnerOptions,
              agent: 'codex',
              agentVersion: CODEX_PROFILE.version,
              codexToolchainPath,
            }),
          },
        ],
        pairConcurrency: manifest.maxConcurrency,
        armExecution: manifest.metadata.execution.armExecution,
      });
      return buildHarnessAbReport(summary, { annotations: [], warnings: [] }, BILLING_MODE);
    },
    artifacts: (report) => [
      {
        path: join(runRoot, 'harness-ab-report.json'),
        content: `${JSON.stringify(report, null, 2)}\n`,
      },
      { path: join(runRoot, 'harness-ab-report.csv'), content: renderHarnessAbReportCsv(report) },
      {
        path: join(runRoot, 'harness-ab-report.md'),
        content: renderHarnessAbReportMarkdown(report),
      },
    ],
  });
  assertHarnessAbReportCompleted(report);
  console.log(
    `${report.runStatus}: ${report.coverage.attemptedCells}/${report.coverage.scheduledCells} cells attempted; ${report.effectiveness.pairedEvaluated} paired Pass@1 outcomes -> ${runRoot}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
