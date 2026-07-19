/**
 * Shared identity and source-coverage contract for cross-ledger evidence.
 *
 * This module does not change Runtime or Task persistence. It gives later
 * integration phases one vocabulary for describing which execution, task,
 * log prefix, workspace revision, and target snapshot support a projection or
 * evidence claim.
 */

export const EXECUTION_EVIDENCE_REF_SCHEMA_VERSION = 'maka.execution_evidence_ref.v1' as const;

export const EXECUTION_LOG_LEDGERS = [
  'runtime_event',
  'runtime_event_projection',
  'task_event',
] as const;
export type ExecutionLogLedger = (typeof EXECUTION_LOG_LEDGERS)[number];

export const WORKSPACE_REVISION_KINDS = [
  'git_commit',
  'workspace_snapshot',
  'manifest',
  'opaque',
] as const;
export type WorkspaceRevisionKind = (typeof WORKSPACE_REVISION_KINDS)[number];

/**
 * Runtime identity lane.
 *
 * `invocationId` is the existing durable Runtime spine id. `agentRunId` maps
 * to `AgentRunHeader.runId` and `RuntimeEvent.runId`; the longer field name
 * avoids confusing an AgentRun with a TaskRun at cross-ledger boundaries.
 *
 * Only `sessionId` is required so callers can represent partial knowledge
 * without inventing child identities.
 */
export interface ExecutionIdentityRef {
  sessionId: string;
  invocationId?: string;
  agentRunId?: string;
  turnId?: string;
}

/** Task identity lane. `attemptId` is meaningful only inside `taskRunId`. */
export interface TaskIdentityRef {
  taskRunId: string;
  attemptId?: string;
}

/**
 * Ordered position in one log or explicitly versioned projection stream.
 *
 * `sequence` is the zero-based append ordinal within (`ledger`, `streamId`).
 * For canonical Runtime/Task ledgers it is the append ordinal. A
 * `runtime_event_projection` owner MUST publish the ordering/filter policy
 * beside the cursor. `sequence` is the only ordering field; `eventId` is an
 * optional audit/dedup pointer and MUST NOT be used to order events. Cursors
 * from different streams are incomparable.
 */
export interface ExecutionLogCursor {
  ledger: ExecutionLogLedger;
  streamId: string;
  sequence: number;
  eventId?: string;
}

/** Inclusive coverage of one append-only log stream. */
export interface ExecutionLogCoverage {
  highWater: ExecutionLogCursor;
  lowWater?: ExecutionLogCursor;
  /** Observed rows represented by this coverage; gaps may make it smaller than the ordinal span. */
  eventCount?: number;
}

export interface WorkspaceRevisionRef {
  kind: WorkspaceRevisionKind;
  ref: string;
  dirty?: boolean;
}

export interface TargetSnapshotRef {
  snapshotId: string;
  sourceLabel?: string;
}

/**
 * Versioned cross-ledger source reference.
 *
 * This is a reference to facts, not a new fact authority. At least one of the
 * Runtime or Task identity lanes is required. Every other field is optional so
 * old data and partially observed executions can be represented honestly.
 */
export interface ExecutionEvidenceRef {
  schemaVersion: typeof EXECUTION_EVIDENCE_REF_SCHEMA_VERSION;
  execution?: ExecutionIdentityRef;
  task?: TaskIdentityRef;
  runtimeCoverage?: ExecutionLogCoverage;
  taskCoverage?: ExecutionLogCoverage;
  workspace?: WorkspaceRevisionRef;
  target?: TargetSnapshotRef;
}

export type ExecutionLogCursorComparison =
  | 'before'
  | 'equal'
  | 'after'
  | 'incomparable'
  | 'conflict';

export interface ExecutionEvidenceValidationIssue {
  path: string;
  message: string;
}

export type ExecutionEvidenceValidationResult =
  | { ok: true; value: ExecutionEvidenceRef }
  | { ok: false; errors: ExecutionEvidenceValidationIssue[] };

