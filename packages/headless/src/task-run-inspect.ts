import type { AgentRunHeader, RuntimeEvent } from '@maka/core';
import type {
  ExecutionEvidenceRef,
  ExecutionIdentityRef,
  ExecutionLogCoverage,
  WorkspaceRevisionRef,
} from '@maka/core/execution-evidence';
import {
  inspectAgentRunReadModel,
  type AgentRunInspectReader,
  type AgentRunInspectDiagnostic,
  type AgentRunInspectSourceHealth,
  type RuntimeEventInspectReader,
} from '@maka/runtime/agent-run-inspect';
import {
  validateHistoryCompactCheckpointShape,
  type HistoryCompactCheckpoint,
} from '@maka/runtime';
import { isStorageRootAuthorityError } from './headless-storage.js';
import {
  isTerminalTaskRunStatus,
  type HeavyTaskSelfCheckProjection,
  type TaskAttempt,
} from './task-contracts.js';
import { projectTaskRun, type TaskRunProjection } from './task-run-projection.js';
import type { TaskRunReader } from './task-run-store.js';

export const TASK_RUN_INSPECT_SCHEMA_VERSION = 'maka.task_run_inspect.v1' as const;

export type TaskRunInspectSeverity = 'error' | 'warning' | 'info';

export type TaskRunInspectDiagnosticCode =
  | 'task_projection_warning'
  | 'attempt_execution_missing'
  | 'execution_identity_missing'
  | 'agent_run_unavailable'
  | 'agent_run_source_diagnostic'
  | 'runtime_coverage_unknown'
  | 'runtime_coverage_source_missing'
  | 'runtime_coverage_mismatch'
  | 'tool_response_missing'
  | 'tool_call_missing'
  | 'self_check_stale'
  | 'self_check_source_unknown'
  | 'compaction_checkpoint_invalid';

export interface TaskRunInspectDiagnostic {
  severity: TaskRunInspectSeverity;
  code: TaskRunInspectDiagnosticCode;
  message: string;
  taskRunId: string;
  attemptId?: string;
  sessionId?: string;
  agentRunId?: string;
  eventId?: string;
  detail?: Record<string, unknown>;
}

export interface TaskRunInspectSummary {
  taskRunId: string;
  taskId: string;
  configId: string;
  status: TaskRunProjection['status'];
  terminal: boolean;
  attemptCount: number;
  eventCount: number;
  startedAt?: number;
  finishedAt?: number;
  result?: {
    passed: boolean;
    taxonomy: string;
  };
  errorClass?: string;
  parked?: TaskRunProjection['parked'];
}

export interface TaskRunInspectTaskEventSource {
  eventCount: number;
  coverage?: ExecutionLogCoverage;
}

export type TaskRunInspectCoverageStatus = 'matched' | 'unknown' | 'source_missing' | 'mismatch';

export interface TaskRunInspectToolFact {
  toolCallId: string;
  toolName: string;
  eventId: string;
}

export interface TaskRunInspectToolSummary {
  callCount: number;
  responseCount: number;
  errorResponseCount: number;
  callsWithoutResponse: TaskRunInspectToolFact[];
  responsesWithoutCall: TaskRunInspectToolFact[];
}

export interface TaskRunInspectCompactionCheckpoint {
  eventId: string;
  validation: 'shape_valid' | 'invalid';
  checkpointId?: string;
  policyVersion?: string;
  sourceCoverage?: ExecutionLogCoverage;
}

export interface TaskRunInspectAgentRun {
  identity?: ExecutionIdentityRef;
  status?: AgentRunHeader['status'];
  claimedCoverage?: ExecutionLogCoverage;
  observedCoverage?: ExecutionLogCoverage;
  coverageStatus: TaskRunInspectCoverageStatus;
  runtimeEventCount: number;
  sourceHealth?: AgentRunInspectSourceHealth;
  tools: TaskRunInspectToolSummary;
  compactionCheckpoints: TaskRunInspectCompactionCheckpoint[];
}

export interface TaskRunInspectSelfCheck {
  selfCheckId: string;
  status: HeavyTaskSelfCheckProjection['status'];
  freshness: HeavyTaskSelfCheckProjection['freshness'];
  freshnessReasons: HeavyTaskSelfCheckProjection['freshnessReasons'];
  workspace?: WorkspaceRevisionRef;
  runtimeCoverage?: ExecutionLogCoverage;
  taskCoverage?: ExecutionLogCoverage;
}

