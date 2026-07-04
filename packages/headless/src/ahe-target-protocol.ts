export const MAKA_AHE_TARGET_PROTOCOL_VERSION = 'maka.ahe-target.v1' as const;

export const MAKA_AHE_TARGET_SOURCE_LABEL = 'ahe-target-protocol-20260701' as const;

export const MAKA_AHE_COMPONENT_CATEGORIES = [
  'system_prompt',
  'heavy_task_policy',
  'tool_contract',
  'context_management_policy',
  'permission_policy',
  'runtime_evidence',
  'headless_evaluation_policy',
] as const;

export const MAKA_AHE_RESULT_STATUSES = [
  'official_pass',
  'official_fail',
  'infra_failed',
  'excluded',
  'self_check_only',
  'unscored',
] as const;

export const MAKA_AHE_SCORE_AUTHORITIES = [
  'official_verifier',
  'official_scorer',
  'self_check',
  'analysis_only',
] as const;

export const MAKA_AHE_TRANSITION_STATUSES = [
  'fail_to_pass',
  'fail_to_fail',
  'pass_to_pass',
  'pass_to_fail',
  'new_pass',
  'new_fail',
  'infra_or_excluded',
] as const;

const FORBIDDEN_PATCH_PATH_PREFIXES = [
  '.git/',
  'node_modules/',
  'dist/',
  'packages/core/dist/',
  'packages/runtime/dist/',
  'packages/storage/dist/',
  'packages/headless/dist/',
  'packages/ui/dist/',
  'apps/desktop/dist/',
] as const;

const FORBIDDEN_PATCH_PATH_PARTS = [
  '/.git/',
  '/node_modules/',
  '/dist/',
] as const;

export type MakaAheTargetProtocolVersion = typeof MAKA_AHE_TARGET_PROTOCOL_VERSION;
export type MakaAheTargetSourceLabel = typeof MAKA_AHE_TARGET_SOURCE_LABEL;
export type MakaAheComponentCategory = typeof MAKA_AHE_COMPONENT_CATEGORIES[number];
export type MakaAheResultStatus = typeof MAKA_AHE_RESULT_STATUSES[number];
export type MakaAheScoreAuthority = typeof MAKA_AHE_SCORE_AUTHORITIES[number];
export type MakaAheTransitionStatus = typeof MAKA_AHE_TRANSITION_STATUSES[number];

export interface MakaAheSourceRef {
  path: string;
  exportName?: string;
  description?: string;
}

export interface MakaAheTargetComponent {
  id: string;
  category: MakaAheComponentCategory;
  label: string;
  description: string;
  sourceRefs: readonly MakaAheSourceRef[];
  editable: boolean;
}

export interface MakaAheSnapshotIdentity {
  protocolVersion: MakaAheTargetProtocolVersion;
  sourceLabel: MakaAheTargetSourceLabel | string;
  snapshotId: string;
  createdAt: string;
  git?: {
    repository: string;
    ref?: string;
    commit?: string;
    dirty?: boolean;
  };
}

export interface MakaAheTargetSnapshot extends MakaAheSnapshotIdentity {
  components: readonly MakaAheTargetComponent[];
}

export interface MakaAheArtifactRef {
  kind: 'file' | 'directory' | 'url' | 'blob' | 'other';
  ref: string;
  mediaType?: string;
  description?: string;
}

export interface MakaAheTraceIndexEntry {
  taskId: string;
  runId: string;
  snapshotId: string;
  runtimeEventsJsonl?: MakaAheArtifactRef;
  transcript?: MakaAheArtifactRef;
  agentRun?: MakaAheArtifactRef;
  toolResults?: readonly MakaAheArtifactRef[];
  artifacts?: readonly MakaAheArtifactRef[];
}

export interface MakaAheTraceIndex {
  protocolVersion: MakaAheTargetProtocolVersion;
  snapshotId: string;
  entries: readonly MakaAheTraceIndexEntry[];
}

