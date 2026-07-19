import type { Task } from './contracts.js';
import { evaluateHeavyTaskCompletionStatus } from './heavy-task-finalization.js';
import {
  heavyTaskSelfCheckStrongPassBlocker,
  isAcceptedHeavyTaskSelfCheck,
} from './heavy-task-self-check.js';
import type { HeavyTaskModeSelection } from './heavy-task-policy.js';
import type {
  HeavyTaskAcceptanceCheck,
  HeavyTaskSemanticSelfCheckState,
  HeavyTaskSelfCheckGateState,
  HeavyTaskWorkspaceObservationState,
  HeavyTaskTodoItem,
} from './task-contracts.js';
import type { TaskRunProjection } from './task-run-store.js';

export type HeavyTaskSelfCheckGateDecision =
  | {
      action: 'allow_finalize';
      reason: string;
      checklist: HeavyTaskAcceptanceCheck[];
      selfCheckId: string;
    }
  | {
      action: 'repair_prompt';
      reason: string;
      checklist: HeavyTaskAcceptanceCheck[];
      prompt: string;
      attempt: 1;
    }
  | {
      action: 'allow_official_verifier_after_bounded_attempt';
      reason: string;
      checklist: HeavyTaskAcceptanceCheck[];
    };

export interface HeavyTaskSelfCheckGateInput {
  task: Task;
  heavyTaskMode: HeavyTaskModeSelection;
  projection: TaskRunProjection;
  repairAttemptsUsed?: number;
  maxRepairAttempts?: number;
}

export function evaluateHeavyTaskSelfCheckGate(
  input: HeavyTaskSelfCheckGateInput,
): HeavyTaskSelfCheckGateDecision {
  const checklist = deriveHeavyTaskAcceptanceChecks(input.task, input.projection);
  if (!input.heavyTaskMode.enabled) {
    return {
      action: 'allow_finalize',
      reason: 'heavy-task mode is not enabled',
      checklist,
      selfCheckId: input.projection.latestHeavyTaskSelfCheck?.selfCheckId ?? 'not_required',
    };
  }

  const completion = evaluateHeavyTaskCompletionStatus({
    status: input.projection.status,
    taxonomy: input.projection.latestScoreResult?.taxonomy ?? input.projection.result?.taxonomy,
    error: input.projection.error,
    heavyTaskMode: input.projection.heavyTaskMode ?? input.heavyTaskMode,
    latestHeavyTaskTodos: input.projection.latestHeavyTaskTodos,
    latestHeavyTaskSelfCheckPlan: input.projection.latestHeavyTaskSelfCheckPlan,
    latestHeavyTaskSelfCheck: input.projection.latestHeavyTaskSelfCheck,
    decisions: input.projection.decisions,
  });
  const selfCheck = input.projection.latestHeavyTaskSelfCheck;
  const reason = gateBlockerReason(
    selfCheck,
    input.projection.latestHeavyTaskSelfCheckPlan,
    completion.semantic.reason,
    checklist,
  );
  if (!reason && completion.semantic.status === 'complete' && selfCheck) {
    return {
      action: 'allow_finalize',
      reason: 'latest accepted public self-check is complete and evidence-bearing',
      checklist,
      selfCheckId: selfCheck.selfCheckId,
    };
  }

  const attemptsUsed = input.repairAttemptsUsed ?? 0;
  const maxAttempts = input.maxRepairAttempts ?? 1;
  const blockedReason = reason ?? completion.semantic.reason;
  if (attemptsUsed >= maxAttempts) {
    return {
      action: 'allow_official_verifier_after_bounded_attempt',
      reason: blockedReason,
      checklist,
    };
  }

  return {
    action: 'repair_prompt',
    reason: blockedReason,
    checklist,
    prompt: renderHeavyTaskSelfCheckGatePrompt({
      reason: blockedReason,
      checklist,
      selfCheck,
      workspaceObservation: input.projection.latestHeavyTaskWorkspaceObservation,
      attempt: attemptsUsed + 1,
      maxAttempts,
    }),
    attempt: 1,
  };
}

export function heavyTaskSelfCheckGateStateFromDecision(input: {
  decision: HeavyTaskSelfCheckGateDecision;
  attempt: number;
  maxAttempts: number;
}): HeavyTaskSelfCheckGateState {
  const base = {
    schemaVersion: 1 as const,
    action: input.decision.action,
    reason: input.decision.reason,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    checklist: input.decision.checklist,
  };
  if (input.decision.action === 'allow_finalize') {
    return { ...base, selfCheckId: input.decision.selfCheckId };
  }
  if (input.decision.action === 'repair_prompt') {
    return { ...base, prompt: input.decision.prompt };
  }
  return base;
}