export interface TaskRunInspectAttempt {
  attemptId: string;
  status: TaskAttempt['status'];
  startedAt: number;
  finishedAt?: number;
  agentRuns: TaskRunInspectAgentRun[];
  selfChecks: TaskRunInspectSelfCheck[];
}

export interface TaskRunInspectDocument {
  schemaVersion: typeof TASK_RUN_INSPECT_SCHEMA_VERSION;
  kind: 'task_run';
  taskRun: TaskRunInspectSummary;
  taskEventSource: TaskRunInspectTaskEventSource;
  attempts: TaskRunInspectAttempt[];
  unscopedSelfChecks: TaskRunInspectSelfCheck[];
  diagnostics: TaskRunInspectDiagnostic[];
}

export interface InspectTaskRunDependencies {
  taskRunStore: TaskRunReader;
  agentRunStore: AgentRunInspectReader;
  runtimeEventStore: RuntimeEventInspectReader;
}

export async function inspectTaskRun(
  dependencies: InspectTaskRunDependencies,
  taskRunId: string,
): Promise<TaskRunInspectDocument> {
  const records = await dependencies.taskRunStore.readEventRecords(taskRunId);
  // Project the exact rows whose source coverage is reported below. Calling
  // `project()` separately could observe a later append and produce a read
  // model whose advertised Task high water is already stale.
  const projection = projectTaskRun(
    records.map((record) => record.event),
    taskRunId,
  );
  const diagnostics: TaskRunInspectDiagnostic[] = projection.warnings.map((message) => ({
    severity: 'warning',
    code: 'task_projection_warning',
    message,
    taskRunId,
  }));
  const attempts: TaskRunInspectAttempt[] = [];
  const attemptIds = new Set(projection.attempts.map((attempt) => attempt.attemptId));

  for (const attempt of projection.attempts) {
    const agentRuns: TaskRunInspectAgentRun[] = [];
    if (attempt.executionLineage.length === 0) {
      diagnostics.push(
        diagnostic(
          taskRunId,
          'attempt_execution_missing',
          'warning',
          'Attempt has no durable AgentRun execution link.',
          { attemptId: attempt.attemptId },
        ),
      );
    }
    for (const evidence of attempt.executionLineage) {
      agentRuns.push(
        await inspectLinkedAgentRun(
          dependencies,
          taskRunId,
          attempt.attemptId,
          evidence,
          diagnostics,
        ),
      );
    }
    const selfChecks = projection.heavyTaskSelfChecks
      .filter((selfCheck) => selfCheck.attemptId === attempt.attemptId)
      .map((selfCheck) => inspectSelfCheck(taskRunId, attempt.attemptId, selfCheck, diagnostics));
    attempts.push({
      attemptId: attempt.attemptId,
      status: attempt.status,
      startedAt: attempt.startedAt,
      ...(attempt.finishedAt !== undefined ? { finishedAt: attempt.finishedAt } : {}),
      agentRuns,
      selfChecks,
    });
  }

  return {
    schemaVersion: TASK_RUN_INSPECT_SCHEMA_VERSION,
    kind: 'task_run',
    taskRun: taskRunSummary(projection),
    taskEventSource: taskEventSource(records),
    attempts,
    unscopedSelfChecks: projection.heavyTaskSelfChecks
      .filter((selfCheck) => !selfCheck.attemptId || !attemptIds.has(selfCheck.attemptId))
      .map((selfCheck) => inspectSelfCheck(taskRunId, selfCheck.attemptId, selfCheck, diagnostics)),
    diagnostics,
  };
}

