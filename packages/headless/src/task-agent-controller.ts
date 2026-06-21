import { randomUUID } from 'node:crypto';
import type {
  AgentRunStore,
  RuntimeEvent,
  RuntimeEventStore,
  SessionBlockedReason,
  SessionHeader,
  SessionStatus,
  StoredMessage,
} from '@maka/core';
import {
  AgentRun,
  AiSdkFlow,
  BackendRegistry,
  RuntimeRunner,
  type AgentRunActiveSession,
  type InvocationResult,
  type SessionStore,
} from '@maka/runtime';
import {
  createAgentRunStore,
  createRuntimeEventStore,
  createSessionStore,
} from '@maka/storage';
import type { Config, ResultRecord, Task } from './contracts.js';
import { registerFakeBackend } from './backends.js';
import type { HeadlessBackendContext } from './isolation.js';
import {
  ISOLATED_HEADLESS_TOOL_NAMES,
  taskIsolationFacts,
  toolExecutorIdentity,
  validateRealBackendIsolation,
} from './isolation.js';
import {
  commandResourceScope,
  hashNormalizedArgs,
  matchPermissionGrant,
  permissionPreview,
} from './permission-grants.js';
import { freezeSubmittedWorkspace, prepareScoringWorkspace, prepareWorkspace, restoreProtectedPaths } from './sandbox.js';
import { defaultFinalScorer } from './scorer.js';
import { approvalRequestInboxItem } from './task-inbox.js';
import { normalizeVerifier, runVerifier, verifierProtectedPaths } from './verifier.js';
import {
  backendNeedsIsolation,
  type RunExperimentDeps,
  validateTaskVerification,
} from './runner.js';
import {
  taxonomyFromResultRecord,
  type AutonomousResultTaxonomy,
  type FeedbackObservation,
  type PermissionResourceScope,
  type ScoreResult,
  type TaskAttemptStatus,
  type TaskEvent,
  type TaskInterventionPolicy,
  type TaskPermissionGrant,
  type TaskPermissionRequest,
  type TaskRunError,
  type TaskRunResult,
  type VerifierResult,
} from './task-contracts.js';
import {
  createTaskRunStore,
  type TaskRunProjection,
  type TaskRunStore,
} from './task-run-store.js';
import { taskDefinitionFromTask } from './task-run-adapter.js';

export interface RunTaskOnceDeps extends RunExperimentDeps {
  taskRunStore?: TaskRunStore;
  runtimeEventStore?: RuntimeEventStore;
  sessionStore?: SessionStore;
  agentRunStore?: AgentRunStore;
  taskRunId?: string;
  attemptId?: string;
  createTaskRun?: boolean;
  closeTaskRun?: boolean;
  instructionOverride?: string;
  permissionMode?: 'execute';
  interventionPolicy?: TaskInterventionPolicy;
  permissionGrants?: readonly TaskPermissionGrant[];
}

export interface RunTaskOnceResult {
  taskRunId: string;
  attemptId: string;
  resultRecord: ResultRecord;
  projection: TaskRunProjection;
  invocation: InvocationResult;
}

export class TaskAgentController {
  constructor(private readonly deps: RunTaskOnceDeps) {}

  runOnce(config: Config, task: Task): Promise<RunTaskOnceResult> {
    return runTaskOnce(config, task, this.deps);
  }
}

