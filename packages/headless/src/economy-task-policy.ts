import type { Config, EconomyTaskModeConfig, Task } from './contracts.js';
import { resolveHeavyTaskMode } from './heavy-task-policy.js';

export const ECONOMY_TASK_POLICY_VERSION = 'maka-economy-task-policy.v1';

export type EconomyTaskModeTriggerSource = 'default' | 'config' | 'task_metadata';

export interface EconomyTaskModeSelection {
  schemaVersion: 1;
  enabled: boolean;
  triggerSource: EconomyTaskModeTriggerSource;
  triggerReason: string;
  policyVersion: string;
}

const DEFAULT_DISABLED_REASON = 'economy-task mode was not explicitly enabled';
const DEFAULT_CONFIG_ENABLED_REASON = 'economy-task mode explicitly enabled by config';
const DEFAULT_CONFIG_DISABLED_REASON = 'economy-task mode explicitly disabled by config';
const DEFAULT_TASK_METADATA_ENABLED_REASON =
  'economy-task mode explicitly enabled by task benchmark metadata';

const ECONOMY_TASK_CATEGORIES = new Set([
  'data-processing',
  'log-analysis',
  'report-generation',
  'csv-processing',
  'data-transform',
]);

const ECONOMY_TASK_TAGS = new Set([
  'data-processing',
  'log-analysis',
  'report-generation',
  'csv',
  'data-transform',
  'summary',
]);

const ECONOMY_INSTRUCTION_SIGNALS = [
  'write a csv',
  'generate a csv',
  'count how many',
  'summarize',
  'log files',
  'severity',
  'date ranges',
  'log summary',
  'summary.csv',
] as const;

export function resolveEconomyTaskMode(config: Config, task?: Task): EconomyTaskModeSelection {
  const heavyTaskMode = resolveHeavyTaskMode(config, task);
  if (heavyTaskMode.enabled) {
    return {
      schemaVersion: 1,
      enabled: false,
      triggerSource: 'default',
      triggerReason: 'heavy-task mode is enabled, so economy-task mode is disabled',
      policyVersion: ECONOMY_TASK_POLICY_VERSION,
    };
  }

  const configMode = normalizeModeConfig(config.economyTaskMode);
  if (configMode?.enabled === false) {
    return {
      schemaVersion: 1,
      enabled: false,
      triggerSource: 'config',
      triggerReason: configMode.reason ?? DEFAULT_CONFIG_DISABLED_REASON,
      policyVersion: configMode.policyVersion ?? ECONOMY_TASK_POLICY_VERSION,
    };
  }
  if (configMode?.enabled === true) {
    return {
      schemaVersion: 1,
      enabled: true,
      triggerSource: 'config',
      triggerReason: configMode.reason ?? DEFAULT_CONFIG_ENABLED_REASON,
      policyVersion: configMode.policyVersion ?? ECONOMY_TASK_POLICY_VERSION,
    };
  }

  const taskMode = normalizeTaskMetadataMode(task?.benchmark?.metadata);
  if (taskMode?.enabled === true) {
    return {
      schemaVersion: 1,
      enabled: true,
      triggerSource: 'task_metadata',
      triggerReason: taskMode.reason ?? DEFAULT_TASK_METADATA_ENABLED_REASON,
      policyVersion: taskMode.policyVersion ?? ECONOMY_TASK_POLICY_VERSION,
    };
  }

  const signalMode = normalizeTaskSignalMode(task);
  if (signalMode?.enabled === true) {
    return {
      schemaVersion: 1,
      enabled: true,
      triggerSource: 'task_metadata',
      triggerReason: signalMode.reason ?? 'economy-task mode enabled by benchmark task signal',
      policyVersion: signalMode.policyVersion ?? ECONOMY_TASK_POLICY_VERSION,
    };
  }

  return {
    schemaVersion: 1,
    enabled: false,
    triggerSource: 'default',
    triggerReason: DEFAULT_DISABLED_REASON,
    policyVersion: ECONOMY_TASK_POLICY_VERSION,
  };
}

export function buildEconomyTaskSystemPromptPolicy(
  selection: Pick<EconomyTaskModeSelection, 'policyVersion'> = {
    policyVersion: ECONOMY_TASK_POLICY_VERSION,
  },
): string {
  return [
    `Economy-task benchmark policy (${selection.policyVersion})`,
    '',
    '- This is a simple, one-shot data-transform task. Keep exploration and verification to an absolute minimum.',
    '- Use a single shallow Glob (for example Glob *.log /app/logs) to list files. Do NOT use recursive **/* patterns.',
    '- Do not use ls -la. If you must confirm a path, use ls without flags, or read a tiny sample.',
    '- Read at most 5 lines from at most 2 sample files to understand the format, then stop reading.',
    '- Write one focused script that produces the required output file, run it once, and stop.',
    '- After the required output file exists, run at most one lightweight targeted preview, such as reading the first few output lines or checking a header/row count.',
    '- After that one preview, stop. avoid repeated grep, wc, sort, uniq, recursive scans, or broad verification loops.',
    '- The benchmark verifier will check correctness independently; your job is only to produce the required artifact.',
  ].join('\n');
}

export function appendEconomyTaskPolicyToSystemPrompt(
  systemPrompt: string | undefined,
  selection: EconomyTaskModeSelection,
): string | undefined {
  if (!selection.enabled) return systemPrompt;
  return [systemPrompt, buildEconomyTaskSystemPromptPolicy(selection)]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n\n');
}

export function configWithEconomyTaskPolicy(
  config: Config,
  selection: EconomyTaskModeSelection,
): Config {
  const systemPrompt = appendEconomyTaskPolicyToSystemPrompt(config.systemPrompt, selection);
  if (systemPrompt === config.systemPrompt) return config;
  return { ...config, systemPrompt };
}

function normalizeTaskMetadataMode(
  metadata: Record<string, unknown> | undefined,
): EconomyTaskModeConfig | undefined {
  if (!metadata) return undefined;
  const mode = normalizeModeConfig(metadata.economyTaskMode);
  if (mode) return mode;
  return normalizeModeConfig(metadata.economyTask);
}

function normalizeTaskSignalMode(task: Task | undefined): EconomyTaskModeConfig | undefined {
  const metadata = task?.benchmark?.metadata;

  if (metadata) {
    const category = cleanString(metadata.category)?.toLowerCase();
    if (category && ECONOMY_TASK_CATEGORIES.has(category)) {
      return { enabled: true, reason: `economy-task mode enabled by category: ${category}` };
    }
    const tags = metadata.tags;
    if (
      Array.isArray(tags) &&
      tags.some((tag) => ECONOMY_TASK_TAGS.has(String(tag).toLowerCase()))
    ) {
      return { enabled: true, reason: 'economy-task mode enabled by task tags' };
    }
  }

  const instruction = cleanString(task?.instruction)?.toLowerCase() ?? '';
  if (ECONOMY_INSTRUCTION_SIGNALS.some((signal) => instruction.includes(signal))) {
    return { enabled: true, reason: 'economy-task mode enabled by instruction signal' };
  }

  return undefined;
}

function normalizeModeConfig(value: unknown): EconomyTaskModeConfig | undefined {
  if (typeof value === 'boolean') return { enabled: value };
  if (!isRecord(value)) return undefined;
  const enabled = typeof value.enabled === 'boolean' ? value.enabled : undefined;
  const reason = cleanString(value.reason);
  const policyVersion = cleanPolicyVersion(value.policyVersion);
  if (enabled === undefined && reason === undefined && policyVersion === undefined)
    return undefined;
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