async function inspectLinkedAgentRun(
  dependencies: InspectTaskRunDependencies,
  taskRunId: string,
  attemptId: string,
  evidence: ExecutionEvidenceRef,
  diagnostics: TaskRunInspectDiagnostic[],
): Promise<TaskRunInspectAgentRun> {
  const identity = evidence.execution;
  if (!identity?.sessionId || !identity.agentRunId) {
    diagnostics.push(
      diagnostic(
        taskRunId,
        'execution_identity_missing',
        'warning',
        'Execution link does not identify an AgentRun; source facts remain unknown.',
        { attemptId },
      ),
    );
    return emptyAgentRun(identity, evidence.runtimeCoverage);
  }

  const refs = { attemptId, sessionId: identity.sessionId, agentRunId: identity.agentRunId };
  try {
    const inspected = await inspectAgentRunReadModel(
      dependencies.agentRunStore,
      dependencies.runtimeEventStore,
      {
        sessionId: identity.sessionId,
        runId: identity.agentRunId,
        isFatalReadError: isStorageRootAuthorityError,
      },
    );
    for (const sourceDiagnostic of inspected.diagnostics) {
      diagnostics.push(agentRunDiagnostic(taskRunId, refs, sourceDiagnostic));
    }
    const observedCoverage = runtimeCoverage(identity.agentRunId, inspected.runtimeEvents);
    const coverageStatus = inspectRuntimeCoverage(
      taskRunId,
      refs,
      evidence.runtimeCoverage,
      inspected.runtimeEvents,
      diagnostics,
    );
    const tools = inspectToolFacts(taskRunId, refs, inspected.runtimeEvents, diagnostics);
    const compactionCheckpoints = inspectCompactionCheckpoints(
      taskRunId,
      refs,
      inspected.events,
      diagnostics,
    );
    return {
      identity,
      status: inspected.header.status,
      ...(evidence.runtimeCoverage ? { claimedCoverage: evidence.runtimeCoverage } : {}),
      ...(observedCoverage ? { observedCoverage } : {}),
      coverageStatus,
      runtimeEventCount: inspected.runtimeEvents.length,
      sourceHealth: inspected.sourceHealth,
      tools,
      compactionCheckpoints,
    };
  } catch (error) {
    if (isStorageRootAuthorityError(error)) throw error;
    diagnostics.push(
      diagnostic(
        taskRunId,
        'agent_run_unavailable',
        'error',
        'Linked AgentRun could not be read.',
        {
          ...refs,
          detail: { error: errorMessage(error) },
        },
      ),
    );
    if (evidence.runtimeCoverage) {
      diagnostics.push(
        diagnostic(
          taskRunId,
          'runtime_coverage_source_missing',
          'error',
          'Claimed Runtime coverage cannot be checked because its AgentRun source is unavailable.',
          refs,
        ),
      );
    }
    return emptyAgentRun(identity, evidence.runtimeCoverage, 'source_missing');
  }
}

function inspectRuntimeCoverage(
  taskRunId: string,
  refs: Pick<TaskRunInspectDiagnostic, 'attemptId' | 'sessionId' | 'agentRunId'>,
  claimed: ExecutionLogCoverage | undefined,
  events: readonly RuntimeEvent[],
  diagnostics: TaskRunInspectDiagnostic[],
): TaskRunInspectCoverageStatus {
  if (!claimed) {
    diagnostics.push(
      diagnostic(
        taskRunId,
        'runtime_coverage_unknown',
        'info',
        'Execution identity is known, but this legacy link has no Runtime Event coverage.',
        refs,
      ),
    );
    return 'unknown';
  }
  if (events.length === 0) {
    diagnostics.push(
      diagnostic(
        taskRunId,
        'runtime_coverage_source_missing',
        'error',
        'Claimed Runtime coverage has no readable source events.',
        refs,
      ),
    );
    return 'source_missing';
  }
  const lowSequence = claimed.lowWater?.sequence ?? 0;
  const highSequence = claimed.highWater.sequence;
  const low = events[lowSequence];
  const high = events[highSequence];
  const observedCount = highSequence >= lowSequence ? highSequence - lowSequence + 1 : 0;
  const matches =
    claimed.highWater.ledger === 'runtime_event' &&
    claimed.highWater.streamId === refs.agentRunId &&
    (!claimed.lowWater ||
      (claimed.lowWater.ledger === 'runtime_event' &&
        claimed.lowWater.streamId === refs.agentRunId)) &&
    low !== undefined &&
    high !== undefined &&
    (!claimed.lowWater?.eventId || claimed.lowWater.eventId === low.id) &&
    (!claimed.highWater.eventId || claimed.highWater.eventId === high.id) &&
    (claimed.eventCount === undefined || claimed.eventCount === observedCount);
  if (matches) return 'matched';
  diagnostics.push(
    diagnostic(
      taskRunId,
      'runtime_coverage_mismatch',
      'error',
      'Claimed Runtime coverage does not match the observed AgentRun ledger boundaries.',
      {
        ...refs,
        detail: {
          claimedLow: claimed.lowWater,
          claimedHigh: claimed.highWater,
          claimedEventCount: claimed.eventCount,
          observedLowEventId: low?.id,
          observedHighEventId: high?.id,
          observedEventCount: observedCount,
        },
      },
    ),
  );
  return 'mismatch';
}

