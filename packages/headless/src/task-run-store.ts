import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResultRecord } from './contracts.js';
import { compactArtifactEvidence, compactSelfCheckEvidence } from './heavy-task-evidence.js';
import { evaluateHeavyTaskCompletionStatus, type HeavyTaskCompletionStatus } from './heavy-task-finalization.js';
import { isAcceptedHeavyTaskSelfCheck } from './heavy-task-self-check.js';
import type {
  AutonomousDecision,
  FeedbackObservation,
  HeavyTaskCompactEvidenceEnvelope,
  HeavyTaskSelfCheckGateState,
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
  heavyTaskSelfChecks: HeavyTaskSemanticSelfCheckState[];
  latestHeavyTaskSelfCheck?: HeavyTaskSemanticSelfCheckState;
  heavyTaskSelfCheckGates: HeavyTaskSelfCheckGateState[];
  latestHeavyTaskSelfCheckGate?: HeavyTaskSelfCheckGateState;
  heavyTaskEvidence: HeavyTaskCompactEvidenceEnvelope[];
  latestHeavyTaskEvidence?: HeavyTaskCompactEvidenceEnvelope;
  heavyTaskCompletion?: HeavyTaskCompletionStatus;
  isolation?: TaskIsolationFacts;
  workspaceLease?: WorkspaceLeaseFacts;
  parked?: TaskRunParkedState;
  sourceResultRecord?: ResultRecord;
}

export interface TaskRunStore {
  appendEvent(taskRunId: string, event: TaskEvent): Promise<void>;
  readEvents(taskRunId: string): Promise<TaskEvent[]>;
  project(taskRunId: string): Promise<TaskRunProjection>;
}

export function createInMemoryTaskRunStore(initialEvents: readonly TaskEvent[] = []): TaskRunStore {
  return new InMemoryTaskRunStore(initialEvents);
}

export function createTaskRunStore(storageRoot: string): TaskRunStore {
  return new FileTaskRunStore(storageRoot);
}