export async function runTaskOnce(
  config: Config,
  task: Task,
  deps: RunTaskOnceDeps,
): Promise<RunTaskOnceResult> {
  const isolationRequired = backendNeedsIsolation(config.backend);
  if (isolationRequired) {
    validateRealBackendIsolation(deps.realBackendIsolation);
    if (!deps.registerBackends) {
      throw new Error(
        `@maka/headless: backend "${config.backend}" requires registerBackends to wire an isolated backend factory`,
      );
    }
  }
  validateTaskVerification(task);

  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const taskRunId = deps.taskRunId ?? newId();
  const attemptId = deps.attemptId ?? `${taskRunId}-attempt-1`;
  const instruction = deps.instructionOverride ?? task.instruction;
  const createTaskRun = deps.createTaskRun ?? true;
  const closeTaskRun = deps.closeTaskRun ?? true;
  const interventionPolicy = deps.interventionPolicy ?? DEFAULT_INTERVENTION_POLICY;
  const taskRunStore = deps.taskRunStore ?? createTaskRunStore(deps.storageRoot);
  const sessionStore = deps.sessionStore ?? createSessionStore(deps.storageRoot);
  const agentRunStore = deps.agentRunStore ?? createAgentRunStore(deps.storageRoot);
  const runtimeEventStore = deps.runtimeEventStore ?? createRuntimeEventStore(deps.storageRoot);
  const startedAt = now();
  const verifier = normalizeVerifier(task);

  if (createTaskRun) {
    await appendTaskEvent(taskRunStore, taskRunId, {
      type: 'task_run_created',
      id: newId(),
      taskRunId,
      ts: startedAt,
      taskId: task.id,
      configId: config.id,
      taskDefinition: taskDefinitionFromTask(task),
    });
    await appendTaskEvent(taskRunStore, taskRunId, {
      type: 'task_run_queued',
      id: newId(),
      taskRunId,
      ts: now(),
      taskId: task.id,
      configId: config.id,
      taskDefinition: taskDefinitionFromTask(task),
    });
  }
  await appendTaskEvent(taskRunStore, taskRunId, {
    type: 'isolation_policy_recorded',
    id: newId(),
    taskRunId,
    ts: now(),
    facts: taskIsolationFacts({
      backendKind: config.backend,
      required: isolationRequired,
      isolation: deps.realBackendIsolation,
      validatedAt: now(),
    }),
  });
  for (const grant of deps.permissionGrants ?? []) {
    if (grant.taskRunId !== taskRunId) continue;
    await appendTaskEvent(taskRunStore, taskRunId, {
      type: 'permission_grant_recorded',
      id: newId(),
      taskRunId,
      ts: now(),
      grant,
    });
  }

  const workspace = await prepareWorkspace(task.workspaceDir);
  try {
    await appendTaskEvent(taskRunStore, taskRunId, {
      type: 'workspace_lease_recorded',
      id: newId(),
      taskRunId,
      ts: now(),
      lease: {
        schemaVersion: 1,
        leaseId: newId(),
        taskRunId,
        attemptId,
        sourceWorkspaceDir: task.workspaceDir,
        workspaceDir: workspace.dir,
        leaseKind: 'throwaway_copy',
        writable: true,
        cleanupPolicy: 'cleanup_on_finally',
        createdAt: now(),
      },
    });
    await appendTaskEvent(taskRunStore, taskRunId, {
      type: 'tool_executor_identity_recorded',
      id: newId(),
      taskRunId,
      ts: now(),
      identity: toolExecutorIdentity({
        executorId: newId(),
        taskRunId,
        attemptId,
        isolation: deps.realBackendIsolation,
        toolNames: deps.realBackendIsolation?.toolExecutor ? [...ISOLATED_HEADLESS_TOOL_NAMES] : ['registered_backend'],
      }),
    });
    const backends = new BackendRegistry();
    const registerBackends: NonNullable<RunExperimentDeps['registerBackends']> =
      deps.registerBackends ?? ((registry) => registerFakeBackend(registry));
    await registerBackends(backends, {
      config,
      task,
      workspaceDir: workspace.dir,
      ...(backendNeedsIsolation(config.backend)
        ? { realBackendIsolation: deps.realBackendIsolation, toolExecutor: deps.realBackendIsolation?.toolExecutor }
        : {}),
    });

    const header = await sessionStore.create({
      cwd: workspace.dir,
      backend: config.backend,
      llmConnectionSlug: config.llmConnectionSlug,
      model: config.model,
      permissionMode: deps.permissionMode ?? 'execute',
      name: `task:${config.id}:${task.id}`,
    });
    const turnId = newId();
    const active = createSingleRunActiveSession(backends, sessionStore, now, newId);
    const run = new AgentRun({
      sessionId: header.id,
      header,
      userInput: { turnId, text: instruction },
      store: sessionStore,
      runStore: agentRunStore,
      runtimeEventStore,
      newId,
      now,
      hooks: active.hooks,
    });
    active.bindRun(run);

    await appendTaskEvent(taskRunStore, taskRunId, {
      type: 'task_run_started',
      id: newId(),
      taskRunId,
      ts: now(),
      startedAt,
      sessionId: header.id,
      agentRunId: run.runId,
    });
    await appendTaskEvent(taskRunStore, taskRunId, {
      type: 'task_attempt_started',
      id: newId(),
      taskRunId,
      ts: now(),
      attemptId,
      startedAt,
      sessionId: header.id,
      agentRunId: run.runId,
    });

    let runtimeInvocation: InvocationResult;
    try {
      runtimeInvocation = await runRuntimeAttempt({
        run,
        header,
        instruction,
        now,
        newId,
      });
    } finally {
      await active.dispose();
    }
    const permissionHandling = await handlePermissionIntervention({
      invocation: runtimeInvocation,
      store: taskRunStore,
      taskRunId,
      attemptId,
      now,
      newId,
      policy: interventionPolicy,
      config,
      task,
      sessionId: header.id,
      startedAt,
      closeTaskRun,
    });
    if (permissionHandling.parked) {
      return {
        taskRunId,
        attemptId,
        resultRecord: permissionHandling.resultRecord,
        projection: await taskRunStore.project(taskRunId),
        invocation: permissionHandling.invocation,
      };
    }
    const invocation = permissionHandling.invocation;

    const runtimeSummary = summarizeRuntime(invocation, deps.realBackendIsolation);
    await appendRuntimeFeedback(taskRunStore, taskRunId, attemptId, now, newId, runtimeSummary);

    await appendTaskEvent(taskRunStore, taskRunId, {
      type: 'task_run_verifying',
      id: newId(),
      taskRunId,
      ts: now(),
      startedAt: now(),
    });
    const runnerCompleted = invocation.status === 'completed';
    const frozen = await freezeSubmittedWorkspace({
      workspaceDir: workspace.dir,
      artifactRefs: runtimeSummary.artifactRefs,
      now,
      newId,
    });
    const scoringWorkspace = await prepareScoringWorkspace(frozen.submittedSnapshot);
    let verifierResult: VerifierResult;
    try {
      await restoreProtectedPaths(task.workspaceDir, scoringWorkspace.dir, verifierProtectedPaths(verifier));
      const verifierStartedAt = now();
      verifierResult = await runVerifier({
        verifier,
        taskRunId,
        attemptId,
        ts: verifierStartedAt,
        id: newId(),
        workspaceDir: scoringWorkspace.dir,
        submittedSnapshotId: frozen.submittedSnapshot.id,
        scoringWorkspaceId: scoringWorkspace.dir,
        benchmarkAdapters: deps.benchmarkAdapters,
      });
    } finally {
      await scoringWorkspace.cleanup();
    }
    const finalScore = defaultFinalScorer({
      config,
      task,
      runnerCompleted,
      runnerStatus: invocation.status,
      invocationFailure: invocation.failure,
      submittedSnapshot: frozen.submittedSnapshot,
      verifierResult,
    });
    const finishedAt = now();
    const scoreResultId = newId();
    const resultRecord = resultRecordFromInvocation({
      config,
      task,
      sessionId: header.id,
      invocation,
      verifierResult,
      finalScore,
      submittedSnapshotId: frozen.submittedSnapshot.id,
      scoreResultId,
      startedAt,
      finishedAt,
    });
    const taxonomy = finalScore.taxonomy;
    const scoreResult: ScoreResult = {
      id: scoreResultId,
      taskRunId,
      attemptId,
      ts: finishedAt,
      passed: finalScore.passed,
      scored: finalScore.scored,
      eligible: finalScore.eligible,
      ...(finalScore.score !== undefined ? { score: finalScore.score } : {}),
      ...(finalScore.maxScore !== undefined ? { maxScore: finalScore.maxScore } : {}),
      ...(finalScore.errorClass ? { errorClass: finalScore.errorClass } : {}),
      ...(finalScore.excludedReason ? { excludedReason: finalScore.excludedReason } : {}),
      taxonomy,
      details: {
        steps: resultRecord.steps,
        invocationStatus: invocation.status,
        ...(invocation.failure?.class ? { runtimeFailureClass: invocation.failure.class } : {}),
        verifierExitCode: verifierResult.exitCode ?? null,
        runtimeRefs: runtimeSummary.runtimeRefs,
        artifactRefs: runtimeSummary.artifactRefs,
        submittedSnapshot: frozen.submittedSnapshot,
        scoringWorkspaceContract: 'v1_copy_snapshot_then_restore_protected_paths_in_disposable_scoring_workspace',
        isolation: runtimeSummary.isolation,
        budget: runtimeSummary.budget,
        ...(finalScore.details ? { finalScore: finalScore.details } : {}),
      },
    };
    const runResult: TaskRunResult = {
      passed: scoreResult.passed,
      taxonomy,
      verifierResultId: verifierResult.id,
      scoreResultId: scoreResult.id,
    };

    await appendTaskEvent(taskRunStore, taskRunId, {
      type: 'verifier_result_recorded',
      id: newId(),
      taskRunId,
      ts: finishedAt,
      result: verifierResult,
    });
    await appendTaskEvent(taskRunStore, taskRunId, {
      type: 'score_result_recorded',
      id: newId(),
      taskRunId,
      ts: finishedAt,
      result: scoreResult,
    });
    await appendTaskEvent(taskRunStore, taskRunId, {
      type: 'task_attempt_completed',
      id: newId(),
      taskRunId,
      ts: finishedAt,
      attemptId,
      finishedAt,
      status: attemptStatusFromResult(resultRecord.status, taxonomy),
      ...(resultRecord.status === 'failed' ? { error: errorFromResultRecord(resultRecord, taxonomy) } : {}),
    });
    if (closeTaskRun) {
      await appendTaskEvent(
        taskRunStore,
        taskRunId,
        terminalEventFromResult(resultRecord, taxonomy, runResult, taskRunId, newId),
      );
    }

    return {
      taskRunId,
      attemptId,
      resultRecord,
      projection: await taskRunStore.project(taskRunId),
      invocation,
    };
  } finally {
    await workspace.cleanup();
  }
}

