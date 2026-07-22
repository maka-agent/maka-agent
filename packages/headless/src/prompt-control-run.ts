import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LlmConnection } from '@maka/core';
import type { HarborCellTokenSummary } from './cell-output.js';
import {
  hashSystemPrompt,
  type FixedPromptTask,
  type TaskRunInput,
  type TaskRunOutput,
} from './fixed-prompt-controller.js';
import type { HarborTaskPricing } from './harbor-task-runner.js';
import type { MetaAgent } from './prompt-candidate-loop.js';
import {
  type PromptAcceptancePartitionSummary,
  type PromptAcceptanceResult,
} from './prompt-acceptance-policy.js';
import {
  ensurePromptOptimizationPromptRepo,
  preparePromptOptimizationResume,
} from './prompt-optimization-bootstrap.js';
import {
  runPromptOptimizationRun,
  type PromptOptimizationRunResult,
} from './prompt-optimization-run.js';

export const CONTROL_RULE_MARKER = 'CONTROL_RULE_ALPHA';

const CONTROL_PROGRAM = `This is a tiny known-rule control experiment for the RSI prompt loop.
The task evaluator is deliberately simple: all control tasks share one missing
general rule. Use held-in feedback to add a conservative prompt rule that should
also apply to held-out control tasks. Do not add task-specific answers.
`;

const CONTROL_BASE_SYSTEM_PROMPT = `You are an autonomous benchmark agent.
Solve each task carefully and avoid task-specific memorization.
`;

const CONTROL_HELD_IN_TASKS: FixedPromptTask[] = [
  { id: 'control-held-in-a', path: '/control/tasks/held-in-a' },
  { id: 'control-held-in-b', path: '/control/tasks/held-in-b' },
];

const CONTROL_HELD_OUT_TASKS: FixedPromptTask[] = [
  { id: 'control-held-out-a', path: '/control/tasks/held-out-a' },
];

const CONTROL_TASK_COST_USD = 0.000001;

export interface RunPromptControlExperimentInput {
  runId: string;
  runRoot: string;
  apiKeyFile: string;
  provider?: LlmConnection['providerType'];
  baseUrl?: string;
  model?: string;
  metaAgent?: MetaAgent;
  now?: () => number;
  newId?: () => string;
}

export interface PromptControlExperimentResult {
  runId: string;
  runRoot: string;
  resultPath: string;
  reportPath: string;
  promptRepoDir: string;
  controllerDir: string;
  accepted: boolean;
  learnedRulePresent: boolean;
  decision: PromptAcceptanceResult | undefined;
  heldInBefore: PromptAcceptancePartitionSummary;
  heldInAfter: PromptAcceptancePartitionSummary;
  heldOutAfter: PromptAcceptancePartitionSummary;
  loopResult: PromptOptimizationRunResult;
}