function inspectToolFacts(
  taskRunId: string,
  refs: Pick<TaskRunInspectDiagnostic, 'attemptId' | 'sessionId' | 'agentRunId'>,
  events: readonly RuntimeEvent[],
  diagnostics: TaskRunInspectDiagnostic[],
): TaskRunInspectToolSummary {
  const calls = new Map<string, TaskRunInspectToolFact>();
  const responses = new Map<string, TaskRunInspectToolFact & { isError: boolean }>();
  for (const event of events) {
    if (event.content?.kind === 'function_call') {
      calls.set(event.content.id, {
        toolCallId: event.content.id,
        toolName: event.content.name,
        eventId: event.id,
      });
    } else if (event.content?.kind === 'function_response') {
      responses.set(event.content.id, {
        toolCallId: event.content.id,
        toolName: event.content.name,
        eventId: event.id,
        isError: event.content.isError === true,
      });
    }
  }
  const callsWithoutResponse = [...calls.values()].filter(
    (call) => !responses.has(call.toolCallId),
  );
  const responsesWithoutCall = [...responses.values()]
    .filter((response) => !calls.has(response.toolCallId))
    .map(({ isError: _isError, ...response }) => response);
  for (const call of callsWithoutResponse) {
    diagnostics.push(
      diagnostic(
        taskRunId,
        'tool_response_missing',
        'warning',
        `Tool Call ${call.toolCallId} has no committed Runtime response; its outcome and external side effects are unknown.`,
        {
          ...refs,
          eventId: call.eventId,
          detail: { toolCallId: call.toolCallId, toolName: call.toolName },
        },
      ),
    );
  }
  for (const response of responsesWithoutCall) {
    diagnostics.push(
      diagnostic(
        taskRunId,
        'tool_call_missing',
        'warning',
        `Tool response ${response.toolCallId} has no matching Runtime call fact.`,
        {
          ...refs,
          eventId: response.eventId,
          detail: { toolCallId: response.toolCallId, toolName: response.toolName },
        },
      ),
    );
  }
  return {
    callCount: calls.size,
    responseCount: responses.size,
    errorResponseCount: [...responses.values()].filter((response) => response.isError).length,
    callsWithoutResponse,
    responsesWithoutCall,
  };
}

function inspectCompactionCheckpoints(
  taskRunId: string,
  refs: Pick<TaskRunInspectDiagnostic, 'attemptId' | 'sessionId' | 'agentRunId'>,
  events: readonly { type: string; id: string; data?: Record<string, unknown> }[],
  diagnostics: TaskRunInspectDiagnostic[],
): TaskRunInspectCompactionCheckpoint[] {
  const checkpoints: TaskRunInspectCompactionCheckpoint[] = [];
  for (const event of events) {
    if (event.type !== 'history_compact_checkpoint_recorded') continue;
    const checkpoint = event.data?.checkpoint;
    if (!validateHistoryCompactCheckpointShape(checkpoint, refs.sessionId)) {
      diagnostics.push(
        diagnostic(
          taskRunId,
          'compaction_checkpoint_invalid',
          'error',
          'AgentRun contains an invalid durable Compaction checkpoint record.',
          { ...refs, eventId: event.id },
        ),
      );
      checkpoints.push({ eventId: event.id, validation: 'invalid' });
      continue;
    }
    const valid = checkpoint as HistoryCompactCheckpoint;
    checkpoints.push({
      eventId: event.id,
      validation: 'shape_valid',
      checkpointId: valid.checkpointId,
      ...(valid.source?.policyVersion ? { policyVersion: valid.source.policyVersion } : {}),
      ...(valid.source?.coverage ? { sourceCoverage: valid.source.coverage } : {}),
    });
  }
  return checkpoints;
}

