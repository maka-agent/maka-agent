#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCHMARK_BASE_SYSTEM_PROMPT } from '@maka/headless';
import { ensureAbRunManifest } from '#ab-manifest';
import { discoverCachedHarborTasks, resolveFixedPromptRunRoot } from '#fixed-prompt-task-source';
import { createHarborTaskRunner } from '#harbor-task-runner';
import { providerCredentialEnv } from '#provider-env';
import { runRuntimePolicyAbLifecycle } from '#runtime-policy-ab-lifecycle';
import { parseRuntimePolicyAbExecutionProfile } from '#runtime-policy-ab-profile';
import {
  buildRuntimePolicyAbRunManifest,
  renderRuntimePolicyAbComparisonMarkdown,
} from '#runtime-policy-ab-run';
import { parseRuntimePolicyAbSpec } from '#runtime-policy-ab-spec';
import {
  buildSubjectFingerprint,
  buildTaskSourceFingerprint,
  buildToolchainFingerprint,
} from './run-prompt-ab.mjs';

function envPath(name, fallback) {
  const raw = process.env[name] || fallback;
  if (!raw) throw new Error(`${name} is required`);
  return raw.startsWith('~') ? join(homedir(), raw.slice(1)) : resolve(raw);
}

function selectTasks(allTasks, taskIds, label) {
  const byId = new Map(allTasks.map((task) => [task.id, task]));
  const missing = taskIds.filter((id) => !byId.has(id));
  if (missing.length > 0)
    throw new Error(`${label} contains unknown task id(s): ${missing.join(', ')}`);
  return taskIds.map((id) => byId.get(id));
}

