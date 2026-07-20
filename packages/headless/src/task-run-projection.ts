import {
  validateExecutionEvidenceRef,
  type ExecutionEvidenceRef,
} from '@maka/core/execution-evidence';
import type { ResultRecord } from './contracts.js';
import { compactArtifactEvidence, compactSelfCheckEvidence } from './heavy-task-evidence.js';
import {
  evaluateHeavyTaskCompletionStatus,
  type HeavyTaskCompletionStatus,
} from './heavy-task-finalization.js';
import { isAcceptedHeavyTaskSelfCheck } from './heavy-task-self-check.js';
import type {
  AutonomousDecision,
  FeedbackObservation,
  HeavyTaskCompactEvidenceEnvelope,
  HeavyTaskSelfCheckPlanState,
  HeavyTaskSelfCheckGateState,
  HeavyTaskSelfCheckFreshnessReason,
  HeavyTaskSelfCheckProjection,
  HeavyTaskWorkspaceObservationState,
  EconomyTaskModeFacts,
  HeavyTaskInventoryState,
  TaskInboxItem,
  HeavyTaskModeFacts,
  HeavyTaskSemanticSelfCheckState,
  HeavyTaskTodoState,
  TaskIsolationFacts,
  TaskPermissionGrant,
  TaskPermissionRequest,
  TaskRunParkedState,
  ScoreResult,
  SelfCheckObservation,
  TaskAttempt,
  TaskRunArtifact,
  TaskEvent,
  TaskRun,
  TaskRunError,
  TaskRunResult,
  ToolExecutorIdentity,
  VerifierResult,
  WorkspaceLeaseFacts,
} from './task-contracts.js';

export interface TaskRunProjection extends TaskRun {
  events: TaskEvent[];
  attempts: TaskAttempt[];
  executionLineage: ExecutionEvidenceRef[];
  selfChecks: SelfCheckObservation[];
  feedback: FeedbackObservation[];
  decisions: AutonomousDecision[];
  artifacts: TaskRunArtifact[];
  verifierResults: VerifierResult[];
  scoreResults: ScoreResult[];
  toolExecutors: ToolExecutorIdentity[];
  permissionGrants: TaskPermissionGrant[];
  permissionRequests: TaskPermissionRequest[];
  inboxItems: TaskInboxItem[];
  warnings: string[];
  latestVerifierResult?: VerifierResult;
  latestScoreResult?: ScoreResult;
  heavyTaskMode?: HeavyTaskModeFacts;
  economyTaskMode?: EconomyTaskModeFacts;
  heavyTaskInventory: HeavyTaskInventoryState[];
  latestHeavyTaskInventory?: HeavyTaskInventoryState;
  heavyTaskTodoStates: HeavyTaskTodoState[];
  latestHeavyTaskTodos?: HeavyTaskTodoState;
  heavyTaskSelfChecks: HeavyTaskSelfCheckProjection[];
  latestHeavyTaskSelfCheck?: HeavyTaskSelfCheckProjection;
  heavyTaskSelfCheckPlans: HeavyTaskSelfCheckPlanState[];
  latestHeavyTaskSelfCheckPlan?: HeavyTaskSelfCheckPlanState;
  heavyTaskSelfCheckGates: HeavyTaskSelfCheckGateState[];
  latestHeavyTaskSelfCheckGate?: HeavyTaskSelfCheckGateState;
  heavyTaskWorkspaceObservations: HeavyTaskWorkspaceObservationState[];
  latestHeavyTaskWorkspaceObservation?: HeavyTaskWorkspaceObservationState;
  heavyTaskEvidence: HeavyTaskCompactEvidenceEnvelope[];
  latestHeavyTaskEvidence?: HeavyTaskCompactEvidenceEnvelope;
  heavyTaskCompletion?: HeavyTaskCompletionStatus;
  isolation?: TaskIsolationFacts;
  workspaceLease?: WorkspaceLeaseFacts;
  parked?: TaskRunParkedState;
  sourceResultRecord?: ResultRecord;
}

