import {
  heavyTaskSelfCheckStrongPassBlocker,
  isAcceptedHeavyTaskSelfCheck,
} from './heavy-task-self-check.js';
import type {
  AutonomousDecision,
  AutonomousResultTaxonomy,
  HeavyTaskModeFacts,
  HeavyTaskSelfCheckPlanState,
  HeavyTaskSelfCheckFreshness,
  HeavyTaskSelfCheckStatus,
  HeavyTaskSemanticSelfCheckState,
  HeavyTaskTodoItem,
  HeavyTaskTodoState,
  TaskRunError,
  TaskRunStatus,
} from './task-contracts.js';

type HeavyTaskPhaseGateKind = 'runnable_artifact' | 'public_check';

const REQUIRED_PHASE_GATE_KINDS: readonly HeavyTaskPhaseGateKind[] = [
  'runnable_artifact',
  'public_check',
];

export type HeavyTaskRuntimeCapKind =
  | 'none'
  | 'tool_call_step_cap'
  | 'token_cap'
  | 'runtime_step_cap'
  | 'wall_time_cap'
  | 'max_attempts'
  | 'timeout'
  | 'budget_exhausted'
  | 'unknown_cap';

export type HeavyTaskSemanticStatus = 'complete' | 'incomplete';

export interface HeavyTaskCompletionStatus {
  schemaVersion: 1;
  runtime: {
    taskRunStatus: TaskRunStatus;
    taxonomy?: AutonomousResultTaxonomy | string;
    capLike: boolean;
    capKind: HeavyTaskRuntimeCapKind;
    failureClass?: string;
    reason?: string;
  };
  semantic: {
    status: HeavyTaskSemanticStatus;
    advisory: true;
    reason: string;
    selfCheckId?: string;
    selfCheckStatus?: HeavyTaskSelfCheckStatus;
    todoSetId?: string;
    unresolvedTodoIds: string[];
    nonblockingTodoIds: string[];
  };
  finalization: {
    eligible: boolean;
    reason: string;
    boundedTurnImplemented: false;
  };
}

export interface HeavyTaskCompletionInput {
  status: TaskRunStatus;
  taxonomy?: AutonomousResultTaxonomy | string;
  error?: TaskRunError;
  heavyTaskMode?: HeavyTaskModeFacts;
  latestHeavyTaskTodos?: HeavyTaskTodoState;
  latestHeavyTaskSelfCheckPlan?: HeavyTaskSelfCheckPlanState;
  latestHeavyTaskSelfCheck?: HeavyTaskSemanticSelfCheckState & {
    freshness?: HeavyTaskSelfCheckFreshness;
  };
  decisions?: readonly AutonomousDecision[];
}

export function evaluateHeavyTaskCompletionStatus(
  input: HeavyTaskCompletionInput,
): HeavyTaskCompletionStatus {
  const runtime = runtimeStatusFromInput(input);
  const semantic = semanticStatusFromInput(input);
  const eligible = semantic.status === 'complete' && runtime.capLike;
  return {
    schemaVersion: 1,
    runtime,
    semantic,
    finalization: {
      eligible,
      reason: eligible
        ? 'runtime cap outcome with accepted semantic completion evidence'
        : finalizationIneligibleReason(runtime, semantic),
      boundedTurnImplemented: false,
    },
  };
}

function runtimeStatusFromInput(
  input: HeavyTaskCompletionInput,
): HeavyTaskCompletionStatus['runtime'] {
  const failureClass = input.error?.class;
  const reason = runtimeReason(input);
  const capKind = classifyCapKind(input, reason);
  return {
    taskRunStatus: input.status,
    ...(input.taxonomy ? { taxonomy: input.taxonomy } : {}),
    capLike: capKind !== 'none',
    capKind,
    ...(failureClass ? { failureClass } : {}),
    ...(reason ? { reason } : {}),
  };
}

function semanticStatusFromInput(
  input: HeavyTaskCompletionInput,
): HeavyTaskCompletionStatus['semantic'] {
  const selfCheck = input.latestHeavyTaskSelfCheck;
  const todos = input.latestHeavyTaskTodos;
  const unresolvedTodoIds = unresolvedTodoIdsFrom(todos);
  const nonblockingTodoIds = nonblockingTodoIdsFrom(todos);
  const base = {
    advisory: true as const,
    ...(selfCheck ? { selfCheckId: selfCheck.selfCheckId, selfCheckStatus: selfCheck.status } : {}),
    ...(todos ? { todoSetId: todos.todoSetId } : {}),
    unresolvedTodoIds,
    nonblockingTodoIds,
  };

  if (input.heavyTaskMode?.enabled !== true) {
    return { ...base, status: 'incomplete', reason: 'heavy-task mode is not enabled' };
  }
  if (!selfCheck) {
    return { ...base, status: 'incomplete', reason: 'missing accepted public self-check evidence' };
  }
  if (!isAcceptedHeavyTaskSelfCheck(selfCheck)) {
    return {
      ...base,
      status: 'incomplete',
      reason: 'latest self-check evidence was not accepted as public',
    };
  }
  if (selfCheck.freshness === 'stale') {
    return { ...base, status: 'incomplete', reason: 'latest self-check evidence is stale' };
  }
  if (selfCheck.status !== 'pass') {
    return {
      ...base,
      status: 'incomplete',
      reason: `latest self-check status is ${selfCheck.status}`,
    };
  }
  const strongPassBlocker = heavyTaskSelfCheckStrongPassBlocker(
    selfCheck,
    input.latestHeavyTaskSelfCheckPlan,
  );
  if (strongPassBlocker) {
    return { ...base, status: 'incomplete', reason: strongPassBlocker };
  }
  if (!todos) {
    return { ...base, status: 'incomplete', reason: 'missing latest heavy-task todos' };
  }
  if (todos.items.length === 0) {
    return { ...base, status: 'incomplete', reason: 'latest heavy-task todos are empty' };
  }
  if (unresolvedTodoIds.length > 0) {
    return {
      ...base,
      status: 'incomplete',
      reason: 'latest heavy-task todos contain unresolved work',
    };
  }
  const missingPhaseGateKinds = missingPhaseGateKindsFrom(todos);
  if (missingPhaseGateKinds.length > 0) {
    return {
      ...base,
      status: 'incomplete',
      reason: `missing completed early runnable/check phase-gate todos: ${missingPhaseGateKinds.join(', ')}`,
    };
  }
  return {
    ...base,
    status: 'complete',
    reason:
      'accepted public self-check passed, todos are resolved/nonblocking, and early runnable/check phase gate is complete',
  };
}

