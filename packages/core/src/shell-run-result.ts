import type {
  ShellRunSnapshotResult,
  ShellRunStateResult,
  ToolResultContent,
} from './events.js';
import {
  isShellOutput,
  isShellRunStatus,
  isValidShellRunState,
  type ShellOutput,
  type ShellRunStatus,
} from './shell-run.js';

export type ShellRunToolResult = Extract<ToolResultContent, { kind: 'shell_run' }>;
type TerminalToolResult = Extract<ToolResultContent, { kind: 'terminal' }>;
type ShellToolResult = TerminalToolResult | ShellRunToolResult;

export type ShellToolResultNormalization =
  | { state: 'not_shell' }
  | { state: 'invalid' }
  | { state: 'valid'; content: ShellToolResult };

const CURRENT_TERMINAL_RESULT_KEYS = new Set([
  'kind',
  'cwd',
  'cmd',
  'status',
  'exitCode',
  'failureMessage',
  'output',
]);

const CURRENT_SHELL_RUN_RESULT_KEYS = new Set([
  'kind',
  'ref',
  'mode',
  'status',
  'cwd',
  'cmd',
  'startedAt',
  'updatedAt',
  'completedAt',
  'exitCode',
  'failureMessage',
  'revision',
  'timeoutMs',
  'output',
  'operation',
]);

const STOP_OPERATION_KEYS = new Set(['kind', 'applied']);
const PTY_CONTROL_OPERATION_KEYS = new Set(['kind', 'failed', 'input', 'resize']);
const PTY_CONTROL_INPUT_KEYS = new Set(['bytes', 'applied']);
const PTY_CONTROL_RESIZE_KEYS = new Set(['cols', 'rows', 'applied', 'changed']);

const LEGACY_TERMINAL_RESULT_KEYS = new Set([
  'kind',
  'cwd',
  'cmd',
  'status',
  'exitCode',
  'stdout',
  'stderr',
  'stdoutTruncated',
  'stderrTruncated',
]);

const LEGACY_SHELL_RUN_RESULT_KEYS = new Set([
  'kind',
  'ref',
  'status',
  'cwd',
  'cmd',
  'startedAt',
  'updatedAt',
  'completedAt',
  'exitCode',
  'failureMessage',
  'stdout',
  'stderr',
  'latestOutputStream',
  'stdoutTruncated',
  'stderrTruncated',
  'timeoutMs',
  'observedAt',
  'orphanedReason',
  'cancelled',
]);

/** Validate current shell results and normalize only the exact preceding shape. */
export function normalizeShellToolResultContent(value: unknown): ShellToolResultNormalization {
  if (!isRecord(value) || (value.kind !== 'terminal' && value.kind !== 'shell_run')) {
    return { state: 'not_shell' };
  }
  const current = value.kind === 'terminal'
    ? currentTerminalResult(value)
    : currentShellRunResult(value);
  if (current) return { state: 'valid', content: current };
  const legacy = value.kind === 'terminal'
    ? normalizeLegacyTerminalResult(value)
    : normalizeLegacyShellRunResult(value);
  return legacy
    ? { state: 'valid', content: legacy }
    : { state: 'invalid' };
}

function currentTerminalResult(value: Record<string, unknown>): TerminalToolResult | undefined {
  if (
    !hasOnlyKeys(value, CURRENT_TERMINAL_RESULT_KEYS)
    || typeof value.cwd !== 'string'
    || typeof value.cmd !== 'string'
    || !isLegacyTerminalStatus(value.status)
    || !isOptionalFiniteNumber(value.exitCode)
    || !isOptionalString(value.failureMessage)
    || !isShellOutput(value.output)
    || !isValidTerminalState(value)
  ) return undefined;
  return value as TerminalToolResult;
}

function isValidTerminalState(value: Record<string, unknown>): boolean {
  switch (value.status) {
    case 'completed':
      return value.exitCode === 0 && value.failureMessage === undefined;
    case 'failed':
      return (isFiniteNumber(value.exitCode) && value.exitCode !== 0)
        || (value.exitCode === undefined
          && typeof value.failureMessage === 'string'
          && value.failureMessage.length > 0);
    case 'timed_out':
      return value.exitCode === 124;
    case 'cancelled':
      return value.exitCode === 130;
    default:
      return false;
  }
}