async function main() {
  const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const makaRepoPath = process.env.MAKA_RUNTIME_AB_MAKA_REPO
    ? resolve(process.env.MAKA_RUNTIME_AB_MAKA_REPO)
    : repoRoot;
  const outDir = envPath('MAKA_RUNTIME_AB_OUT_DIR');
  const tasksRoot = envPath('MAKA_RUNTIME_AB_TASKS_ROOT', join(homedir(), '.cache/harbor/tasks'));
  const specPath = envPath('MAKA_RUNTIME_AB_SPEC_PATH');
  const profilePath = envPath('MAKA_RUNTIME_AB_PROFILE_PATH');
  const runId = process.env.MAKA_RUNTIME_AB_RUN_ID || `runtime-policy-ab-${Date.now()}`;
  const runRoot = resolveFixedPromptRunRoot(outDir, runId, 'MAKA_RUNTIME_AB_RUN_ID');
  const spec = parseRuntimePolicyAbSpec(JSON.parse(await readFile(specPath, 'utf8')));
  const executionProfile = parseRuntimePolicyAbExecutionProfile(
    JSON.parse(await readFile(profilePath, 'utf8')),
  );
  const selectedTaskIds = new Set([...spec.pilotTaskIds, ...spec.evaluationTaskIds]);
  const allTasks = await discoverCachedHarborTasks(tasksRoot, selectedTaskIds);
  const pilotTasks = selectTasks(allTasks, spec.pilotTaskIds, 'pilotTaskIds');
  const evaluationTasks = selectTasks(allTasks, spec.evaluationTaskIds, 'evaluationTaskIds');
  const systemPrompt = `${BENCHMARK_BASE_SYSTEM_PROMPT}\n`;
  const runManifest = buildRuntimePolicyAbRunManifest({
    arms: spec.arms,
    promptHash: `sha256:${createHash('sha256').update(JSON.stringify(systemPrompt)).digest('hex')}`,
    executionProfile,
    sharedAgentEnv: spec.sharedAgentEnv,
    subjectFingerprint: await buildSubjectFingerprint(
      makaRepoPath,
      process.env.MAKA_RUNTIME_AB_EXPLICIT_SUBJECT_FINGERPRINT,
    ),
    taskSourceFingerprint: await buildTaskSourceFingerprint(tasksRoot, [
      ...pilotTasks,
      ...evaluationTasks,
    ]),
    toolchainFingerprint: await buildToolchainFingerprint(
      process.env.MAKA_RUNTIME_AB_TOOLCHAIN_FINGERPRINT,
      undefined,
      makaRepoPath,
    ),
    evaluationTaskIds: evaluationTasks.map((task) => task.id),
    pilotTaskIds: pilotTasks.map((task) => task.id),
    reps: spec.fullReps,
    candidateLimit: null,
    selectionMode: 'explicit',
    candidateTaskIds: evaluationTasks.map((task) => task.id),
    nonInferiorityMargin: spec.nonInferiorityMargin,
  });
  const manifestPath = join(runRoot, 'runtime-policy-ab-manifest.json');
  await ensureAbRunManifest(manifestPath, runManifest);

  if (process.env.MAKA_RUNTIME_AB_DRY_RUN === '1') {
    console.log(`dry-run: executable manifest validated -> ${manifestPath}`);
    return;
  }

  const keyFile = envPath(
    'MAKA_RUNTIME_AB_KEY_FILE',
    join(repoRoot, '.local-secrets/deepseek-key'),
  );
  await readFile(keyFile, 'utf8');
  const controllerDir = join(runRoot, 'controller');
  const jobsDir = join(runRoot, 'jobs');
  const promptsDir = join(runRoot, 'prompts');
  await mkdir(controllerDir, { recursive: true });
  await mkdir(jobsDir, { recursive: true });
  await mkdir(promptsDir, { recursive: true });
  const systemPromptPath = join(promptsDir, 'shared-system-prompt.md');
  await writeFile(systemPromptPath, systemPrompt, 'utf8');
  const config = {
    id: `runtime-policy-ab-${spec.id}`,
    backend: 'harbor',
    llmConnectionSlug: executionProfile.llmConnectionSlug,
    model: executionProfile.model,
  };
  const [baseUrlEnvName] = providerCredentialEnv(executionProfile.provider)?.baseUrls ?? [];
  if (!baseUrlEnvName)
    throw new Error(
      `runtime policy A/B provider ${executionProfile.provider} does not declare a base URL environment variable`,
    );
  const harborRunner = createHarborTaskRunner({
    makaRepoPath,
    jobsDir,
    model: executionProfile.model,
    provider: executionProfile.provider,
    apiKeyFile: keyFile,
    pricing: executionProfile.pricing,
    agentEnv: {
      [baseUrlEnvName]: executionProfile.baseUrl,
      MAKA_CELL_TIMEOUT_SEC: String(executionProfile.taskBudgetSec),
    },
    harborTimeoutMs: executionProfile.harborTimeoutMs,
  });
  const state = await runRuntimePolicyAbLifecycle({
    runId,
    runRoot,
    manifestFingerprint: runManifest.fingerprint,
    config,
    systemPromptPath,
    resultsJsonlPath: join(controllerDir, 'results.jsonl'),
    pilotTasks,
    evaluationTasks,
    fullReps: spec.fullReps,
    arms: spec.arms,
    executionProfile,
    nonInferiorityMargin: spec.nonInferiorityMargin,
    sharedAgentEnv: spec.sharedAgentEnv,
    resumeFingerprint: runManifest.fingerprint,
    harborRunner,
  });
  await writeFile(
    join(runRoot, 'runtime-policy-ab-result.json'),
    `${JSON.stringify({ runManifest, spec, state }, null, 2)}\n`,
    'utf8',
  );
  if (state.full)
    await writeFile(
      join(runRoot, 'runtime-policy-ab-report.md'),
      renderRuntimePolicyAbComparisonMarkdown(state.full),
      'utf8',
    );
  console.log(
    `status: ${state.status}${state.reason ? ` (${state.reason})` : ''}${state.full ? `; decision: ${state.full.decision}` : ''}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