export function projectTaskRun(
  events: readonly TaskEvent[],
  taskRunId?: string,
): TaskRunProjection {
  const projectedTaskRunId = taskRunId ?? events[0]?.taskRunId ?? '';
  const projection: TaskRunProjection = {
    taskRunId: projectedTaskRunId,
    taskId: '',
    configId: '',
    status: 'queued',
    events: [],
    attempts: [],
    executionLineage: [],
    selfChecks: [],
    feedback: [],
    decisions: [],
    artifacts: [],
    verifierResults: [],
    scoreResults: [],
    toolExecutors: [],
    permissionGrants: [],
    permissionRequests: [],
    inboxItems: [],
    warnings: [],
    heavyTaskInventory: [],
    heavyTaskTodoStates: [],
    heavyTaskSelfCheckPlans: [],
    heavyTaskSelfChecks: [],
    heavyTaskSelfCheckGates: [],
    heavyTaskWorkspaceObservations: [],
    heavyTaskEvidence: [],
  };
  const attempts = new Map<string, TaskAttempt>();
  const inboxItems = new Map<string, TaskInboxItem>();
  const selfCheckRows = new Map<
    string,
    Array<{ sequence: number; projectionIndex: number; eventId: string }>
  >();
  const workspaceObservationRows = new Map<
    string,
    { sequence: number; observation: HeavyTaskWorkspaceObservationState }
  >();
  let terminalEvents = 0;

  for (let sequence = 0; sequence < events.length; sequence += 1) {
    const event = events[sequence]!;
    if (projectedTaskRunId && event.taskRunId !== projectedTaskRunId) {
      projection.warnings.push(
        `ignored event ${event.id}: taskRunId ${event.taskRunId} does not match ${projectedTaskRunId}`,
      );
      continue;
    }
    projection.events.push(event);

    switch (event.type) {
      case 'task_run_created':
        projection.taskId = event.taskId;
        projection.configId = event.configId;
        projection.status = 'created';
        projection.sourceResultRecord = event.sourceResultRecord;
        break;
      case 'task_run_queued':
        projection.taskId = event.taskId;
        projection.configId = event.configId;
        projection.status = 'queued';
        break;
      case 'task_run_started':
        projection.status = 'running';
        projection.startedAt = event.startedAt ?? event.ts;
        setOptionalRefs(projection, event.sessionId, event.agentRunId);
        break;
      case 'task_run_verifying':
        projection.status = 'verifying';
        break;
      case 'task_attempt_started': {
        const previous = attempts.get(event.attemptId);
        const attempt: TaskAttempt = {
          attemptId: event.attemptId,
          taskRunId: event.taskRunId,
          startedAt: event.startedAt ?? event.ts,
          status: 'running',
          ...(event.sessionId ? { sessionId: event.sessionId } : {}),
          ...(event.agentRunId ? { agentRunId: event.agentRunId } : {}),
          executionLineage: previous?.executionLineage ?? [],
        };
        attempts.set(event.attemptId, attempt);
        setOptionalRefs(projection, event.sessionId, event.agentRunId);
        break;
      }
      case 'task_attempt_execution_linked': {
        const evidence = validTaskAttemptExecutionEvidence(event, projection.warnings);
        if (!evidence) break;
        projection.executionLineage.push(evidence);
        const previous = attempts.get(event.attemptId);
        attempts.set(event.attemptId, {
          ...(previous ?? {
            attemptId: event.attemptId,
            taskRunId: event.taskRunId,
            startedAt: event.ts,
            status: 'running',
            executionLineage: [],
          }),
          ...(evidence.execution?.sessionId ? { sessionId: evidence.execution.sessionId } : {}),
          ...(!previous?.agentRunId && evidence.execution?.agentRunId
            ? { agentRunId: evidence.execution.agentRunId }
            : {}),
          executionLineage: [...(previous?.executionLineage ?? []), evidence],
        });
        if (!projection.sessionId && evidence.execution?.sessionId) {
          projection.sessionId = evidence.execution.sessionId;
        }
        if (!projection.agentRunId && evidence.execution?.agentRunId) {
          projection.agentRunId = evidence.execution.agentRunId;
        }
        break;
      }
      case 'self_check_observed':
        projection.selfChecks.push(event.observation);
        break;
      case 'feedback_observed':
        projection.feedback.push(event.observation);
        break;
      case 'autonomous_decision_recorded':
        projection.decisions.push(event.decision);
        break;
      case 'verifier_result_recorded':
        projection.verifierResults.push(event.result);
        projection.latestVerifierResult = event.result;
        break;
      case 'task_run_artifact_recorded':
        projection.artifacts.push(event.artifact);
        if (
          projection.heavyTaskMode?.enabled === true &&
          isCompactEvidenceEligibleArtifact(event.artifact)
        ) {
          appendCompactEvidence(
            projection,
            compactArtifactEvidence({
              evidenceId: `${event.id}:compact-artifact`,
              taskRunId: projection.taskRunId,
              ...(event.artifact.attemptId ? { attemptId: event.artifact.attemptId } : {}),
              ts: event.ts,
              source: {
                kind: 'model_tool',
                toolCallId: `task-run-artifact:${event.id}`,
                toolName: 'artifact',
              },
              artifact: event.artifact,
            }),
          );
        }
        break;
      case 'score_result_recorded':
        projection.scoreResults.push(event.result);
        projection.latestScoreResult = event.result;
        projection.result = resultFromScore(event.result, projection.latestVerifierResult);
        break;
      case 'heavy_task_mode_recorded':
        projection.heavyTaskMode = event.facts;
        break;
      case 'economy_task_mode_recorded':
        projection.economyTaskMode = event.facts;
        break;
      case 'heavy_task_inventory_recorded':
        projection.heavyTaskInventory.push(event.inventory);
        projection.latestHeavyTaskInventory = event.inventory;
        break;
      case 'heavy_task_todos_recorded':
        projection.heavyTaskTodoStates.push(event.todos);
        projection.latestHeavyTaskTodos = event.todos;
        break;
      case 'heavy_task_self_check_plan_recorded':
        projection.heavyTaskSelfCheckPlans.push(event.plan);
        projection.latestHeavyTaskSelfCheckPlan = event.plan;
        break;
      case 'heavy_task_self_check_recorded':
        if (isAcceptedHeavyTaskSelfCheck(event.selfCheck)) {
          const projectedSelfCheck: HeavyTaskSelfCheckProjection = {
            ...event.selfCheck,
            freshness: 'unknown',
            freshnessReasons: ['source_binding_missing'],
          };
          const projectionIndex = projection.heavyTaskSelfChecks.push(projectedSelfCheck) - 1;
          selfCheckRows.set(event.selfCheck.selfCheckId, [
            ...(selfCheckRows.get(event.selfCheck.selfCheckId) ?? []),
            { sequence, projectionIndex, eventId: event.id },
          ]);
          projection.latestHeavyTaskSelfCheck = projectedSelfCheck;
          appendCompactEvidence(
            projection,
            ...compactSelfCheckEvidence({
              selfCheck: event.selfCheck,
              newId: selfCheckEvidenceIdFactory(event.selfCheck.selfCheckId),
            }),
          );
        } else {
          projection.warnings.push(
            `ignored heavy-task self-check ${event.selfCheck.selfCheckId}: source guard did not accept public evidence`,
          );
        }
        break;
      case 'heavy_task_self_check_evidence_linked': {
        const rows = selfCheckRows.get(event.selfCheckId) ?? [];
        if (rows.length !== 1) {
          const reason = rows.length === 0 ? 'was not recorded first' : 'is ambiguous';
          projection.warnings.push(
            `ignored self-check evidence link ${event.id}: Self-check ${event.selfCheckId} ${reason}`,
          );
          break;
        }
        const row = rows[0]!;
        const selfCheck = projection.heavyTaskSelfChecks[row.projectionIndex]!;
        if (selfCheck.provenance) {
          projection.warnings.push(
            `ignored self-check evidence link ${event.id}: Self-check ${event.selfCheckId} is already linked`,
          );
          break;
        }
        const observationRow = workspaceObservationRows.get(event.workspaceObservationId);
        const provenance = validHeavyTaskSelfCheckProvenance(
          event,
          selfCheck,
          row.sequence,
          row.eventId,
          observationRow,
          projection.warnings,
        );
        if (!provenance) break;
        projection.heavyTaskSelfChecks[row.projectionIndex] = {
          ...selfCheck,
          provenance,
          workspaceObservationId: event.workspaceObservationId,
        };
        break;
      }
      case 'heavy_task_self_check_gate_recorded':
        projection.heavyTaskSelfCheckGates.push(event.gate);
        projection.latestHeavyTaskSelfCheckGate = event.gate;
        break;
      case 'heavy_task_workspace_observation_recorded':
        projection.heavyTaskWorkspaceObservations.push(event.observation);
        projection.latestHeavyTaskWorkspaceObservation = event.observation;
        workspaceObservationRows.set(event.observation.observationId, {
          sequence,
          observation: event.observation,
        });
        break;
      case 'heavy_task_evidence_recorded':
        if (!appendCompactEvidence(projection, event.evidence)) {
          projection.warnings.push(
            `ignored heavy-task evidence ${event.evidence.evidenceId}: evidence must be public and match taskRunId`,
          );
        }
        break;
      case 'heavy_task_evidence_provenance_linked': {
        const matchingIndexes = projection.heavyTaskEvidence.flatMap((item, index) =>
          item.evidenceId === event.evidenceId ? [index] : [],
        );
        if (matchingIndexes.length !== 1) {
          const reason = matchingIndexes.length === 0 ? 'was not recorded first' : 'is ambiguous';
          projection.warnings.push(
            `ignored evidence provenance ${event.id}: evidence ${event.evidenceId} ${reason}`,
          );
          break;
        }
        const index = matchingIndexes[0]!;
        const evidence = projection.heavyTaskEvidence[index]!;
        const provenance = validHeavyTaskEvidenceProvenance(event, evidence, projection.warnings);
        if (!provenance) break;
        if (evidence.provenance) {
          projection.warnings.push(
            `ignored evidence provenance ${event.id}: evidence ${event.evidenceId} is already linked`,
          );
          break;
        }
        const linked = { ...evidence, provenance };
        projection.heavyTaskEvidence[index] = linked;
        if (projection.latestHeavyTaskEvidence?.evidenceId === event.evidenceId) {
          projection.latestHeavyTaskEvidence = linked;
        }
        break;
      }
      case 'isolation_policy_recorded':
        projection.isolation = event.facts;
        break;
      case 'workspace_lease_recorded':
        projection.workspaceLease = event.lease;
        break;
      case 'tool_executor_identity_recorded':
        projection.toolExecutors.push(event.identity);
        break;
      case 'permission_request_recorded':
        projection.permissionRequests.push(event.request);
        break;
      case 'permission_grant_recorded':
        projection.permissionGrants.push(event.grant);
        break;
      case 'permission_decision_recorded':
        break;
      case 'task_inbox_item_recorded':
        inboxItems.set(event.item.inboxItemId, event.item);
        break;
      case 'task_inbox_item_resolved': {
        const previous = inboxItems.get(event.inboxItemId);
        if (previous) {
          inboxItems.set(event.inboxItemId, {
            ...previous,
            status: event.status,
            ...(event.resolution ? { resolution: event.resolution } : {}),
          });
        }
        if (projection.parked?.inboxItemId === event.inboxItemId && terminalEvents === 0) {
          delete projection.parked;
        }
        break;
      }
      case 'task_run_needs_approval':
        if (terminalEvents === 0) {
          projection.status = 'needs_approval';
          projection.parked = {
            reason: event.reason,
            inboxItemId: event.inboxItemId,
            since: event.ts,
          };
          if (event.attemptId) {
            const previous = attempts.get(event.attemptId);
            attempts.set(event.attemptId, {
              ...(previous ?? {
                attemptId: event.attemptId,
                taskRunId: event.taskRunId,
                startedAt: event.ts,
                executionLineage: [],
              }),
              status: 'needs_approval',
              finishedAt: event.ts,
            });
          }
        }
        break;
      case 'task_attempt_completed':
        attempts.set(event.attemptId, {
          ...(attempts.get(event.attemptId) ?? {
            attemptId: event.attemptId,
            taskRunId: event.taskRunId,
            startedAt: event.ts,
            executionLineage: [],
          }),
          status: event.status,
          finishedAt: event.finishedAt ?? event.ts,
          ...(event.error ? { error: event.error } : {}),
        });
        break;
      case 'task_run_completed':
        terminalEvents = applyTerminalEvent(projection, terminalEvents);
        projection.status = 'completed';
        projection.finishedAt = event.finishedAt ?? event.ts;
        projection.result =
          event.result ??
          projection.result ??
          resultFromScore(projection.latestScoreResult, projection.latestVerifierResult);
        break;
      case 'task_run_failed':
        terminalEvents = applyTerminalEvent(projection, terminalEvents);
        projection.status = 'failed';
        projection.finishedAt = event.finishedAt ?? event.ts;
        projection.error = event.error;
        break;
      case 'task_run_incomplete':
        terminalEvents = applyTerminalEvent(projection, terminalEvents);
        projection.status = 'incomplete';
        projection.finishedAt = event.finishedAt ?? event.ts;
        projection.error = event.error ?? {
          message: 'task run incomplete',
          class: 'agent_incomplete',
        };
        break;
      case 'task_run_blocked':
        terminalEvents = applyTerminalEvent(projection, terminalEvents);
        projection.status = 'blocked';
        projection.finishedAt = event.finishedAt ?? event.ts;
        projection.error = event.error ?? { message: 'task run blocked', class: 'blocked' };
        break;
      case 'task_run_policy_denied':
        terminalEvents = applyTerminalEvent(projection, terminalEvents);
        projection.status = 'policy_denied';
        projection.finishedAt = event.finishedAt ?? event.ts;
        projection.error = event.error ?? {
          message: 'task run denied by policy',
          class: 'policy_denied',
        };
        break;
      case 'task_run_budget_exhausted':
        terminalEvents = applyTerminalEvent(projection, terminalEvents);
        projection.status = 'budget_exhausted';
        projection.finishedAt = event.finishedAt ?? event.ts;
        projection.error = event.error ?? {
          message: 'task run budget exhausted',
          class: 'budget_exhausted',
        };
        break;
      case 'task_run_aborted':
        terminalEvents = applyTerminalEvent(projection, terminalEvents);
        projection.status = 'aborted';
        projection.finishedAt = event.finishedAt ?? event.ts;
        projection.error = event.error ?? { message: 'task run aborted', class: 'aborted' };
        break;
      case 'task_run_cancelled':
        terminalEvents = applyTerminalEvent(projection, terminalEvents);
        projection.status = 'cancelled';
        projection.finishedAt = event.finishedAt ?? event.ts;
        projection.error = event.error ?? { message: 'task run cancelled', class: 'cancelled' };
        break;
      case 'event_corrupt':
        projection.warnings.push(`corrupt event ${event.id}: ${event.error}`);
        break;
    }
  }

  projection.attempts = [...attempts.values()];
  projection.inboxItems = [...inboxItems.values()];
  refreshHeavyTaskSelfCheckFreshness(projection, events, workspaceObservationRows);
  projection.latestVerifierResult = preferredVerifierResult(projection.verifierResults);
  projection.latestScoreResult = preferredScoreResult(
    projection.scoreResults,
    projection.latestVerifierResult,
  );
  if (projection.latestScoreResult) {
    projection.result = resultFromScore(
      projection.latestScoreResult,
      projection.latestVerifierResult,
    );
  } else if (projection.latestVerifierResult) {
    projection.result = resultFromVerifier(projection.latestVerifierResult);
  }
  if (hasHeavyTaskCompletionState(projection)) {
    projection.heavyTaskCompletion = evaluateHeavyTaskCompletionStatus({
      status: projection.status,
      taxonomy: projection.latestScoreResult?.taxonomy ?? projection.result?.taxonomy,
      error: projection.error,
      heavyTaskMode: projection.heavyTaskMode,
      latestHeavyTaskTodos: projection.latestHeavyTaskTodos,
      latestHeavyTaskSelfCheckPlan: projection.latestHeavyTaskSelfCheckPlan,
      latestHeavyTaskSelfCheck: projection.latestHeavyTaskSelfCheck,
      decisions: projection.decisions,
    });
  }
  return projection;
}