function currentShellRunResult(value: Record<string, unknown>): ShellRunToolResult | undefined {
  if (
    !hasOnlyKeys(value, CURRENT_SHELL_RUN_RESULT_KEYS)
    || typeof value.ref !== 'string'
    || (value.mode !== 'pipes' && value.mode !== 'pty')
    || !isShellRunStatus(value.status)
    || typeof value.cwd !== 'string'
    || typeof value.cmd !== 'string'
    || !isFiniteNumber(value.startedAt)
    || !isFiniteNumber(value.updatedAt)
    || !isPositiveInteger(value.revision)
    || !isOptionalFiniteNumber(value.completedAt)
    || !isOptionalFiniteNumber(value.exitCode)
    || !isOptionalFiniteNumber(value.timeoutMs)
    || !isOptionalString(value.failureMessage)
    || (value.output !== undefined
      && (!isShellOutput(value.output) || value.output.mode !== value.mode))
    || !isCurrentShellRunOperation(value.operation, value.mode, value.output !== undefined)
    || !isValidShellRunState(value)
  ) return undefined;
  return value as ShellRunToolResult;
}

function normalizeLegacyTerminalResult(
  value: Record<string, unknown>,
): Extract<ToolResultContent, { kind: 'terminal' }> | undefined {
  if (
    !hasOnlyKeys(value, LEGACY_TERMINAL_RESULT_KEYS)
    || typeof value.cwd !== 'string'
    || typeof value.cmd !== 'string'
    || !isLegacyTerminalStatus(value.status)
    || !isFiniteNumber(value.exitCode)
    || typeof value.stdout !== 'string'
    || typeof value.stderr !== 'string'
    || typeof value.stdoutTruncated !== 'boolean'
    || typeof value.stderrTruncated !== 'boolean'
    || !isValidTerminalState(value)
  ) return undefined;

  return {
    kind: 'terminal',
    cwd: value.cwd,
    cmd: value.cmd,
    status: value.status,
    exitCode: value.exitCode,
    output: legacyPipeOutput(value),
  };
}

function normalizeLegacyShellRunResult(value: Record<string, unknown>): ShellRunToolResult | undefined {
  if (
    !hasOnlyKeys(value, LEGACY_SHELL_RUN_RESULT_KEYS)
    || typeof value.ref !== 'string'
    || !isShellRunStatus(value.status)
    || typeof value.cwd !== 'string'
    || typeof value.cmd !== 'string'
    || !isFiniteNumber(value.startedAt)
    || !isFiniteNumber(value.updatedAt)
    || typeof value.stdout !== 'string'
    || typeof value.stderr !== 'string'
    || typeof value.stdoutTruncated !== 'boolean'
    || typeof value.stderrTruncated !== 'boolean'
    || !isOptionalFiniteNumber(value.completedAt)
    || !isOptionalFiniteNumber(value.exitCode)
    || !isOptionalFiniteNumber(value.timeoutMs)
    || !isOptionalFiniteNumber(value.observedAt)
    || !isOptionalString(value.failureMessage)
    || !isOptionalString(value.orphanedReason)
    || !isOptionalBoolean(value.cancelled)
    || !isOptionalOutputStream(value.latestOutputStream)
    || !isValidLegacyShellRunState(value)
  ) return undefined;

  const failureMessage = typeof value.failureMessage === 'string'
    ? value.failureMessage
    : value.status === 'orphaned'
      ? value.orphanedReason as string
      : undefined;
  return {
    kind: 'shell_run',
    ref: value.ref,
    mode: 'pipes',
    status: value.status,
    cwd: value.cwd,
    cmd: value.cmd,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    ...(isFiniteNumber(value.completedAt) ? { completedAt: value.completedAt } : {}),
    ...(isFiniteNumber(value.timeoutMs) ? { timeoutMs: value.timeoutMs } : {}),
    ...(isFiniteNumber(value.exitCode) ? { exitCode: value.exitCode } : {}),
    ...(failureMessage !== undefined ? { failureMessage } : {}),
    revision: 1,
    output: legacyPipeOutput(value),
    ...(typeof value.cancelled === 'boolean'
      ? { operation: { kind: 'stop', applied: value.cancelled } as const }
      : {}),
  };
}