export function projectTaskRun(events: readonly TaskEvent[], taskRunId?: string): TaskRunProjection {
  const projectedTaskRunId = taskRunId ?? events[0]?.taskRunId ?? '';
  const projection: TaskRunProjection = {
    taskRunId: projectedTaskRunId,
    taskId: '',
    configId: '',
    status: 'queued',
    events: [],
    attempts: [],
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
    heavyTaskSelfChecks: [],
    heavyTaskSelfCheckGates: [],
    heavyTaskEvidence: [],
  };
  const attempts = new Map<string, TaskAttempt>();
  const inboxItems = new Map<string, TaskInboxItem>();
  let terminalEvents = 0;

  for (const event of events) {
    if (projectedTaskRunId && event.taskRunId !== projectedTaskRunId) {
      projection.warnings.push(`ignored event ${event.id}: taskRunId ${event.taskRunId} does not match ${projectedTaskRunId}`);
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
        const attempt: TaskAttempt = {
          attemptId: event.attemptId,
          taskRunId: event.taskRunId,
          startedAt: event.startedAt ?? event.ts,
          status: 'running',
          ...(event.sessionId ? { sessionId: event.sessionId } : {}),
          ...(event.agentRunId ? { agentRunId: event.agentRunId } : {}),
        };
        attempts.set(event.attemptId, attempt);
        setOptionalRefs(projection, event.sessionId, event.agentRunId);
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
        if (projection.heavyTaskMode?.enabled === true && isCompactEvidenceEligibleArtifact(event.artifact)) {
          appendCompactEvidence(projection, compactArtifactEvidence({
            evidenceId: `${event.id}:compact-artifact`,
            taskRunId: projection.taskRunId,
            ...(event.artifact.attemptId ? { attemptId: event.artifact.attemptId } : {}),
            ts: event.ts,
            source: { kind: 'model_tool', toolCallId: `task-run-artifact:${event.id}`, toolName: 'artifact' },
            artifact: event.artifact,
          }));
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
      case 'heavy_task_self_check_recorded':
        if (isAcceptedHeavyTaskSelfCheck(event.selfCheck)) {
          projection.heavyTaskSelfChecks.push(event.selfCheck);
          projection.latestHeavyTaskSelfCheck = event.selfCheck;
          appendCompactEvidence(
            projection,
            ...compactSelfCheckEvidence({
              selfCheck: event.selfCheck,
              newId: selfCheckEvidenceIdFactory(event.selfCheck.selfCheckId),
            }),
          );
        } else {
          projection.warnings.push(`ignored heavy-task self-check ${event.selfCheck.selfCheckId}: source guard did not accept public evidence`);
        }
        break;
      case 'heavy_task_self_check_gate_recorded':
        projection.heavyTaskSelfCheckGates.push(event.gate);
        projection.latestHeavyTaskSelfCheckGate = event.gate;
        break;
      case 'heavy_task_evidence_recorded':
        if (!appendCompactEvidence(projection, event.evidence)) {
          projection.warnings.push(`ignored heavy-task evidence ${event.evidence.evidenceId}: evidence must be public and match taskRunId`);
        }
        break;
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
          projection.parked = { reason: event.reason, inboxItemId: event.inboxItemId, since: event.ts };
          if (event.attemptId) {
            const previous = attempts.get(event.attemptId);
            attempts.set(event.attemptId, {
              ...(previous ?? { attemptId: event.attemptId, taskRunId: event.taskRunId, startedAt: event.ts }),
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
        projection.result = event.result ?? projection.result ?? resultFromScore(projection.latestScoreResult, projection.latestVerifierResult);
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
        projection.error = event.error ?? { message: 'task run incomplete', class: 'agent_incomplete' };
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
        projection.error = event.error ?? { message: 'task run denied by policy', class: 'policy_denied' };
        break;
      case 'task_run_budget_exhausted':
        terminalEvents = applyTerminalEvent(projection, terminalEvents);
        projection.status = 'budget_exhausted';
        projection.finishedAt = event.finishedAt ?? event.ts;
        projection.error = event.error ?? { message: 'task run budget exhausted', class: 'budget_exhausted' };
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
  projection.latestVerifierResult = preferredVerifierResult(projection.verifierResults);
  projection.latestScoreResult = preferredScoreResult(projection.scoreResults, projection.latestVerifierResult);
  if (projection.latestScoreResult) {
    projection.result = resultFromScore(projection.latestScoreResult, projection.latestVerifierResult);
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
      latestHeavyTaskSelfCheck: projection.latestHeavyTaskSelfCheck,
      decisions: projection.decisions,
    });
  }
  return projection;
}

class InMemoryTaskRunStore implements TaskRunStore {
  private readonly events = new Map<string, TaskEvent[]>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(initialEvents: readonly TaskEvent[]) {
    for (const event of initialEvents) {
      const events = this.events.get(event.taskRunId) ?? [];
      events.push(event);
      this.events.set(event.taskRunId, events);
    }
  }

  async appendEvent(taskRunId: string, event: TaskEvent): Promise<void> {
    if (event.taskRunId !== taskRunId) {
      throw new Error(`taskRunId mismatch: append target ${taskRunId}, event ${event.taskRunId}`);
    }

    const previous = this.queues.get(taskRunId) ?? Promise.resolve();
    const next = previous.then(() => {
      const events = this.events.get(taskRunId) ?? [];
      events.push(event);
      this.events.set(taskRunId, events);
    });
    this.queues.set(taskRunId, next.catch(() => undefined));
    await next;
  }

  async readEvents(taskRunId: string): Promise<TaskEvent[]> {
    return [...(this.events.get(taskRunId) ?? [])];
  }

  async project(taskRunId: string): Promise<TaskRunProjection> {
    return projectTaskRun(await this.readEvents(taskRunId), taskRunId);
  }
}

class FileTaskRunStore implements TaskRunStore {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly storageRoot: string) {}

  async appendEvent(taskRunId: string, event: TaskEvent): Promise<void> {
    if (event.taskRunId !== taskRunId) {
      throw new Error(`taskRunId mismatch: append target ${taskRunId}, event ${event.taskRunId}`);
    }

    const previous = this.queues.get(taskRunId) ?? Promise.resolve();
    const next = previous.then(async () => {
      await mkdir(this.taskRunDir(), { recursive: true });
      await appendFile(this.taskRunPath(taskRunId), `${JSON.stringify(event)}\n`, 'utf8');
    });
    this.queues.set(taskRunId, next.catch(() => undefined));
    await next;
  }

  async readEvents(taskRunId: string): Promise<TaskEvent[]> {
    let content: string;
    try {
      content = await readFile(this.taskRunPath(taskRunId), 'utf8');
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }

    const lines = content.endsWith('\n') ? content.split('\n') : content.split('\n').slice(0, -1);
    const events: TaskEvent[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line) continue;
      try {
        events.push(JSON.parse(line) as TaskEvent);
      } catch (error) {
        events.push({
          type: 'event_corrupt',
          id: `corrupt-${i + 1}`,
          taskRunId,
          ts: 0,
          raw: line,
          error: errorMessage(error),
        });
      }
    }
    return events;
  }

  async project(taskRunId: string): Promise<TaskRunProjection> {
    return projectTaskRun(await this.readEvents(taskRunId), taskRunId);
  }

  private taskRunDir(): string {
    return join(this.storageRoot, 'task-runs');
  }

  private taskRunPath(taskRunId: string): string {
    return join(this.taskRunDir(), `${safeFileId(taskRunId)}.jsonl`);
  }
}

function setOptionalRefs(projection: TaskRunProjection, sessionId: string | undefined, agentRunId: string | undefined): void {
  if (sessionId) projection.sessionId = sessionId;
  if (agentRunId) projection.agentRunId = agentRunId;
}

function resultFromScore(score: ScoreResult | undefined, verifier: VerifierResult | undefined): TaskRunResult | undefined {
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

function preferredScoreResult(results: readonly ScoreResult[], verifier: VerifierResult | undefined): ScoreResult | undefined {
  if (verifier?.authority?.authoritative === true && !results.some((result) => result.authority?.authoritative === true)) {
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
    projection.warnings.push('multiple terminal task run events observed; last terminal event wins');
  }
  delete projection.parked;
  return terminalEvents + 1;
}

function appendCompactEvidence(projection: TaskRunProjection, ...evidence: HeavyTaskCompactEvidenceEnvelope[]): boolean {
  let ok = true;
  for (const item of evidence) {
    if (item.public !== true || item.taskRunId !== projection.taskRunId) {
      ok = false;
      continue;
    }
    projection.heavyTaskEvidence.push(item);
    projection.latestHeavyTaskEvidence = item;
  }
  return ok;
}

function selfCheckEvidenceIdFactory(selfCheckId: string): () => string {
  let index = 0;
  return () => `${selfCheckId}:compact-${++index}`;
}

function isCompactEvidenceEligibleArtifact(artifact: TaskRunArtifact): boolean {
  return (artifact.authority.source === 'runtime' || artifact.authority.source === 'self_check')
    && artifact.authority.authoritative !== true;
}

function hasHeavyTaskCompletionState(projection: TaskRunProjection): boolean {
  return projection.heavyTaskMode?.enabled === true
    || projection.heavyTaskInventory.length > 0
    || projection.heavyTaskTodoStates.length > 0
    || projection.heavyTaskSelfChecks.length > 0
    || projection.heavyTaskEvidence.length > 0;
}

function safeFileId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_') || '_';
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