export async function runPromptControlExperiment(
  input: RunPromptControlExperimentInput,
): Promise<PromptControlExperimentResult> {
  const provider = input.provider ?? 'deepseek';
  const model = input.model ?? 'deepseek/deepseek-v4-flash';
  const baseUrl = input.baseUrl ?? 'https://api.deepseek.com';
  const promptRepoDir = join(input.runRoot, 'prompt-repo');
  const controllerDir = join(input.runRoot, 'controller');
  const jobsDir = join(input.runRoot, 'jobs');
  const eventsDir = join(controllerDir, 'events');
  await mkdir(eventsDir, { recursive: true });
  await mkdir(jobsDir, { recursive: true });

  const { agentCwdPath, programPath, systemPromptPath } = await ensurePromptOptimizationPromptRepo({
    promptRepoDir,
    program: CONTROL_PROGRAM,
    systemPrompt: CONTROL_BASE_SYSTEM_PROMPT,
  });

  const resultsJsonlPath = join(controllerDir, 'results.jsonl');
  await preparePromptOptimizationResume({ promptRepoDir, resultsJsonlPath });

  const loopResult = await runPromptOptimizationRun({
    runId: input.runId,
    rounds: 1,
    baselineRuns: 1,
    gitCwdPath: promptRepoDir,
    agentCwdPath,
    programPath,
    systemPromptPath,
    resultsJsonlPath,
    heldInResultsTsvPath: join(controllerDir, 'held-in.tsv'),
    heldOutResultsTsvPath: join(controllerDir, 'held-out.tsv'),
    heldInTasks: CONTROL_HELD_IN_TASKS,
    heldOutTasks: CONTROL_HELD_OUT_TASKS,
    connection: controlConnection(provider, baseUrl, model),
    model,
    provider,
    apiKeyFile: input.apiKeyFile,
    pricing: controlPricing(),
    makaRepoPath: input.runRoot,
    jobsDir,
    rewardHackVerifierPatternsByTaskId: Object.fromEntries(
      CONTROL_HELD_IN_TASKS.map((task) => [task.id, ['ZZZ_NO_CONTROL_VERIFIER_MATCH']]),
    ),
    harborRunner: createControlHarborRunner(eventsDir),
    ...(input.metaAgent ? { metaAgent: input.metaAgent } : {}),
    resumeFingerprint: `prompt-control:${input.runId}`,
    costCeilingUsd: 1,
    maxConcurrency: 3,
    ...(input.now ? { now: input.now } : {}),
    ...(input.newId ? { newId: input.newId } : {}),
  });

  const finalPrompt = await readFile(systemPromptPath, 'utf8');
  const learnedRulePresent = finalPrompt.includes(CONTROL_RULE_MARKER);
  const decision = loopResult.decisions[0];
  if (!decision) {
    throw new Error('control experiment finished without a prompt decision');
  }
  const result: PromptControlExperimentResult = {
    runId: input.runId,
    runRoot: input.runRoot,
    resultPath: join(input.runRoot, 'prompt-control-result.json'),
    reportPath: join(input.runRoot, 'prompt-control-report.md'),
    promptRepoDir,
    controllerDir,
    accepted: decision.decision === 'keep',
    learnedRulePresent,
    decision,
    heldInBefore: decision.metrics.lastKept.heldIn,
    heldInAfter: decision.metrics.candidate.heldIn,
    heldOutAfter: decision.metrics.candidate.heldOut,
    loopResult,
  };

  await writeFile(result.resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await writeFile(result.reportPath, renderPromptControlReport(result), 'utf8');
  return result;
}

function createControlHarborRunner(eventsDir: string) {
  return async ({ roundId, task, systemPrompt }: TaskRunInput): Promise<TaskRunOutput> => {
    const hasRule = systemPrompt.includes(CONTROL_RULE_MARKER);
    const errorClass = hasRule ? undefined : `missing_${CONTROL_RULE_MARKER}`;
    const runtimeEventsPath = join(eventsDir, `${roundId}__${task.id}.jsonl`);
    await writeFile(
      runtimeEventsPath,
      `${JSON.stringify(modelVisibleControlEvent(roundId, task.id, errorClass))}\n`,
      'utf8',
    );
    return {
      harbor: { reward: hasRule ? 1 : 0 },
      cell: {
        schemaVersion: 1,
        status: 'completed',
        ...(errorClass ? { errorClass } : {}),
        runtimeEventsPath,
        promptHash: hashSystemPrompt(systemPrompt),
        tokenSummary: controlTokenSummary(),
        toolSummary: {
          providerVisibleToolCount: 1,
          actualToolCalls: 1,
          actualToolNames: ['ControlVerifier'],
          actualToolCallCounts: { ControlVerifier: 1 },
        },
        steps: 1,
        durationMs: 1,
        startedAt: 0,
        finishedAt: 1,
        runtimeRefs: {
          invocationId: `inv-${roundId}-${task.id}`,
          sessionId: `session-${task.id}`,
          runId: 'prompt-control',
          turnId: `turn-${roundId}`,
        },
      },
    };
  };
}

function modelVisibleControlEvent(
  roundId: string,
  taskId: string,
  errorClass: string | undefined,
): unknown {
  return {
    id: `control-${roundId}-${taskId}`,
    invocationId: `inv-${roundId}-${taskId}`,
    runId: 'prompt-control',
    sessionId: `session-${taskId}`,
    turnId: `turn-${roundId}`,
    ts: 1,
    partial: false,
    role: 'model',
    author: 'agent',
    content: {
      kind: 'text',
      text: errorClass ? `control verifier failed with ${errorClass}` : 'control verifier passed',
    },
  };
}

function controlConnection(
  provider: LlmConnection['providerType'],
  baseUrl: string,
  model: string,
): LlmConnection {
  return {
    slug: provider,
    name: provider,
    providerType: provider,
    baseUrl,
    defaultModel: model.includes('/') ? model.slice(model.indexOf('/') + 1) : model,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

function controlPricing(): HarborTaskPricing {
  return {
    inputUsdPer1M: 1,
    outputUsdPer1M: 1,
    cacheReadUsdPer1M: 1,
    cacheWriteUsdPer1M: 1,
    source: 'prompt-control',
  };
}

function controlTokenSummary(): HarborCellTokenSummary {
  return {
    input: 1,
    output: 1,
    cachedInput: 0,
    cacheHitInput: 0,
    cacheMissInput: 1,
    cacheWriteInput: 0,
    cacheMissInputSource: 'derived',
    reasoning: 0,
    total: 2,
    costUsd: CONTROL_TASK_COST_USD,
    pricingSource: 'runtime',
  };
}

function renderPromptControlReport(result: PromptControlExperimentResult): string {
  return (
    [
      '# RSI Prompt Control Experiment',
      '',
      `run id: ${result.runId}`,
      `decision: ${result.decision?.decision ?? 'none'} (${result.decision?.reason ?? 'none'})`,
      `learned rule: ${result.learnedRulePresent ? CONTROL_RULE_MARKER : 'missing'}`,
      '',
      `held-in before: ${result.heldInBefore.passEligibleRate}`,
      `held-in after: ${result.heldInAfter.passEligibleRate}`,
      `held-out after: ${result.heldOutAfter.passEligibleRate}`,
      '',
      `result: ${result.resultPath}`,
    ].join('\n') + '\n'
  );
}
