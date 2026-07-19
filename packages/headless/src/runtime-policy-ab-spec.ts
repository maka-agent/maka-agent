import {
  RUNTIME_POLICY_CONTEXT_ENV_KEYS,
  RUNTIME_POLICY_SHARED_AGENT_ENV_KEYS,
  type RuntimePolicyAbArmInput,
  type RuntimePolicySharedAgentEnvKey,
} from './runtime-policy-ab-run.js';

export interface RuntimePolicyAbSpec {
  schemaVersion: 1;
  id: string;
  arms: readonly [RuntimePolicyAbArmInput, RuntimePolicyAbArmInput];
  sharedAgentEnv: Partial<Record<RuntimePolicySharedAgentEnvKey, string>>;
  pilotTaskIds: readonly string[];
  evaluationTaskIds: readonly string[];
  fullReps: number;
  nonInferiorityMargin: number;
}

export function parseRuntimePolicyAbSpec(value: unknown): RuntimePolicyAbSpec {
  if (!isRecord(value) || value.schemaVersion !== 1)
    throw new Error('runtime policy A/B spec schemaVersion must be 1');
  nonEmptyString(value.id, 'runtime policy A/B spec id');
  if (!Array.isArray(value.arms) || value.arms.length !== 2)
    throw new Error('runtime policy A/B spec must define exactly two arms');
  const arms = value.arms.map((arm, index) => parseArm(arm, index));
  if (arms[0]!.id === arms[1]!.id)
    throw new Error('runtime policy A/B spec arm ids must be distinct');
  stringEnv(
    value.sharedAgentEnv,
    new Set(RUNTIME_POLICY_SHARED_AGENT_ENV_KEYS),
    'runtime policy A/B spec sharedAgentEnv',
  );
  stringIds(value.pilotTaskIds, 'runtime policy A/B spec pilotTaskIds');
  stringIds(value.evaluationTaskIds, 'runtime policy A/B spec evaluationTaskIds');
  if (!Number.isSafeInteger(value.fullReps) || Number(value.fullReps) < 2)
    throw new Error('runtime policy A/B spec fullReps must be an integer of at least 2');
  if (
    typeof value.nonInferiorityMargin !== 'number' ||
    value.nonInferiorityMargin < 0 ||
    value.nonInferiorityMargin > 1
  ) {
    throw new Error('runtime policy A/B spec nonInferiorityMargin must be a number in [0, 1]');
  }
  return value as unknown as RuntimePolicyAbSpec;
}

function parseArm(value: unknown, index: number): RuntimePolicyAbArmInput {
  if (!isRecord(value)) throw new Error(`runtime policy A/B spec arm ${index} must be an object`);
  nonEmptyString(value.id, `runtime policy A/B spec arm ${index} id`);
  stringEnv(
    value.contextEnv,
    new Set(RUNTIME_POLICY_CONTEXT_ENV_KEYS),
    `runtime policy A/B spec arm ${index} contextEnv`,
  );
  return value as unknown as RuntimePolicyAbArmInput;
}

function stringEnv(value: unknown, allowed: ReadonlySet<string>, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const [key, entryValue] of Object.entries(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported key: ${key}`);
    if (typeof entryValue !== 'string') throw new Error(`${label} values must be strings`);
  }
}

function stringIds(value: unknown, label: string): void {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== 'string' || entry.length === 0)
  ) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicates`);
}

function nonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(`${label} must be a non-empty string`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