export interface MakaAheRunResult {
  protocolVersion: MakaAheTargetProtocolVersion;
  runId: string;
  snapshotId: string;
  taskId: string;
  status: MakaAheResultStatus;
  scoreAuthority: MakaAheScoreAuthority;
  score?: number;
  verifierRef?: MakaAheArtifactRef;
  traceRef?: MakaAheArtifactRef;
  failureTaxonomy?: readonly string[];
  warnings?: readonly string[];
}

export interface MakaAheHarnessResults {
  protocolVersion: MakaAheTargetProtocolVersion;
  snapshotId: string;
  runId: string;
  results: readonly MakaAheRunResult[];
  traceIndexRef?: MakaAheArtifactRef;
}

export interface MakaAheEvidenceCase {
  taskId: string;
  runId?: string;
  resultStatus?: MakaAheResultStatus;
  traceRef?: MakaAheArtifactRef;
  summary: string;
}

export interface MakaAheChangeManifest {
  protocolVersion: MakaAheTargetProtocolVersion;
  manifestId: string;
  sourceLabel: MakaAheTargetSourceLabel | string;
  targetSnapshotId: string;
  createdAt: string;
  changedComponents: readonly string[];
  failureEvidence: readonly MakaAheEvidenceCase[];
  rootCause: string;
  targetedFix: string;
  predictedFixes: readonly MakaAheEvidenceCase[];
  riskCases: readonly MakaAheEvidenceCase[];
  validationDataset: {
    datasetId: string;
    taskIds: readonly string[];
    baselineRunId?: string;
  };
  patch: {
    applyMode: 'staged_patch';
    diffRef?: MakaAheArtifactRef;
    changedFiles?: readonly string[];
  };
  rollbackCriteria: readonly string[];
}

export interface MakaAheChangeEvaluationCell {
  taskId: string;
  baseline?: MakaAheRunResult;
  candidate?: MakaAheRunResult;
  transition: MakaAheTransitionStatus;
}

export interface MakaAheChangeEvaluation {
  protocolVersion: MakaAheTargetProtocolVersion;
  manifestId: string;
  baselineSnapshotId: string;
  candidateSnapshotId: string;
  candidateRunId: string;
  cells: readonly MakaAheChangeEvaluationCell[];
  predictedFixesObserved: readonly string[];
  predictedFixesMissed: readonly string[];
  regressions: readonly string[];
  excludedTaskIds: readonly string[];
  infraFailedTaskIds: readonly string[];
  selfCheckOnlyTaskIds: readonly string[];
}

export interface MakaAheValidationIssue {
  path: string;
  message: string;
}

export type MakaAheValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: MakaAheValidationIssue[] };