function setOptionalRefs(
  projection: TaskRunProjection,
  sessionId: string | undefined,
  agentRunId: string | undefined,
): void {
  if (sessionId) projection.sessionId = sessionId;
  if (agentRunId) projection.agentRunId = agentRunId;
}

function validTaskAttemptExecutionEvidence(
  event: Extract<TaskEvent, { type: 'task_attempt_execution_linked' }>,
  warnings: string[],
): ExecutionEvidenceRef | undefined {
  const validation = validateExecutionEvidenceRef(event.evidence);
  if (!validation.ok) {
    warnings.push(
      `ignored execution lineage ${event.id}: ${validation.errors.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
    );
    return undefined;
  }
  const evidence = validation.value;
  if (evidence.task?.taskRunId !== event.taskRunId || evidence.task.attemptId !== event.attemptId) {
    warnings.push(
      `ignored execution lineage ${event.id}: task identity does not match the owning attempt`,
    );
    return undefined;
  }
  if (!evidence.execution?.agentRunId) {
    warnings.push(`ignored execution lineage ${event.id}: execution.agentRunId is required`);
    return undefined;
  }
  return evidence;
}

function validHeavyTaskEvidenceProvenance(
  event: Extract<TaskEvent, { type: 'heavy_task_evidence_provenance_linked' }>,
  subject: HeavyTaskCompactEvidenceEnvelope,
  warnings: string[],
): ExecutionEvidenceRef | undefined {
  const validation = validateExecutionEvidenceRef(event.provenance);
  if (!validation.ok) {
    warnings.push(
      `ignored evidence provenance ${event.id}: ${validation.errors
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')}`,
    );
    return undefined;
  }
  const provenance = validation.value;
  if (provenance.task?.taskRunId !== event.taskRunId) {
    warnings.push(
      `ignored evidence provenance ${event.id}: task identity does not match the owning TaskRun`,
    );
    return undefined;
  }
  const attemptId = event.attemptId;
  if (
    (subject.attemptId && event.attemptId !== subject.attemptId) ||
    provenance.task?.attemptId !== attemptId
  ) {
    warnings.push(
      `ignored evidence provenance ${event.id}: attempt identity does not match the evidence`,
    );
    return undefined;
  }
  if (!provenance.execution?.agentRunId || !provenance.runtimeCoverage) {
    warnings.push(
      `ignored evidence provenance ${event.id}: AgentRun identity and Runtime coverage are required`,
    );
    return undefined;
  }
  if (
    (subject.source.sessionId && subject.source.sessionId !== provenance.execution.sessionId) ||
    (subject.source.agentRunId && subject.source.agentRunId !== provenance.execution.agentRunId) ||
    (subject.source.turnId && subject.source.turnId !== provenance.execution.turnId)
  ) {
    warnings.push(
      `ignored evidence provenance ${event.id}: Runtime identity does not match the evidence source`,
    );
    return undefined;
  }
  return provenance;
}

function validHeavyTaskSelfCheckProvenance(
  event: Extract<TaskEvent, { type: 'heavy_task_self_check_evidence_linked' }>,
  selfCheck: HeavyTaskSelfCheckProjection,
  selfCheckSequence: number,
  selfCheckEventId: string,
  observationRow: { sequence: number; observation: HeavyTaskWorkspaceObservationState } | undefined,
  warnings: string[],
): ExecutionEvidenceRef | undefined {
  const validation = validateExecutionEvidenceRef(event.provenance);
  if (!validation.ok) {
    warnings.push(
      `ignored self-check evidence link ${event.id}: ${validation.errors
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')}`,
    );
    return undefined;
  }
  const provenance = validation.value;
  if (
    provenance.task?.taskRunId !== event.taskRunId ||
    provenance.task.attemptId !== event.attemptId ||
    selfCheck.taskRunId !== event.taskRunId ||
    selfCheck.attemptId !== event.attemptId
  ) {
    warnings.push(
      `ignored self-check evidence link ${event.id}: TaskRun or attempt identity does not match`,
    );
    return undefined;
  }
  if (
    !provenance.execution?.agentRunId ||
    !provenance.runtimeCoverage ||
    !provenance.taskCoverage ||
    !provenance.workspace
  ) {
    warnings.push(
      `ignored self-check evidence link ${event.id}: Runtime coverage, Task coverage, and workspace revision are required`,
    );
    return undefined;
  }
  if (
    (selfCheck.source.sessionId && selfCheck.source.sessionId !== provenance.execution.sessionId) ||
    (selfCheck.source.agentRunId &&
      selfCheck.source.agentRunId !== provenance.execution.agentRunId) ||
    (selfCheck.source.turnId && selfCheck.source.turnId !== provenance.execution.turnId)
  ) {
    warnings.push(
      `ignored self-check evidence link ${event.id}: Runtime identity does not match the Self-check source`,
    );
    return undefined;
  }
  const taskHighWater = provenance.taskCoverage.highWater;
  if (
    taskHighWater.ledger !== 'task_event' ||
    taskHighWater.streamId !== event.taskRunId ||
    taskHighWater.sequence !== selfCheckSequence ||
    taskHighWater.eventId !== selfCheckEventId
  ) {
    warnings.push(
      `ignored self-check evidence link ${event.id}: Task high water does not identify the Self-check record`,
    );
    return undefined;
  }
  if (
    !observationRow ||
    observationRow.sequence <= selfCheckSequence ||
    observationRow.observation.status !== 'ok' ||
    !observationRow.observation.revision
  ) {
    warnings.push(
      `ignored self-check evidence link ${event.id}: referenced post-check workspace observation is missing`,
    );
    return undefined;
  }
  if (!sameWorkspaceRevision(provenance.workspace, observationRow.observation.revision)) {
    warnings.push(
      `ignored self-check evidence link ${event.id}: workspace revision does not match the referenced observation`,
    );
    return undefined;
  }
  return provenance;
}

function refreshHeavyTaskSelfCheckFreshness(
  projection: TaskRunProjection,
  events: readonly TaskEvent[],
  observationRows: ReadonlyMap<
    string,
    { sequence: number; observation: HeavyTaskWorkspaceObservationState }
  >,
): void {
  projection.heavyTaskSelfChecks = projection.heavyTaskSelfChecks.map((selfCheck) => {
    if (!selfCheck.provenance || !selfCheck.workspaceObservationId) {
      return withSelfCheckFreshness(selfCheck, 'unknown', ['source_binding_missing']);
    }
    const baseline = observationRows.get(selfCheck.workspaceObservationId);
    if (!baseline?.observation.revision) {
      return withSelfCheckFreshness(selfCheck, 'unknown', ['workspace_observation_missing']);
    }
    const laterObservations = [...observationRows.values()]
      .filter(
        (row) =>
          row.sequence >= baseline.sequence &&
          row.observation.status === 'ok' &&
          row.observation.revision,
      )
      .sort((left, right) => left.sequence - right.sequence);
    const latestObservation = laterObservations.at(-1) ?? baseline;
    if (
      !sameWorkspaceRevision(selfCheck.provenance.workspace, latestObservation.observation.revision)
    ) {
      return withSelfCheckFreshness(selfCheck, 'stale', ['workspace_revision_changed']);
    }
    const hasLaterMutation = events.some(
      (event, sequence) =>
        sequence > latestObservation.sequence &&
        invalidatesSelfCheckWorkspace(event, selfCheck.attemptId),
    );
    if (hasLaterMutation) {
      return withSelfCheckFreshness(selfCheck, 'stale', ['later_workspace_mutation']);
    }
    return withSelfCheckFreshness(selfCheck, 'current', []);
  });
  projection.latestHeavyTaskSelfCheck = projection.heavyTaskSelfChecks.at(-1);
}

function withSelfCheckFreshness(
  selfCheck: HeavyTaskSelfCheckProjection,
  freshness: HeavyTaskSelfCheckProjection['freshness'],
  freshnessReasons: HeavyTaskSelfCheckFreshnessReason[],
): HeavyTaskSelfCheckProjection {
  return { ...selfCheck, freshness, freshnessReasons };
}

function invalidatesSelfCheckWorkspace(event: TaskEvent, attemptId: string | undefined): boolean {
  if (event.type !== 'heavy_task_evidence_recorded') return false;
  if (!attemptId || event.evidence.attemptId !== attemptId) return false;
  if (event.evidence.kind === 'artifact') return true;
  if (event.evidence.kind !== 'tool') return false;
  return ['Bash', 'Write', 'Edit'].includes(
    event.evidence.tool?.name ?? event.evidence.source.toolName ?? '',
  );
}

function sameWorkspaceRevision(
  left: ExecutionEvidenceRef['workspace'],
  right: ExecutionEvidenceRef['workspace'],
): boolean {
  return Boolean(
    left &&
      right &&
      left.kind === right.kind &&
      left.ref === right.ref &&
      left.dirty === right.dirty,
  );
}

function resultFromScore(
  score: ScoreResult | undefined,
  verifier: VerifierResult | undefined,
): TaskRunResult | undefined {
  if (!score) return undefined;
  return {
    passed: score.passed,
    taxonomy: score.taxonomy,
    ...(verifier ? { verifierResultId: verifier.id } : {}),
    scoreResultId: score.id,
  };
}

function resultFromVerifier(verifier: VerifierResult): TaskRunResult {
  return {
    passed: verifier.passed,
    taxonomy: verifier.passed ? 'passed' : 'verification_failed',
    verifierResultId: verifier.id,
  };
}

function preferredVerifierResult(results: readonly VerifierResult[]): VerifierResult | undefined {
  return preferredByAuthority(results);
}

function preferredScoreResult(
  results: readonly ScoreResult[],
  verifier: VerifierResult | undefined,
): ScoreResult | undefined {
  if (
    verifier?.authority?.authoritative === true &&
    !results.some((result) => result.authority?.authoritative === true)
  ) {
    return undefined;
  }
  return preferredByAuthority(results);
}

function preferredByAuthority<T extends { authority?: { authoritative: boolean }; ts: number }>(
  results: readonly T[],
): T | undefined {
  const authoritative = results.filter((result) => result.authority?.authoritative === true);
  if (authoritative.length > 0) return authoritative[authoritative.length - 1];
  const nonPlaceholder = results.filter((result) => result.authority?.authoritative !== false);
  if (nonPlaceholder.length > 0) return nonPlaceholder[nonPlaceholder.length - 1];
  return results[results.length - 1];
}

function applyTerminalEvent(projection: TaskRunProjection, terminalEvents: number): number {
  if (terminalEvents > 0) {
    projection.warnings.push(
      'multiple terminal task run events observed; last terminal event wins',
    );
  }
  delete projection.parked;
  return terminalEvents + 1;
}

function appendCompactEvidence(
  projection: TaskRunProjection,
  ...evidence: HeavyTaskCompactEvidenceEnvelope[]
): boolean {
  let ok = true;
  for (const item of evidence) {
    if (item.public !== true || item.taskRunId !== projection.taskRunId) {
      ok = false;
      continue;
    }
    if (item.provenance) {
      projection.warnings.push(
        `ignored embedded provenance on heavy-task evidence ${item.evidenceId}: a provenance link event is required`,
      );
    }
    const { provenance: _embeddedProvenance, ...unlinked } = item;
    projection.heavyTaskEvidence.push(unlinked);
    projection.latestHeavyTaskEvidence = unlinked;
  }
  return ok;
}

function selfCheckEvidenceIdFactory(selfCheckId: string): () => string {
  let index = 0;
  return () => `${selfCheckId}:compact-${++index}`;
}

function isCompactEvidenceEligibleArtifact(artifact: TaskRunArtifact): boolean {
  return (
    (artifact.authority.source === 'runtime' || artifact.authority.source === 'self_check') &&
    artifact.authority.authoritative !== true
  );
}

function hasHeavyTaskCompletionState(projection: TaskRunProjection): boolean {
  return (
    projection.heavyTaskMode?.enabled === true ||
    projection.heavyTaskInventory.length > 0 ||
    projection.heavyTaskTodoStates.length > 0 ||
    projection.heavyTaskSelfCheckPlans.length > 0 ||
    projection.heavyTaskSelfChecks.length > 0 ||
    projection.heavyTaskEvidence.length > 0
  );
}