const DEFAULT_INTERVENTION_POLICY: TaskInterventionPolicy = { mode: 'fail_closed' };
const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

interface PermissionInterventionInput {
  invocation: InvocationResult;
  store: TaskRunStore;
  taskRunId: string;
  attemptId: string;
  now: () => number;
  newId: () => string;
  policy: TaskInterventionPolicy;
  config: Config;
  task: Task;
  sessionId: string;
  startedAt: number;
  closeTaskRun: boolean;
}

type PermissionInterventionResult =
  | { parked: false; invocation: InvocationResult }
  | { parked: true; invocation: InvocationResult; resultRecord: ResultRecord };

async function handlePermissionIntervention(input: PermissionInterventionInput): Promise<PermissionInterventionResult> {
  const permissionRequestEvent = input.invocation.events.find((event) => event.actions?.permissionRequest);
  const rawRequest = permissionRequestEvent?.actions?.permissionRequest;
  if (!rawRequest) {
    return { parked: false, invocation: input.invocation };
  }

  const requestedAt = input.now();
  const request = permissionRequestFromRuntime({
    rawRequest,
    taskRunId: input.taskRunId,
    attemptId: input.attemptId,
    requestedAt,
    expiresAt: requestedAt + (input.policy.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS),
  });
  await appendTaskEvent(input.store, input.taskRunId, {
    type: 'permission_request_recorded',
    id: input.newId(),
    taskRunId: input.taskRunId,
    ts: requestedAt,
    request,
  });

  const projection = await input.store.project(input.taskRunId);
  const postHocGrant = matchPermissionGrant(request, projection.permissionGrants, requestedAt);
  const failClosedDenyReason = postHocGrant
    ? 'matching permission grant was observed only after runtime emitted a permission handoff; headless cannot safely resume post-hoc permission requests'
    : 'headless fail-closed policy denied interactive permission request';

  const inboxItem = approvalRequestInboxItem({
    inboxItemId: input.newId(),
    request,
    createdAt: requestedAt,
  });
  await appendTaskEvent(input.store, input.taskRunId, {
    type: 'task_inbox_item_recorded',
    id: input.newId(),
    taskRunId: input.taskRunId,
    ts: requestedAt,
    item: inboxItem,
  });

  if (input.policy.mode === 'park') {
    await appendTaskEvent(input.store, input.taskRunId, {
      type: 'task_attempt_completed',
      id: input.newId(),
      taskRunId: input.taskRunId,
      ts: requestedAt,
      attemptId: input.attemptId,
      finishedAt: requestedAt,
      status: 'needs_approval',
      error: {
        message: `task run needs approval for ${request.toolName}`,
        class: 'needs_approval',
      },
    });
    if (input.closeTaskRun) {
      await appendTaskEvent(input.store, input.taskRunId, {
        type: 'task_run_needs_approval',
        id: input.newId(),
        taskRunId: input.taskRunId,
        ts: requestedAt,
        attemptId: input.attemptId,
        reason: 'approval',
        inboxItemId: inboxItem.inboxItemId,
      });
    }
    return {
      parked: true,
      invocation: input.invocation,
      resultRecord: syntheticPermissionResultRecord({
        config: input.config,
        task: input.task,
        sessionId: input.sessionId,
        runId: input.invocation.runId,
        startedAt: input.startedAt,
        finishedAt: requestedAt,
        steps: input.invocation.events.length,
        errorClass: 'needs_approval',
        error: `task run needs approval for ${request.toolName}`,
      }),
    };
  }

  await appendTaskEvent(input.store, input.taskRunId, {
    type: 'permission_decision_recorded',
    id: input.newId(),
    taskRunId: input.taskRunId,
    ts: requestedAt,
    requestId: request.requestId,
    decision: 'deny',
    source: 'ci_policy',
    decidedAt: requestedAt,
    reason: failClosedDenyReason,
  });
  await appendTaskEvent(input.store, input.taskRunId, {
    type: 'task_inbox_item_resolved',
    id: input.newId(),
    taskRunId: input.taskRunId,
    ts: requestedAt,
    inboxItemId: inboxItem.inboxItemId,
    status: 'resolved',
    resolution: {
      decision: 'deny',
      actorId: 'ci_policy',
      resolvedAt: requestedAt,
      reason: failClosedDenyReason,
    },
  });

  return { parked: false, invocation: normalizeHeadlessInvocation(input.invocation) };
}