export const MAKA_AHE_CURRENT_COMPONENTS: readonly MakaAheTargetComponent[] = [
  {
    id: 'maka-system-prompt',
    category: 'system_prompt',
    label: 'Maka desktop system prompt',
    description: 'Desktop main-process prompt and workspace context that shape every interactive Maka turn.',
    editable: true,
    sourceRefs: [
      { path: 'apps/desktop/src/main/system-prompt-main.ts' },
      { path: 'packages/runtime/src/system-prompt/session-environment-prompt.ts' },
      { path: 'apps/desktop/src/main/workspace-instructions.ts' },
    ],
  },
  {
    id: 'maka-heavy-task-policy',
    category: 'heavy_task_policy',
    label: 'Heavy-task policy',
    description: 'Policy text and benchmark wrapper expectations for long-running and evidence-heavy tasks.',
    editable: true,
    sourceRefs: [
      { path: 'docs/heavy-task-mainline-system-design.md' },
      { path: 'packages/headless/README.md' },
      { path: 'terminal-bench-smoke/README-terminal-bench-sample.md' },
    ],
  },
  {
    id: 'maka-tool-contracts',
    category: 'tool_contract',
    label: 'Tool descriptions and schemas',
    description: 'Maka tool names, descriptions, input schemas, gating, and selected desktop tool wrappers.',
    editable: true,
    sourceRefs: [
      { path: 'packages/runtime/src/tool-runtime.ts', exportName: 'MakaTool' },
      { path: 'packages/runtime/src/builtin-tools.ts' },
      { path: 'packages/runtime/src/tool-availability.ts' },
      { path: 'apps/desktop/src/main/rive-workflow-tool.ts' },
    ],
  },
  {
    id: 'maka-context-management',
    category: 'context_management_policy',
    label: 'Context budget and compaction',
    description: 'Runtime context-budget, active tool-result pruning, and semantic compaction behavior.',
    editable: true,
    sourceRefs: [
      { path: 'packages/runtime/src/context-budget.ts' },
      { path: 'packages/runtime/src/active-full-compact.ts' },
      { path: 'packages/runtime/src/semantic-compact.ts' },
      { path: 'apps/desktop/src/main/context-budget-policy.ts' },
    ],
  },
  {
    id: 'maka-permission-policy',
    category: 'permission_policy',
    label: 'Permission and tool availability policy',
    description: 'Permission modes, pre-tool-use policy, runtime permission enforcement, and dynamic tool availability.',
    editable: true,
    sourceRefs: [
      { path: 'packages/core/src/permission.ts' },
      { path: 'packages/runtime/src/permission-engine.ts' },
      { path: 'packages/runtime/src/tool-availability.ts' },
    ],
  },
  {
    id: 'maka-runtime-evidence',
    category: 'runtime_evidence',
    label: 'Runtime evidence ledger',
    description: 'Canonical runtime events, agent-run records, and runner output used as AHE trace evidence.',
    editable: false,
    sourceRefs: [
      { path: 'packages/core/src/runtime-event.ts', exportName: 'RuntimeEvent' },
      { path: 'packages/core/src/agent-run.ts', exportName: 'AgentRunHeader' },
      { path: 'packages/runtime/src/runtime-runner.ts', exportName: 'RuntimeRunner' },
    ],
  },
  {
    id: 'maka-headless-evaluation',
    category: 'headless_evaluation_policy',
    label: 'Headless and benchmark evaluation',
    description: 'Headless result format, official verifier accounting, and Terminal-Bench smoke runner protocol.',
    editable: true,
    sourceRefs: [
      { path: 'packages/headless/README.md' },
      { path: 'terminal-bench-smoke/maka_harbor_runner.mjs' },
      { path: 'terminal-bench-smoke/run-terminal-bench-sample-heavy.sh' },
    ],
  },
];

export function validateMakaAheTargetComponents(
  value: unknown,
): MakaAheValidationResult<readonly MakaAheTargetComponent[]> {
  const errors: MakaAheValidationIssue[] = [];
  if (!Array.isArray(value)) {
    return invalid('components', 'expected an array');
  }

  const ids = new Set<string>();
  value.forEach((component, index) => {
    const path = `components[${index}]`;
    if (!isRecord(component)) {
      errors.push({ path, message: 'expected an object' });
      return;
    }

    const id = readString(component.id);
    if (!id) {
      errors.push({ path: `${path}.id`, message: 'expected a non-empty string' });
    } else if (ids.has(id)) {
      errors.push({ path: `${path}.id`, message: `duplicate component id "${id}"` });
    } else {
      ids.add(id);
    }

    if (!isOneOf(component.category, MAKA_AHE_COMPONENT_CATEGORIES)) {
      errors.push({ path: `${path}.category`, message: 'expected a known component category' });
    }
    if (!readString(component.label)) {
      errors.push({ path: `${path}.label`, message: 'expected a non-empty string' });
    }
    if (!readString(component.description)) {
      errors.push({ path: `${path}.description`, message: 'expected a non-empty string' });
    }
    if (typeof component.editable !== 'boolean') {
      errors.push({ path: `${path}.editable`, message: 'expected a boolean' });
    }
    validateSourceRefs(component.sourceRefs, `${path}.sourceRefs`, errors);
  });

  return errors.length === 0 ? { ok: true, value: value as readonly MakaAheTargetComponent[] } : { ok: false, errors };
}

