import type {
  ShellRunSnapshotResult,
  ShellRunStateResult,
  ToolResultContent,
} from './events.js';
import type { ShellOutput } from './shell-run.js';

export type ShellRunToolResult = Extract<ToolResultContent, { kind: 'shell_run' }>;

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