function permissionRequestFromRuntime(input: {
  rawRequest: {
    requestId?: string;
    toolUseId?: string;
    toolName?: string;
    reason?: string;
    category?: string;
    args?: unknown;
  };
  taskRunId: string;
  attemptId: string;
  requestedAt: number;
  expiresAt: number;
}): TaskPermissionRequest {
  const args = input.rawRequest.args;
  const toolName = input.rawRequest.toolName ?? 'unknown_tool';
  const toolCallId = input.rawRequest.toolUseId ?? input.rawRequest.requestId ?? 'unknown_tool_call';
  return {
    schemaVersion: 1,
    requestId: input.rawRequest.requestId ?? `${input.taskRunId}:${input.attemptId}:${toolCallId}`,
    taskRunId: input.taskRunId,
    attemptId: input.attemptId,
    toolCallId,
    toolName,
    normalizedArgsHash: hashNormalizedArgs(args),
    resourceScope: permissionScope(toolName, args),
    reason: input.rawRequest.reason ?? input.rawRequest.category ?? 'permission required',
    preview: permissionPreview(args),
    requestedAt: input.requestedAt,
    expiresAt: input.expiresAt,
  };
}

function permissionScope(toolName: string, args: unknown): PermissionResourceScope {
  if (toolName.toLowerCase() === 'bash' && isRecord(args) && typeof args.command === 'string') {
    return commandResourceScope(args.command);
  }
  return { kind: 'tool', value: toolName, mode: 'execute' };
}

