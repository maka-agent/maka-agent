import { createHash } from 'node:crypto';
import {
  runFixedPromptController,
  type FixedPromptTask,
  type HarborTaskRunner,
} from './fixed-prompt-controller.js';
import { renderAbComparisonMarkdown } from './ab-render.js';
import { buildAbRunManifest } from './ab-manifest.js';
import { runAbComparison } from './ab-run.js';
import type { AbArmSpec, AbComparisonSummary, AbRunManifest, AbRunManifestInput } from './ab-types.js';
import type { Config } from './contracts.js';
import {
  HARBOR_CELL_CONTEXT_ENV_KEYS,
  normalizeHarborCellContextEnv,
  type HarborCellContextEnvKey,
} from './harbor-cell.js';

export const RUNTIME_POLICY_CONTEXT_ENV_KEYS = HARBOR_CELL_CONTEXT_ENV_KEYS;
export const RUNTIME_POLICY_SHARED_AGENT_ENV_KEYS = [
  'MAKA_HARBOR_CONTINUATION',
  'MAKA_HARBOR_CONTINUATION_MAX_TURNS',
  'MAKA_HARBOR_CONTINUATION_PROMPT',
] as const;

export type RuntimePolicyContextEnvKey = HarborCellContextEnvKey;
export type RuntimePolicySharedAgentEnvKey = typeof RUNTIME_POLICY_SHARED_AGENT_ENV_KEYS[number];

export interface RuntimePolicyAbArmInput {
  id: string;
  contextEnv: Partial<Record<RuntimePolicyContextEnvKey, string>>;
}

export interface RunRuntimePolicyAbComparisonInput {
  runId: string;
  config: Config;
  systemPromptPath: string;
  resultsJsonlPath: string;
  evaluationTasks: readonly FixedPromptTask[];
  arms: readonly [RuntimePolicyAbArmInput, RuntimePolicyAbArmInput];
  reps?: number;
  maxConcurrency?: number;
  resumeFingerprint?: string;
  budgetMs?: number;
  nonInferiorityMargin?: number;
  sharedAgentEnv?: Partial<Record<RuntimePolicySharedAgentEnvKey, string>>;
  harborRunner: HarborTaskRunner;
  now?: () => number;
  newId?: () => string;
}

export type RuntimePolicyAbComparisonSummary = AbComparisonSummary;

export interface RuntimePolicyAbRunManifestInput extends Omit<AbRunManifestInput, 'experimentKind' | 'arms'> {
  arms: readonly [RuntimePolicyAbArmInput, RuntimePolicyAbArmInput];
  promptHash: string;
  provider: string;
  baseUrl: string;
  model: string;
  sharedAgentEnv?: Partial<Record<RuntimePolicySharedAgentEnvKey, string>>;
}

export type RuntimePolicyAbRunManifest = AbRunManifest;

export function buildRuntimePolicyAbRunManifest(input: RuntimePolicyAbRunManifestInput): RuntimePolicyAbRunManifest {
  const { arms, promptHash, provider, baseUrl, model, sharedAgentEnv: rawSharedAgentEnv, ...abInput } = input;
  const sharedAgentEnv = sanitizeSharedAgentEnv(rawSharedAgentEnv ?? {});
  const sharedMetadata = { promptHash, provider, baseUrl, model, sharedAgentEnv };
  return buildAbRunManifest({
    ...abInput,
    experimentKind: 'runtime',
    arms: [
      runtimeArmSpec(arms[0], sharedMetadata),
      runtimeArmSpec(arms[1], sharedMetadata),
    ],
  });
}