function legacyPipeOutput(value: Record<string, unknown>): Extract<ShellOutput, { mode: 'pipes' }> {
  return {
    mode: 'pipes',
    stdout: value.stdout as string,
    stderr: value.stderr as string,
    ...(isOutputStream(value.latestOutputStream) ? { latestStream: value.latestOutputStream } : {}),
    stdoutTruncated: value.stdoutTruncated as boolean,
    stderrTruncated: value.stderrTruncated as boolean,
    redacted: false,
  };
}

function isLegacyTerminalStatus(
  value: unknown,
): value is Exclude<ShellRunStatus, 'running' | 'orphaned'> {
  return value === 'completed' || value === 'failed' || value === 'timed_out' || value === 'cancelled';
}

function isCurrentShellRunOperation(
  value: unknown,
  mode: unknown,
  hasOutput: boolean,
): boolean {
  if (value === undefined) return true;
  if (!hasOutput || !isRecord(value)) return false;
  if (value.kind === 'stop') {
    return hasOnlyKeys(value, STOP_OPERATION_KEYS) && typeof value.applied === 'boolean';
  }
  if (
    value.kind !== 'pty_control'
    || mode !== 'pty'
    || !hasOnlyKeys(value, PTY_CONTROL_OPERATION_KEYS)
    || typeof value.failed !== 'boolean'
    || (value.input === undefined && value.resize === undefined)
  ) return false;
  if (
    value.input !== undefined
    && (!isRecord(value.input)
      || !hasOnlyKeys(value.input, PTY_CONTROL_INPUT_KEYS)
      || !isNonNegativeInteger(value.input.bytes)
      || typeof value.input.applied !== 'boolean')
  ) return false;
  return value.resize === undefined
    || (isRecord(value.resize)
      && hasOnlyKeys(value.resize, PTY_CONTROL_RESIZE_KEYS)
      && isPositiveInteger(value.resize.cols)
      && isPositiveInteger(value.resize.rows)
      && typeof value.resize.applied === 'boolean'
      && typeof value.resize.changed === 'boolean');
}