/** True only when both cursors use the same ledger and stream identity. */
export function executionLogCursorsShareStream(
  left: Pick<ExecutionLogCursor, 'ledger' | 'streamId'>,
  right: Pick<ExecutionLogCursor, 'ledger' | 'streamId'>,
): boolean {
  return left.ledger === right.ledger && left.streamId === right.streamId;
}

/**
 * Compare append positions without guessing across streams.
 *
 * Different event ids at the same stream position are reported as `conflict`:
 * the ordinal says the rows are equal while their audit identities disagree.
 */
export function compareExecutionLogCursors(
  left: ExecutionLogCursor,
  right: ExecutionLogCursor,
): ExecutionLogCursorComparison {
  if (!executionLogCursorsShareStream(left, right)) return 'incomparable';
  if (left.sequence < right.sequence) return 'before';
  if (left.sequence > right.sequence) return 'after';
  if (left.eventId && right.eventId && left.eventId !== right.eventId) return 'conflict';
  return 'equal';
}

export function validateExecutionEvidenceRef(value: unknown): ExecutionEvidenceValidationResult {
  const errors: ExecutionEvidenceValidationIssue[] = [];
  if (!isRecord(value)) return invalid('ref', 'expected an object');

  if (value.schemaVersion !== EXECUTION_EVIDENCE_REF_SCHEMA_VERSION) {
    errors.push({
      path: 'schemaVersion',
      message: `expected "${EXECUTION_EVIDENCE_REF_SCHEMA_VERSION}"`,
    });
  }

  const execution = validateExecutionIdentity(value.execution, errors);
  const task = validateTaskIdentity(value.task, errors);
  if (!execution && !task) {
    errors.push({ path: 'ref', message: 'expected at least one execution or task identity lane' });
  }

  const runtimeCoverage = validateCoverage(
    value.runtimeCoverage,
    'runtimeCoverage',
    'runtime_event',
    errors,
  );
  const taskCoverage = validateCoverage(value.taskCoverage, 'taskCoverage', 'task_event', errors);

  if (
    execution?.agentRunId &&
    runtimeCoverage &&
    runtimeCoverage.highWater.streamId !== execution.agentRunId
  ) {
    errors.push({
      path: 'runtimeCoverage.highWater.streamId',
      message: 'expected streamId to match execution.agentRunId',
    });
  }
  if (task?.taskRunId && taskCoverage && taskCoverage.highWater.streamId !== task.taskRunId) {
    errors.push({
      path: 'taskCoverage.highWater.streamId',
      message: 'expected streamId to match task.taskRunId',
    });
  }

  validateWorkspaceRevision(value.workspace, errors);
  validateTargetSnapshot(value.target, errors);

  return errors.length === 0
    ? { ok: true, value: value as unknown as ExecutionEvidenceRef }
    : { ok: false, errors };
}

export function isExecutionEvidenceRef(value: unknown): value is ExecutionEvidenceRef {
  return validateExecutionEvidenceRef(value).ok;
}

function validateExecutionIdentity(
  value: unknown,
  errors: ExecutionEvidenceValidationIssue[],
): ExecutionIdentityRef | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    errors.push({ path: 'execution', message: 'expected an object' });
    return undefined;
  }
  requireNonEmptyString(value.sessionId, 'execution.sessionId', errors);
  optionalNonEmptyString(value.invocationId, 'execution.invocationId', errors);
  optionalNonEmptyString(value.agentRunId, 'execution.agentRunId', errors);
  optionalNonEmptyString(value.turnId, 'execution.turnId', errors);
  return value as unknown as ExecutionIdentityRef;
}

function validateTaskIdentity(
  value: unknown,
  errors: ExecutionEvidenceValidationIssue[],
): TaskIdentityRef | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    errors.push({ path: 'task', message: 'expected an object' });
    return undefined;
  }
  requireNonEmptyString(value.taskRunId, 'task.taskRunId', errors);
  optionalNonEmptyString(value.attemptId, 'task.attemptId', errors);
  return value as unknown as TaskIdentityRef;
}