export function deriveHeavyTaskAcceptanceChecks(
  task: Task,
  projection: Pick<TaskRunProjection, 'latestHeavyTaskTodos' | 'latestHeavyTaskSelfCheckPlan'> = {},
): HeavyTaskAcceptanceCheck[] {
  const checks: HeavyTaskAcceptanceCheck[] = [];
  const seen = new Set<string>();
  const add = (check: Omit<HeavyTaskAcceptanceCheck, 'id'>) => {
    const key = `${check.kind}:${check.source}:${check.path ?? ''}:${check.description}`;
    if (seen.has(key)) return;
    seen.add(key);
    checks.push({ id: `check-${checks.length + 1}`, ...check });
  };

  for (const artifact of projection.latestHeavyTaskSelfCheckPlan?.finalArtifacts ?? []) {
    const path = artifact.path;
    add({
      kind: 'required_artifact',
      source: 'self_check_plan',
      description: `Accepted self_check_plan_submit declares final artifact ${path}`,
      evidenceRequired: 'command_or_artifact',
      path,
      commandHint: `test -e ${shellQuote(path)}`,
    });
    const parseHint = parseCheckForPath(path, 'self_check_plan');
    if (parseHint) add(parseHint);
  }

  for (const item of projection.latestHeavyTaskTodos?.items ?? []) {
    if (!['runnable_artifact', 'public_check', 'final_self_check'].includes(item.kind ?? ''))
      continue;
    add({
      kind: item.kind === 'public_check' ? 'public_command' : 'task_family_hint',
      source: 'todo',
      description: `Current heavy-task todo ${item.id}: ${cleanOneLine(item.content, 160)}`,
      evidenceRequired: item.kind === 'runnable_artifact' ? 'command_or_artifact' : 'command',
    });
  }

  const metadataText = JSON.stringify(publicMetadata(task.benchmark?.metadata));
  if (task.verifier?.kind === 'terminal_bench' || task.benchmark?.source === 'terminal_bench') {
    add({
      kind: 'task_family_hint',
      source: 'terminal_bench_hint',
      description:
        'Terminal-bench task should verify required /app deliverables with public commands or artifact inspections',
      evidenceRequired: 'command_or_artifact',
      path: '/app',
      commandHint: 'find /app -maxdepth 2 -type f | sort | sed -n "1,120p"',
    });
  }
  if (/\b(package|library|module|import)\b/i.test(`${task.instruction} ${metadataText}`)) {
    add({
      kind: 'fresh_context',
      source: 'terminal_bench_hint',
      description:
        'Package/library task should include a fresh-context import or execution check where practical',
      evidenceRequired: 'command',
    });
  }
  if (/\b(cli|command line|script|executable)\b/i.test(`${task.instruction} ${metadataText}`)) {
    add({
      kind: 'public_command',
      source: 'terminal_bench_hint',
      description:
        'CLI/script task should include a direct public invocation check where practical',
      evidenceRequired: 'command',
    });
  }

  add({
    kind: 'workspace_hygiene',
    source: 'generic_heavy_task',
    description:
      'Pass self-check must include sandbox execution evidence and a public workspace hygiene guard',
    evidenceRequired: 'command_or_artifact',
  });

  return checks;
}

export function renderHeavyTaskSelfCheckGatePrompt(input: {
  reason: string;
  checklist: readonly HeavyTaskAcceptanceCheck[];
  selfCheck?: HeavyTaskSemanticSelfCheckState;
  workspaceObservation?: HeavyTaskWorkspaceObservationState;
  attempt: number;
  maxAttempts: number;
}): string {
  const lines = [
    'Your previous completion is not accepted for heavy-task finalization yet.',
    `Gate reason: ${input.reason}`,
    `Bounded repair/check attempt: ${input.attempt} of ${input.maxAttempts}.`,
    '',
    'Public acceptance checklist:',
    ...input.checklist.map((check) => {
      const target = check.path ? ` target=${check.path}` : '';
      const command = check.commandHint ? ` command_hint=${check.commandHint}` : '';
      return `- [${check.id}] ${check.kind}/${check.source}: ${check.description}; evidence=${check.evidenceRequired}${target}${command}`;
    }),
    '',
    latestSelfCheckSummary(input.selfCheck),
    ...latestWorkspaceObservationSummary(input.workspaceObservation),
    '',
    'Required action: run public commands or artifact inspections in the current workspace or under /tmp/maka-self-check, repair only if those checks fail, then call self_check_submit with concrete command/artifact evidence, executionHygiene.sandbox, and executionHygiene.workspaceGuard.',
    'Constraints: do not inspect hidden, private, evaluator, official verifier, or scorer-only material. Keep scratch outputs under /tmp/maka-self-check/... and clean or report any workspace side effects.',
  ];
  return lines.filter((line) => line !== undefined).join('\n');
}