export function isValidLegacyShellRunState(value: Record<string, unknown>): boolean {
  switch (value.status) {
    case 'running':
      return value.completedAt === undefined
        && value.exitCode === undefined
        && value.failureMessage === undefined
        && value.observedAt === undefined
        && value.orphanedReason === undefined;
    case 'completed':
      return isFiniteNumber(value.completedAt)
        && value.exitCode === 0
        && value.failureMessage === undefined
        && value.orphanedReason === undefined;
    case 'failed':
      return isFiniteNumber(value.completedAt)
        && isFiniteNumber(value.exitCode)
        && value.exitCode !== 0
        && value.orphanedReason === undefined;
    case 'timed_out':
      return isFiniteNumber(value.completedAt)
        && value.exitCode === 124
        && value.orphanedReason === undefined;
    case 'cancelled':
      return isFiniteNumber(value.completedAt)
        && value.exitCode === 130
        && value.orphanedReason === undefined;
    case 'orphaned':
      return isFiniteNumber(value.completedAt)
        && value.exitCode === undefined
        && value.failureMessage === undefined
        && typeof value.orphanedReason === 'string'
        && value.orphanedReason.length > 0;
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isOutputStream(value: unknown): value is 'stdout' | 'stderr' {
  return value === 'stdout' || value === 'stderr';
}

function isOptionalOutputStream(value: unknown): boolean {
  return value === undefined || isOutputStream(value);
}

export interface ShellRunStateMerge<
  Result extends ShellRunStateResult = ShellRunStateResult,
> {
  result: Result;
  changed: boolean;
  invariantViolation?: 'ref_mismatch' | 'same_revision_conflict';
}

export interface ShellRunMergeDiagnostic {
  context: string;
  violation: NonNullable<ShellRunStateMerge['invariantViolation']>;
  currentRef?: string;
  candidateRef: string;
  currentRevision?: number;
  candidateRevision: number;
}

export type ShellRunMergeDiagnosticReporter = (diagnostic: ShellRunMergeDiagnostic) => void;

export function shellRunStateProjection(result: ShellRunToolResult): ShellRunStateResult {
  const { operation: _operation, ...state } = result;
  return state;
}

export function mergeShellRunState(
  current: ShellRunSnapshotResult | undefined,
  candidate: ShellRunSnapshotResult,
): ShellRunStateMerge<ShellRunSnapshotResult>;
export function mergeShellRunState(
  current: ShellRunToolResult | undefined,
  candidate: ShellRunToolResult,
): ShellRunStateMerge;
export function mergeShellRunState(
  current: ShellRunToolResult | undefined,
  candidate: ShellRunToolResult,
): ShellRunStateMerge {
  const next = shellRunStateProjection(candidate);
  if (!current) return { result: next, changed: true };

  const previous = shellRunStateProjection(current);
  if (previous.ref !== next.ref) {
    return { result: previous, changed: false, invariantViolation: 'ref_mismatch' };
  }
  if (next.revision > previous.revision) return { result: next, changed: true };
  if (next.revision < previous.revision) return { result: previous, changed: false };

  if (!sameMetadata(previous, next)) {
    return { result: previous, changed: false, invariantViolation: 'same_revision_conflict' };
  }
  if (previous.output === undefined && next.output !== undefined) {
    return { result: next, changed: true };
  }
  if (previous.output !== undefined && next.output === undefined) {
    return { result: previous, changed: false };
  }
  if (shellOutputEqual(previous.output, next.output)) {
    return { result: previous, changed: false };
  }
  return { result: previous, changed: false, invariantViolation: 'same_revision_conflict' };
}

export function mergeShellRunStateWithDiagnostics(
  current: ShellRunSnapshotResult | undefined,
  candidate: ShellRunSnapshotResult,
  context: string,
  report?: ShellRunMergeDiagnosticReporter,
): ShellRunStateMerge<ShellRunSnapshotResult>;
export function mergeShellRunStateWithDiagnostics(
  current: ShellRunToolResult | undefined,
  candidate: ShellRunToolResult,
  context: string,
  report?: ShellRunMergeDiagnosticReporter,
): ShellRunStateMerge;
export function mergeShellRunStateWithDiagnostics(
  current: ShellRunToolResult | undefined,
  candidate: ShellRunToolResult,
  context: string,
  report: ShellRunMergeDiagnosticReporter = reportShellRunMergeDiagnostic,
): ShellRunStateMerge {
  const merged = mergeShellRunState(current, candidate);
  if (merged.invariantViolation) {
    report({
      context,
      violation: merged.invariantViolation,
      ...(current ? { currentRef: current.ref, currentRevision: current.revision } : {}),
      candidateRef: candidate.ref,
      candidateRevision: candidate.revision,
    });
  }
  return merged;
}

function reportShellRunMergeDiagnostic(diagnostic: ShellRunMergeDiagnostic): void {
  console.warn('[shell-run] state reconciliation invariant violation', diagnostic);
}

function sameMetadata(left: ShellRunStateResult, right: ShellRunStateResult): boolean {
  return left.mode === right.mode
    && left.status === right.status
    && left.cwd === right.cwd
    && left.cmd === right.cmd
    && left.startedAt === right.startedAt
    && left.updatedAt === right.updatedAt
    && left.completedAt === right.completedAt
    && left.timeoutMs === right.timeoutMs
    && left.exitCode === right.exitCode
    && left.failureMessage === right.failureMessage
    && left.revision === right.revision;
}

function shellOutputEqual(left: ShellOutput | undefined, right: ShellOutput | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.mode !== right.mode) return false;
  if (left.mode === 'pipes' && right.mode === 'pipes') {
    return left.stdout === right.stdout
      && left.stderr === right.stderr
      && left.latestStream === right.latestStream
      && left.stdoutTruncated === right.stdoutTruncated
      && left.stderrTruncated === right.stderrTruncated
      && left.redacted === right.redacted;
  }
  if (left.mode !== 'pty' || right.mode !== 'pty') return false;
  return left.screen === right.screen
    && left.scrollback === right.scrollback
    && left.lastAlternateScreen === right.lastAlternateScreen
    && left.cols === right.cols
    && left.rows === right.rows
    && left.cursor.x === right.cursor.x
    && left.cursor.y === right.cursor.y
    && left.cursor.visible === right.cursor.visible
    && left.alternateScreen === right.alternateScreen
    && left.truncated === right.truncated
    && left.redacted === right.redacted;
}