function syntheticPermissionResultRecord(input: {
  config: Config;
  task: Task;
  sessionId: string;
  runId: string;
  startedAt: number;
  finishedAt: number;
  steps: number;
  errorClass: string;
  error: string;
}): ResultRecord {
  return {
    taskId: input.task.id,
    configId: input.config.id,
    sessionId: input.sessionId,
    runId: input.runId,
    status: 'failed',
    runnerCompleted: false,
    passed: false,
    scored: false,
    eligible: false,
    excludedReason: input.error,
    exitCode: null,
    steps: input.steps,
    durationMs: input.finishedAt - input.startedAt,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    error: input.error,
    errorClass: input.errorClass,
  };
}

interface RunRuntimeAttemptInput {
  run: AgentRun;
  header: SessionHeader;
  instruction: string;
  now: () => number;
  newId: () => string;
}

async function runRuntimeAttempt(input: RunRuntimeAttemptInput): Promise<InvocationResult> {
  let begin;
  try {
    begin = await input.run.begin();
  } catch (error) {
    await input.run.recordFailure(error);
    await input.run.finalize();
    throw error;
  }

  const flow = new AiSdkFlow({
    backend: begin.backend,
    drainAfterTerminal: true,
    onSessionEvent: async (sessionEvent, runtimeEvent) => {
      await input.run.recordSessionEvent(sessionEvent);
      await input.run.recordRuntimeEvents([runtimeEvent]);
    },
    onError: async (error) => {
      await input.run.recordFailure(error);
    },
    onFinally: async () => {
      await input.run.finalize();
    },
  });
  const runner = new RuntimeRunner({
    flow,
    providers: { newId: input.newId, now: input.now },
    onInitialRuntimeEvent: (event) => input.run.recordRuntimeEvents([event]),
    stopOnTerminal: false,
  });

  const invocation = await runner.run({
    sessionId: input.header.id,
    runId: input.run.runId,
    turnId: input.run.turnId,
    text: input.instruction,
    context: begin.backendInput.context,
    ...(begin.backendInput.runtimeContext !== undefined ? { runtimeContext: begin.backendInput.runtimeContext } : {}),
    ...(begin.backendInput.attachments ? { attachments: begin.backendInput.attachments } : {}),
    source: 'test',
    lineage: input.run.lineage,
  });
  await input.run.finalize();
  return invocation;
}

