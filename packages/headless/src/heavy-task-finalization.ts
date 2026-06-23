import { isAcceptedHeavyTaskSelfCheck } from './heavy-task-self-check.js';
import type {
  AutonomousDecision,
  AutonomousResultTaxonomy,
  HeavyTaskCompactEvidenceEnvelope,
  HeavyTaskEngineeringRecord,
  HeavyTaskModeFacts,
  HeavyTaskSelfCheckStatus,
  HeavyTaskSemanticSelfCheckState,
  HeavyTaskTodoItem,
  HeavyTaskTodoState,
  TaskRunError,
  TaskRunStatus,
} from './task-contracts.js';

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

export type HeavyTaskEvidenceChainOutcome =
  | 'complete'
  | 'nonblocking'
  | 'failed'
  | 'missing'
  | 'inconclusive';

export interface HeavyTaskEvidenceChainItem {
  id: string;
  kind:
    | 'todo'
    | 'self_check'
    | 'targeted_check'
    | 'patch'
    | 'repair'
    | 'artifact'
    | 'compact_evidence'
    | 'nonblocking_rationale';
  required: boolean;
  outcome: HeavyTaskEvidenceChainOutcome;
  reason: string;
  todoIds: string[];
  evidenceIds: string[];
  checkIds: string[];
  artifactIds: string[];
  recordIds: string[];
}

export interface HeavyTaskEvidenceChainSummary {
  schemaVersion: 1;
  outcome: HeavyTaskEvidenceChainOutcome;
  completeItemIds: string[];
  nonblockingItemIds: string[];
  failedItemIds: string[];
  missingItemIds: string[];
  inconclusiveItemIds: string[];
  items: HeavyTaskEvidenceChainItem[];
}

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
    evidenceChain: HeavyTaskEvidenceChainSummary;
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
  latestHeavyTaskSelfCheck?: HeavyTaskSemanticSelfCheckState;
  heavyTaskEvidence?: readonly HeavyTaskCompactEvidenceEnvelope[];
  heavyTaskEngineeringRecords?: readonly HeavyTaskEngineeringRecord[];
  decisions?: readonly AutonomousDecision[];
}

