import type { Config, HeavyTaskModeConfig, Task } from './contracts.js';

export const HEAVY_TASK_POLICY_VERSION = 'maka-heavy-task-policy.v1';

export type HeavyTaskModeTriggerSource = 'default' | 'config' | 'task_metadata';

export interface HeavyTaskModeSelection {
  schemaVersion: 1;
  enabled: boolean;
  triggerSource: HeavyTaskModeTriggerSource;
  triggerReason: string;
  policyVersion: string;
}

export const FORBIDDEN_HEAVY_TASK_POLICY_TERMS = [
  'hidden tests',
  'hidden reference artifacts',
  'hidden thresholds',
  'private scoring criteria',
  'private scoring constants',
  'scorer-specific constants',
  'pytest assertions',
  'official verifier artifacts',
  'hidden assertion text',
  'non-public evaluator files',
  'private verifier execution details',
  'verifier timing details',
  'verifier execution order',
  'private benchmark file identifiers',
] as const;

const DEFAULT_DISABLED_REASON = 'heavy-task mode was not explicitly enabled';
const DEFAULT_CONFIG_ENABLED_REASON = 'heavy-task mode explicitly enabled by config';
const DEFAULT_CONFIG_DISABLED_REASON = 'heavy-task mode explicitly disabled by config';
const DEFAULT_TASK_METADATA_ENABLED_REASON = 'heavy-task mode explicitly enabled by task benchmark metadata';

export function resolveHeavyTaskMode(config: Config, task?: Task): HeavyTaskModeSelection {
  const configMode = normalizeModeConfig(config.heavyTaskMode);
  if (configMode?.enabled === false) {
    return {
      schemaVersion: 1,
      enabled: false,
      triggerSource: 'config',
      triggerReason: configMode.reason ?? DEFAULT_CONFIG_DISABLED_REASON,
      policyVersion: configMode.policyVersion ?? HEAVY_TASK_POLICY_VERSION,
    };
  }
  if (configMode?.enabled === true) {
    return {
      schemaVersion: 1,
      enabled: true,
      triggerSource: 'config',
      triggerReason: configMode.reason ?? DEFAULT_CONFIG_ENABLED_REASON,
      policyVersion: configMode.policyVersion ?? HEAVY_TASK_POLICY_VERSION,
    };
  }

  const taskMode = normalizeTaskMetadataMode(task?.benchmark?.metadata);
  if (taskMode?.enabled === true) {
    return {
      schemaVersion: 1,
      enabled: true,
      triggerSource: 'task_metadata',
      triggerReason: taskMode.reason ?? DEFAULT_TASK_METADATA_ENABLED_REASON,
      policyVersion: taskMode.policyVersion ?? HEAVY_TASK_POLICY_VERSION,
    };
  }

  return {
    schemaVersion: 1,
    enabled: false,
    triggerSource: 'default',
    triggerReason: DEFAULT_DISABLED_REASON,
    policyVersion: HEAVY_TASK_POLICY_VERSION,
  };
}

export function buildHeavyTaskSystemPromptPolicy(
  selection: Pick<HeavyTaskModeSelection, 'policyVersion'> = { policyVersion: HEAVY_TASK_POLICY_VERSION },
): string {
  return [
    `Heavy-task benchmark policy (${selection.policyVersion})`,
    '',
    '- Work like a persistent engineer on a long-running task: inspect public task files and workspace state before editing, keep compact evidence that helps continue the work, and avoid relying on assistant prose as durable state.',
    '- Use inventory_submit to submit a structured inventory snapshot after initial public inspection and whenever the important workspace/artifact inventory changes.',
    '- Use todo_update to submit the full current todo/progress snapshot as work advances. Keep at most one item in_progress, and treat todo completion as advisory progress rather than benchmark success.',
    '- After initial public inspection and inventory, define an agent-owned public self-check plan before broad implementation, expensive builds, or long-running commands. Derive the plan only from visible task/workspace evidence such as public instructions, files, build metadata, sample commands, or generated public artifacts.',
    '- Record the public self-check plan in durable progress state with todo_update using stable todo ids for both implementation work and check work. You own the check plan; the runner records public evidence and must not invent task-specific success checks for you.',
    '- Prefer cheap targeted public checks before long broad commands when the visible task evidence suggests expensive work. Run targeted public checks before and after repairs, and record the concrete expectations and results with check_record linked to todo ids, tool call ids, and compact evidence ids.',
    '- Use self_check_submit to submit public, task-derived semantic self-check evidence from visible tests, builds, sample commands, or artifact inspections only after the relevant public checks have been executed or inspected. Include public command/artifact evidence only.',
    '- Use engineering_record for structured hypotheses, repairs, and patch/change summaries. Link records to todo ids, compact evidence ids, check ids, tool call ids, changed files, and artifact ids where those links apply.',
    '- Use check_record for targeted checks. Complete check records require todo ids, tool call ids, and compact evidence ids; incomplete records require an explicit incomplete reason, such as a planned public check that has not run yet.',
    '- The self_check_submit source guard rejects hidden, private, or evaluator-only material before it can become accepted task-run state. Treat accepted checks as advisory engineering feedback.',
    '- Official benchmark scoring remains external and authoritative. Do not claim success solely from your own checks, and do not replace verifier results with self-checks.',
    `- Do not seek, infer, read, or rely on forbidden evaluator material: ${FORBIDDEN_HEAVY_TASK_POLICY_TERMS.join(', ')}.`,
  ].join('\n');
}

export function appendHeavyTaskPolicyToSystemPrompt(
  systemPrompt: string | undefined,
  selection: HeavyTaskModeSelection,
): string | undefined {
  if (!selection.enabled) return systemPrompt;
  return [systemPrompt, buildHeavyTaskSystemPromptPolicy(selection)]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n\n');
}

export function configWithHeavyTaskPolicy(config: Config, selection: HeavyTaskModeSelection): Config {
  const systemPrompt = appendHeavyTaskPolicyToSystemPrompt(config.systemPrompt, selection);
  if (systemPrompt === config.systemPrompt) return config;
  return { ...config, systemPrompt };
}

function normalizeTaskMetadataMode(metadata: Record<string, unknown> | undefined): HeavyTaskModeConfig | undefined {
  if (!metadata) return undefined;
  const mode = normalizeModeConfig(metadata.heavyTaskMode);
  if (mode) return mode;
  return normalizeModeConfig(metadata.heavyTask);
}

function normalizeModeConfig(value: unknown): HeavyTaskModeConfig | undefined {
  if (typeof value === 'boolean') return { enabled: value };
  if (!isRecord(value)) return undefined;
  const enabled = typeof value.enabled === 'boolean' ? value.enabled : undefined;
  const reason = cleanString(value.reason);
  const policyVersion = cleanPolicyVersion(value.policyVersion);
  if (enabled === undefined && reason === undefined && policyVersion === undefined) return undefined;
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(reason ? { reason } : {}),
    ...(policyVersion ? { policyVersion } : {}),
  };
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function cleanPolicyVersion(value: unknown): string | undefined {
  const cleaned = cleanString(value);
  if (!cleaned) return undefined;
  return /^[A-Za-z0-9._-]{1,64}$/.test(cleaned) ? cleaned : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