export function validateMakaAheChangeManifest(
  value: unknown,
  components: readonly MakaAheTargetComponent[] = MAKA_AHE_CURRENT_COMPONENTS,
): MakaAheValidationResult<MakaAheChangeManifest> {
  const errors: MakaAheValidationIssue[] = [];
  if (!isRecord(value)) {
    return invalid('manifest', 'expected an object');
  }

  requireProtocol(value.protocolVersion, 'protocolVersion', errors);
  requireNonEmptyString(value.manifestId, 'manifestId', errors);
  requireNonEmptyString(value.sourceLabel, 'sourceLabel', errors);
  requireNonEmptyString(value.targetSnapshotId, 'targetSnapshotId', errors);
  requireNonEmptyString(value.createdAt, 'createdAt', errors);
  requireNonEmptyString(value.rootCause, 'rootCause', errors);
  requireNonEmptyString(value.targetedFix, 'targetedFix', errors);

  const componentIds = new Set(components.map((component) => component.id));
  validateStringArray(value.changedComponents, 'changedComponents', errors, { minItems: 1, allowedValues: componentIds });
  const changedComponentIds = stringArray(value.changedComponents);
  for (const componentId of changedComponentIds) {
    const component = components.find((candidate) => candidate.id === componentId);
    if (component && !component.editable) {
      errors.push({
        path: 'changedComponents',
        message: `component "${componentId}" is evidence-only and cannot be patched`,
      });
    }
  }
  validateEvidenceCases(value.failureEvidence, 'failureEvidence', errors, { minItems: 1 });
  validateEvidenceCases(value.predictedFixes, 'predictedFixes', errors, { minItems: 1 });
  validateEvidenceCases(value.riskCases, 'riskCases', errors, { minItems: 1 });
  validateValidationDataset(value.validationDataset, errors);
  validatePatch(value.patch, errors, components.filter((component) => changedComponentIds.includes(component.id)));
  validateStringArray(value.rollbackCriteria, 'rollbackCriteria', errors, { minItems: 1 });

  return errors.length === 0 ? { ok: true, value: value as unknown as MakaAheChangeManifest } : { ok: false, errors };
}

export function validateMakaAheRunResult(value: unknown): MakaAheValidationResult<MakaAheRunResult> {
  const errors: MakaAheValidationIssue[] = [];
  if (!isRecord(value)) {
    return invalid('result', 'expected an object');
  }

  requireProtocol(value.protocolVersion, 'protocolVersion', errors);
  requireNonEmptyString(value.runId, 'runId', errors);
  requireNonEmptyString(value.snapshotId, 'snapshotId', errors);
  requireNonEmptyString(value.taskId, 'taskId', errors);

  if (!isOneOf(value.status, MAKA_AHE_RESULT_STATUSES)) {
    errors.push({ path: 'status', message: 'expected a known result status' });
  }
  if (!isOneOf(value.scoreAuthority, MAKA_AHE_SCORE_AUTHORITIES)) {
    errors.push({ path: 'scoreAuthority', message: 'expected a known score authority' });
  }
  if (
    (value.status === 'official_pass' || value.status === 'official_fail')
    && value.scoreAuthority !== 'official_verifier'
    && value.scoreAuthority !== 'official_scorer'
  ) {
    errors.push({
      path: 'status',
      message: 'official pass/fail requires scoreAuthority official_verifier or official_scorer',
    });
  }
  if (typeof value.score !== 'undefined' && typeof value.score !== 'number') {
    errors.push({ path: 'score', message: 'expected a number when present' });
  }

  return errors.length === 0 ? { ok: true, value: value as unknown as MakaAheRunResult } : { ok: false, errors };
}

function validateSourceRefs(value: unknown, path: string, errors: MakaAheValidationIssue[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({ path, message: 'expected at least one source ref' });
    return;
  }
  value.forEach((sourceRef, index) => {
    const sourcePath = `${path}[${index}]`;
    if (!isRecord(sourceRef)) {
      errors.push({ path: sourcePath, message: 'expected an object' });
      return;
    }
    requireNonEmptyString(sourceRef.path, `${sourcePath}.path`, errors);
  });
}