function inspectSelfCheck(
  taskRunId: string,
  attemptId: string | undefined,
  selfCheck: HeavyTaskSelfCheckProjection,
  diagnostics: TaskRunInspectDiagnostic[],
): TaskRunInspectSelfCheck {
  if (selfCheck.freshness === 'stale') {
    diagnostics.push(
      diagnostic(
        taskRunId,
        'self_check_stale',
        'warning',
        `Self-check ${selfCheck.selfCheckId} is stale.`,
        {
          ...(attemptId ? { attemptId } : {}),
          detail: { freshnessReasons: selfCheck.freshnessReasons },
        },
      ),
    );
  } else if (selfCheck.freshness === 'unknown') {
    diagnostics.push(
      diagnostic(
        taskRunId,
        'self_check_source_unknown',
        'info',
        `Self-check ${selfCheck.selfCheckId} has no fully validated source binding.`,
        {
          ...(attemptId ? { attemptId } : {}),
          detail: { freshnessReasons: selfCheck.freshnessReasons },
        },
      ),
    );
  }
  return {
    selfCheckId: selfCheck.selfCheckId,
    status: selfCheck.status,
    freshness: selfCheck.freshness,
    freshnessReasons: [...selfCheck.freshnessReasons],
    ...(selfCheck.provenance?.workspace ? { workspace: selfCheck.provenance.workspace } : {}),
    ...(selfCheck.provenance?.runtimeCoverage
      ? { runtimeCoverage: selfCheck.provenance.runtimeCoverage }
      : {}),
    ...(selfCheck.provenance?.taskCoverage
      ? { taskCoverage: selfCheck.provenance.taskCoverage }
      : {}),
  };
}

export function renderTaskRunInspectTree(document: TaskRunInspectDocument): string {
  const hasRootTail =
    document.attempts.length > 0 ||
    document.unscopedSelfChecks.length > 0 ||
    document.diagnostics.length > 0;
  const lines = [
    `TaskRun ${document.taskRun.taskRunId} [${document.taskRun.status}]`,
    `${hasRootTail ? '├─' : '└─'} Task Events ${formatCoverage(document.taskEventSource.coverage)} (${document.taskEventSource.eventCount})`,
  ];
  document.attempts.forEach((attempt, attemptIndex) => {
    const isLastRootNode =
      attemptIndex === document.attempts.length - 1 &&
      document.unscopedSelfChecks.length === 0 &&
      document.diagnostics.length === 0;
    const rootBranch = isLastRootNode ? '└─' : '├─';
    const childPrefix = isLastRootNode ? '   ' : '│  ';
    lines.push(`${rootBranch} Attempt ${attempt.attemptId} [${attempt.status}]`);
    const attemptChildCount = attempt.agentRuns.length + attempt.selfChecks.length;
    if (attemptChildCount === 0) lines.push(`${childPrefix}└─ No linked execution facts`);
    let attemptChildIndex = 0;
    for (const agentRun of attempt.agentRuns) {
      attemptChildIndex += 1;
      const lastAgent = attemptChildIndex === attemptChildCount;
      const detailPrefix = `${childPrefix}${lastAgent ? '   ' : '│  '}`;
      lines.push(
        `${childPrefix}${lastAgent ? '└─' : '├─'} AgentRun ${agentRun.identity?.agentRunId ?? 'unknown'} [${agentRun.status ?? 'unknown'}]`,
      );
      const details = [
        `Runtime Events ${formatCoverage(agentRun.claimedCoverage)} [${agentRun.coverageStatus}]`,
        `Tool Calls ${agentRun.tools.callCount} / Responses ${agentRun.tools.responseCount}`,
        ...agentRun.compactionCheckpoints.map(
          (checkpoint) =>
            `Compaction ${checkpoint.checkpointId ?? checkpoint.eventId} ${formatCoverage(checkpoint.sourceCoverage)} [${checkpoint.validation}]`,
        ),
      ];
      details.forEach((detail, index) => {
        lines.push(`${detailPrefix}${index === details.length - 1 ? '└─' : '├─'} ${detail}`);
      });
    }
    for (const selfCheck of attempt.selfChecks) {
      attemptChildIndex += 1;
      const lastSelfCheck = attemptChildIndex === attemptChildCount;
      lines.push(
        `${childPrefix}${lastSelfCheck ? '└─' : '├─'} Self-check ${selfCheck.selfCheckId} [${selfCheck.status}; ${selfCheck.freshness}]`,
      );
      if (selfCheck.workspace) {
        const detailPrefix = `${childPrefix}${lastSelfCheck ? '   ' : '│  '}`;
        lines.push(
          `${detailPrefix}└─ Workspace ${selfCheck.workspace.kind}:${selfCheck.workspace.ref}`,
        );
      }
    }
  });
  document.unscopedSelfChecks.forEach((selfCheck, index) => {
    const isLast =
      index === document.unscopedSelfChecks.length - 1 && document.diagnostics.length === 0;
    lines.push(
      `${isLast ? '└─' : '├─'} Self-check ${selfCheck.selfCheckId} [${selfCheck.status}; ${selfCheck.freshness}] (unscoped)`,
    );
  });
  if (document.diagnostics.length > 0) {
    lines.push(`└─ Diagnostics (${document.diagnostics.length})`);
    document.diagnostics.forEach((item, index) => {
      lines.push(
        `   ${index === document.diagnostics.length - 1 ? '└─' : '├─'} ${item.severity.toUpperCase()} ${item.code}: ${item.message}`,
      );
    });
  }
  return `${lines.join('\n')}\n`;
}

