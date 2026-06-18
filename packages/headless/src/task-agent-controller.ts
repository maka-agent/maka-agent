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
import { validateRealBackendIsolation } from './isolation.js';
import { prepareWorkspace, restoreProtectedPaths } from './sandbox.js';
import { runVerification } from './evaluator.js';
import {
  backendNeedsIsolation,
  type RunExperimentDeps,
  validateTaskVerification,
} from './runner.js';
import {
  taxonomyFromResultRecord,
  type AutonomousResultTaxonomy,
  type FeedbackObservation,
  type ScoreResult,
  type TaskAttemptStatus,
  type TaskEvent,
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
  permissionMode?: 'execute';
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
  if (backendNeedsIsolation(config.backend)) {
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
  const taskRunStore = deps.taskRunStore ?? createTaskRunStore(deps.storageRoot);
  const sessionStore = deps.sessionStore ?? createSessionStore(deps.storageRoot);
  const agentRunStore = deps.agentRunStore ?? createAgentRunStore(deps.storageRoot);
  const runtimeEventStore = deps.runtimeEventStore ?? createRuntimeEventStore(deps.storageRoot);
  const startedAt = now();

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

  const workspace = await prepareWorkspace(task.workspaceDir);
  try {
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
      userInput: { turnId, text: task.instruction },
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
        task,
        header,
        now,
        newId,
      });
    } finally {
      await active.dispose();
    }
    const invocation = normalizeHeadlessInvocation(runtimeInvocation);

    const runtimeSummary = summarizeRuntime(invocation, deps.realBackendIsolation);
    await appendRuntimeFeedback(taskRunStore, taskRunId, attemptId, now, newId, runtimeSummary);

    await appendTaskEvent(taskRunStore, taskRunId, {
      type: 'task_run_verifying',
      id: newId(),
      taskRunId,
      ts: now(),
      startedAt: now(),
    });
    await restoreProtectedPaths(task.workspaceDir, workspace.dir, task.verification.protectedPaths);
    const evaluation = await runVerification(
      task.verification.command,
      workspace.dir,
      task.verification.timeoutMs,
    );

    const finishedAt = now();
    const resultRecord = resultRecordFromInvocation({
      config,
      task,
      sessionId: header.id,
      invocation,
      evaluation,
      startedAt,
      finishedAt,
    });
    const taxonomy = taxonomyFromResultRecord(resultRecord);
    const verifierResult: VerifierResult = {
      id: newId(),
      taskRunId,
      attemptId,
      ts: finishedAt,
      kind: 'command',
      passed: resultRecord.status === 'completed' && evaluation.passed,
      exitCode: evaluation.exitCode,
      command: task.verification.command,
      ...(evaluation.timedOut ? { error: 'verification timed out' } : {}),
    };
    const scoreResult: ScoreResult = {
      id: newId(),
      taskRunId,
      attemptId,
      ts: finishedAt,
      passed: resultRecord.status === 'completed' && evaluation.passed,
      taxonomy,
      details: {
        steps: resultRecord.steps,
        invocationStatus: invocation.status,
        ...(invocation.failure?.class ? { runtimeFailureClass: invocation.failure.class } : {}),
        verifierExitCode: evaluation.exitCode,
        runtimeRefs: runtimeSummary.runtimeRefs,
        artifactRefs: runtimeSummary.artifactRefs,
        isolation: runtimeSummary.isolation,
        budget: runtimeSummary.budget,
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
    await appendTaskEvent(
      taskRunStore,
      taskRunId,
      terminalEventFromResult(resultRecord, taxonomy, runResult, taskRunId, newId),
    );

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

interface RunRuntimeAttemptInput {
  run: AgentRun;
  task: Task;
  header: SessionHeader;
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
    text: input.task.instruction,
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
  evaluation: Awaited<ReturnType<typeof runVerification>>;
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
    passed: status === 'completed' && input.evaluation.passed,
    exitCode: input.evaluation.exitCode,
    steps: input.invocation.events.length,
    durationMs: input.finishedAt - input.startedAt,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    ...(status === 'failed'
      ? {
          error: input.invocation.failure?.message ?? input.invocation.failure?.class ?? 'run did not complete',
          ...(input.invocation.failure?.class ? { errorClass: input.invocation.failure.class } : {}),
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