type AgentRunHooks = ConstructorParameters<typeof AgentRun>[0]['hooks'];

function createSingleRunActiveSession(
  backends: BackendRegistry,
  store: SessionStore,
  now: () => number,
  newId: () => string,
): {
  hooks: AgentRunHooks;
  bindRun(run: AgentRun): void;
  dispose(): Promise<void>;
} {
  let boundRun: AgentRun | undefined;
  let active: AgentRunActiveSession | undefined;
  const bindRun = (run: AgentRun) => {
    boundRun = run;
  };
  return {
    bindRun,
    hooks: {
      ensureActive: async (sessionId, header) => {
        if (active) {
          active.cachedHeader = header;
          return active;
        }
        const backend = await backends.build(header.backend, {
          sessionId,
          workspaceRoot: header.workspaceRoot,
          header,
          store,
          recordRunTrace: (event) => boundRun?.recordRunTrace(event),
        });
        active = {
          sessionId,
          backend,
          cachedHeader: header,
          activeRuns: new Map(),
          turnToRunId: new Map(),
        };
        return active;
      },
      registerRun: (targetActive, run) => {
        targetActive.activeRuns.set(run.runId, run);
        targetActive.turnToRunId.set(run.turnId, run.runId);
      },
      unregisterRun: (targetActive, run) => {
        targetActive.activeRuns.delete(run.runId);
        if (targetActive.turnToRunId.get(run.turnId) === run.runId) {
          targetActive.turnToRunId.delete(run.turnId);
        }
      },
      updateHeader: async (sessionId, patch) => store.updateHeader(sessionId, patch),
      updateStatus: async (sessionId, status, blockedReason, ts = now()) => {
        await store.updateHeader(sessionId, statusPatch(status, ts, blockedReason));
      },
      appendTurnState: async (sessionId, turnId, status, lineage, options = {}) => {
        const ts = options.ts ?? now();
        const runLineage = lineage ?? {};
        await store.appendMessage(sessionId, {
          type: 'turn_state',
          id: newId(),
          turnId,
          ts,
          status,
          ...(runLineage.parentTurnId ? { parentTurnId: runLineage.parentTurnId } : {}),
          ...(runLineage.retriedFromTurnId ? { retriedFromTurnId: runLineage.retriedFromTurnId } : {}),
          ...(runLineage.regeneratedFromTurnId ? { regeneratedFromTurnId: runLineage.regeneratedFromTurnId } : {}),
          ...(runLineage.branchOfTurnId ? { branchOfTurnId: runLineage.branchOfTurnId } : {}),
          ...(runLineage.parentSessionId ? { parentSessionId: runLineage.parentSessionId } : {}),
          ...(status === 'aborted' ? { abortedAt: ts } : {}),
          ...(status === 'aborted' && options.abortSource ? { abortSource: options.abortSource } : {}),
          ...(status === 'failed' ? { errorClass: options.errorClass ?? 'unknown' } : {}),
          partialOutputRetained: await turnHasRetainedOutput(store, sessionId, turnId),
        });
      },
    },
    dispose: async () => {
      const backend = active?.backend;
      active = undefined;
      if (backend) await backend.dispose().catch(() => {});
    },
  };
}

function statusPatch(
  status: SessionStatus,
  ts: number,
  blockedReason?: SessionBlockedReason,
): Pick<SessionHeader, 'status' | 'blockedReason' | 'statusUpdatedAt'> {
  return {
    status,
    blockedReason: status === 'blocked' ? (blockedReason ?? 'unknown') : undefined,
    statusUpdatedAt: ts,
  };
}

async function turnHasRetainedOutput(store: SessionStore, sessionId: string, turnId: string): Promise<boolean> {
  const messages = await store.readMessages(sessionId).catch((): StoredMessage[] => []);
  return messages.some((message) =>
    (message.type === 'assistant' && message.turnId === turnId && message.text.trim().length > 0) ||
    (message.type === 'tool_result' && message.turnId === turnId),
  );
}

