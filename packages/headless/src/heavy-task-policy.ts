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
const DEFAULT_TASK_METADATA_ENABLED_REASON =
  'heavy-task mode explicitly enabled by task benchmark metadata';

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
  const signalMode = normalizeTaskSignalMode(task);
  if (signalMode?.enabled === true) {
    return {
      schemaVersion: 1,
      enabled: true,
      triggerSource: 'task_metadata',
      triggerReason:
        signalMode.reason ?? 'heavy-task mode enabled by benchmark task complexity signal',
      policyVersion: signalMode.policyVersion ?? HEAVY_TASK_POLICY_VERSION,
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
  selection: Pick<HeavyTaskModeSelection, 'policyVersion'> = {
    policyVersion: HEAVY_TASK_POLICY_VERSION,
  },
): string {
  return [
    `Heavy-task benchmark policy (${selection.policyVersion})`,
    '',
    '- Work like a persistent engineer on a long-running task: inspect public task files and workspace state before editing, then move quickly to a runnable artifact instead of turning research into the deliverable.',
    '- Follow this thin work loop until the task is done or a real cap is reached: inventory -> runnable_artifact -> public_check -> repair_or_continue -> semantic_self_check -> finish_or_continue.',
    '- Use inventory_submit to submit a structured inventory snapshot after initial public inspection and whenever the important workspace/artifact inventory changes.',
    '- Use todo_update to submit the full current todo/progress snapshot as work advances. Keep at most one item in_progress, and treat todo completion as advisory progress rather than benchmark success.',
    '- After the first inventory, record a lightweight agent-owned check plan with todo_update: include a first runnable artifact todo (kind runnable_artifact) and a public check todo (kind public_check) derived only from visible task/workspace evidence.',
    '- Early runnable/check phase gate: before broad implementation loops or declaring completion, produce the smallest runnable artifact, run one visible public check such as a build, sample command, public test, or artifact inspection, then update the runnable_artifact and public_check todos with concise evidence.',
    '- Before final self_check_submit, call self_check_plan_submit. Declare final artifacts, the self-check scratch root, workspace guard checked paths, and any expected added or generated paths using only visible public evidence.',
    '- Before final self_check_submit, confirm the required runnable artifact or deliverable is present and supported by visible public evidence, then submit and finish rather than doing unrelated environment work.',
    '- Use self_check_submit only after that public check has run or been inspected. Submit public, task-derived semantic self-check evidence from visible tests, builds, sample commands, or artifact inspections. Include public command/artifact evidence only.',
    '- Self-check sandbox execution: run self-check compiles, probes, temporary scripts, generated outputs, and destructive experiments under an explicit scratch root such as /tmp/maka-self-check/<task-or-check-id>. Copy public inputs there or reference deliverable files read-only; do not write check outputs back into the deliverable workspace.',
    '- Report the sandbox contract in self_check_submit.executionHygiene.sandbox: root, strategy, input paths, command cwd, output policy, and a public reason. A pass self-check without sandbox evidence is not strong semantic completion evidence.',
    '- Self-check execution hygiene: run compiles, probes, temporary scripts, and generated check outputs in a scratch directory such as /tmp when possible. If a check must touch the deliverable workspace, clean up temporary files before finishing and report scratch/cleanup facts in self_check_submit.executionHygiene.',
    '- Before final self_check_submit, run a public workspace hygiene guard over relevant deliverable directories: compare before/after listing or diff output, summarize checked paths and added/modified/removed files in self_check_submit.executionHygiene.workspaceGuard, and make the evidence consistent with the latest accepted self_check_plan_submit.',
    '- Heavy-task finalization may be rejected once before official verification when the latest self_check_plan_submit or self_check_submit is missing, failing, inconclusive, inconsistent, lacks sandbox/workspace guard evidence, or does not address visible required artifacts. Treat the bounded gate message as a diagnostic: compare it against your accepted plan and public evidence, then resubmit self_check_plan_submit and self_check_submit as needed.',
    '- Do not create separate live audit reports or proof chains for the model. Failed-check retrospectives and export summaries should be derived from the trace rather than added as extra model-facing work.',
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

export function configWithHeavyTaskPolicy(
  config: Config,
  selection: HeavyTaskModeSelection,
): Config {
  const systemPrompt = appendHeavyTaskPolicyToSystemPrompt(config.systemPrompt, selection);
  if (systemPrompt === config.systemPrompt) return config;
  return { ...config, systemPrompt };
}

function normalizeTaskMetadataMode(
  metadata: Record<string, unknown> | undefined,
): HeavyTaskModeConfig | undefined {
  if (!metadata) return undefined;
  const mode = normalizeModeConfig(metadata.heavyTaskMode);
  if (mode) return mode;
  return normalizeModeConfig(metadata.heavyTask);
}

function normalizeTaskSignalMode(task: Task | undefined): HeavyTaskModeConfig | undefined {
  const metadata = task?.benchmark?.metadata;
  if (!metadata) return undefined;
  const taskComplexity = cleanString(metadata.taskComplexity);
  if (taskComplexity && ['heavy', 'long', 'complex'].includes(taskComplexity.toLowerCase())) {
    return { enabled: true, reason: `benchmark task complexity signal: ${taskComplexity}` };
  }
  const runtimeSignal = cleanString(metadata.runtimeSignal);
  if (
    runtimeSignal &&
    ['heavy_task', 'long_running', 'complex_engineering'].includes(runtimeSignal.toLowerCase())
  ) {
    return { enabled: true, reason: `benchmark runtime signal: ${runtimeSignal}` };
  }
  const instructionSignal = cleanString(metadata.instructionSignal);
  if (
    instructionSignal &&
    ['heavy_task', 'long_running', 'complex_engineering'].includes(instructionSignal.toLowerCase())
  ) {
    return { enabled: true, reason: `benchmark instruction signal: ${instructionSignal}` };
  }
  return undefined;
}

function normalizeModeConfig(value: unknown): HeavyTaskModeConfig | undefined {
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