function validateEvidenceCases(
  value: unknown,
  path: string,
  errors: MakaAheValidationIssue[],
  options: { minItems: number },
): void {
  if (!Array.isArray(value) || value.length < options.minItems) {
    errors.push({ path, message: `expected at least ${options.minItems} evidence case(s)` });
    return;
  }
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(item)) {
      errors.push({ path: itemPath, message: 'expected an object' });
      return;
    }
    requireNonEmptyString(item.taskId, `${itemPath}.taskId`, errors);
    requireNonEmptyString(item.summary, `${itemPath}.summary`, errors);
    if (typeof item.resultStatus !== 'undefined' && !isOneOf(item.resultStatus, MAKA_AHE_RESULT_STATUSES)) {
      errors.push({ path: `${itemPath}.resultStatus`, message: 'expected a known result status' });
    }
  });
}

function validateValidationDataset(value: unknown, errors: MakaAheValidationIssue[]): void {
  if (!isRecord(value)) {
    errors.push({ path: 'validationDataset', message: 'expected an object' });
    return;
  }
  requireNonEmptyString(value.datasetId, 'validationDataset.datasetId', errors);
  validateStringArray(value.taskIds, 'validationDataset.taskIds', errors, { minItems: 1 });
}

function validatePatch(
  value: unknown,
  errors: MakaAheValidationIssue[],
  changedComponents: readonly MakaAheTargetComponent[],
): void {
  if (!isRecord(value)) {
    errors.push({ path: 'patch', message: 'expected an object' });
    return;
  }
  if (value.applyMode !== 'staged_patch') {
    errors.push({ path: 'patch.applyMode', message: 'expected "staged_patch"' });
  }
  if (typeof value.changedFiles !== 'undefined') {
    validateStringArray(value.changedFiles, 'patch.changedFiles', errors, { minItems: 1 });
    const allowedFiles = new Set(
      changedComponents
        .filter((component) => component.editable)
        .flatMap((component) => component.sourceRefs.map((sourceRef) => sourceRef.path)),
    );
    for (const [index, changedFile] of stringArray(value.changedFiles).entries()) {
      const path = `patch.changedFiles[${index}]`;
      const safetyIssue = unsafePatchPathReason(changedFile);
      if (safetyIssue) {
        errors.push({ path, message: safetyIssue });
        continue;
      }
      if (!allowedFiles.has(changedFile)) {
        errors.push({
          path,
          message: `changed file "${changedFile}" is not a source ref of an editable changed component`,
        });
      }
    }
  }
}

function unsafePatchPathReason(path: string): string | undefined {
  if (path.startsWith('/') || path.includes('\\')) {
    return 'patch paths must be repo-relative POSIX paths';
  }
  if (path === '.' || path === '..' || path.includes('../') || path.includes('/..')) {
    return 'patch paths must not traverse outside the repo';
  }
  if (FORBIDDEN_PATCH_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return 'patch path targets generated, dependency, or repository-control content';
  }
  if (FORBIDDEN_PATCH_PATH_PARTS.some((part) => path.includes(part))) {
    return 'patch path contains generated, dependency, or repository-control content';
  }
  return undefined;
}

function validateStringArray(
  value: unknown,
  path: string,
  errors: MakaAheValidationIssue[],
  options: { minItems: number; allowedValues?: ReadonlySet<string> },
): void {
  if (!Array.isArray(value) || value.length < options.minItems) {
    errors.push({ path, message: `expected at least ${options.minItems} string item(s)` });
    return;
  }
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!readString(item)) {
      errors.push({ path: itemPath, message: 'expected a non-empty string' });
      return;
    }
    if (options.allowedValues && !options.allowedValues.has(item)) {
      errors.push({ path: itemPath, message: `unknown value "${item}"` });
    }
  });
}

function requireProtocol(value: unknown, path: string, errors: MakaAheValidationIssue[]): void {
  if (value !== MAKA_AHE_TARGET_PROTOCOL_VERSION) {
    errors.push({ path, message: `expected "${MAKA_AHE_TARGET_PROTOCOL_VERSION}"` });
  }
}

function requireNonEmptyString(value: unknown, path: string, errors: MakaAheValidationIssue[]): void {
  if (!readString(value)) {
    errors.push({ path, message: 'expected a non-empty string' });
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === 'string' && allowed.includes(value);
}

function invalid(path: string, message: string): MakaAheValidationResult<never> {
  return { ok: false, errors: [{ path, message }] };
}