function unresolvedTodoIdsFrom(todos: HeavyTaskTodoState | undefined): string[] {
  if (!todos) return [];
  return todos.items.filter((item) => !isResolvedOrNonblockingTodo(item)).map((item) => item.id);
}

function nonblockingTodoIdsFrom(todos: HeavyTaskTodoState | undefined): string[] {
  if (!todos) return [];
  return todos.items.filter(isNonblockingTodo).map((item) => item.id);
}

function isResolvedOrNonblockingTodo(item: HeavyTaskTodoItem): boolean {
  return item.status === 'completed' || isNonblockingTodo(item);
}

function isNonblockingTodo(item: HeavyTaskTodoItem): boolean {
  return (
    item.status === 'cancelled' &&
    typeof item.evidence === 'string' &&
    item.evidence.trim().length > 0
  );
}

function missingPhaseGateKindsFrom(todos: HeavyTaskTodoState): HeavyTaskPhaseGateKind[] {
  return REQUIRED_PHASE_GATE_KINDS.filter(
    (kind) => !todos.items.some((item) => item.kind === kind && item.status === 'completed'),
  );
}

function classifyCapKind(
  input: HeavyTaskCompletionInput,
  reason: string | undefined,
): HeavyTaskRuntimeCapKind {
  const haystack = [
    input.status,
    input.taxonomy,
    input.error?.class,
    input.error?.message,
    reason,
    ...decisionReasons(input.decisions),
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ')
    .toLowerCase();

  if (
    haystack.includes('incomplete_tool_calls') ||
    haystack.includes('tool_step_cap') ||
    haystack.includes('tool_call_step') ||
    haystack.includes('tool call step')
  ) {
    return 'tool_call_step_cap';
  }
  if (
    haystack.includes('max_tokens') ||
    haystack.includes('max token') ||
    haystack.includes('token cap') ||
    haystack.includes('truncated')
  ) {
    return 'token_cap';
  }
  if (
    haystack.includes('runtime step cap') ||
    haystack.includes('max_steps') ||
    haystack.includes('max steps')
  ) {
    return 'runtime_step_cap';
  }
  if (
    haystack.includes('wall time cap') ||
    haystack.includes('wall-time cap') ||
    haystack.includes('wall_time')
  ) {
    return 'wall_time_cap';
  }
  if (haystack.includes('max attempts') || haystack.includes('max_attempts')) {
    return 'max_attempts';
  }
  if (
    haystack.includes('timeout') ||
    haystack.includes('timed out') ||
    haystack.includes('timed_out')
  ) {
    return 'timeout';
  }
  if (
    input.status === 'budget_exhausted' ||
    input.taxonomy === 'budget_exhausted' ||
    haystack.includes('budget exhausted')
  ) {
    return 'budget_exhausted';
  }
  if (input.status === 'incomplete' || input.taxonomy === 'agent_incomplete') {
    return 'unknown_cap';
  }
  if (
    haystack.includes('tool_calls') ||
    haystack.includes('tool calls') ||
    haystack.includes('budget') ||
    haystack.includes('limit')
  ) {
    return 'unknown_cap';
  }
  return 'none';
}

function runtimeReason(input: HeavyTaskCompletionInput): string | undefined {
  const decisionReason = [...(input.decisions ?? [])]
    .reverse()
    .find((decision) => decision.reason)?.reason;
  return input.error?.message ?? decisionReason;
}

function decisionReasons(decisions: readonly AutonomousDecision[] | undefined): string[] {
  return (decisions ?? [])
    .map((decision) => decision.reason)
    .filter((reason): reason is string => typeof reason === 'string');
}

function finalizationIneligibleReason(
  runtime: HeavyTaskCompletionStatus['runtime'],
  semantic: HeavyTaskCompletionStatus['semantic'],
): string {
  if (semantic.status !== 'complete') return 'semantic completion evidence is incomplete';
  if (!runtime.capLike) return 'runtime outcome is not cap-like';
  return 'finalization is not eligible';
}