export function evaluateHeavyTaskCompletionStatus(input: HeavyTaskCompletionInput): HeavyTaskCompletionStatus {
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

function runtimeStatusFromInput(input: HeavyTaskCompletionInput): HeavyTaskCompletionStatus['runtime'] {
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

function semanticStatusFromInput(input: HeavyTaskCompletionInput): HeavyTaskCompletionStatus['semantic'] {
  const selfCheck = input.latestHeavyTaskSelfCheck;
  const todos = input.latestHeavyTaskTodos;
  const unresolvedTodoIds = unresolvedTodoIdsFrom(todos);
  const nonblockingTodoIds = nonblockingTodoIdsFrom(todos);
  const evidenceChain = evaluateEvidenceChain(input);
  const base = {
    advisory: true as const,
    ...(selfCheck ? { selfCheckId: selfCheck.selfCheckId, selfCheckStatus: selfCheck.status } : {}),
    ...(todos ? { todoSetId: todos.todoSetId } : {}),
    unresolvedTodoIds,
    nonblockingTodoIds,
    evidenceChain,
  };

  if (input.heavyTaskMode?.enabled !== true) {
    return { ...base, status: 'incomplete', reason: 'heavy-task mode is not enabled' };
  }
  if (evidenceChain.outcome !== 'complete') {
    return { ...base, status: 'incomplete', reason: semanticReasonForEvidenceChain(evidenceChain.outcome) };
  }
  return {
    ...base,
    status: 'complete',
    reason: 'accepted public self-check passed and required evidence chain is complete',
  };
}

function evaluateEvidenceChain(input: HeavyTaskCompletionInput): HeavyTaskEvidenceChainSummary {
  const index = buildEvidenceIndex(input);
  const items: HeavyTaskEvidenceChainItem[] = [];

  items.push(evaluateSelfCheckItem(input, index));

  const todos = input.latestHeavyTaskTodos;
  if (!todos) {
    items.push(chainItem({
      id: 'todo:latest',
      kind: 'todo',
      required: true,
      outcome: 'missing',
      reason: 'missing latest heavy-task todos',
    }));
  } else if (todos.items.length === 0) {
    items.push(chainItem({
      id: `todo_set:${todos.todoSetId}`,
      kind: 'todo',
      required: true,
      outcome: 'missing',
      reason: 'latest heavy-task todos are empty',
    }));
  } else {
    for (const todo of todos.items) items.push(evaluateTodoItem(todo, index));
  }

  for (const record of input.heavyTaskEngineeringRecords ?? []) {
    const item = evaluateEngineeringRecordItem(record, input, index);
    if (item) items.push(item);
    items.push(...missingRecordLinkItems(record, input, index));
  }

  return summarizeEvidenceChain(dedupeChainItems(items));
}

function evaluateSelfCheckItem(
  input: HeavyTaskCompletionInput,
  index: EvidenceIndex,
): HeavyTaskEvidenceChainItem {
  const selfCheck = input.latestHeavyTaskSelfCheck;
  if (!selfCheck) {
    return chainItem({
      id: 'self_check:latest',
      kind: 'self_check',
      required: true,
      outcome: 'missing',
      reason: 'missing accepted public self-check evidence',
    });
  }
  const evidenceIds = index.evidenceIdsByCheckId.get(selfCheck.selfCheckId) ?? [];
  if (!isAcceptedHeavyTaskSelfCheck(selfCheck)) {
    return chainItem({
      id: `self_check:${selfCheck.selfCheckId}`,
      kind: 'self_check',
      required: true,
      outcome: 'missing',
      reason: 'latest self-check evidence was not accepted as public',
      evidenceIds,
      checkIds: [selfCheck.selfCheckId],
    });
  }
  if (selfCheck.status === 'fail') {
    return chainItem({
      id: `self_check:${selfCheck.selfCheckId}`,
      kind: 'self_check',
      required: true,
      outcome: 'failed',
      reason: 'latest accepted public self-check failed',
      evidenceIds,
      checkIds: [selfCheck.selfCheckId],
    });
  }
  if (selfCheck.status === 'inconclusive') {
    return chainItem({
      id: `self_check:${selfCheck.selfCheckId}`,
      kind: 'self_check',
      required: true,
      outcome: 'inconclusive',
      reason: 'latest accepted public self-check was inconclusive',
      evidenceIds,
      checkIds: [selfCheck.selfCheckId],
    });
  }
  return chainItem({
    id: `self_check:${selfCheck.selfCheckId}`,
    kind: 'self_check',
    required: true,
    outcome: 'complete',
    reason: 'latest accepted public self-check passed',
    evidenceIds,
    checkIds: [selfCheck.selfCheckId],
  });
}

function evaluateTodoItem(todo: HeavyTaskTodoItem, index: EvidenceIndex): HeavyTaskEvidenceChainItem {
  const support = supportForTodo(todo.id, index);
  if (todo.status === 'completed') {
    if (support.evidenceIds.length === 0 && support.recordIds.length === 0 && support.checkIds.length === 0 && support.artifactIds.length === 0) {
      return chainItem({
        id: `todo:${todo.id}`,
        kind: 'todo',
        required: true,
        outcome: 'missing',
        reason: 'completed todo has no linked compact evidence, patch, targeted check, or engineering record support',
        todoIds: [todo.id],
      });
    }
    return chainItem({
      id: `todo:${todo.id}`,
      kind: 'todo',
      required: true,
      outcome: 'complete',
      reason: 'completed todo has linked public evidence-chain support',
      todoIds: [todo.id],
      evidenceIds: support.evidenceIds,
      checkIds: support.checkIds,
      artifactIds: support.artifactIds,
      recordIds: support.recordIds,
    });
  }
  if (todo.status === 'cancelled') {
    if (hasNonblockingTodoEvidence(todo, index)) {
      return chainItem({
        id: `todo:${todo.id}`,
        kind: 'todo',
        required: false,
        outcome: 'nonblocking',
        reason: 'cancelled todo has public rationale and durable nonblocking support',
        todoIds: [todo.id],
        evidenceIds: support.evidenceIds,
        checkIds: support.checkIds,
        artifactIds: support.artifactIds,
        recordIds: support.recordIds,
      });
    }
    return chainItem({
      id: `todo:${todo.id}`,
      kind: 'todo',
      required: true,
      outcome: 'missing',
      reason: 'cancelled todo is missing public rationale or durable nonblocking support',
      todoIds: [todo.id],
      evidenceIds: support.evidenceIds,
      checkIds: support.checkIds,
      artifactIds: support.artifactIds,
      recordIds: support.recordIds,
    });
  }
  return chainItem({
    id: `todo:${todo.id}`,
    kind: 'todo',
    required: true,
    outcome: 'missing',
    reason: `todo status ${todo.status} is unresolved`,
    todoIds: [todo.id],
    evidenceIds: support.evidenceIds,
    checkIds: support.checkIds,
    artifactIds: support.artifactIds,
    recordIds: support.recordIds,
  });
}

function evaluateEngineeringRecordItem(
  record: HeavyTaskEngineeringRecord,
  input: HeavyTaskCompletionInput,
  index: EvidenceIndex,
): HeavyTaskEvidenceChainItem | undefined {
  const required = recordRequired(record, input.latestHeavyTaskTodos, index);
  if (record.kind === 'targeted_check') return evaluateTargetedCheckItem(record, input, index, required);
  if (record.kind === 'patch') return evaluatePatchItem(record, required);
  if (record.kind === 'repair') return evaluateRepairItem(record, required);
  return undefined;
}

function evaluateTargetedCheckItem(
  record: HeavyTaskEngineeringRecord,
  input: HeavyTaskCompletionInput,
  index: EvidenceIndex,
  required: boolean,
): HeavyTaskEvidenceChainItem {
  const checkId = record.targetedCheck?.checkId;
  const base = recordChainRefs(record, index);
  const id = `targeted_check:${checkId ?? record.recordId}`;
  if (record.completeness !== 'complete') {
    return chainItem({
      id,
      kind: 'targeted_check',
      required,
      outcome: required ? 'missing' : 'nonblocking',
      reason: record.incompleteReason ?? 'targeted check record is incomplete',
      ...base,
    });
  }
  if (record.status === 'failed' || record.targetedCheck?.result === 'fail') {
    if (isFailedCheckRepaired(record, input)) {
      return chainItem({
        id,
        kind: 'targeted_check',
        required,
        outcome: 'complete',
        reason: 'failed targeted check was followed by complete repair and later passing evidence',
        ...base,
      });
    }
    return chainItem({
      id,
      kind: 'targeted_check',
      required,
      outcome: required ? 'failed' : 'nonblocking',
      reason: 'targeted check failed',
      ...base,
    });
  }
  if (record.targetedCheck?.result === 'inconclusive') {
    return chainItem({
      id,
      kind: 'targeted_check',
      required,
      outcome: required ? 'inconclusive' : 'nonblocking',
      reason: 'targeted check was inconclusive',
      ...base,
    });
  }
  return chainItem({
    id,
    kind: 'targeted_check',
    required,
    outcome: 'complete',
    reason: 'targeted check passed',
    ...base,
  });
}

function evaluatePatchItem(record: HeavyTaskEngineeringRecord, required: boolean): HeavyTaskEvidenceChainItem {
  const hasMutationSupport = record.links.evidenceIds.length > 0
    || record.links.artifactIds.length > 0
    || record.links.changedFiles.length > 0
    || (record.patch?.mutationEvidenceIds.length ?? 0) > 0
    || (record.patch?.changedFiles.length ?? 0) > 0;
  const outcome: HeavyTaskEvidenceChainOutcome = record.completeness !== 'complete' || !hasMutationSupport
    ? (required ? 'missing' : 'nonblocking')
    : record.status === 'failed'
      ? (required ? 'failed' : 'nonblocking')
      : 'complete';
  return chainItem({
    id: `patch:${record.patch?.patchId ?? record.recordId}`,
    kind: 'patch',
    required,
    outcome,
    reason: outcome === 'complete'
      ? 'patch record has mutation evidence'
      : record.incompleteReason ?? 'patch record is missing mutation evidence',
    ...recordChainRefs(record),
  });
}

function evaluateRepairItem(record: HeavyTaskEngineeringRecord, required: boolean): HeavyTaskEvidenceChainItem {
  const repairOutcome = record.repair?.outcome;
  const outcome: HeavyTaskEvidenceChainOutcome = record.completeness !== 'complete'
    ? (required ? 'missing' : 'nonblocking')
    : repairOutcome === 'check_passed' || record.status === 'repaired'
      ? 'complete'
      : repairOutcome === 'check_failed'
        ? (required ? 'failed' : 'nonblocking')
        : (required ? 'inconclusive' : 'nonblocking');
  return chainItem({
    id: `repair:${record.recordId}`,
    kind: 'repair',
    required,
    outcome,
    reason: outcome === 'complete' ? 'repair record links a passing follow-up check' : record.incompleteReason ?? 'repair record lacks passing follow-up evidence',
    ...recordChainRefs(record),
  });
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
  return item.status === 'cancelled' && typeof item.evidence === 'string' && item.evidence.trim().length > 0;
}

interface EvidenceIndex {
  evidenceById: Map<string, HeavyTaskCompactEvidenceEnvelope>;
  evidenceIdsByTodoId: Map<string, string[]>;
  evidenceIdsByCheckId: Map<string, string[]>;
  evidenceIdsByArtifactId: Map<string, string[]>;
  recordsByTodoId: Map<string, HeavyTaskEngineeringRecord[]>;
  recordsByCheckId: Map<string, HeavyTaskEngineeringRecord[]>;
  compactArtifactIds: Set<string>;
}

function buildEvidenceIndex(input: HeavyTaskCompletionInput): EvidenceIndex {
  const index: EvidenceIndex = {
    evidenceById: new Map(),
    evidenceIdsByTodoId: new Map(),
    evidenceIdsByCheckId: new Map(),
    evidenceIdsByArtifactId: new Map(),
    recordsByTodoId: new Map(),
    recordsByCheckId: new Map(),
    compactArtifactIds: new Set(),
  };
  for (const evidence of input.heavyTaskEvidence ?? []) {
    if (isOfficialVerifierArtifactEvidence(evidence)) continue;
    index.evidenceById.set(evidence.evidenceId, evidence);
    if (isDirectTodoSupportEvidence(evidence)) {
      for (const todoId of evidence.links?.todoIds ?? []) addToMapList(index.evidenceIdsByTodoId, todoId, evidence.evidenceId);
    }
    for (const checkId of compactEvidenceCheckIds(evidence)) addToMapList(index.evidenceIdsByCheckId, checkId, evidence.evidenceId);
    for (const artifactId of compactEvidenceArtifactIds(evidence)) {
      addToMapList(index.evidenceIdsByArtifactId, artifactId, evidence.evidenceId);
      index.compactArtifactIds.add(artifactId);
    }
  }
  for (const record of input.heavyTaskEngineeringRecords ?? []) {
    for (const todoId of record.links.todoIds) addToMapList(index.recordsByTodoId, todoId, record);
    for (const checkId of recordCheckIds(record)) addToMapList(index.recordsByCheckId, checkId, record);
  }
  return index;
}

function isDirectTodoSupportEvidence(evidence: HeavyTaskCompactEvidenceEnvelope): boolean {
  return evidence.kind !== 'artifact';
}

function isOfficialVerifierArtifactEvidence(evidence: HeavyTaskCompactEvidenceEnvelope): boolean {
  if (evidence.artifact?.authority?.authoritative === true) return true;
  const source = evidence.artifact?.authority?.source.toLowerCase();
  return source === 'official_harbor_verifier'
    || source === 'official_verifier'
    || source === 'verifier'
    || source === 'scorer';
}

function supportForTodo(todoId: string, index: EvidenceIndex): {
  evidenceIds: string[];
  checkIds: string[];
  artifactIds: string[];
  recordIds: string[];
} {
  const records = index.recordsByTodoId.get(todoId) ?? [];
  const evidenceIds = new Set(index.evidenceIdsByTodoId.get(todoId) ?? []);
  const checkIds = new Set<string>();
  const artifactIds = new Set<string>();
  const recordIds = new Set<string>();
  for (const record of records) {
    if (!recordSupportsTodo(record)) continue;
    recordIds.add(record.recordId);
    for (const evidenceId of record.links.evidenceIds) evidenceIds.add(evidenceId);
    for (const artifactId of record.links.artifactIds) artifactIds.add(artifactId);
    for (const checkId of recordCheckIds(record)) checkIds.add(checkId);
    for (const evidenceId of record.patch?.mutationEvidenceIds ?? []) evidenceIds.add(evidenceId);
  }
  for (const artifactId of artifactIds) {
    for (const evidenceId of index.evidenceIdsByArtifactId.get(artifactId) ?? []) evidenceIds.add(evidenceId);
  }
  for (const checkId of checkIds) {
    for (const evidenceId of index.evidenceIdsByCheckId.get(checkId) ?? []) evidenceIds.add(evidenceId);
  }
  return {
    evidenceIds: sorted([...evidenceIds].filter((id) => index.evidenceById.has(id))),
    checkIds: sorted([...checkIds]),
    artifactIds: sorted([...artifactIds]),
    recordIds: sorted([...recordIds]),
  };
}

function hasNonblockingTodoEvidence(todo: HeavyTaskTodoItem, index: EvidenceIndex): boolean {
  if (!isNonblockingTodo(todo)) return false;
  const support = supportForTodo(todo.id, index);
  if (support.evidenceIds.length > 0 || support.artifactIds.length > 0) return true;
  const records = index.recordsByTodoId.get(todo.id) ?? [];
  return records.some((record) => {
    if (record.completeness !== 'complete') return false;
    if (record.status === 'abandoned' || record.status === 'superseded') return true;
    if (record.kind === 'targeted_check' && (record.targetedCheck?.result === 'fail' || record.targetedCheck?.result === 'inconclusive')) return true;
    return false;
  });
}

function recordSupportsTodo(record: HeavyTaskEngineeringRecord): boolean {
  if (record.completeness !== 'complete') return false;
  if (record.status === 'failed' || record.status === 'running' || record.status === 'proposed' || record.status === 'abandoned') return false;
  if (record.kind === 'targeted_check') return record.targetedCheck?.result === 'pass';
  if (record.kind === 'repair') return record.repair?.outcome === 'check_passed' || record.status === 'repaired';
  if (record.kind === 'patch') {
    return record.links.evidenceIds.length > 0
      || record.links.artifactIds.length > 0
      || record.links.changedFiles.length > 0
      || (record.patch?.mutationEvidenceIds.length ?? 0) > 0
      || (record.patch?.changedFiles.length ?? 0) > 0;
  }
  return record.links.evidenceIds.length > 0;
}

function recordRequired(
  record: HeavyTaskEngineeringRecord,
  todos: HeavyTaskTodoState | undefined,
  index: EvidenceIndex,
): boolean {
  if (record.links.todoIds.length === 0) return false;
  const todoById = new Map((todos?.items ?? []).map((todo) => [todo.id, todo]));
  return record.links.todoIds.some((todoId) => {
    const todo = todoById.get(todoId);
    return !todo || todo.status !== 'cancelled' || !hasNonblockingTodoEvidence(todo, index);
  });
}

function isFailedCheckRepaired(record: HeavyTaskEngineeringRecord, input: HeavyTaskCompletionInput): boolean {
  const checkId = record.targetedCheck?.checkId;
  if (!checkId) return false;
  const records = [...(input.heavyTaskEngineeringRecords ?? [])].sort((a, b) => a.ts - b.ts);
  const repair = records.find((candidate) =>
    candidate.ts > record.ts
    && candidate.kind === 'repair'
    && candidate.completeness === 'complete'
    && candidate.repair?.outcome === 'check_passed'
    && candidate.repair.failedCheckIds.includes(checkId)
  );
  if (!repair) return false;
  const repairedTodoIds = new Set(record.links.todoIds);
  const laterPassingCheck = records.some((candidate) =>
    candidate.ts > repair.ts
    && candidate.kind === 'targeted_check'
    && candidate.completeness === 'complete'
    && candidate.targetedCheck?.result === 'pass'
    && candidate.links.todoIds.some((todoId) => repairedTodoIds.has(todoId))
  );
  const laterSelfCheck = input.latestHeavyTaskSelfCheck
    && isAcceptedHeavyTaskSelfCheck(input.latestHeavyTaskSelfCheck)
    && input.latestHeavyTaskSelfCheck.status === 'pass'
    && input.latestHeavyTaskSelfCheck.ts > repair.ts;
  return Boolean(laterPassingCheck || laterSelfCheck);
}

function missingRecordLinkItems(
  record: HeavyTaskEngineeringRecord,
  input: HeavyTaskCompletionInput,
  index: EvidenceIndex,
): HeavyTaskEvidenceChainItem[] {
  const items: HeavyTaskEvidenceChainItem[] = [];
  const required = recordRequired(record, input.latestHeavyTaskTodos, index);
  for (const evidenceId of record.links.evidenceIds) {
    if (index.evidenceById.has(evidenceId)) continue;
    items.push(chainItem({
      id: `compact_evidence:${record.recordId}:${evidenceId}`,
      kind: 'compact_evidence',
      required,
      outcome: required ? 'missing' : 'nonblocking',
      reason: 'engineering record references compact evidence that is not present in projection',
      todoIds: record.links.todoIds,
      evidenceIds: [evidenceId],
      checkIds: recordCheckIds(record),
      recordIds: [record.recordId],
    }));
  }
  for (const artifactId of record.links.artifactIds) {
    if (index.compactArtifactIds.has(artifactId)) continue;
    items.push(chainItem({
      id: `artifact:${record.recordId}:${artifactId}`,
      kind: 'artifact',
      required,
      outcome: required ? 'missing' : 'nonblocking',
      reason: 'engineering record references artifact evidence that is not present in projection',
      todoIds: record.links.todoIds,
      artifactIds: [artifactId],
      checkIds: recordCheckIds(record),
      recordIds: [record.recordId],
    }));
  }
  return items;
}

function recordChainRefs(record: HeavyTaskEngineeringRecord, index?: EvidenceIndex): Pick<HeavyTaskEvidenceChainItem, 'todoIds' | 'evidenceIds' | 'checkIds' | 'artifactIds' | 'recordIds'> {
  const evidenceIds = new Set(record.links.evidenceIds);
  for (const evidenceId of record.patch?.mutationEvidenceIds ?? []) evidenceIds.add(evidenceId);
  for (const checkId of recordCheckIds(record)) {
    for (const evidenceId of index?.evidenceIdsByCheckId.get(checkId) ?? []) evidenceIds.add(evidenceId);
  }
  return {
    todoIds: sorted(record.links.todoIds),
    evidenceIds: sorted([...evidenceIds].filter((id) => !index || index.evidenceById.has(id))),
    checkIds: sorted(recordCheckIds(record)),
    artifactIds: sorted(record.links.artifactIds),
    recordIds: [record.recordId],
  };
}

function recordCheckIds(record: HeavyTaskEngineeringRecord): string[] {
  return sorted([
    ...record.links.checkIds,
    ...(record.targetedCheck?.checkId ? [record.targetedCheck.checkId] : []),
    ...(record.repair?.failedCheckIds ?? []),
  ]);
}

function compactEvidenceCheckIds(evidence: HeavyTaskCompactEvidenceEnvelope): string[] {
  return sorted([
    ...(evidence.links?.checkIds ?? []),
    ...(evidence.check?.checkId ? [evidence.check.checkId] : []),
    ...(evidence.check?.linkedSelfCheckId ? [evidence.check.linkedSelfCheckId] : []),
  ]);
}

function compactEvidenceArtifactIds(evidence: HeavyTaskCompactEvidenceEnvelope): string[] {
  return sorted([
    ...(evidence.links?.artifactIds ?? []),
    ...(evidence.artifact?.artifactId ? [evidence.artifact.artifactId] : []),
    ...(evidence.artifact?.path ? [evidence.artifact.path] : []),
    ...(evidence.artifact?.workspacePath ? [evidence.artifact.workspacePath] : []),
  ]);
}

function summarizeEvidenceChain(items: HeavyTaskEvidenceChainItem[]): HeavyTaskEvidenceChainSummary {
  const failedItemIds = itemIdsByOutcome(items, 'failed');
  const missingItemIds = itemIdsByOutcome(items, 'missing');
  const inconclusiveItemIds = itemIdsByOutcome(items, 'inconclusive');
  const requiredFailed = items.some((item) => item.required && item.outcome === 'failed');
  const requiredMissing = items.some((item) => item.required && item.outcome === 'missing');
  const requiredInconclusive = items.some((item) => item.required && item.outcome === 'inconclusive');
  const outcome: HeavyTaskEvidenceChainOutcome = requiredFailed
    ? 'failed'
    : requiredMissing
      ? 'missing'
      : requiredInconclusive
        ? 'inconclusive'
        : 'complete';
  return {
    schemaVersion: 1,
    outcome,
    completeItemIds: itemIdsByOutcome(items, 'complete'),
    nonblockingItemIds: itemIdsByOutcome(items, 'nonblocking'),
    failedItemIds,
    missingItemIds,
    inconclusiveItemIds,
    items,
  };
}

function itemIdsByOutcome(items: readonly HeavyTaskEvidenceChainItem[], outcome: HeavyTaskEvidenceChainOutcome): string[] {
  return items.filter((item) => item.outcome === outcome).map((item) => item.id);
}

function semanticReasonForEvidenceChain(outcome: HeavyTaskEvidenceChainOutcome): string {
  if (outcome === 'failed') return 'required evidence chain contains failed evidence';
  if (outcome === 'missing') return 'required evidence chain is missing evidence';
  if (outcome === 'inconclusive') return 'required evidence chain is inconclusive';
  return 'required evidence chain is incomplete';
}

function chainItem(input: {
  id: string;
  kind: HeavyTaskEvidenceChainItem['kind'];
  required: boolean;
  outcome: HeavyTaskEvidenceChainOutcome;
  reason: string;
  todoIds?: string[];
  evidenceIds?: string[];
  checkIds?: string[];
  artifactIds?: string[];
  recordIds?: string[];
}): HeavyTaskEvidenceChainItem {
  return {
    id: input.id,
    kind: input.kind,
    required: input.required,
    outcome: input.outcome,
    reason: input.reason,
    todoIds: sorted(input.todoIds ?? []),
    evidenceIds: sorted(input.evidenceIds ?? []),
    checkIds: sorted(input.checkIds ?? []),
    artifactIds: sorted(input.artifactIds ?? []),
    recordIds: sorted(input.recordIds ?? []),
  };
}

function dedupeChainItems(items: HeavyTaskEvidenceChainItem[]): HeavyTaskEvidenceChainItem[] {
  const seen = new Set<string>();
  const deduped: HeavyTaskEvidenceChainItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
  }
  return deduped;
}

function addToMapList<T>(map: Map<string, T[]>, key: string, value: T): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function sorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function classifyCapKind(input: HeavyTaskCompletionInput, reason: string | undefined): HeavyTaskRuntimeCapKind {
  const haystack = [
    input.status,
    input.taxonomy,
    input.error?.class,
    input.error?.message,
    reason,
    ...decisionReasons(input.decisions),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0).join(' ').toLowerCase();

  if (haystack.includes('incomplete_tool_calls') || haystack.includes('tool_call_step') || haystack.includes('tool call step')) {
    return 'tool_call_step_cap';
  }
  if (haystack.includes('max_tokens') || haystack.includes('max token') || haystack.includes('token cap') || haystack.includes('truncated')) {
    return 'token_cap';
  }
  if (haystack.includes('runtime step cap') || haystack.includes('max_steps') || haystack.includes('max steps')) {
    return 'runtime_step_cap';
  }
  if (haystack.includes('wall time cap') || haystack.includes('wall-time cap') || haystack.includes('wall_time')) {
    return 'wall_time_cap';
  }
  if (haystack.includes('max attempts') || haystack.includes('max_attempts')) {
    return 'max_attempts';
  }
  if (haystack.includes('timeout') || haystack.includes('timed out') || haystack.includes('timed_out')) {
    return 'timeout';
  }
  if (input.status === 'budget_exhausted' || input.taxonomy === 'budget_exhausted' || haystack.includes('budget exhausted')) {
    return 'budget_exhausted';
  }
  if (input.status === 'incomplete' || input.taxonomy === 'agent_incomplete') {
    return 'unknown_cap';
  }
  if (haystack.includes('tool_calls') || haystack.includes('tool calls') || haystack.includes('budget') || haystack.includes('limit')) {
    return 'unknown_cap';
  }
  return 'none';
}

function runtimeReason(input: HeavyTaskCompletionInput): string | undefined {
  const decisionReason = [...(input.decisions ?? [])].reverse().find((decision) => decision.reason)?.reason;
  return input.error?.message ?? decisionReason;
}

function decisionReasons(decisions: readonly AutonomousDecision[] | undefined): string[] {
  return (decisions ?? []).map((decision) => decision.reason).filter((reason): reason is string => typeof reason === 'string');
}

function finalizationIneligibleReason(
  runtime: HeavyTaskCompletionStatus['runtime'],
  semantic: HeavyTaskCompletionStatus['semantic'],
): string {
  if (semantic.status !== 'complete') return 'semantic completion evidence is incomplete';
  if (!runtime.capLike) return 'runtime outcome is not cap-like';
  return 'finalization is not eligible';
}