function resultRecordFromInvocation(input: {
  config: Config;
  task: Task;
  sessionId: string;
  invocation: InvocationResult;
  verifierResult: VerifierResult;
  finalScore: ReturnType<typeof defaultFinalScorer>;
  submittedSnapshotId: string;
  scoreResultId: string;
  startedAt: number;
  finishedAt: number;
}): ResultRecord {
  const status = input.invocation.status;
  return {
    taskId: input.task.id,
    configId: input.config.id,
    sessionId: input.sessionId,
    runId: input.invocation.runId,
    status,
    runnerCompleted: status === 'completed',
    passed: input.finalScore.passed,
    scored: input.finalScore.scored,
    eligible: input.finalScore.eligible,
    ...(input.finalScore.excludedReason ? { excludedReason: input.finalScore.excludedReason } : {}),
    verifierKind: input.verifierResult.kind,
    verifierResultId: input.verifierResult.id,
    scoreResultId: input.scoreResultId,
    submittedSnapshotId: input.submittedSnapshotId,
    exitCode: input.verifierResult.exitCode ?? null,
    steps: input.invocation.events.length,
    durationMs: input.finishedAt - input.startedAt,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    ...(input.finalScore.errorClass ? { errorClass: input.finalScore.errorClass } : {}),
    ...(!input.finalScore.scored && input.finalScore.errorClass
      ? { error: input.finalScore.excludedReason ?? input.invocation.failure?.message ?? input.finalScore.errorClass }
      : status === 'failed'
      ? {
          error: input.invocation.failure?.message ?? input.invocation.failure?.class ?? 'run did not complete',
        }
      : {}),
  };
}

function normalizeHeadlessInvocation(invocation: InvocationResult): InvocationResult {
  const permissionRequestEvent = invocation.events.find((event) => event.actions?.permissionRequest);
  if (!permissionRequestEvent) return invocation;

  const request = permissionRequestEvent.actions?.permissionRequest;
  return {
    ...invocation,
    status: 'failed',
    failure: {
      class: 'policy_denied',
      message: request?.requestId
        ? `headless task run cannot satisfy permission request ${request.requestId}`
        : 'headless task run cannot satisfy an interactive permission request',
    },
  };
}

interface RuntimeSummary {
  runtimeRefs: {
    invocationId: string;
    sessionId: string;
    runId: string;
    turnId: string;
    runtimeEventIds: string[];
  };
  artifactRefs: Array<Record<string, unknown>>;
  isolation: Record<string, unknown>;
  budget: Record<string, unknown>;
}

function summarizeRuntime(invocation: InvocationResult, isolation: RunExperimentDeps['realBackendIsolation']): RuntimeSummary {
  return {
    runtimeRefs: {
      invocationId: invocation.invocationId,
      sessionId: invocation.sessionId,
      runId: invocation.runId,
      turnId: invocation.turnId,
      runtimeEventIds: invocation.events.map((event) => event.id),
    },
    artifactRefs: collectArtifactRefs(invocation.events),
    isolation: isolation ? { kind: isolation.kind, label: isolation.label } : { kind: 'inert_fake_backend' },
    budget: summarizeBudget(invocation),
  };
}

async function appendRuntimeFeedback(
  store: TaskRunStore,
  taskRunId: string,
  attemptId: string,
  now: () => number,
  newId: () => string,
  summary: RuntimeSummary,
): Promise<void> {
  const ts = now();
  const observation: FeedbackObservation = {
    id: newId(),
    taskRunId,
    attemptId,
    ts,
    source: 'runtime',
    summary: 'runtime invocation completed',
    details: { ...summary },
  };
  await appendTaskEvent(store, taskRunId, {
    type: 'feedback_observed',
    id: newId(),
    taskRunId,
    ts,
    observation,
  });
}

function collectArtifactRefs(events: readonly RuntimeEvent[]): Array<Record<string, unknown>> {
  const refs: Array<Record<string, unknown>> = [];
  for (const event of events) {
    if (event.refs?.artifactId) {
      refs.push({ runtimeEventId: event.id, artifactId: event.refs.artifactId });
    }
    if (event.actions?.artifactDelta) {
      refs.push({ runtimeEventId: event.id, artifactDelta: event.actions.artifactDelta });
    }
    const result = event.content?.kind === 'function_response' ? event.content.result : undefined;
    if (isRecord(result) && typeof result.artifactId === 'string') {
      refs.push({
        runtimeEventId: event.id,
        artifactId: result.artifactId,
        toolCallId: event.refs?.toolCallId,
      });
    }
  }
  return refs;
}