function gateBlockerReason(
  selfCheck: TaskRunProjection['latestHeavyTaskSelfCheck'],
  plan: TaskRunProjection['latestHeavyTaskSelfCheckPlan'],
  semanticReason: string,
  checklist: readonly HeavyTaskAcceptanceCheck[],
): string | undefined {
  if (!selfCheck) return 'missing accepted public self-check evidence';
  if (!isAcceptedHeavyTaskSelfCheck(selfCheck))
    return 'latest self-check evidence was not accepted as public';
  if (selfCheck.freshness === 'stale') {
    return `latest self-check is stale: ${selfCheck.freshnessReasons.join(', ') || 'workspace changed'}`;
  }
  if (selfCheck.status !== 'pass') return `latest self-check status is ${selfCheck.status}`;
  if (selfCheck.commandEvidence.length + selfCheck.artifactEvidence.length === 0) {
    return 'latest pass self-check lacks concrete command or artifact evidence';
  }
  const strongPassBlocker = heavyTaskSelfCheckStrongPassBlocker(selfCheck, plan);
  if (strongPassBlocker) return strongPassBlocker;
  if (!selfCheckAddressesRequiredArtifacts(selfCheck, checklist)) {
    return 'latest self-check does not address visible required artifact contract';
  }
  if (
    semanticReason !==
    'accepted public self-check passed, todos are resolved/nonblocking, and early runnable/check phase gate is complete'
  ) {
    return semanticReason;
  }
  return undefined;
}

function selfCheckAddressesRequiredArtifacts(
  selfCheck: HeavyTaskSemanticSelfCheckState,
  checklist: readonly HeavyTaskAcceptanceCheck[],
): boolean {
  const requiredPaths = checklist
    .filter((check) => check.kind === 'required_artifact' && check.path)
    .map((check) => check.path as string);
  if (requiredPaths.length === 0) return true;
  const evidenceText = [
    selfCheck.publicReason,
    ...selfCheck.commandEvidence.flatMap((evidence) => [
      evidence.command,
      evidence.outputExcerpt ?? '',
      ...(evidence.artifactRefs ?? []),
    ]),
    ...selfCheck.artifactEvidence.map((evidence) => evidence.path),
  ]
    .join('\n')
    .toLowerCase();
  return requiredPaths.some(
    (path) =>
      evidenceText.includes(path.toLowerCase()) ||
      evidenceText.includes(basename(path).toLowerCase()),
  );
}

function parseCheckForPath(
  path: string,
  source: HeavyTaskAcceptanceCheck['source'],
): Omit<HeavyTaskAcceptanceCheck, 'id'> | undefined {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith('.jsonl')) {
    return {
      kind: 'artifact_parse',
      source,
      description: `Declared JSONL artifact ${path} should be parseable or line-inspected`,
      evidenceRequired: 'command_or_artifact',
      path,
      commandHint: `python - <<'PY'\nimport json\nfrom pathlib import Path\np=Path(${JSON.stringify(path)})\nfor line in p.read_text().splitlines(): json.loads(line)\nPY`,
    };
  }
  if (lowerPath.endsWith('.json')) {
    return {
      kind: 'artifact_parse',
      source,
      description: `Declared JSON artifact ${path} should be parseable`,
      evidenceRequired: 'command_or_artifact',
      path,
      commandHint: `python -m json.tool ${shellQuote(path)} >/tmp/maka-self-check/json-parse.out`,
    };
  }
  return undefined;
}

function latestSelfCheckSummary(selfCheck: HeavyTaskSemanticSelfCheckState | undefined): string {
  if (!selfCheck) return 'Latest self-check summary: none accepted yet.';
  const commands = selfCheck.commandEvidence
    .slice(0, 3)
    .map(
      (evidence) => `${cleanOneLine(evidence.command, 140)} exit=${evidence.exitCode ?? 'unknown'}`,
    );
  const artifacts = selfCheck.artifactEvidence
    .slice(0, 3)
    .map((evidence) => `${evidence.path} exists=${evidence.exists ?? 'unknown'}`);
  return [
    `Latest self-check summary: id=${selfCheck.selfCheckId} status=${selfCheck.status}`,
    `- reason: ${cleanOneLine(selfCheck.publicReason, 240)}`,
    ...commands.map((command) => `- command: ${command}`),
    ...artifacts.map((artifact) => `- artifact: ${artifact}`),
  ].join('\n');
}

function latestWorkspaceObservationSummary(
  observation: HeavyTaskWorkspaceObservationState | undefined,
): string[] {
  if (!observation) return [];
  if (observation.status !== 'ok') {
    return [
      '',
      'Machine workspace observation facts: unavailable.',
      `- roots: ${observation.roots.join(', ') || '(none)'}`,
      `- error: ${cleanOneLine(observation.errorExcerpt ?? 'unknown observation error', 240)}`,
    ];
  }
  const entries = observation.entries.slice(0, 40).map((entry) => {
    const suffix =
      entry.kind === 'symlink' && entry.symlinkTarget ? ` -> ${entry.symlinkTarget}` : '';
    return `- ${entry.kind} ${entry.path}${suffix}`;
  });
  return [
    '',
    'Machine workspace observation facts (directory listing only; compare with the task instructions and your accepted plan):',
    `- roots: ${observation.roots.join(', ') || '(none)'}`,
    ...entries,
    ...(observation.entries.length > entries.length
      ? [`- ... ${observation.entries.length - entries.length} more entries omitted`]
      : []),
  ];
}

function publicMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metadata) return {};
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (/hidden|private|evaluator|official|scorer/i.test(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      output[key] = value;
  }
  return output;
}

function cleanOneLine(value: string, limit: number): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length <= limit ? cleaned : `${cleaned.slice(0, limit - 3)}...`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts.at(-1) ?? path;
}