export async function runRuntimePolicyAbComparison(
  input: RunRuntimePolicyAbComparisonInput,
): Promise<RuntimePolicyAbComparisonSummary> {
  const sharedConfigFingerprint = runtimePolicySharedConfigFingerprint(input.config);
  const sharedAgentEnv = sanitizeSharedAgentEnv(input.sharedAgentEnv ?? {});
  return runAbComparison({
    runId: input.runId,
    arms: [runtimeArmSpec(input.arms[0]), runtimeArmSpec(input.arms[1])],
    evaluationTasks: input.evaluationTasks,
    ...(input.reps !== undefined ? { reps: input.reps } : {}),
    ...(input.maxConcurrency !== undefined ? { maxConcurrency: input.maxConcurrency } : {}),
    ...(input.budgetMs !== undefined ? { budgetMs: input.budgetMs } : {}),
    ...(input.nonInferiorityMargin !== undefined ? { nonInferiorityMargin: input.nonInferiorityMargin } : {}),
    runArm: async ({ roundId, arm, task }) => {
      const runtimeArm = input.arms.find((candidate) => candidate.id === arm.id);
      if (!runtimeArm) throw new Error(`runtime policy A/B arm ${arm.id} is not configured`);
      const contextEnv = sanitizeContextEnv(runtimeArm.contextEnv);
      const resumeFingerprint = runtimePolicyResumeFingerprint({
        sharedConfigFingerprint,
        sharedAgentEnvFingerprint: sharedAgentEnvFingerprint(sharedAgentEnv),
        armContextEnvFingerprint: contextEnvFingerprint(contextEnv),
        callerResumeFingerprint: input.resumeFingerprint,
      });
      const agentEnv = { ...sharedAgentEnv, ...contextEnv };
      const result = await runFixedPromptController({
        runId: input.runId,
        roundId,
        config: input.config,
        systemPromptPath: input.systemPromptPath,
        resultsJsonlPath: input.resultsJsonlPath,
        resultsTsvPath: `${input.resultsJsonlPath}.${roundId}.tsv`,
        tasks: [task],
        resumeFingerprint,
        harborRunner: (runnerInput) => input.harborRunner({ ...runnerInput, agentEnv }),
        ...(input.now ? { now: input.now } : {}),
        ...(input.newId ? { newId: input.newId } : {}),
      });
      const event = result.events.find((candidate) => candidate.taskId === task.id);
      if (!event) throw new Error(`runtime policy A/B arm ${roundId} produced no event for ${task.id}`);
      return event;
    },
  });
}

export function renderRuntimePolicyAbComparisonMarkdown(summary: RuntimePolicyAbComparisonSummary): string {
  return renderAbComparisonMarkdown(summary).replace('# A/B Comparison', '# Runtime Policy A/B Comparison');
}

function runtimeArmSpec(arm: RuntimePolicyAbArmInput, sharedMetadata: Record<string, unknown> = {}): AbArmSpec {
  const contextEnv = sanitizeContextEnv(arm.contextEnv);
  return {
    id: arm.id,
    kind: 'runtime' as const,
    fingerprint: contextEnvFingerprint(contextEnv),
    metadata: { ...sharedMetadata, contextEnv },
  };
}

function sanitizeContextEnv(
  env: Partial<Record<RuntimePolicyContextEnvKey, string>>,
): Record<RuntimePolicyContextEnvKey, string> | Partial<Record<RuntimePolicyContextEnvKey, string>> {
  for (const key of Object.keys(env)) {
    if (!key.startsWith('MAKA_CONTEXT_')) throw new Error(`unsupported runtime policy env key: ${key}`);
  }
  return normalizeHarborCellContextEnv(env);
}

function sanitizeSharedAgentEnv(
  env: Partial<Record<RuntimePolicySharedAgentEnvKey, string>>,
): Partial<Record<RuntimePolicySharedAgentEnvKey, string>> {
  const allowed = new Set<string>(RUNTIME_POLICY_SHARED_AGENT_ENV_KEYS);
  const result: Partial<Record<RuntimePolicySharedAgentEnvKey, string>> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!allowed.has(key)) {
      throw new Error(`unsupported runtime policy shared agent env key: ${key}`);
    }
    if (value !== undefined) {
      result[key as RuntimePolicySharedAgentEnvKey] = value;
    }
  }
  return result;
}

function contextEnvFingerprint(env: Partial<Record<RuntimePolicyContextEnvKey, string>>): string {
  return `sha256:${createHash('sha256').update(canonicalJson(sanitizeContextEnv(env))).digest('hex')}`;
}

function sharedAgentEnvFingerprint(env: Partial<Record<RuntimePolicySharedAgentEnvKey, string>>): string {
  return `sha256:${createHash('sha256').update(canonicalJson(sanitizeSharedAgentEnv(env))).digest('hex')}`;
}

function runtimePolicySharedConfigFingerprint(config: Config): string {
  const { systemPrompt: _systemPrompt, ...effectiveConfig } = config;
  return `sha256:${createHash('sha256').update(canonicalJson(effectiveConfig)).digest('hex')}`;
}

function runtimePolicyResumeFingerprint(input: {
  sharedConfigFingerprint: string;
  sharedAgentEnvFingerprint: string;
  armContextEnvFingerprint: string;
  callerResumeFingerprint?: string;
}): string {
  return `sha256:${createHash('sha256').update(canonicalJson({
    version: 'maka-runtime-policy-resume-v1',
    sharedConfigFingerprint: input.sharedConfigFingerprint,
    sharedAgentEnvFingerprint: input.sharedAgentEnvFingerprint,
    armContextEnvFingerprint: input.armContextEnvFingerprint,
    callerResumeFingerprint: input.callerResumeFingerprint,
  })).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