function summarizeBudget(invocation: InvocationResult): Record<string, unknown> {
  const totals = {
    input: 0,
    output: 0,
    reasoning: 0,
    total: 0,
    costUsd: 0,
  };
  const contextBudget: unknown[] = [];
  const rawFinishReasons: string[] = [];
  for (const event of invocation.events) {
    const usage = event.actions?.tokenUsage;
    if (!usage) continue;
    totals.input += usage.input ?? 0;
    totals.output += usage.output ?? 0;
    totals.reasoning += usage.reasoning ?? 0;
    totals.total += usage.total ?? 0;
    totals.costUsd += usage.costUsd ?? 0;
    if (usage.contextBudget) contextBudget.push(usage.contextBudget);
    if (usage.rawFinishReason) rawFinishReasons.push(usage.rawFinishReason);
  }
  return {
    totals,
    ...(contextBudget.length > 0 ? { contextBudget } : {}),
    ...(rawFinishReasons.length > 0 ? { rawFinishReasons } : {}),
    ...(invocation.failure?.class ? { failureClass: invocation.failure.class } : {}),
  };
}

function attemptStatusFromResult(
  status: ResultRecord['status'],
  taxonomy: AutonomousResultTaxonomy,
): Exclude<TaskAttemptStatus, 'running'> {
  if (status === 'completed') return 'completed';
  switch (taxonomy) {
    case 'agent_incomplete':
      return 'incomplete';
    case 'blocked':
      return 'blocked';
    case 'policy_denied':
      return 'policy_denied';
    case 'budget_exhausted':
      return 'budget_exhausted';
    case 'aborted':
      return 'aborted';
    case 'cancelled':
      return 'cancelled';
    case 'passed':
    case 'verification_failed':
    case 'verification_error':
    case 'agent_failed':
    case 'invalid_setup':
    case 'unsupported_adapter':
    case 'isolation_required':
    case 'setup_failed':
    case 'infra_failed':
      return 'failed';
  }
}

function terminalEventFromResult(
  record: ResultRecord,
  taxonomy: AutonomousResultTaxonomy,
  result: TaskRunResult,
  taskRunId: string,
  eventId: () => string,
): TaskEvent {
  const base = { id: eventId(), taskRunId, ts: record.finishedAt, finishedAt: record.finishedAt };
  if (record.status === 'completed') {
    return { type: 'task_run_completed', ...base, result };
  }

  const error = errorFromResultRecord(record, taxonomy);
  switch (taxonomy) {
    case 'agent_incomplete':
      return { type: 'task_run_incomplete', ...base, error };
    case 'blocked':
      return { type: 'task_run_blocked', ...base, error };
    case 'policy_denied':
      return { type: 'task_run_policy_denied', ...base, error };
    case 'budget_exhausted':
      return { type: 'task_run_budget_exhausted', ...base, error };
    case 'aborted':
      return { type: 'task_run_aborted', ...base, error };
    case 'cancelled':
      return { type: 'task_run_cancelled', ...base, error };
    case 'passed':
    case 'verification_failed':
    case 'verification_error':
    case 'agent_failed':
    case 'invalid_setup':
    case 'unsupported_adapter':
    case 'isolation_required':
    case 'setup_failed':
    case 'infra_failed':
      return { type: 'task_run_failed', ...base, error };
  }
}

function errorFromResultRecord(record: ResultRecord, taxonomy: AutonomousResultTaxonomy): TaskRunError {
  return {
    message: record.error ?? errorMessageFromTaxonomy(taxonomy),
    ...(record.errorClass ? { class: record.errorClass } : {}),
  };
}

function errorMessageFromTaxonomy(taxonomy: AutonomousResultTaxonomy): string {
  switch (taxonomy) {
    case 'agent_failed':
      return 'agent run failed';
    case 'agent_incomplete':
      return 'agent run incomplete';
    case 'invalid_setup':
      return 'invalid setup';
    case 'unsupported_adapter':
      return 'unsupported verifier adapter';
    case 'isolation_required':
      return 'isolated executor required';
    case 'setup_failed':
      return 'task setup failed';
    case 'infra_failed':
      return 'infrastructure failed';
    case 'verification_error':
      return 'verification errored';
    case 'policy_denied':
      return 'task run denied by policy';
    case 'budget_exhausted':
      return 'task run budget exhausted';
    case 'aborted':
      return 'task run aborted';
    case 'blocked':
      return 'task run blocked';
    case 'cancelled':
      return 'task run cancelled';
    case 'verification_failed':
      return 'verification failed';
    case 'passed':
      return 'task run failed';
  }
}

function appendTaskEvent(store: TaskRunStore, taskRunId: string, event: TaskEvent): Promise<void> {
  return store.appendEvent(taskRunId, event);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