function validateCoverage(
  value: unknown,
  path: string,
  expectedLedger: ExecutionLogLedger,
  errors: ExecutionEvidenceValidationIssue[],
): ExecutionLogCoverage | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    errors.push({ path, message: 'expected an object' });
    return undefined;
  }

  const highWater = validateCursor(value.highWater, `${path}.highWater`, expectedLedger, errors);
  const lowWater =
    value.lowWater === undefined
      ? undefined
      : validateCursor(value.lowWater, `${path}.lowWater`, expectedLedger, errors);

  if (lowWater && highWater) {
    const comparison = compareExecutionLogCursors(lowWater, highWater);
    if (comparison === 'incomparable') {
      errors.push({
        path: `${path}.lowWater`,
        message: 'expected lowWater and highWater in the same log stream',
      });
    } else if (comparison === 'after') {
      errors.push({
        path: `${path}.lowWater.sequence`,
        message: 'expected lowWater at or before highWater',
      });
    } else if (comparison === 'conflict') {
      errors.push({
        path: `${path}.lowWater.eventId`,
        message: 'conflicting event ids at the same log position',
      });
    }
  }

  if (value.eventCount !== undefined && !isPositiveSafeInteger(value.eventCount)) {
    errors.push({ path: `${path}.eventCount`, message: 'expected a positive safe integer' });
  }
  return highWater ? (value as unknown as ExecutionLogCoverage) : undefined;
}

function validateCursor(
  value: unknown,
  path: string,
  expectedLedger: ExecutionLogLedger,
  errors: ExecutionEvidenceValidationIssue[],
): ExecutionLogCursor | undefined {
  if (!isRecord(value)) {
    errors.push({ path, message: 'expected an object' });
    return undefined;
  }
  if (value.ledger !== expectedLedger) {
    errors.push({ path: `${path}.ledger`, message: `expected "${expectedLedger}"` });
  }
  requireNonEmptyString(value.streamId, `${path}.streamId`, errors);
  if (!isNonNegativeSafeInteger(value.sequence)) {
    errors.push({ path: `${path}.sequence`, message: 'expected a non-negative safe integer' });
  }
  optionalNonEmptyString(value.eventId, `${path}.eventId`, errors);
  return value as unknown as ExecutionLogCursor;
}

function validateWorkspaceRevision(
  value: unknown,
  errors: ExecutionEvidenceValidationIssue[],
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path: 'workspace', message: 'expected an object' });
    return;
  }
  if (!isOneOf(value.kind, WORKSPACE_REVISION_KINDS)) {
    errors.push({ path: 'workspace.kind', message: 'expected a known workspace revision kind' });
  }
  requireNonEmptyString(value.ref, 'workspace.ref', errors);
  if (value.dirty !== undefined && typeof value.dirty !== 'boolean') {
    errors.push({ path: 'workspace.dirty', message: 'expected a boolean when present' });
  }
}

function validateTargetSnapshot(value: unknown, errors: ExecutionEvidenceValidationIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path: 'target', message: 'expected an object' });
    return;
  }
  requireNonEmptyString(value.snapshotId, 'target.snapshotId', errors);
  optionalNonEmptyString(value.sourceLabel, 'target.sourceLabel', errors);
}

function requireNonEmptyString(
  value: unknown,
  path: string,
  errors: ExecutionEvidenceValidationIssue[],
): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push({ path, message: 'expected a non-empty string' });
  }
}

function optionalNonEmptyString(
  value: unknown,
  path: string,
  errors: ExecutionEvidenceValidationIssue[],
): void {
  if (value !== undefined) requireNonEmptyString(value, path, errors);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === 'string' && values.includes(value);
}

function invalid(path: string, message: string): ExecutionEvidenceValidationResult {
  return { ok: false, errors: [{ path, message }] };
}