function taskRunSummary(projection: TaskRunProjection): TaskRunInspectSummary {
  return {
    taskRunId: projection.taskRunId,
    taskId: projection.taskId,
    configId: projection.configId,
    status: projection.status,
    terminal: isTerminalTaskRunStatus(projection.status),
    attemptCount: projection.attempts.length,
    eventCount: projection.events.length,
    ...(projection.startedAt !== undefined ? { startedAt: projection.startedAt } : {}),
    ...(projection.finishedAt !== undefined ? { finishedAt: projection.finishedAt } : {}),
    ...(projection.result
      ? {
          result: {
            passed: projection.result.passed,
            taxonomy: projection.result.taxonomy,
          },
        }
      : {}),
    ...(projection.error?.class ? { errorClass: projection.error.class } : {}),
    ...(projection.parked ? { parked: projection.parked } : {}),
  };
}

function taskEventSource(
  records: Awaited<ReturnType<TaskRunReader['readEventRecords']>>,
): TaskRunInspectTaskEventSource {
  const first = records[0]?.cursor;
  const last = records.at(-1)?.cursor;
  return {
    eventCount: records.length,
    ...(first && last
      ? { coverage: { lowWater: first, highWater: last, eventCount: records.length } }
      : {}),
  };
}

function runtimeCoverage(
  runId: string,
  events: readonly RuntimeEvent[],
): ExecutionLogCoverage | undefined {
  const first = events[0];
  const last = events.at(-1);
  if (!first || !last) return undefined;
  return {
    lowWater: { ledger: 'runtime_event', streamId: runId, sequence: 0, eventId: first.id },
    highWater: {
      ledger: 'runtime_event',
      streamId: runId,
      sequence: events.length - 1,
      eventId: last.id,
    },
    eventCount: events.length,
  };
}

function emptyAgentRun(
  identity: ExecutionIdentityRef | undefined,
  claimedCoverage?: ExecutionLogCoverage,
  coverageStatus: TaskRunInspectCoverageStatus = 'unknown',
): TaskRunInspectAgentRun {
  return {
    ...(identity ? { identity } : {}),
    ...(claimedCoverage ? { claimedCoverage } : {}),
    coverageStatus,
    runtimeEventCount: 0,
    tools: {
      callCount: 0,
      responseCount: 0,
      errorResponseCount: 0,
      callsWithoutResponse: [],
      responsesWithoutCall: [],
    },
    compactionCheckpoints: [],
  };
}

function agentRunDiagnostic(
  taskRunId: string,
  refs: Pick<TaskRunInspectDiagnostic, 'attemptId' | 'sessionId' | 'agentRunId'>,
  source: AgentRunInspectDiagnostic,
): TaskRunInspectDiagnostic {
  const severity: TaskRunInspectSeverity = /read_failed|corrupt|mismatch/.test(source.code)
    ? 'error'
    : 'warning';
  return diagnostic(taskRunId, 'agent_run_source_diagnostic', severity, source.message, {
    ...refs,
    ...(source.eventId ? { eventId: source.eventId } : {}),
    // Runtime read-model details may contain the offending RuntimeEvent. The
    // inspect contract reports the stable diagnostic code and event pointer,
    // never copies model or tool payloads into a second evidence surface.
    detail: { sourceCode: source.code },
  });
}

function diagnostic(
  taskRunId: string,
  code: TaskRunInspectDiagnosticCode,
  severity: TaskRunInspectSeverity,
  message: string,
  refs: Partial<Omit<TaskRunInspectDiagnostic, 'taskRunId' | 'code' | 'severity' | 'message'>> = {},
): TaskRunInspectDiagnostic {
  return { severity, code, message, taskRunId, ...refs };
}

function formatCoverage(coverage: ExecutionLogCoverage | undefined): string {
  if (!coverage) return 'unknown';
  const low = coverage.lowWater?.sequence ?? 0;
  return `${coverage.highWater.ledger}:${coverage.highWater.streamId} ${low}–${coverage.highWater.sequence}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
